import type {
  MarketplaceBookingStatus,
  MarketplaceCancellationKind,
  MarketplaceDiscoveryQuery,
  MarketplaceDisputeOutcome,
  MarketplaceDisputeStatus,
  MarketplacePaymentStatus,
  MarketplaceServiceCategory,
  VehicleType,
} from "@autospokes/shared";
import { MARKETPLACE_DEFAULT_RADIUS_KM } from "@autospokes/shared";
import type {
  BookingAction,
  BookingSnapshot,
  DiscoveryCandidate,
  MarketplaceBookingRecord,
  MarketplacePaymentRecord,
  MarketplaceProfileRecord,
  MarketplaceServiceRecord,
  TransitionPayload,
} from "./repository.js";

export class MarketplaceRuleError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "MarketplaceRuleError";
  }
}

export type ActorKind = "VENDOR" | "OWNER" | "PLATFORM_ADMIN";

type TransitionRule = { from: MarketplaceBookingStatus; to: MarketplaceBookingStatus; actor: ActorKind };

/**
 * REQUESTED -> ACCEPTED -> IN_PROGRESS -> PROVIDER_REPORTED_COMPLETION -> CUSTOMER_ACCEPTED -> SETTLED -> CLOSED
 * Branches: REJECTED (from REQUESTED); DISPUTED (from PROVIDER_REPORTED_COMPLETION) which a Superadmin resolves to
 * CUSTOMER_ACCEPTED, IN_PROGRESS (rework) or CANCELLED; CANCELLED (see planCancellation).
 * Settlement and closure are internal platform records performed only by a Superadmin; no money moves.
 */
export const BOOKING_TRANSITIONS: Record<BookingAction, TransitionRule> = {
  accept: { from: "REQUESTED", to: "ACCEPTED", actor: "VENDOR" },
  reject: { from: "REQUESTED", to: "REJECTED", actor: "VENDOR" },
  start: { from: "ACCEPTED", to: "IN_PROGRESS", actor: "VENDOR" },
  report_completion: { from: "IN_PROGRESS", to: "PROVIDER_REPORTED_COMPLETION", actor: "VENDOR" },
  customer_accept: { from: "PROVIDER_REPORTED_COMPLETION", to: "CUSTOMER_ACCEPTED", actor: "OWNER" },
  dispute: { from: "PROVIDER_REPORTED_COMPLETION", to: "DISPUTED", actor: "OWNER" },
  settle: { from: "CUSTOMER_ACCEPTED", to: "SETTLED", actor: "PLATFORM_ADMIN" },
  close: { from: "SETTLED", to: "CLOSED", actor: "PLATFORM_ADMIN" },
};

export type TransitionContext = { verifiedPaidPaise?: number; openDispute?: boolean };

export type TransitionPlan = {
  to: MarketplaceBookingStatus;
  patch: Partial<MarketplaceBookingRecord>;
  note: string | null;
};

export function planTransition(
  booking: Pick<MarketplaceBookingRecord, "status" | "servicePricePaise">,
  action: BookingAction,
  actor: ActorKind,
  payload: TransitionPayload,
  now: Date,
  context: TransitionContext = {},
): TransitionPlan {
  const rule = BOOKING_TRANSITIONS[action];
  if (rule.actor !== actor) {
    throw new MarketplaceRuleError(403, "This action is not available for your role");
  }
  if (booking.status !== rule.from) {
    throw new MarketplaceRuleError(
      409,
      `This booking is ${booking.status.toLowerCase().replaceAll("_", " ")} and cannot be moved by "${action.replaceAll("_", " ")}"`,
    );
  }
  switch (action) {
    case "accept":
      return { to: rule.to, patch: { acceptedAt: now }, note: null };
    case "reject": {
      const reason = payload.reason?.trim();
      if (!reason) throw new MarketplaceRuleError(400, "A reason is required to reject a request");
      return { to: rule.to, patch: { rejectionReason: reason }, note: reason };
    }
    case "start":
      return { to: rule.to, patch: { startedAt: now }, note: null };
    case "report_completion": {
      const notes = payload.notes?.trim();
      if (!notes) throw new MarketplaceRuleError(400, "Completion notes are required");
      return {
        to: rule.to,
        patch: {
          completionNotes: notes,
          completionEvidenceUrls: payload.evidenceUrls ?? [],
          completionReportedAt: now,
        },
        note: notes,
      };
    }
    case "customer_accept":
      return { to: rule.to, patch: { customerRespondedAt: now }, note: null };
    case "dispute": {
      const reason = payload.reason?.trim();
      if (!reason) throw new MarketplaceRuleError(400, "A reason is required to raise a dispute");
      return { to: rule.to, patch: { disputeReason: reason, customerRespondedAt: now }, note: reason };
    }
    case "settle":
      if (context.openDispute) {
        throw new MarketplaceRuleError(409, "Settlement is blocked while a dispute is unresolved");
      }
      if ((context.verifiedPaidPaise ?? 0) < booking.servicePricePaise) {
        throw new MarketplaceRuleError(409, "Settlement requires verified payment records covering the agreed price");
      }
      return { to: rule.to, patch: { settledAt: now }, note: null };
    case "close":
      if (context.openDispute) {
        throw new MarketplaceRuleError(409, "Closure is blocked while a dispute is unresolved");
      }
      return { to: rule.to, patch: { closedAt: now }, note: null };
  }
}

