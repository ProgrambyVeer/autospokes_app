import type {
  CreateVehicleInput,
  OwnerProfileUpdateInput,
  UpdateVehicleInput,
  VehicleProviderType,
  VehicleStatus,
  VehicleType,
} from "@autospokes/shared";

export type OwnerProfileRecord = {
  roleProfileId: string;
  accountId: string;
  displayName: string;
  phoneNumber: string | null;
};

export type OwnerVehicleRecord = {
  id: string;
  accountId: string;
  type: VehicleType;
  registrationNumber: string;
  make: string | null;
  model: string | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  photoUrls: string[];
  locationName: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  providerType: VehicleProviderType | null;
  providerName: string | null;
  assignedWasherName: string | null;
  status: VehicleStatus;
  createdAt: Date;
  updatedAt: Date;
};

export interface OwnerRepository {
  findOwnerProfile(roleProfileId: string, accountId: string): Promise<OwnerProfileRecord | null>;
  updateOwnerProfile(
    roleProfileId: string,
    accountId: string,
    input: OwnerProfileUpdateInput,
  ): Promise<OwnerProfileRecord | null>;
  listVehicles(accountId: string): Promise<OwnerVehicleRecord[]>;
  findVehicle(accountId: string, vehicleId: string): Promise<OwnerVehicleRecord | null>;
  createVehicle(
    accountId: string,
    input: CreateVehicleInput & { registrationNumberNormalized: string },
  ): Promise<OwnerVehicleRecord>;
  updateVehicle(
    accountId: string,
    vehicleId: string,
    input: UpdateVehicleInput & { registrationNumberNormalized?: string },
  ): Promise<OwnerVehicleRecord | null>;
}
