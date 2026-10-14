import { randomUUID } from "node:crypto";
import type { CreateVehicleInput, OwnerProfileUpdateInput, UpdateVehicleInput } from "@autospokes/shared";
import type {
  OwnerProfileRecord,
  OwnerRepository,
  OwnerVehicleRecord,
} from "../../src/owner/repository.js";

function uniqueError(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

type MemoryVehicle = OwnerVehicleRecord & { registrationNumberNormalized: string };

function publicVehicle(vehicle: MemoryVehicle): OwnerVehicleRecord {
  return {
    id: vehicle.id,
    accountId: vehicle.accountId,
    type: vehicle.type,
    registrationNumber: vehicle.registrationNumber,
    make: vehicle.make,
    model: vehicle.model,
    lengthCm: vehicle.lengthCm,
    widthCm: vehicle.widthCm,
    heightCm: vehicle.heightCm,
    photoUrls: [...vehicle.photoUrls],
    locationName: vehicle.locationName,
    address: vehicle.address,
    city: vehicle.city,
    postalCode: vehicle.postalCode,
    providerType: vehicle.providerType,
    providerName: vehicle.providerName,
    assignedWasherName: vehicle.assignedWasherName,
    status: vehicle.status,
    createdAt: vehicle.createdAt,
    updatedAt: vehicle.updatedAt,
  };
}

export class MemoryOwnerRepository implements OwnerRepository {
  private readonly profiles = new Map<string, OwnerProfileRecord>();
  private readonly vehicles = new Map<string, MemoryVehicle>();

  addProfile(roleProfileId: string, accountId: string, displayName: string): void {
    this.profiles.set(roleProfileId, {
      roleProfileId,
      accountId,
      displayName,
      phoneNumber: null,
    });
  }

  async findOwnerProfile(roleProfileId: string, accountId: string) {
    const profile = this.profiles.get(roleProfileId);
    return profile?.accountId === accountId ? { ...profile } : null;
  }

  async updateOwnerProfile(
    roleProfileId: string,
    accountId: string,
    input: OwnerProfileUpdateInput,
  ) {
    const profile = await this.findOwnerProfile(roleProfileId, accountId);
    if (!profile) return null;
    const updated = {
      ...profile,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
    };
    this.profiles.set(roleProfileId, updated);
    return { ...updated };
  }

  async listVehicles(accountId: string) {
    return [...this.vehicles.values()]
      .filter((vehicle) => vehicle.accountId === accountId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(publicVehicle);
  }

  async findVehicle(accountId: string, vehicleId: string) {
    const vehicle = this.vehicles.get(vehicleId);
    return vehicle?.accountId === accountId
      ? publicVehicle(vehicle)
      : null;
  }

  async createVehicle(
    accountId: string,
    input: CreateVehicleInput & { registrationNumberNormalized: string },
  ) {
    if (
      [...this.vehicles.values()].some(
        (vehicle) => vehicle.registrationNumberNormalized === input.registrationNumberNormalized,
      )
    ) {
      throw uniqueError();
    }
    const now = new Date();
    const vehicle: OwnerVehicleRecord & { registrationNumberNormalized: string } = {
      id: randomUUID(),
      accountId,
      type: input.type,
      registrationNumber: input.registrationNumber,
      registrationNumberNormalized: input.registrationNumberNormalized,
      make: input.make ?? null,
      model: input.model ?? null,
      lengthCm: input.lengthCm ?? null,
      widthCm: input.widthCm ?? null,
      heightCm: input.heightCm ?? null,
      photoUrls: input.photoUrls ?? [],
      locationName: input.locationName ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      providerType: input.providerType ?? null,
      providerName: input.providerName ?? null,
      assignedWasherName: input.assignedWasherName ?? null,
      status: input.status ?? "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    this.vehicles.set(vehicle.id, vehicle);
    return publicVehicle(vehicle);
  }

  async updateVehicle(
    accountId: string,
    vehicleId: string,
    input: UpdateVehicleInput & { registrationNumberNormalized?: string },
  ) {
    const current = this.vehicles.get(vehicleId);
    if (!current || current.accountId !== accountId) return null;
    const registrationNumberNormalized =
      input.registrationNumberNormalized ?? current.registrationNumberNormalized;
    if (
      [...this.vehicles.values()].some(
        (vehicle) =>
          vehicle.id !== vehicleId &&
          vehicle.registrationNumberNormalized === registrationNumberNormalized,
      )
    ) {
      throw uniqueError();
    }

    const updated = {
      ...current,
      ...input,
      registrationNumberNormalized,
      photoUrls: input.photoUrls ? [...input.photoUrls] : [...current.photoUrls],
      updatedAt: new Date(),
    };
    this.vehicles.set(vehicleId, updated);
    return publicVehicle(updated);
  }
}
