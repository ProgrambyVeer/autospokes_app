import { Prisma, type PrismaClient, type UserRole } from "@prisma/client";
import type { MarketplaceBookingStatus, MarketplaceDisputeStatus, MarketplaceServiceStatus } from "@autospokes/shared";
import type {
  BookingAction,
  BookingScope,
  DiscoveryCandidate,
  MarketplaceBookingDetail,
  MarketplaceBookingRecord,
  MarketplaceCancellationRecord,
  MarketplaceDisputeRecord,
  MarketplacePaymentRecord,
  MarketplaceProfileRecord,
  MarketplaceRefundRecord,
  MarketplaceRepository,
  MarketplaceServiceRecord,
  MarketplaceSettlementRecord,
  MarketplaceStaffRecord,
  NewMarketplaceBooking,
  TransitionPayload,
} from "./repository.js";
import {
  BOOKING_TRANSITIONS,
  MarketplaceRuleError,
  assertDisputeRespondable,
  assertPaymentRecordable,
  assertPaymentReviewable,
  assertRefundable,
  assertStaffAssignable,
  planCancellation,
  planDisputeResolution,
  planTransition,
} from "./rules.js";

type PaymentRow = Prisma.MarketplacePaymentGetPayload<object>;
type DisputeRow = Prisma.MarketplaceDisputeGetPayload<{ include: { entries: true } }>;

const toPayment = (row: PaymentRow): MarketplacePaymentRecord => ({
  id: row.id,
  bookingId: row.bookingId,
  amountPaise: row.amountPaise,
  currency: row.currency,
  method: row.method,
  reference: row.reference,
  note: row.note,
  status: row.status,
  createdAt: row.createdAt,
  verifiedAt: row.verifiedAt,
  verificationSource: row.verificationSource,
  verificationEvidence: (row.verificationEvidence ?? null) as MarketplacePaymentRecord["verificationEvidence"],
  failedAt: row.failedAt,
  failureReason: row.failureReason,
});

const toDispute = (row: DisputeRow): MarketplaceDisputeRecord => ({
  id: row.id,
  bookingId: row.bookingId,
  ownerAccountId: row.ownerAccountId,
  vendorAccountId: row.vendorAccountId,
  status: row.status,
  category: row.category,
  reason: row.reason,
  description: row.description,
  evidenceUrls: row.evidenceUrls,
  outcome: row.outcome,
  resolutionRationale: row.resolutionRationale,
  resolvedAt: row.resolvedAt,
  createdAt: row.createdAt,
  entries: [...row.entries]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((entry) => ({
      id: entry.id,
      disputeId: entry.disputeId,
      kind: entry.kind,
      actorRole: entry.actorRole,
      message: entry.message,
      evidenceUrls: entry.evidenceUrls,
      createdAt: entry.createdAt,
    })),
});

const toRefund = (row: Prisma.MarketplaceRefundGetPayload<object>): MarketplaceRefundRecord => ({
  id: row.id,
  paymentId: row.paymentId,
  bookingId: row.bookingId,
  amountPaise: row.amountPaise,
  status: row.status,
  reason: row.reason,
  confirmedAt: row.confirmedAt,
  evidenceReference: row.evidenceReference,
  createdAt: row.createdAt,
});

const toSettlement = (row: Prisma.MarketplaceSettlementGetPayload<object>): MarketplaceSettlementRecord => ({
  id: row.id,
  bookingId: row.bookingId,
  agreedPricePaise: row.agreedPricePaise,
  verifiedPaidPaise: row.verifiedPaidPaise,
  note: row.note,
  externalTransfer: false,
  createdAt: row.createdAt,
});

const toCancellation = (row: Prisma.MarketplaceCancellationGetPayload<object>): MarketplaceCancellationRecord => ({
  id: row.id,
  bookingId: row.bookingId,
  kind: row.kind,
  initiatorRole: row.initiatorRole,
  reason: row.reason,
  policyKey: row.policyKey,
  policyVersion: row.policyVersion,
  feePaise: row.feePaise,
  fromStatus: row.fromStatus,
  unrefundedPaidPaise: row.unrefundedPaidPaise,
  createdAt: row.createdAt,
});

