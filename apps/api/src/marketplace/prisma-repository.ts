import { Prisma, type PrismaClient, type UserRole } from "@prisma/client";
import type { MarketplaceBookingStatus, MarketplaceServiceStatus } from "@autospokes/shared";
import type {
  BookingAction,
  BookingScope,
  DiscoveryCandidate,
  MarketplaceBookingDetail,
  MarketplaceBookingRecord,
  MarketplacePaymentRecord,
  MarketplaceProfileRecord,
  MarketplaceRepository,
  MarketplaceServiceRecord,
  MarketplaceStaffRecord,
  NewMarketplaceBooking,
  TransitionPayload,
} from "./repository.js";
import {
  BOOKING_TRANSITIONS,
  MarketplaceRuleError,
  assertPaymentRecordable,
  assertStaffAssignable,
  planTransition,
} from "./rules.js";

type ProfileRow = Omit<MarketplaceProfileRecord, "operatingHours"> & { operatingHours: Prisma.JsonValue };

const toProfile = (row: ProfileRow): MarketplaceProfileRecord => ({
  ...row,
  operatingHours: (typeof row.operatingHours === "object" && row.operatingHours !== null && !Array.isArray(row.operatingHours)
    ? row.operatingHours
    : {}) as MarketplaceProfileRecord["operatingHours"],
});

const scopeWhere = (scope: BookingScope, id?: string): Prisma.MarketplaceBookingWhereInput => ({
  ...(id ? { id } : {}),
  ...(scope.role === "VENDOR" ? { vendorAccountId: scope.accountId } : { ownerAccountId: scope.accountId }),
});

const actorRoleOf = (scope: BookingScope): UserRole => (scope.role === "VENDOR" ? "MARKETPLACE_VENDOR" : "OWNER");