export const STAFF_ASSIGNABLE_STATUSES: MarketplaceBookingStatus[] = ["ACCEPTED", "IN_PROGRESS"];
export const PAYMENT_RECORDABLE_STATUSES: MarketplaceBookingStatus[] = [
  "ACCEPTED",
  "IN_PROGRESS",
  "PROVIDER_REPORTED_COMPLETION",
  "CUSTOMER_ACCEPTED",
  "DISPUTED",
  "SETTLED",
];

export function assertStaffAssignable(status: MarketplaceBookingStatus): void {
  if (!STAFF_ASSIGNABLE_STATUSES.includes(status)) {
    throw new MarketplaceRuleError(409, "Staff can only be assigned to accepted or in-progress bookings");
  }
}

type PaymentLike = Pick<MarketplacePaymentRecord, "amountPaise" | "status">;

export type PaymentState =
  | "NONE"
  | "RECORDED_UNVERIFIED"
  | "PARTIALLY_VERIFIED"
  | "VERIFIED"
  | "FAILED"
  | "REFUNDED";

export type PaymentSummary = {
  recordedUnverifiedPaise: number;
  verifiedPaise: number;
  failedPaise: number;
  refundedPaise: number;
  committedPaise: number;
  outstandingPaise: number;
  state: PaymentState;
};

/** Failed and refunded payments never count toward the agreed price; unverified ones are not proof of payment. */
export function summarizePayments(payments: PaymentLike[], agreedPricePaise: number): PaymentSummary {
  const sum = (status: MarketplacePaymentStatus) =>
    payments.filter((payment) => payment.status === status).reduce((total, payment) => total + payment.amountPaise, 0);
  const recordedUnverifiedPaise = sum("RECORDED_UNVERIFIED");
  const verifiedPaise = sum("VERIFIED");
  const failedPaise = sum("FAILED");
  const refundedPaise = sum("REFUNDED");
  let state: PaymentState = "NONE";
  if (verifiedPaise >= agreedPricePaise) state = "VERIFIED";
  else if (verifiedPaise > 0) state = "PARTIALLY_VERIFIED";
  else if (recordedUnverifiedPaise > 0) state = "RECORDED_UNVERIFIED";
  else if (refundedPaise > 0) state = "REFUNDED";
  else if (failedPaise > 0) state = "FAILED";
  return {
    recordedUnverifiedPaise,
    verifiedPaise,
    failedPaise,
    refundedPaise,
    committedPaise: recordedUnverifiedPaise + verifiedPaise,
    outstandingPaise: Math.max(0, agreedPricePaise - verifiedPaise),
    state,
  };
}

export function assertPaymentRecordable(
  booking: Pick<MarketplaceBookingRecord, "status" | "servicePricePaise">,
  committedPaise: number,
  amountPaise: number,
): void {
  if (!PAYMENT_RECORDABLE_STATUSES.includes(booking.status)) {
    throw new MarketplaceRuleError(409, "Payments can only be recorded against an accepted booking");
  }
  if (committedPaise + amountPaise > booking.servicePricePaise) {
    throw new MarketplaceRuleError(409, "Recorded payments cannot exceed the agreed price");
  }
}

export function assertPaymentReviewable(payment: Pick<MarketplacePaymentRecord, "status">): void {
  if (payment.status !== "RECORDED_UNVERIFIED") {
    throw new MarketplaceRuleError(
      409,
      `This payment is already ${payment.status.toLowerCase().replaceAll("_", " ")} and cannot be reviewed again`,
    );
  }
}

