import type { MarketplaceBookingStatus } from "@autospokes/shared";
import type { MarketplaceBookingDetail } from "../marketplace/repository.js";
import { computeRefundState, summarizePayments, type PaymentState, type RefundState } from "../marketplace/rules.js";
import type { OwnerVehicleRecord } from "./repository.js";

export type OwnerServiceStatus = "INACTIVE" | "NO_PROVIDER" | "PROVIDER_RECORDED";

export type OwnerDashboardBooking = {
  id: string;
  vehicleId: string;
  vehicleRegistration: string;
  serviceName: string;
  vendorBusinessName: string | null;
  status: MarketplaceBookingStatus;
  windowStart: string;
  windowEnd: string;
  servicePricePaise: number;
  payment: { state: PaymentState; verifiedPaise: number; outstandingPaise: number };
  dispute: "NONE" | "OPEN" | "RESPONDED" | "RESOLVED";
  refundState: RefundState;
};

export type OwnerDashboard = {
  summary: {
    totalVehicles: number;
    activeVehicles: number;
    inactiveVehicles: number;
    vehiclesWithoutProvider: number;
    providerCounts: {
      INDEPENDENT_WASHER: number;
      SOCIETY_VENDOR: number;
      MARKETPLACE_VENDOR: number;
    };
  };
  vehicles: {
    vehicleId: string;
    serviceStatus: OwnerServiceStatus;
    providerType: OwnerVehicleRecord["providerType"];
    // Providers are entered by the Owner; no vendor workflow has verified them.
    providerVerified: false;
    upcomingService: {
      bookingId: string;
      serviceName: string;
      windowStart: string;
      windowEnd: string;
      status: MarketplaceBookingStatus;
    } | null;
    currentWashStatus: null;
  }[];
  marketplace: {
    connected: boolean;
    counts: { total: number; awaitingVendor: number; confirmed: number; disputed: number; cancelled: number };
    bookings: OwnerDashboardBooking[];
  };
  recentActivity: {
    id: string;
    kind: "VEHICLE_ADDED" | "VEHICLE_UPDATED" | "BOOKING_EVENT";
    vehicleId: string;
    registrationNumber: string;
    occurredAt: string;
    bookingId?: string;
    eventKind?: string;
    serviceName?: string;
  }[];
  availability: {
    bookings: { available: boolean };
    billing: { available: false };
    notifications: { available: false };
  };
};

const RECENT_ACTIVITY_LIMIT = 8;
const UPDATE_THRESHOLD_MS = 1000;
const CONFIRMED: MarketplaceBookingStatus[] = ["ACCEPTED", "IN_PROGRESS"];

export type MarketplaceDashboardInput = {
  bookings: MarketplaceBookingDetail[];
  now: Date;
};

export function buildOwnerDashboard(
  vehicles: OwnerVehicleRecord[],
  marketplace?: MarketplaceDashboardInput,
): OwnerDashboard {
  const providerCounts = { INDEPENDENT_WASHER: 0, SOCIETY_VENDOR: 0, MARKETPLACE_VENDOR: 0 };
  for (const vehicle of vehicles) {
    if (vehicle.providerType) providerCounts[vehicle.providerType] += 1;
  }

  const activity: OwnerDashboard["recentActivity"] = [];
  for (const vehicle of vehicles) {
    activity.push({
      id: `${vehicle.id}:added`,
      kind: "VEHICLE_ADDED",
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      occurredAt: vehicle.createdAt.toISOString(),
    });
    if (vehicle.updatedAt.getTime() - vehicle.createdAt.getTime() > UPDATE_THRESHOLD_MS) {
      activity.push({
        id: `${vehicle.id}:updated`,
        kind: "VEHICLE_UPDATED",
        vehicleId: vehicle.id,
        registrationNumber: vehicle.registrationNumber,
        occurredAt: vehicle.updatedAt.toISOString(),
      });
    }
  }

  const details = marketplace?.bookings ?? [];
  const bookings: OwnerDashboardBooking[] = details.map((detail) => {
    const { booking } = detail;
    const summary = summarizePayments(detail.payments, booking.servicePricePaise);
    const latest = detail.disputes.at(-1);
    return {
      id: booking.id,
      vehicleId: booking.vehicleId,
      vehicleRegistration: booking.vehicleRegistration,
      serviceName: booking.serviceName,
      vendorBusinessName: detail.vendorBusinessName,
      status: booking.status,
      windowStart: booking.windowStart.toISOString(),
      windowEnd: booking.windowEnd.toISOString(),
      servicePricePaise: booking.servicePricePaise,
      payment: { state: summary.state, verifiedPaise: summary.verifiedPaise, outstandingPaise: summary.outstandingPaise },
      dispute: latest ? latest.status : "NONE",
      refundState: computeRefundState(booking.status, detail.payments),
    };
    });
  for (const detail of details) {
    for (const event of detail.events) {
      if (event.kind === "requested") continue;
      activity.push({
        id: `event:${event.id}`,
        kind: "BOOKING_EVENT",
        vehicleId: detail.booking.vehicleId,
        registrationNumber: detail.booking.vehicleRegistration,
        occurredAt: event.createdAt.toISOString(),
        bookingId: detail.booking.id,
        eventKind: event.kind,
        serviceName: detail.booking.serviceName,
      });
    }
  }
  activity.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));

  const nowMs = marketplace?.now.getTime() ?? 0;
  const upcomingFor = (vehicleId: string): OwnerDashboard["vehicles"][number]["upcomingService"] => {
    const next = details
      .map((detail) => detail.booking)
      .filter((booking) => booking.vehicleId === vehicleId && CONFIRMED.includes(booking.status) && booking.windowEnd.getTime() >= nowMs)
      .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime())[0];
    return next
      ? {
          bookingId: next.id,
          serviceName: next.serviceName,
          windowStart: next.windowStart.toISOString(),
          windowEnd: next.windowEnd.toISOString(),
          status: next.status,
        }
      : null;
  };

  const activeVehicles = vehicles.filter((vehicle) => vehicle.status === "ACTIVE").length;
  return {
    summary: {
      totalVehicles: vehicles.length,
      activeVehicles,
      inactiveVehicles: vehicles.length - activeVehicles,
      vehiclesWithoutProvider: vehicles.filter((vehicle) => vehicle.providerType === null).length,
      providerCounts,
    },
    vehicles: vehicles.map((vehicle) => ({
      vehicleId: vehicle.id,
      serviceStatus: vehicle.status !== "ACTIVE"
        ? "INACTIVE"
        : vehicle.providerType === null ? "NO_PROVIDER" : "PROVIDER_RECORDED",
      providerType: vehicle.providerType,
      providerVerified: false,
      upcomingService: upcomingFor(vehicle.id),
      currentWashStatus: null,
    })),
    marketplace: {
      connected: marketplace !== undefined,
      counts: {
        total: bookings.length,
        awaitingVendor: bookings.filter((b) => b.status === "REQUESTED").length,
        confirmed: bookings.filter((b) => CONFIRMED.includes(b.status)).length,
        disputed: bookings.filter((b) => b.status === "DISPUTED").length,
        cancelled: bookings.filter((b) => b.status === "CANCELLED").length,
      },
      bookings,
    },
    recentActivity: activity.slice(0, RECENT_ACTIVITY_LIMIT),
    availability: {
      bookings: { available: marketplace !== undefined },
      billing: { available: false },
      notifications: { available: false },
    },
  };
}