export class PrismaMarketplaceRepository implements MarketplaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private audit(
    tx: Prisma.TransactionClient,
    accountId: string,
    actorId: string,
    action: string,
    details: Prisma.InputJsonValue,
  ) {
    return tx.auditEvent.create({ data: { accountId, actorId, action, details } });
  }

  async findProfile(accountId: string) {
    const row = await this.prisma.marketplaceProfile.findUnique({ where: { accountId } });
    return row ? toProfile(row as ProfileRow) : null;
  }

  async saveProfile(accountId: string, actorId: string, input: Parameters<MarketplaceRepository["saveProfile"]>[2]) {
    const data = { ...input, operatingHours: input.operatingHours as Prisma.InputJsonValue };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.marketplaceProfile.upsert({
        where: { accountId },
        create: { accountId, ...data },
        update: data,
      });
      await this.audit(tx, accountId, actorId, "marketplace.profile.saved", { profileId: row.id });
      return toProfile(row as ProfileRow);
    });
  }

  listServices(accountId: string): Promise<MarketplaceServiceRecord[]> {
    return this.prisma.marketplaceService.findMany({ where: { accountId }, orderBy: { createdAt: "desc" } });
  }

  findService(accountId: string, serviceId: string) {
    return this.prisma.marketplaceService.findFirst({ where: { id: serviceId, accountId } });
  }

  createService(accountId: string, actorId: string, input: Parameters<MarketplaceRepository["createService"]>[2]) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.marketplaceService.create({ data: { ...input, accountId } });
      await this.audit(tx, accountId, actorId, "marketplace.service.created", { serviceId: row.id });
      return row;
    });
  }

  updateService(
    accountId: string,
    actorId: string,
    serviceId: string,
    patch: Parameters<MarketplaceRepository["updateService"]>[3],
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Archived services are immutable; the version bump marks that bookings made earlier hold older terms.
      const result = await tx.marketplaceService.updateMany({
        where: { id: serviceId, accountId, status: { not: "ARCHIVED" } },
        data: { ...patch, version: { increment: 1 } },
      });
      if (result.count !== 1) return null;
      await this.audit(tx, accountId, actorId, "marketplace.service.updated", {
        serviceId,
        fields: Object.keys(patch),
      });
      return tx.marketplaceService.findFirst({ where: { id: serviceId, accountId } });
    });
  }

  setServiceStatus(accountId: string, actorId: string, serviceId: string, status: MarketplaceServiceStatus) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.marketplaceService.updateMany({
        where: { id: serviceId, accountId, status: { not: "ARCHIVED" } },
        data: { status, archivedAt: status === "ARCHIVED" ? new Date() : null },
      });
      if (result.count !== 1) return null;
      await this.audit(tx, accountId, actorId, "marketplace.service.status", { serviceId, status });
      return tx.marketplaceService.findFirst({ where: { id: serviceId, accountId } });
    });
  }

  async listStaff(accountId: string) {
    const [staff, open] = await Promise.all([
      this.prisma.marketplaceStaff.findMany({ where: { accountId }, orderBy: { name: "asc" } }),
      this.prisma.marketplaceBooking.groupBy({
        by: ["staffId"],
        where: { vendorAccountId: accountId, staffId: { not: null }, status: { in: ["ACCEPTED", "IN_PROGRESS"] } },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(open.map((entry) => [entry.staffId, entry._count._all]));
    return staff.map((member) => ({ ...member, openBookings: counts.get(member.id) ?? 0 }));
  }

  createStaff(accountId: string, actorId: string, input: Parameters<MarketplaceRepository["createStaff"]>[2]) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.marketplaceStaff.create({ data: { ...input, accountId } });
      await this.audit(tx, accountId, actorId, "marketplace.staff.created", { staffId: row.id });
      return row;
    });
  }

  updateStaff(
    accountId: string,
    actorId: string,
    staffId: string,
    patch: Parameters<MarketplaceRepository["updateStaff"]>[3],
  ): Promise<MarketplaceStaffRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.marketplaceStaff.updateMany({ where: { id: staffId, accountId }, data: patch });
      if (result.count !== 1) return null;
      await this.audit(tx, accountId, actorId, "marketplace.staff.updated", { staffId, fields: Object.keys(patch) });
      return tx.marketplaceStaff.findFirst({ where: { id: staffId, accountId } });
    });
  }

  async listActiveCandidates(): Promise<DiscoveryCandidate[]> {
    const services = await this.prisma.marketplaceService.findMany({
      where: { status: "ACTIVE" },
      take: 2000,
    });
    if (services.length === 0) return [];
    const profiles = await this.prisma.marketplaceProfile.findMany({
      where: { accountId: { in: [...new Set(services.map((service) => service.accountId))] } },
    });
    const byAccount = new Map(profiles.map((profile) => [profile.accountId, toProfile(profile as ProfileRow)]));
    return services.flatMap((service) => {
      const profile = byAccount.get(service.accountId);
      return profile ? [{ service, profile }] : [];
    });
  }

  async findServiceForBooking(serviceId: string): Promise<DiscoveryCandidate | null> {
    const service = await this.prisma.marketplaceService.findUnique({ where: { id: serviceId } });
    if (!service) return null;
    const profile = await this.findProfile(service.accountId);
    return profile ? { service, profile } : null;
  }

  findBookingByIdempotencyKey(ownerAccountId: string, key: string): Promise<MarketplaceBookingRecord | null> {
    return this.prisma.marketplaceBooking.findUnique({
      where: { ownerAccountId_idempotencyKey: { ownerAccountId, idempotencyKey: key } },
    });
  }

  async createBooking(input: NewMarketplaceBooking) {
    try {
      const booking = await this.prisma.$transaction(async (tx) => {
        const created = await tx.marketplaceBooking.create({
          data: {
            ownerAccountId: input.ownerAccountId,
            vendorAccountId: input.vendorAccountId,
            vehicleId: input.vehicleId,
            serviceId: input.serviceId,
            idempotencyKey: input.idempotencyKey,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            serviceLocation: input.serviceLocation,
            accessNotes: input.accessNotes,
            ...input.snapshot,
          },
        });
        await tx.marketplaceBookingEvent.create({
          data: {
            bookingId: created.id,
            vendorAccountId: created.vendorAccountId,
            actorId: input.actorId,
            actorRole: "OWNER",
            kind: "requested",
            toStatus: "REQUESTED",
          },
        });
        await this.audit(tx, input.ownerAccountId, input.actorId, "marketplace.booking.requested", {
          bookingId: created.id,
          vendorAccountId: created.vendorAccountId,
        });
        return created;
      });
      return { booking, created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.findBookingByIdempotencyKey(input.ownerAccountId, input.idempotencyKey);
        if (existing) return { booking: existing, created: false };
      }
      throw error;
    }
  }

  listBookings(scope: BookingScope, statuses?: MarketplaceBookingStatus[]) {
    return this.prisma.marketplaceBooking.findMany({
      where: { ...scopeWhere(scope), ...(statuses ? { status: { in: statuses } } : {}) },
      orderBy: { windowStart: "asc" },
      take: 500,
    });
  }

  async findBooking(scope: BookingScope, bookingId: string): Promise<MarketplaceBookingDetail | null> {
    const booking = await this.prisma.marketplaceBooking.findFirst({ where: scopeWhere(scope, bookingId) });
    if (!booking) return null;
    const [events, payments, profile, staff] = await Promise.all([
      this.prisma.marketplaceBookingEvent.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } }),
      this.prisma.marketplacePayment.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } }),
      this.prisma.marketplaceProfile.findUnique({
        where: { accountId: booking.vendorAccountId },
        select: { businessName: true, contactPhone: true },
      }),
      booking.staffId
        ? this.prisma.marketplaceStaff.findFirst({
            where: { id: booking.staffId, accountId: booking.vendorAccountId },
            select: { name: true },
          })
        : null,
    ]);
    return {
      booking,
      events,
      payments: payments as MarketplacePaymentRecord[],
      vendorBusinessName: profile?.businessName ?? null,
      vendorContactPhone: profile?.contactPhone ?? null,
      staffName: staff?.name ?? null,
    };
  }

  async transitionBooking(
    scope: BookingScope,
    actorId: string,
    bookingId: string,
    action: BookingAction,
    payload: TransitionPayload,
    now: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceBooking.findFirst({ where: scopeWhere(scope, bookingId) });
      if (!current) return null;
      const plan = planTransition(current, action, scope.role, payload, now);
      // Compare-and-set: only one concurrent caller can move the booking out of the expected state.
      const result = await tx.marketplaceBooking.updateMany({
        where: { id: current.id, status: BOOKING_TRANSITIONS[action].from },
        data: { ...plan.patch, status: plan.to },
      });
      if (result.count !== 1) throw new MarketplaceRuleError(409, "This booking was changed by someone else; refresh and retry");
      await tx.marketplaceBookingEvent.create({
        data: {
          bookingId: current.id,
          vendorAccountId: current.vendorAccountId,
          actorId,
          actorRole: actorRoleOf(scope),
          kind: action,
          fromStatus: current.status,
          toStatus: plan.to,
          note: plan.note,
        },
      });
      await this.audit(tx, scope.accountId, actorId, `marketplace.booking.${action}`, {
        bookingId: current.id,
        from: current.status,
        to: plan.to,
      });
      return tx.marketplaceBooking.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  async assignStaff(
    vendorAccountId: string,
    actorId: string,
    bookingId: string,
    staffId: string | null,
    note: string | null,
    now: Date,
  ) {
    void now;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceBooking.findFirst({ where: { id: bookingId, vendorAccountId } });
      if (!current) return null;
      assertStaffAssignable(current.status);
      if (staffId) {
        const member = await tx.marketplaceStaff.findFirst({ where: { id: staffId, accountId: vendorAccountId } });
        if (!member) throw new MarketplaceRuleError(404, "Staff member not found");
        if (!member.active || !member.available) {
          throw new MarketplaceRuleError(409, "That staff member is not available for assignment");
        }
      }
      const result = await tx.marketplaceBooking.updateMany({
        where: { id: current.id, status: current.status },
        data: { staffId },
      });
      if (result.count !== 1) throw new MarketplaceRuleError(409, "This booking was changed by someone else; refresh and retry");
      await tx.marketplaceBookingEvent.create({
        data: {
          bookingId: current.id,
          vendorAccountId,
          actorId,
          actorRole: "MARKETPLACE_VENDOR",
          kind: staffId ? (current.staffId ? "staff_reassigned" : "staff_assigned") : "staff_unassigned",
          note,
          details: { previousStaffId: current.staffId, staffId },
        },
      });
      await this.audit(tx, vendorAccountId, actorId, "marketplace.booking.staff", {
        bookingId: current.id,
        previousStaffId: current.staffId,
        staffId,
      });
      return tx.marketplaceBooking.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  async recordPayment(
    vendorAccountId: string,
    actorId: string,
    bookingId: string,
    payment: Parameters<MarketplaceRepository["recordPayment"]>[3],
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Row lock serialises concurrent payment records so the total cannot exceed the agreed price.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "MarketplaceBooking" WHERE "id" = ${bookingId}::uuid AND "vendorAccountId" = ${vendorAccountId}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const booking = await tx.marketplaceBooking.findUniqueOrThrow({ where: { id: bookingId } });
      const existing = await tx.marketplacePayment.aggregate({
        where: { bookingId },
        _sum: { amountPaise: true },
      });
      assertPaymentRecordable(booking, existing._sum.amountPaise ?? 0, payment.amountPaise);
      const row = await tx.marketplacePayment.create({
        data: { ...payment, bookingId, vendorAccountId, recordedBy: actorId, status: "RECORDED_UNVERIFIED" },
      });
      await tx.marketplaceBookingEvent.create({
        data: {
          bookingId,
          vendorAccountId,
          actorId,
          actorRole: "MARKETPLACE_VENDOR",
          kind: "payment_recorded",
          details: { paymentId: row.id, amountPaise: payment.amountPaise, verified: false },
        },
      });
      await this.audit(tx, vendorAccountId, actorId, "marketplace.payment.recorded", {
        bookingId,
        paymentId: row.id,
        amountPaise: payment.amountPaise,
      });
      return row as MarketplacePaymentRecord;
    });
  }
}