/** Refunds are only reviewed for cancelled bookings; they are internal approvals, not money movement. */
export function assertRefundable(
  booking: Pick<MarketplaceBookingRecord, "status">,
  payment: Pick<MarketplacePaymentRecord, "status">,
  hasRefund: boolean,
): void {
  if (booking.status !== "CANCELLED") {
    throw new MarketplaceRuleError(409, "Refunds can only be approved for cancelled bookings");
  }
  if (payment.status !== "VERIFIED") {
    throw new MarketplaceRuleError(409, "Only verified payments can be refunded");
  }
  if (hasRefund) throw new MarketplaceRuleError(409, "This payment already has a refund");
}

export type RefundState = "NONE" | "REVIEW_REQUIRED" | "RESOLVED";

export function computeRefundState(status: MarketplaceBookingStatus, payments: PaymentLike[]): RefundState {
  if (status !== "CANCELLED") return "NONE";
  if (payments.some((payment) => payment.status === "RECORDED_UNVERIFIED" || payment.status === "VERIFIED")) {
    return "REVIEW_REQUIRED";
  }
  return payments.length > 0 ? "RESOLVED" : "NONE";
}

export type CancellationPolicy = {
  key: string;
  version: string;
  ownerCancellableFrom: MarketplaceBookingStatus[];
  vendorCancellableFrom: MarketplaceBookingStatus[];
  /** Always zero: no fee or penalty is charged automatically. */
  feePaise: 0;
  /** Always manual: no refund is issued automatically. */
  refundMode: "MANUAL_REVIEW";
};

/**
 * Safe default until the business confirms fees, deadlines and refund rules: nothing is charged, nothing is
 * refunded automatically, and cancellation is only self-service before work starts.
 */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  key: "default-no-fee",
  version: "1",
  ownerCancellableFrom: ["REQUESTED", "ACCEPTED"],
  vendorCancellableFrom: ["ACCEPTED"],
  feePaise: 0,
  refundMode: "MANUAL_REVIEW",
};

export type CancellationPlan = {
  to: "CANCELLED";
  kind: MarketplaceCancellationKind;
  reason: string;
  fromStatus: MarketplaceBookingStatus;
  policyKey: string;
  policyVersion: string;
  feePaise: 0;
  unrefundedPaidPaise: number;
};

export function planCancellation(
  booking: Pick<MarketplaceBookingRecord, "status" | "windowStart">,
  role: "OWNER" | "VENDOR",
  input: { reason: string; noShow: boolean },
  policy: CancellationPolicy,
  now: Date,
  committedPaise: number,
): CancellationPlan {
  const reason = input.reason.trim();
  if (!reason) throw new MarketplaceRuleError(400, "A reason is required to cancel");
  if (booking.status === "DISPUTED") {
    throw new MarketplaceRuleError(409, "This booking is disputed; it can only be resolved by the platform");
  }
  const allowed = role === "OWNER" ? policy.ownerCancellableFrom : policy.vendorCancellableFrom;
  if (input.noShow) {
    if (booking.status !== "ACCEPTED") {
      throw new MarketplaceRuleError(409, "A no-show can only be reported on an accepted booking that has not started");
    }
    if (now.getTime() < booking.windowStart.getTime()) {
      throw new MarketplaceRuleError(409, "A no-show can only be reported after the booked window has started");
    }
  } else if (!allowed.includes(booking.status)) {
    throw new MarketplaceRuleError(
      409,
      `A ${booking.status.toLowerCase().replaceAll("_", " ")} booking cannot be cancelled here; raise a dispute or contact support`,
    );
  }
  const kind: MarketplaceCancellationKind = input.noShow
    ? role === "OWNER" ? "VENDOR_NO_SHOW" : "OWNER_NO_SHOW"
    : role === "OWNER" ? "OWNER_CANCELLED" : "VENDOR_CANCELLED";
  return {
    to: "CANCELLED",
    kind,
    reason,
    fromStatus: booking.status,
    policyKey: policy.key,
    policyVersion: policy.version,
    feePaise: 0,
    unrefundedPaidPaise: committedPaise,
  };
}

const DISPUTE_OUTCOME_STATUS: Record<MarketplaceDisputeOutcome, MarketplaceBookingStatus> = {
  UPHELD_COMPLETION: "CUSTOMER_ACCEPTED",
  REWORK_REQUIRED: "IN_PROGRESS",
  CANCELLED_NO_CHARGE: "CANCELLED",
};

export function planDisputeResolution(
  booking: Pick<MarketplaceBookingRecord, "status">,
  dispute: { status: MarketplaceDisputeStatus },
  outcome: MarketplaceDisputeOutcome,
): MarketplaceBookingStatus {
  if (dispute.status === "RESOLVED") throw new MarketplaceRuleError(409, "This dispute is already resolved");
  if (booking.status !== "DISPUTED") throw new MarketplaceRuleError(409, "This booking is not disputed");
  return DISPUTE_OUTCOME_STATUS[outcome];
}

