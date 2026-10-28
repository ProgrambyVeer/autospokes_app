import { randomUUID } from "node:crypto";
import type { MarketplaceBookingStatus, MarketplaceServiceStatus } from "@autospokes/shared";
import type {
  BookingAction,
  BookingScope,
  DiscoveryCandidate,
  MarketplaceBookingDetail,
  MarketplaceBookingEventRecord,
  MarketplaceBookingRecord,
  MarketplacePaymentRecord,
  MarketplaceProfileRecord,
  MarketplaceRepository,
  MarketplaceServiceRecord,
  MarketplaceStaffRecord,
  NewMarketplaceBooking,
  TransitionPayload,
} from "../../src/marketplace/repository.js";
import {
  MarketplaceRuleError,
  assertPaymentRecordable,
  assertStaffAssignable,
  planTransition,
} from "../../src/marketplace/rules.js";

export class MemoryMarketplaceRepository implements MarketplaceRepository {
  profiles = new Map<string, MarketplaceProfileRecord>();
  services = new Map<string, MarketplaceServiceRecord>();
  staff = new Map<string, MarketplaceStaffRecord>();
  bookings = new Map<string, MarketplaceBookingRecord>();
  events: (MarketplaceBookingEventRecord & { vendorAccountId: string })[] = [];
  payments: (MarketplacePaymentRecord & { vendorAccountId: string })[] = [];
  audits: { accountId: string; action: string }[] = [];

  async findProfile(accountId: string) {
    return this.profiles.get(accountId) ?? null;
  }

