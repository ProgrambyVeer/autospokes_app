import type { Prisma, PrismaClient } from "@prisma/client";
import type { OwnerProfileUpdateInput, UpdateVehicleInput } from "@autospokes/shared";
import type {
  OwnerProfileRecord,
  OwnerRepository,
  OwnerVehicleRecord,
} from "./repository.js";

const vehicleSelect = {
  id: true,
  accountId: true,
  type: true,
  registrationNumber: true,
  make: true,
  model: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  photoUrls: true,
  locationName: true,
  address: true,
  city: true,
  postalCode: true,
  providerType: true,
  providerName: true,
  assignedWasherName: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VehicleSelect;

type SelectedVehicle = Prisma.VehicleGetPayload<{ select: typeof vehicleSelect }>;

function readPhoneNumber(profileData: Prisma.JsonValue): string | null {
  if (typeof profileData !== "object" || profileData === null || Array.isArray(profileData)) {
    return null;
  }
  const phoneNumber = profileData.phoneNumber;
  return typeof phoneNumber === "string" ? phoneNumber : null;
}

function ownerProfileRecord(profile: {
  id: string;
  accountId: string | null;
  displayName: string;
  profileData: Prisma.JsonValue;
}): OwnerProfileRecord | null {
  if (profile.accountId === null) return null;
  return {
    roleProfileId: profile.id,
    accountId: profile.accountId,
    displayName: profile.displayName,
    phoneNumber: readPhoneNumber(profile.profileData),
  };
}

function vehicleRecord(vehicle: SelectedVehicle): OwnerVehicleRecord {
  return vehicle;
}

const ownerProfileWhere = { role: "OWNER" as const };

export class PrismaOwnerRepository implements OwnerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOwnerProfile(roleProfileId: string, accountId: string) {
    const profile = await this.prisma.roleProfile.findFirst({
      where: { id: roleProfileId, accountId, ...ownerProfileWhere },
      select: { id: true, accountId: true, displayName: true, profileData: true },
    });
    return profile ? ownerProfileRecord(profile) : null;
  }

  async updateOwnerProfile(
    roleProfileId: string,
    accountId: string,
    input: OwnerProfileUpdateInput,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const profile = await transaction.roleProfile.findFirst({
        where: { id: roleProfileId, accountId, ...ownerProfileWhere },
        select: { id: true, accountId: true, displayName: true, profileData: true },
      });
      if (!profile) return null;

      let profileData: Prisma.InputJsonValue | undefined;
      if (input.phoneNumber !== undefined) {
        const current =
          typeof profile.profileData === "object" &&
          profile.profileData !== null &&
          !Array.isArray(profile.profileData)
            ? profile.profileData
            : {};
        profileData = { ...current, phoneNumber: input.phoneNumber } as Prisma.InputJsonValue;
      }

      const updated = await transaction.roleProfile.update({
        where: { id: roleProfileId },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(profileData !== undefined ? { profileData } : {}),
        },
        select: { id: true, accountId: true, displayName: true, profileData: true },
      });
      return ownerProfileRecord(updated);
    });
  }

  async listVehicles(accountId: string) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: vehicleSelect,
    });
    return vehicles.map(vehicleRecord);
  }

  async findVehicle(accountId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, accountId },
      select: vehicleSelect,
    });
    return vehicle ? vehicleRecord(vehicle) : null;
  }

  async createVehicle(
    accountId: string,
    input: Parameters<OwnerRepository["createVehicle"]>[1],
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const vehicle = await transaction.vehicle.create({
        data: { ...input, accountId },
        select: vehicleSelect,
      });
      await transaction.auditEvent.create({
        data: { accountId, action: "OWNER_VEHICLE_CREATED" },
      });
      return vehicleRecord(vehicle);
    });
  }

  async updateVehicle(
    accountId: string,
    vehicleId: string,
    input: UpdateVehicleInput & { registrationNumberNormalized?: string },
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.vehicle.updateMany({
        where: { id: vehicleId, accountId },
        data: input,
      });
      if (updated.count !== 1) return null;

      const vehicle = await transaction.vehicle.findFirstOrThrow({
        where: { id: vehicleId, accountId },
        select: vehicleSelect,
      });
      await transaction.auditEvent.create({
        data: { accountId, action: "OWNER_VEHICLE_UPDATED" },
      });
      return vehicleRecord(vehicle);
    });
  }
}