export function assertDisputeRespondable(dispute: { status: MarketplaceDisputeStatus }): void {
  if (dispute.status === "RESOLVED") throw new MarketplaceRuleError(409, "This dispute is already resolved");
  if (dispute.status === "WITHDRAWN") throw new MarketplaceRuleError(409, "This dispute was withdrawn");
  if (dispute.status === "RESPONDED") throw new MarketplaceRuleError(409, "A response has already been recorded");
}

/**
 * An Owner may withdraw their own dispute until the platform resolves it. The booking returns to the state it
 * was disputed from, so the Owner can still accept the completion or raise a new dispute. History is preserved.
 */
export function planDisputeWithdrawal(
  booking: Pick<MarketplaceBookingRecord, "status">,
  dispute: { status: MarketplaceDisputeStatus },
): MarketplaceBookingStatus {
  if (dispute.status === "RESOLVED") throw new MarketplaceRuleError(409, "This dispute is already resolved");
  if (dispute.status === "WITHDRAWN") throw new MarketplaceRuleError(409, "This dispute was already withdrawn");
  if (booking.status !== "DISPUTED") throw new MarketplaceRuleError(409, "This booking is not disputed");
  return BOOKING_TRANSITIONS.dispute.from;
}

export const DISPUTE_CANCELLATION_POLICY_KEY = "dispute-resolution";

export function snapshotFromService(
  service: MarketplaceServiceRecord,
  vehicle: {
    registrationNumber: string;
    type: VehicleType;
    make: string | null;
    model: string | null;
  },
): BookingSnapshot {
  const label = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  return {
    vehicleRegistration: vehicle.registrationNumber,
    vehicleType: vehicle.type,
    vehicleLabel: label || null,
    serviceName: service.name,
    serviceDescription: service.description,
    serviceCategory: service.category,
    serviceInclusions: [...service.inclusions],
    serviceExclusions: [...service.exclusions],
    serviceTerms: service.terms,
    servicePricePaise: service.pricePaise,
    serviceDurationMinutes: service.durationMinutes,
    serviceVersion: service.version,
  };
}

const MAX_ADVANCE_MS = 90 * 24 * 60 * 60 * 1000;

export function assertBookable(input: {
  service: MarketplaceServiceRecord;
  profile: MarketplaceProfileRecord | null;
  vehicle: { type: VehicleType; status: "ACTIVE" | "INACTIVE" };
  windowStart: Date;
  now: Date;
}): void {
  const { service, profile, vehicle, windowStart, now } = input;
  if (service.status !== "ACTIVE" || !profile) {
    throw new MarketplaceRuleError(409, "This service is not currently available for booking");
  }
  if (vehicle.status !== "ACTIVE") {
    throw new MarketplaceRuleError(409, "Only active vehicles can be booked");
  }
  if (!service.vehicleTypes.includes(vehicle.type) || !profile.supportedVehicleTypes.includes(vehicle.type)) {
    throw new MarketplaceRuleError(409, "This service does not support the selected vehicle type");
  }
  if (windowStart.getTime() <= now.getTime()) {
    throw new MarketplaceRuleError(400, "The requested window must start in the future");
  }
  if (windowStart.getTime() - now.getTime() > MAX_ADVANCE_MS) {
    throw new MarketplaceRuleError(400, "Bookings can be requested up to 90 days ahead");
  }
}

export function sameBookingRequest(
  existing: Pick<MarketplaceBookingRecord, "vehicleId" | "serviceId" | "windowStart" | "windowEnd" | "serviceLocation">,
  next: { vehicleId: string; serviceId: string; windowStart: Date; windowEnd: Date; serviceLocation: string },
): boolean {
  return (
    existing.vehicleId === next.vehicleId &&
    existing.serviceId === next.serviceId &&
    existing.windowStart.getTime() === next.windowStart.getTime() &&
    existing.windowEnd.getTime() === next.windowEnd.getTime() &&
    existing.serviceLocation === next.serviceLocation
  );
}

export function maskRegistration(registration: string): string {
  const compact = registration.replace(/[\s-]+/g, "");
  return `••••${compact.slice(-4)}`;
}

/** Vendors see the Owner's access details only after they accept the request. */
export function toVendorBookingView<T extends MarketplaceBookingRecord>(booking: T): T {
  if (booking.acceptedAt) return booking;
  return {
    ...booking,
    vehicleRegistration: maskRegistration(booking.vehicleRegistration),
    serviceLocation: "Shared after you accept the request",
    accessNotes: null,
  };
}

