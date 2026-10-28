import { randomUUID } from "node:crypto";
import type {
  MarketplaceBookingStatus,
  MarketplaceDisputeOutcome,
  MarketplaceDisputeStatus,
  MarketplaceServiceStatus,
} from "@autospokes/shared";
import type {
  BookingAction,
  BookingScope,
  DiscoveryCandidate,
  MarketplaceBookingDetail,
  MarketplaceBookingEventRecord,
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
} from "../../src/marketplace/repository.js";
import {
  MarketplaceRuleError,
  assertDisputeRespondable,
  assertPaymentRecordable,
  assertPaymentReviewable,
  assertRefundable,
  assertStaffAssignable,
  planCancellation,
  planDisputeResolution,
  planTransition,
} from "../../src/marketplace/rules.js";

export class MemoryMarketplaceRepository implements MarketplaceRepository {
  profiles = new Map<string, MarketplaceProfileRecord>();
  services = new Map<string, MarketplaceServiceRecord>();
  staff = new Map<string, MarketplaceStaffRecord>();
  bookings = new Map<string, MarketplaceBookingRecord>();
  events: (MarketplaceBookingEventRecord & { vendorAccountId: string })[] = [];
  payments: (MarketplacePaymentRecord & { vendorAccountId: string; idempotencyKey: string | null })[] = [];
  disputes: MarketplaceDisputeRecord[] = [];
  settlements = new Map<string, MarketplaceSettlementRecord>();
  cancellations = new Map<string, MarketplaceCancellationRecord>();
  refunds: MarketplaceRefundRecord[] = [];
  audits: { accountId: string | null; action: string }[] = [];

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
    return this.detail(booking);
  }

  async findBookingForAdmin(bookingId: string) {
    const booking = this.bookings.get(bookingId);
    return booking ? this.detail(booking) : null;
  }

  private detail(booking: MarketplaceBookingRecord): MarketplaceBookingDetail {
    const bookingId = booking.id;
    const profile = this.profiles.get(booking.vendorAccountId);
    return {
      booking,
      events: this.events.filter((event) => event.bookingId === bookingId),
      payments: this.payments.filter((payment) => payment.bookingId === bookingId),
      disputes: this.disputes.filter((dispute) => dispute.bookingId === bookingId),
      settlement: this.settlements.get(bookingId) ?? null,
      cancellation: this.cancellations.get(bookingId) ?? null,
      refunds: this.refunds.filter((refund) => refund.bookingId === bookingId),
      vendorBusinessName: profile?.businessName ?? null,
      vendorContactPhone: profile?.contactPhone ?? null,
      staffName: booking.staffId ? this.staff.get(booking.staffId)?.name ?? null : null,
    };
  }

  private setBooking(booking: MarketplaceBookingRecord, patch: Partial<MarketplaceBookingRecord>) {
    const next = { ...booking, ...patch, updatedAt: new Date() };
    this.bookings.set(booking.id, next);
    return next;
  }

  private committedPaise(bookingId: string) {
    return this.payments
      .filter((p) => p.bookingId === bookingId && (p.status === "RECORDED_UNVERIFIED" || p.status === "VERIFIED"))
      .reduce((sum, p) => sum + p.amountPaise, 0);
  }

  private hasOpenDispute(bookingId: string) {
    return this.disputes.some((d) => d.bookingId === bookingId && d.status !== "RESOLVED");
  }

  async openDispute(
    ownerAccountId: string,
    actorId: string,
    bookingId: string,
    input: Parameters<MarketplaceRepository["openDispute"]>[3],
    now: Date,
  ) {
    const current = this.bookings.get(bookingId);
    if (!current || current.ownerAccountId !== ownerAccountId) return null;
    const plan = planTransition(current, "dispute", "OWNER", { reason: input.reason }, now);
    const next = this.setBooking(current, { ...plan.patch, status: plan.to });
    const id = randomUUID();
    this.disputes.push({
      id,
      bookingId,
      ownerAccountId,
      vendorAccountId: current.vendorAccountId,
      status: "OPEN",
      category: input.category,
      reason: input.reason,
      description: input.description,
      evidenceUrls: input.evidenceUrls,
      outcome: null,
      resolutionRationale: null,
      resolvedAt: null,
      createdAt: now,
      entries: [
        {
          id: randomUUID(),
          disputeId: id,
          kind: "OPENED",
          actorRole: "OWNER",
          message: input.description ?? input.reason,
          evidenceUrls: input.evidenceUrls,
          createdAt: now,
        },
      ],
    });
    this.pushEvent(next, "OWNER", "dispute", current.status, plan.to, plan.note);
    this.audits.push({ accountId: ownerAccountId, action: "marketplace.dispute.opened" });
    void actorId;
    return next;
  }

  async respondDispute(
    vendorAccountId: string,
    _actorId: string,
    bookingId: string,
    input: { message: string; evidenceUrls: string[] },
    now: Date,
  ) {
    const booking = this.bookings.get(bookingId);
    if (!booking || booking.vendorAccountId !== vendorAccountId) return null;
    const dispute = this.disputes.find((d) => d.bookingId === bookingId && d.status !== "RESOLVED");
    if (!dispute || booking.status !== "DISPUTED") throw new MarketplaceRuleError(409, "There is no open dispute to respond to");
    assertDisputeRespondable(dispute);
    dispute.status = "RESPONDED";
    dispute.entries.push({
      id: randomUUID(),
      disputeId: dispute.id,
      kind: "VENDOR_RESPONSE",
      actorRole: "MARKETPLACE_VENDOR",
      message: input.message,
      evidenceUrls: input.evidenceUrls,
      createdAt: now,
    });
    this.pushEvent(booking, "MARKETPLACE_VENDOR", "dispute_response", null, null, null);
    this.audits.push({ accountId: vendorAccountId, action: "marketplace.dispute.responded" });
    return dispute;
  }

  async cancelBooking(
    scope: BookingScope,
    _actorId: string,
    bookingId: string,
    input: { reason: string; noShow: boolean },
    policy: Parameters<MarketplaceRepository["cancelBooking"]>[4],
    now: Date,
  ) {
    const current = this.bookings.get(bookingId);
    if (!current || !this.inScope(current, scope)) return null;
    const plan = planCancellation(current, scope.role, input, policy, now, this.committedPaise(bookingId));
    const next = this.setBooking(current, { status: plan.to });
    this.cancellations.set(bookingId, {
      id: randomUUID(),
      bookingId,
      kind: plan.kind,
      initiatorRole: scope.role === "OWNER" ? "OWNER" : "MARKETPLACE_VENDOR",
      reason: plan.reason,
      policyKey: plan.policyKey,
      policyVersion: plan.policyVersion,
      feePaise: 0,
      fromStatus: plan.fromStatus,
      unrefundedPaidPaise: plan.unrefundedPaidPaise,
      createdAt: now,
    });
    this.pushEvent(next, scope.role === "OWNER" ? "OWNER" : "MARKETPLACE_VENDOR", input.noShow ? "no_show" : "cancel", current.status, plan.to, plan.reason);
    this.audits.push({ accountId: scope.accountId, action: "marketplace.booking.cancelled" });
    return next;
  }

  async listDisputes(status?: MarketplaceDisputeStatus) {
    return this.disputes.filter((d) => !status || d.status === status);
  }

  async resolveDispute(
    _actorId: string,
    disputeId: string,
    input: { outcome: MarketplaceDisputeOutcome; rationale: string },
    now: Date,
  ) {
    const dispute = this.disputes.find((d) => d.id === disputeId);
    if (!dispute) return null;
    const booking = this.bookings.get(dispute.bookingId);
    if (!booking) return null;
    const to = planDisputeResolution(booking, dispute, input.outcome);
    dispute.status = "RESOLVED";
    dispute.outcome = input.outcome;
    dispute.resolutionRationale = input.rationale;
    dispute.resolvedAt = now;
    dispute.entries.push({
      id: randomUUID(),
      disputeId,
      kind: "RESOLVED",
      actorRole: "SUPERADMIN",
      message: input.rationale,
      evidenceUrls: [],
      createdAt: now,
    });
    const next = this.setBooking(booking, { status: to });
    this.pushEvent(next, "SUPERADMIN", "dispute_resolved", "DISPUTED", to, input.rationale);
    this.audits.push({ accountId: null, action: "marketplace.dispute.resolved" });
    return { booking: next, dispute };
  }

  private reviewPayment(paymentId: string, patch: Partial<MarketplacePaymentRecord>, kind: string) {
    const payment = this.payments.find((p) => p.id === paymentId);
    if (!payment) return null;
    assertPaymentReviewable(payment);
    Object.assign(payment, patch);
    const booking = this.bookings.get(payment.bookingId);
    if (booking) this.pushEvent(booking, "SUPERADMIN", kind, null, null, null);
    this.audits.push({ accountId: null, action: `marketplace.${kind}` });
    return payment;
  }

  async verifyPayment(_actorId: string, paymentId: string, input: { evidenceReference: string; note: string | null }, now: Date) {
    return this.reviewPayment(
      paymentId,
      {
        status: "VERIFIED",
        verifiedAt: now,
        verificationSource: "PLATFORM_RECONCILIATION",
        verificationEvidence: { reference: input.evidenceReference, note: input.note },
      },
      "payment_verified",
    );
  }

  async rejectPayment(_actorId: string, paymentId: string, reason: string, now: Date) {
    return this.reviewPayment(paymentId, { status: "FAILED", failedAt: now, failureReason: reason }, "payment_failed");
  }

  async approveRefund(_actorId: string, paymentId: string, reason: string, now: Date) {
    const payment = this.payments.find((p) => p.id === paymentId);
    if (!payment) return null;
    const booking = this.bookings.get(payment.bookingId);
    if (!booking) return null;
    assertRefundable(booking, payment, this.refunds.some((r) => r.paymentId === paymentId));
    const refund: MarketplaceRefundRecord = {
      id: randomUUID(),
      paymentId,
      bookingId: booking.id,
      amountPaise: payment.amountPaise,
      status: "APPROVED_PENDING_EXTERNAL_TRANSFER",
      reason,
      confirmedAt: null,
      evidenceReference: null,
      createdAt: now,
    };
    this.refunds.push(refund);
    this.pushEvent(booking, "SUPERADMIN", "refund_approved", null, null, reason);
    this.audits.push({ accountId: null, action: "marketplace.refund.approved" });
    return refund;
  }

  async confirmRefund(_actorId: string, refundId: string, evidenceReference: string, now: Date) {
    const refund = this.refunds.find((r) => r.id === refundId);
    if (!refund) return null;
    if (refund.status !== "APPROVED_PENDING_EXTERNAL_TRANSFER") {
      throw new MarketplaceRuleError(409, "This refund has already been confirmed");
    }
    const payment = this.payments.find((p) => p.id === refund.paymentId);
    if (!payment || payment.status !== "VERIFIED") {
      throw new MarketplaceRuleError(409, "The refunded payment is not in a refundable state");
    }
    refund.status = "CONFIRMED_EXTERNALLY";
    refund.confirmedAt = now;
    refund.evidenceReference = evidenceReference;
    payment.status = "REFUNDED";
    const booking = this.bookings.get(refund.bookingId);
    if (booking) this.pushEvent(booking, "SUPERADMIN", "refund_confirmed", null, null, null);
    this.audits.push({ accountId: null, action: "marketplace.refund.confirmed" });
    return refund;
  }

  async settleBooking(_actorId: string, bookingId: string, note: string | null, now: Date) {
    const booking = this.bookings.get(bookingId);
    if (!booking) return null;
    const existing = this.settlements.get(bookingId);
    if (existing) return { booking, settlement: existing, created: false };
    const verifiedPaidPaise = this.payments
      .filter((p) => p.bookingId === bookingId && p.status === "VERIFIED")
      .reduce((sum, p) => sum + p.amountPaise, 0);
    const plan = planTransition(booking, "settle", "PLATFORM_ADMIN", {}, now, {
      verifiedPaidPaise,
      openDispute: this.hasOpenDispute(bookingId),
    });
    const next = this.setBooking(booking, { ...plan.patch, status: plan.to });
    const settlement: MarketplaceSettlementRecord = {
      id: randomUUID(),
      bookingId,
      agreedPricePaise: booking.servicePricePaise,
      verifiedPaidPaise,
      note,
      externalTransfer: false,
      createdAt: now,
    };
    this.settlements.set(bookingId, settlement);
    this.pushEvent(next, "SUPERADMIN", "settle", booking.status, plan.to, note);
    this.audits.push({ accountId: null, action: "marketplace.booking.settled" });
    return { booking: next, settlement, created: true };
  }

  async closeBooking(_actorId: string, bookingId: string, now: Date) {
    const booking = this.bookings.get(bookingId);
    if (!booking) return null;
    if (booking.status === "CLOSED") return booking;
    const plan = planTransition(booking, "close", "PLATFORM_ADMIN", {}, now, {
      openDispute: this.hasOpenDispute(bookingId),
    });
    const next = this.setBooking(booking, { ...plan.patch, status: plan.to });
    this.pushEvent(next, "SUPERADMIN", "close", booking.status, plan.to, null);
    this.audits.push({ accountId: null, action: "marketplace.booking.closed" });
    return next;
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
    if (payment.idempotencyKey) {
      const replay = this.payments.find((p) => p.bookingId === bookingId && p.idempotencyKey === payment.idempotencyKey);
      if (replay) {
        if (replay.amountPaise !== payment.amountPaise || replay.method !== payment.method) {
          throw new MarketplaceRuleError(409, "This Idempotency-Key was already used for a different payment");
        }
        return { payment: replay, created: false };
      }
    }
    assertPaymentRecordable(booking, this.committedPaise(bookingId), payment.amountPaise);
    const { idempotencyKey, ...fields } = payment;
    const record = {
      id: randomUUID(),
      bookingId,
      vendorAccountId,
      idempotencyKey,
      status: "RECORDED_UNVERIFIED" as const,
      currency: "INR",
      createdAt: new Date(),
      verifiedAt: null,
      verificationSource: null,
      verificationEvidence: null,
      failedAt: null,
      failureReason: null,
      ...fields,
    };
    this.payments.push(record);
    this.audits.push({ accountId: vendorAccountId, action: "marketplace.payment.recorded" });
    return { payment: record, created: true };
  }
}