  async saveProfile(accountId: string, _actorId: string, input: Parameters<MarketplaceRepository["saveProfile"]>[2]) {
    const existing = this.profiles.get(accountId);
    const now = new Date();
    const profile: MarketplaceProfileRecord = {
      ...input,
      id: existing?.id ?? randomUUID(),
      accountId,
      // Verification is never set from client input.
      verificationStatus: existing?.verificationStatus ?? "PENDING",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.profiles.set(accountId, profile);
    this.audits.push({ accountId, action: "marketplace.profile.saved" });
    return profile;
  }

  async listServices(accountId: string) {
    return [...this.services.values()].filter((service) => service.accountId === accountId);
  }

  async findService(accountId: string, serviceId: string) {
    const service = this.services.get(serviceId);
    return service && service.accountId === accountId ? service : null;
  }

  async createService(accountId: string, _actorId: string, input: Parameters<MarketplaceRepository["createService"]>[2]) {
    const now = new Date();
    const service: MarketplaceServiceRecord = {
      id: randomUUID(),
      accountId,
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      vehicleTypes: input.vehicleTypes,
      pricePaise: input.pricePaise,
      durationMinutes: input.durationMinutes,
      status: input.status,
      inclusions: input.inclusions,
      exclusions: input.exclusions,
      terms: input.terms ?? null,
      serviceAreas: input.serviceAreas,
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.services.set(service.id, service);
    return service;
  }

  async updateService(
    accountId: string,
    _actorId: string,
    serviceId: string,
    patch: Parameters<MarketplaceRepository["updateService"]>[3],
  ) {
    const service = await this.findService(accountId, serviceId);
    if (!service || service.status === "ARCHIVED") return null;
    const next = { ...service, ...patch, version: service.version + 1, updatedAt: new Date() } as MarketplaceServiceRecord;
    this.services.set(serviceId, next);
    return next;
  }

  async setServiceStatus(accountId: string, _actorId: string, serviceId: string, status: MarketplaceServiceStatus) {
    const service = await this.findService(accountId, serviceId);
    if (!service || service.status === "ARCHIVED") return null;
    const next = { ...service, status, archivedAt: status === "ARCHIVED" ? new Date() : null, updatedAt: new Date() };
    this.services.set(serviceId, next);
    return next;
  }

  async listStaff(accountId: string) {
    return [...this.staff.values()]
      .filter((member) => member.accountId === accountId)
      .map((member) => ({
        ...member,
        openBookings: [...this.bookings.values()].filter(
          (booking) =>
            booking.staffId === member.id && (booking.status === "ACCEPTED" || booking.status === "IN_PROGRESS"),
        ).length,
      }));
  }

  async createStaff(accountId: string, _actorId: string, input: Parameters<MarketplaceRepository["createStaff"]>[2]) {
    const now = new Date();
    const member: MarketplaceStaffRecord = { id: randomUUID(), accountId, active: true, createdAt: now, updatedAt: now, ...input };
    this.staff.set(member.id, member);
    return member;
  }

  async updateStaff(
    accountId: string,
    _actorId: string,
    staffId: string,
    patch: Parameters<MarketplaceRepository["updateStaff"]>[3],
  ) {
    const member = this.staff.get(staffId);
    if (!member || member.accountId !== accountId) return null;
    const next = { ...member, ...patch, updatedAt: new Date() };
    this.staff.set(staffId, next);
    return next;
  }

  async listActiveCandidates(): Promise<DiscoveryCandidate[]> {
    return [...this.services.values()].flatMap((service) => {
      const profile = this.profiles.get(service.accountId);
      return service.status === "ACTIVE" && profile ? [{ service, profile }] : [];
    });
  }

  async findServiceForBooking(serviceId: string): Promise<DiscoveryCandidate | null> {
    const service = this.services.get(serviceId);
    const profile = service ? this.profiles.get(service.accountId) : undefined;
    return service && profile ? { service, profile } : null;
  }

  async findBookingByIdempotencyKey(ownerAccountId: string, key: string) {
    return (
      [...this.bookings.values()].find(
        (booking) => booking.ownerAccountId === ownerAccountId && booking.idempotencyKey === key,
      ) ?? null
    );
  }

  async createBooking(input: NewMarketplaceBooking) {
    const existing = await this.findBookingByIdempotencyKey(input.ownerAccountId, input.idempotencyKey);
    if (existing) return { booking: existing, created: false };
    const now = new Date();
    const booking: MarketplaceBookingRecord = {
      id: randomUUID(),
      ownerAccountId: input.ownerAccountId,
      vendorAccountId: input.vendorAccountId,
      vehicleId: input.vehicleId,
      serviceId: input.serviceId,
      staffId: null,
      idempotencyKey: input.idempotencyKey,
      status: "REQUESTED",
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      serviceLocation: input.serviceLocation,
      accessNotes: input.accessNotes,
      rejectionReason: null,
      completionNotes: null,
      completionEvidenceUrls: [],
      disputeReason: null,
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      startedAt: null,
      completionReportedAt: null,
      customerRespondedAt: null,
      settledAt: null,
      closedAt: null,
      ...input.snapshot,
    };
    this.bookings.set(booking.id, booking);
    this.pushEvent(booking, "OWNER", "requested", null, "REQUESTED", null);
    return { booking, created: true };
  }

  private inScope(booking: MarketplaceBookingRecord, scope: BookingScope) {
    return scope.role === "VENDOR" ? booking.vendorAccountId === scope.accountId : booking.ownerAccountId === scope.accountId;
  }

  private pushEvent(
    booking: MarketplaceBookingRecord,
    actorRole: string,
    kind: string,
    fromStatus: MarketplaceBookingStatus | null,
    toStatus: MarketplaceBookingStatus | null,
    note: string | null,
  ) {
    this.events.push({
      id: randomUUID(),
      bookingId: booking.id,
      vendorAccountId: booking.vendorAccountId,
      kind,
      fromStatus,
      toStatus,
      note,
      actorRole,
      createdAt: new Date(),
    });
  }

  async listBookings(scope: BookingScope, statuses?: MarketplaceBookingStatus[]) {
    return [...this.bookings.values()]
      .filter((booking) => this.inScope(booking, scope) && (!statuses || statuses.includes(booking.status)))
      .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
  }

  async findBooking(scope: BookingScope, bookingId: string): Promise<MarketplaceBookingDetail | null> {
    const booking = this.bookings.get(bookingId);
    if (!booking || !this.inScope(booking, scope)) return null;
    const profile = this.profiles.get(booking.vendorAccountId);
    return {
      booking,
      events: this.events.filter((event) => event.bookingId === bookingId),
      payments: this.payments.filter((payment) => payment.bookingId === bookingId),
      vendorBusinessName: profile?.businessName ?? null,
      vendorContactPhone: profile?.contactPhone ?? null,
      staffName: booking.staffId ? this.staff.get(booking.staffId)?.name ?? null : null,
    };
  }

  async transitionBooking(
    scope: BookingScope,
    _actorId: string,
    bookingId: string,
    action: BookingAction,
    payload: TransitionPayload,
    now: Date,
  ) {
    const current = this.bookings.get(bookingId);
    if (!current || !this.inScope(current, scope)) return null;
    const plan = planTransition(current, action, scope.role, payload, now);
    const next = { ...current, ...plan.patch, status: plan.to, updatedAt: now };
    this.bookings.set(bookingId, next);
    this.pushEvent(next, scope.role, action, current.status, plan.to, plan.note);
    this.audits.push({ accountId: scope.accountId, action: `marketplace.booking.${action}` });
    return next;
  }

  async assignStaff(
    vendorAccountId: string,
    _actorId: string,
    bookingId: string,
    staffId: string | null,
    note: string | null,
    now: Date,
  ) {
    const current = this.bookings.get(bookingId);
    if (!current || current.vendorAccountId !== vendorAccountId) return null;
    assertStaffAssignable(current.status);
    if (staffId) {
      const member = this.staff.get(staffId);
      if (!member || member.accountId !== vendorAccountId) throw new MarketplaceRuleError(404, "Staff member not found");
      if (!member.active || !member.available) {
        throw new MarketplaceRuleError(409, "That staff member is not available for assignment");
      }
    }
    const next = { ...current, staffId, updatedAt: now };
    this.bookings.set(bookingId, next);
    this.pushEvent(
      next,
      "VENDOR",
      staffId ? (current.staffId ? "staff_reassigned" : "staff_assigned") : "staff_unassigned",
      null,
      null,
      note,
    );
    this.audits.push({ accountId: vendorAccountId, action: "marketplace.booking.staff" });
    return next;
  }

  async recordPayment(
    vendorAccountId: string,
    _actorId: string,
    bookingId: string,
    payment: Parameters<MarketplaceRepository["recordPayment"]>[3],
  ) {
    const booking = this.bookings.get(bookingId);
    if (!booking || booking.vendorAccountId !== vendorAccountId) return null;
    const existing = this.payments
      .filter((entry) => entry.bookingId === bookingId)
      .reduce((sum, entry) => sum + entry.amountPaise, 0);
    assertPaymentRecordable(booking, existing, payment.amountPaise);
    const record = {
      id: randomUUID(),
      bookingId,
      vendorAccountId,
      status: "RECORDED_UNVERIFIED" as const,
      createdAt: new Date(),
      ...payment,
    };
    this.payments.push(record);
    this.audits.push({ accountId: vendorAccountId, action: "marketplace.payment.recorded" });
    return record;
  }
}