export function haversineKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type DiscoveryResult = {
  serviceId: string;
  name: string;
  description: string | null;
  category: MarketplaceServiceCategory;
  vehicleTypes: VehicleType[];
  pricePaise: number;
  durationMinutes: number;
  inclusions: string[];
  exclusions: string[];
  terms: string | null;
  serviceAreas: string[];
  matchBasis: "DISTANCE" | "AREA";
  distanceKm: number | null;
  vendor: {
    businessName: string;
    category: string;
    city: string | null;
    verificationStatus: string;
  };
};

export type DiscoveryResponse = {
  status: "OK" | "LOCATION_REQUIRED";
  location: { mode: "COORDINATES" | "AREA"; radiusKm: number | null; city: string | null } | null;
  results: DiscoveryResult[];
  noResultsWithinRadius: boolean;
  unsupported: string[];
};

const normalizeArea = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function searchCandidates(
  candidates: DiscoveryCandidate[],
  query: MarketplaceDiscoveryQuery,
): DiscoveryResponse {
  // Ratings, availability slots and sponsored placement have no backing data, so they are not offered.
  const unsupported = ["rating", "soonest availability", "sponsored placement"];
  const hasCoordinates = query.latitude !== undefined && query.longitude !== undefined;
  const city = query.city ? normalizeArea(query.city) : null;
  if (!hasCoordinates && !city) {
    return { status: "LOCATION_REQUIRED", location: null, results: [], noResultsWithinRadius: false, unsupported };
  }

  const radiusKm = query.radiusKm ?? MARKETPLACE_DEFAULT_RADIUS_KM;
  const origin = hasCoordinates ? { latitude: query.latitude!, longitude: query.longitude! } : null;
  const results: DiscoveryResult[] = [];

  for (const { service, profile } of candidates) {
    if (service.status !== "ACTIVE") continue;
    if (query.category && service.category !== query.category) continue;
    if (query.vehicleType && (
      !service.vehicleTypes.includes(query.vehicleType) ||
      !profile.supportedVehicleTypes.includes(query.vehicleType)
    )) continue;
    if (query.minPricePaise !== undefined && service.pricePaise < query.minPricePaise) continue;
    if (query.maxPricePaise !== undefined && service.pricePaise > query.maxPricePaise) continue;

    let distanceKm: number | null = null;
    let matchBasis: "DISTANCE" | "AREA";
    if (origin) {
      if (profile.latitude === null || profile.longitude === null) continue;
      const distance = haversineKm(origin, { latitude: profile.latitude, longitude: profile.longitude });
      if (distance > radiusKm) continue;
      if (profile.serviceRadiusKm !== null && distance > profile.serviceRadiusKm) continue;
      distanceKm = Math.round(distance * 10) / 10;
      matchBasis = "DISTANCE";
    } else {
      const areas = [profile.city, ...profile.serviceAreas].filter(Boolean).map((area) => normalizeArea(area!));
      if (!city || !areas.includes(city)) continue;
      if (service.serviceAreas.length > 0 && !service.serviceAreas.map(normalizeArea).includes(city)) continue;
      matchBasis = "AREA";
    }

    results.push({
      serviceId: service.id,
      name: service.name,
      description: service.description,
      category: service.category,
      vehicleTypes: service.vehicleTypes,
      pricePaise: service.pricePaise,
      durationMinutes: service.durationMinutes,
      inclusions: service.inclusions,
      exclusions: service.exclusions,
      terms: service.terms,
      serviceAreas: service.serviceAreas,
      matchBasis,
      distanceKm,
      vendor: {
        businessName: profile.businessName,
        category: profile.category,
        city: profile.city,
        verificationStatus: profile.verificationStatus,
      },
    });
  }

  const sort = query.sort ?? (origin ? "distance" : "price_asc");
  results.sort((a, b) => {
    const primary = sort === "distance"
      ? (a.distanceKm ?? 0) - (b.distanceKm ?? 0)
      : a.pricePaise - b.pricePaise;
    return primary || a.name.localeCompare(b.name) || a.serviceId.localeCompare(b.serviceId);
  });

  return {
    status: "OK",
    location: origin
      ? { mode: "COORDINATES", radiusKm, city: null }
      : { mode: "AREA", radiusKm: null, city: query.city!.trim() },
    results,
    noResultsWithinRadius: Boolean(origin) && results.length === 0,
    unsupported,
  };
}
