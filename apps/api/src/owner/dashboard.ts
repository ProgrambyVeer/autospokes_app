import type { OwnerVehicleRecord } from "./repository.js";

export type OwnerServiceStatus = "INACTIVE" | "NO_PROVIDER" | "PROVIDER_RECORDED";

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
    upcomingService: null;
    currentWashStatus: null;
  }[];
  recentActivity: {
    id: string;
    kind: "VEHICLE_ADDED" | "VEHICLE_UPDATED";
    vehicleId: string;
    registrationNumber: string;
    occurredAt: string;
  }[];
  availability: {
    bookings: { available: false };
    billing: { available: false };
    notifications: { available: false };
  };
};

const RECENT_ACTIVITY_LIMIT = 8;
const UPDATE_THRESHOLD_MS = 1000;

export function buildOwnerDashboard(vehicles: OwnerVehicleRecord[]): OwnerDashboard {
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
  activity.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));

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
      upcomingService: null,
      currentWashStatus: null,
    })),
    recentActivity: activity.slice(0, RECENT_ACTIVITY_LIMIT),
    availability: {
      bookings: { available: false },
      billing: { available: false },
      notifications: { available: false },
    },
  };
}