const CONCURRENT = "This booking was changed by someone else; refresh and retry";

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
    accountId: string | null,
    actorId: string,
    action: string,
    details: Prisma.InputJsonValue,
  ) {
    return tx.auditEvent.create({ data: { accountId, actorId, action, details } });
  }

  private async lockBooking(tx: Prisma.TransactionClient, bookingId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "MarketplaceBooking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    return rows.length > 0 ? tx.marketplaceBooking.findUniqueOrThrow({ where: { id: bookingId } }) : null;
  }

  private recordEvent(
    tx: Prisma.TransactionClient,
    booking: Pick<MarketplaceBookingRecord, "id" | "vendorAccountId">,
    actorId: string,
    actorRole: UserRole,
    kind: string,
    transition: { from?: MarketplaceBookingStatus; to?: MarketplaceBookingStatus; note?: string | null },
    details?: Prisma.InputJsonValue,
  ) {
    return tx.marketplaceBookingEvent.create({
      data: {
        bookingId: booking.id,
        vendorAccountId: booking.vendorAccountId,
        actorId,
        actorRole,
        kind,
        fromStatus: transition.from ?? null,
        toStatus: transition.to ?? null,
        note: transition.note ?? null,
        ...(details ? { details } : {}),
      },
    });
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
    return booking ? this.buildDetail(this.prisma, booking) : null;
  }

  async findBookingForAdmin(bookingId: string): Promise<MarketplaceBookingDetail | null> {
    const booking = await this.prisma.marketplaceBooking.findUnique({ where: { id: bookingId } });
    return booking ? this.buildDetail(this.prisma, booking) : null;
  }

  private async buildDetail(
    db: PrismaClient | Prisma.TransactionClient,
    booking: MarketplaceBookingRecord,
  ): Promise<MarketplaceBookingDetail> {
    const bookingId = booking.id;
    const [events, payments, disputes, settlement, cancellation, refunds, profile, staff] = await Promise.all([
      db.marketplaceBookingEvent.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } }),
      db.marketplacePayment.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } }),
      db.marketplaceDispute.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" }, include: { entries: true } }),
      db.marketplaceSettlement.findUnique({ where: { bookingId } }),
      db.marketplaceCancellation.findUnique({ where: { bookingId } }),
      db.marketplaceRefund.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } }),
      db.marketplaceProfile.findUnique({
        where: { accountId: booking.vendorAccountId },
        select: { businessName: true, contactPhone: true },
      }),
      booking.staffId
        ? db.marketplaceStaff.findFirst({
            where: { id: booking.staffId, accountId: booking.vendorAccountId },
            select: { name: true },
          })
        : null,
    ]);
    return {
      booking,
      events,
      payments: payments.map(toPayment),
      disputes: disputes.map(toDispute),
      settlement: settlement ? toSettlement(settlement) : null,
      cancellation: cancellation ? toCancellation(cancellation) : null,
      refunds: refunds.map(toRefund),
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
      if (payment.idempotencyKey) {
        const replay = await tx.marketplacePayment.findUnique({
          where: { bookingId_idempotencyKey: { bookingId, idempotencyKey: payment.idempotencyKey } },
        });
        if (replay) {
          if (replay.amountPaise !== payment.amountPaise || replay.method !== payment.method) {
            throw new MarketplaceRuleError(409, "This Idempotency-Key was already used for a different payment");
          }
          return { payment: toPayment(replay), created: false };
        }
      }
      const committed = await tx.marketplacePayment.aggregate({
        where: { bookingId, status: { in: ["RECORDED_UNVERIFIED", "VERIFIED"] } },
        _sum: { amountPaise: true },
      });
      assertPaymentRecordable(booking, committed._sum.amountPaise ?? 0, payment.amountPaise);
      const row = await tx.marketplacePayment.create({
        data: { ...payment, bookingId, vendorAccountId, recordedBy: actorId, status: "RECORDED_UNVERIFIED" },
      });
      await this.recordEvent(tx, booking, actorId, "MARKETPLACE_VENDOR", "payment_recorded", {}, {
        paymentId: row.id,
        amountPaise: payment.amountPaise,
        verified: false,
      });
      await this.audit(tx, vendorAccountId, actorId, "marketplace.payment.recorded", {
        bookingId,
        paymentId: row.id,
        amountPaise: payment.amountPaise,
      });
      return { payment: toPayment(row), created: true };
    });
  }

  async openDispute(
    ownerAccountId: string,
    actorId: string,
    bookingId: string,
    input: Parameters<MarketplaceRepository["openDispute"]>[3],
    now: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceBooking.findFirst({ where: { id: bookingId, ownerAccountId } });
      if (!current) return null;
      const plan = planTransition(current, "dispute", "OWNER", { reason: input.reason }, now);
      const moved = await tx.marketplaceBooking.updateMany({
        where: { id: current.id, status: BOOKING_TRANSITIONS.dispute.from },
        data: { ...plan.patch, status: plan.to },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      const dispute = await tx.marketplaceDispute.create({
        data: {
          bookingId: current.id,
          vendorAccountId: current.vendorAccountId,
          ownerAccountId,
          category: input.category,
          reason: plan.note ?? input.reason,
          description: input.description,
          evidenceUrls: input.evidenceUrls,
          openedBy: actorId,
        },
      });
      await tx.marketplaceDisputeEntry.create({
        data: {
          disputeId: dispute.id,
          bookingId: current.id,
          kind: "OPENED",
          actorId,
          actorRole: "OWNER",
          message: input.description ?? input.reason,
          evidenceUrls: input.evidenceUrls,
        },
      });
      await this.recordEvent(tx, current, actorId, "OWNER", "dispute", { from: current.status, to: plan.to, note: plan.note }, {
        disputeId: dispute.id,
        category: input.category,
      });
      await this.audit(tx, ownerAccountId, actorId, "marketplace.dispute.opened", {
        bookingId: current.id,
        disputeId: dispute.id,
      });
      return tx.marketplaceBooking.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  async respondDispute(
    vendorAccountId: string,
    actorId: string,
    bookingId: string,
    input: { message: string; evidenceUrls: string[] },
    now: Date,
  ) {
    void now;
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.marketplaceBooking.findFirst({ where: { id: bookingId, vendorAccountId } });
      if (!booking) return null;
      const dispute = await tx.marketplaceDispute.findFirst({
        where: { bookingId, status: { in: ["OPEN", "RESPONDED"] } },
        orderBy: { createdAt: "desc" },
        include: { entries: true },
      });
      if (!dispute || booking.status !== "DISPUTED") throw new MarketplaceRuleError(409, "There is no open dispute to respond to");
      assertDisputeRespondable(dispute);
      const moved = await tx.marketplaceDispute.updateMany({
        where: { id: dispute.id, status: "OPEN" },
        data: { status: "RESPONDED" },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      await tx.marketplaceDisputeEntry.create({
        data: {
          disputeId: dispute.id,
          bookingId,
          kind: "VENDOR_RESPONSE",
          actorId,
          actorRole: "MARKETPLACE_VENDOR",
          message: input.message,
          evidenceUrls: input.evidenceUrls,
        },
      });
      await this.recordEvent(tx, booking, actorId, "MARKETPLACE_VENDOR", "dispute_response", {}, { disputeId: dispute.id });
      await this.audit(tx, vendorAccountId, actorId, "marketplace.dispute.responded", { bookingId, disputeId: dispute.id });
      return toDispute(await tx.marketplaceDispute.findUniqueOrThrow({ where: { id: dispute.id }, include: { entries: true } }));
    });
  }

  async cancelBooking(
    scope: BookingScope,
    actorId: string,
    bookingId: string,
    input: { reason: string; noShow: boolean },
    policy: Parameters<MarketplaceRepository["cancelBooking"]>[4],
    now: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.marketplaceBooking.findFirst({ where: scopeWhere(scope, bookingId) });
      if (!owned) return null;
      const current = (await this.lockBooking(tx, bookingId)) ?? owned;
      const committed = await tx.marketplacePayment.aggregate({
        where: { bookingId, status: { in: ["RECORDED_UNVERIFIED", "VERIFIED"] } },
        _sum: { amountPaise: true },
      });
      const plan = planCancellation(current, scope.role, input, policy, now, committed._sum.amountPaise ?? 0);
      const moved = await tx.marketplaceBooking.updateMany({
        where: { id: current.id, status: current.status },
        data: { status: plan.to },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      await tx.marketplaceCancellation.create({
        data: {
          bookingId: current.id,
          vendorAccountId: current.vendorAccountId,
          kind: plan.kind,
          initiatorId: actorId,
          initiatorRole: actorRoleOf(scope),
          reason: plan.reason,
          policyKey: plan.policyKey,
          policyVersion: plan.policyVersion,
          feePaise: 0,
          fromStatus: plan.fromStatus,
          unrefundedPaidPaise: plan.unrefundedPaidPaise,
        },
      });
      await this.recordEvent(tx, current, actorId, actorRoleOf(scope), input.noShow ? "no_show" : "cancel", {
        from: current.status,
        to: plan.to,
        note: plan.reason,
      }, { kind: plan.kind, policyKey: plan.policyKey, policyVersion: plan.policyVersion, feePaise: 0 });
      await this.audit(tx, scope.accountId, actorId, "marketplace.booking.cancelled", {
        bookingId: current.id,
        kind: plan.kind,
        policyKey: plan.policyKey,
      });
      return tx.marketplaceBooking.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  async listDisputes(status?: MarketplaceDisputeStatus) {
    const rows = await this.prisma.marketplaceDispute.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "asc" },
      include: { entries: true },
      take: 200,
    });
    return rows.map(toDispute);
  }

  async resolveDispute(
    actorId: string,
    disputeId: string,
    input: { outcome: Parameters<typeof planDisputeResolution>[2]; rationale: string },
    now: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.marketplaceDispute.findUnique({ where: { id: disputeId } });
      if (!found) return null;
      const booking = await this.lockBooking(tx, found.bookingId);
      if (!booking) return null;
      const dispute = await tx.marketplaceDispute.findUniqueOrThrow({ where: { id: disputeId } });
      const to = planDisputeResolution(booking, dispute, input.outcome);
      const resolved = await tx.marketplaceDispute.updateMany({
        where: { id: disputeId, status: { in: ["OPEN", "RESPONDED"] } },
        data: {
          status: "RESOLVED",
          outcome: input.outcome,
          resolutionRationale: input.rationale,
          resolvedBy: actorId,
          resolvedAt: now,
        },
      });
      if (resolved.count !== 1) throw new MarketplaceRuleError(409, "This dispute is already resolved");
      const moved = await tx.marketplaceBooking.updateMany({
        where: { id: booking.id, status: "DISPUTED" },
        data: { status: to },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      await tx.marketplaceDisputeEntry.create({
        data: {
          disputeId,
          bookingId: booking.id,
          kind: "RESOLVED",
          actorId,
          actorRole: "SUPERADMIN",
          message: input.rationale,
          evidenceUrls: [],
        },
      });
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", "dispute_resolved", {
        from: "DISPUTED",
        to,
        note: input.rationale,
      }, { disputeId, outcome: input.outcome });
      await this.audit(tx, null, actorId, "marketplace.dispute.resolved", {
        bookingId: booking.id,
        disputeId,
        outcome: input.outcome,
      });
      return {
        booking: await tx.marketplaceBooking.findUniqueOrThrow({ where: { id: booking.id } }),
        dispute: toDispute(await tx.marketplaceDispute.findUniqueOrThrow({ where: { id: disputeId }, include: { entries: true } })),
      };
    });
  }

  private async reviewPayment(
    actorId: string,
    paymentId: string,
    data: Prisma.MarketplacePaymentUpdateManyMutationInput,
    kind: string,
    now: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.marketplacePayment.findUnique({ where: { id: paymentId } });
      if (!found) return null;
      const booking = await this.lockBooking(tx, found.bookingId);
      if (!booking) return null;
      assertPaymentReviewable(await tx.marketplacePayment.findUniqueOrThrow({ where: { id: paymentId } }));
      // Compare-and-set prevents duplicate or conflicting reviews.
      const moved = await tx.marketplacePayment.updateMany({
        where: { id: paymentId, status: "RECORDED_UNVERIFIED" },
        data,
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, "This payment has already been reviewed");
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", kind, {}, { paymentId, amountPaise: found.amountPaise });
      await this.audit(tx, null, actorId, `marketplace.${kind}`, { bookingId: booking.id, paymentId, at: now.toISOString() });
      return toPayment(await tx.marketplacePayment.findUniqueOrThrow({ where: { id: paymentId } }));
    });
  }

  verifyPayment(actorId: string, paymentId: string, input: { evidenceReference: string; note: string | null }, now: Date) {
    return this.reviewPayment(
      actorId,
      paymentId,
      {
        status: "VERIFIED",
        verifiedAt: now,
        verifiedBy: actorId,
        verificationSource: "PLATFORM_RECONCILIATION",
        verificationEvidence: { reference: input.evidenceReference, note: input.note },
      },
      "payment_verified",
      now,
    );
  }

  rejectPayment(actorId: string, paymentId: string, reason: string, now: Date) {
    return this.reviewPayment(
      actorId,
      paymentId,
      { status: "FAILED", failedAt: now, failedBy: actorId, failureReason: reason },
      "payment_failed",
      now,
    );
  }

  async approveRefund(actorId: string, paymentId: string, reason: string, now: Date) {
    void now;
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.marketplacePayment.findUnique({ where: { id: paymentId } });
      if (!found) return null;
      const booking = await this.lockBooking(tx, found.bookingId);
      if (!booking) return null;
      const payment = await tx.marketplacePayment.findUniqueOrThrow({ where: { id: paymentId } });
      const existing = await tx.marketplaceRefund.findUnique({ where: { paymentId } });
      assertRefundable(booking, payment, existing !== null);
      const row = await tx.marketplaceRefund.create({
        data: { paymentId, bookingId: booking.id, amountPaise: payment.amountPaise, reason, approvedBy: actorId },
      });
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", "refund_approved", { note: reason }, {
        refundId: row.id,
        paymentId,
        amountPaise: row.amountPaise,
        externalTransferRequired: true,
      });
      await this.audit(tx, null, actorId, "marketplace.refund.approved", { bookingId: booking.id, paymentId, refundId: row.id });
      return toRefund(row);
    });
  }

  async confirmRefund(actorId: string, refundId: string, evidenceReference: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.marketplaceRefund.findUnique({ where: { id: refundId } });
      if (!found) return null;
      const booking = await this.lockBooking(tx, found.bookingId);
      if (!booking) return null;
      const moved = await tx.marketplaceRefund.updateMany({
        where: { id: refundId, status: "APPROVED_PENDING_EXTERNAL_TRANSFER" },
        data: { status: "CONFIRMED_EXTERNALLY", confirmedAt: now, confirmedBy: actorId, evidenceReference },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, "This refund has already been confirmed");
      const payment = await tx.marketplacePayment.updateMany({
        where: { id: found.paymentId, status: "VERIFIED" },
        data: { status: "REFUNDED" },
      });
      if (payment.count !== 1) throw new MarketplaceRuleError(409, "The refunded payment is not in a refundable state");
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", "refund_confirmed", {}, {
        refundId,
        paymentId: found.paymentId,
        recordedOnly: true,
      });
      await this.audit(tx, null, actorId, "marketplace.refund.confirmed", { bookingId: booking.id, refundId });
      return toRefund(await tx.marketplaceRefund.findUniqueOrThrow({ where: { id: refundId } }));
    });
  }

  async settleBooking(actorId: string, bookingId: string, note: string | null, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await this.lockBooking(tx, bookingId);
      if (!booking) return null;
      const existing = await tx.marketplaceSettlement.findUnique({ where: { bookingId } });
      if (existing) {
        return { booking, settlement: toSettlement(existing), created: false };
      }
      const [openDisputes, verified] = await Promise.all([
        tx.marketplaceDispute.count({ where: { bookingId, status: { in: ["OPEN", "RESPONDED"] } } }),
        tx.marketplacePayment.aggregate({ where: { bookingId, status: "VERIFIED" }, _sum: { amountPaise: true } }),
      ]);
      const verifiedPaidPaise = verified._sum.amountPaise ?? 0;
      const plan = planTransition(booking, "settle", "PLATFORM_ADMIN", {}, now, {
        verifiedPaidPaise,
        openDispute: openDisputes > 0,
      });
      const moved = await tx.marketplaceBooking.updateMany({
        where: { id: bookingId, status: BOOKING_TRANSITIONS.settle.from },
        data: { ...plan.patch, status: plan.to },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      const settlement = await tx.marketplaceSettlement.create({
        data: {
          bookingId,
          vendorAccountId: booking.vendorAccountId,
          agreedPricePaise: booking.servicePricePaise,
          verifiedPaidPaise,
          settledBy: actorId,
          note,
        },
      });
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", "settle", { from: booking.status, to: plan.to, note }, {
        settlementId: settlement.id,
        internalRecordOnly: true,
      });
      await this.audit(tx, null, actorId, "marketplace.booking.settled", { bookingId, settlementId: settlement.id });
      return {
        booking: await tx.marketplaceBooking.findUniqueOrThrow({ where: { id: bookingId } }),
        settlement: toSettlement(settlement),
        created: true,
      };
    });
  }

  async closeBooking(actorId: string, bookingId: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await this.lockBooking(tx, bookingId);
      if (!booking) return null;
      if (booking.status === "CLOSED") return booking;
      const openDisputes = await tx.marketplaceDispute.count({
        where: { bookingId, status: { in: ["OPEN", "RESPONDED"] } },
      });
      const plan = planTransition(booking, "close", "PLATFORM_ADMIN", {}, now, { openDispute: openDisputes > 0 });
      const moved = await tx.marketplaceBooking.updateMany({
        where: { id: bookingId, status: BOOKING_TRANSITIONS.close.from },
        data: { ...plan.patch, status: plan.to },
      });
      if (moved.count !== 1) throw new MarketplaceRuleError(409, CONCURRENT);
      await this.recordEvent(tx, booking, actorId, "SUPERADMIN", "close", { from: booking.status, to: plan.to });
      await this.audit(tx, null, actorId, "marketplace.booking.closed", { bookingId });
      return tx.marketplaceBooking.findUniqueOrThrow({ where: { id: bookingId } });
    });
  }
}
