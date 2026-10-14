import { z } from "zod";

export const UserRoleSchema = z.enum([
  "Owner",
  "Independent Detailer",
  "Society Vendor",
  "Marketplace Vendor",
  "Superadmin",
]);

export type UserRole = z.infer<typeof UserRoleSchema>;

export const ApiRoleSchema = z.enum([
  "OWNER",
  "INDEPENDENT_DETAILER",
  "SOCIETY_VENDOR",
  "MARKETPLACE_VENDOR",
  "SUPERADMIN",
]);

export type ApiRole = z.infer<typeof ApiRoleSchema>;

export const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  role: ApiRoleSchema.exclude(["SUPERADMIN"]).default("OWNER"),
  displayName: z.string().trim().min(1).max(80),
});

export const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  role: ApiRoleSchema.optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;

export const AccountIdSchema = z.string().uuid();

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("autospokes-api"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const VehicleTypeSchema = z.enum(["TWO_WHEELER", "FOUR_WHEELER", "OTHER"]);
export type VehicleType = z.infer<typeof VehicleTypeSchema>;

export const VehicleStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type VehicleStatus = z.infer<typeof VehicleStatusSchema>;

export const VehicleProviderTypeSchema = z.enum([
  "INDEPENDENT_WASHER",
  "SOCIETY_VENDOR",
  "MARKETPLACE_VENDOR",
]);
export type VehicleProviderType = z.infer<typeof VehicleProviderTypeSchema>;

const optionalLabel = (max: number) => z.string().trim().max(max).optional().nullable();
const positiveDimension = z.number().positive().max(100_000).optional().nullable();
const RegistrationNumberSchema = z.string().trim().min(3).max(32)
  .regex(/^[A-Za-z0-9 -]+$/)
  .refine((value) => value.replace(/[\s-]+/g, "").length >= 3);

const VehicleFieldsSchema = z.object({
  type: VehicleTypeSchema.optional(),
  registrationNumber: RegistrationNumberSchema.optional(),
  make: optionalLabel(80),
  model: optionalLabel(80),
  lengthCm: positiveDimension,
  widthCm: positiveDimension,
  heightCm: positiveDimension,
  photoUrls: z.array(
    z.string().url().max(2048).refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }),
  ).max(10).optional(),
  locationName: optionalLabel(100),
  address: optionalLabel(240),
  city: optionalLabel(100),
  postalCode: optionalLabel(24),
  providerType: VehicleProviderTypeSchema.optional().nullable(),
  providerName: optionalLabel(120),
  assignedWasherName: optionalLabel(120),
  status: VehicleStatusSchema.optional(),
}).strict();

export const CreateVehicleSchema = VehicleFieldsSchema.extend({
  type: VehicleTypeSchema,
  registrationNumber: RegistrationNumberSchema,
});

export const UpdateVehicleSchema = VehicleFieldsSchema.refine(
  (fields) => Object.keys(fields).length > 0,
  "At least one vehicle field must be provided",
);

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;

export const OwnerProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  phoneNumber: z.string().trim().max(32).optional().nullable(),
}).strict().refine((fields) => Object.keys(fields).length > 0);

export type OwnerProfileUpdateInput = z.infer<typeof OwnerProfileUpdateSchema>;

export function normalizeRegistrationNumber(registrationNumber: string): string {
  return registrationNumber.toUpperCase().replace(/[\s-]+/g, "");
}

export const OwnerProfileSchema = z.object({
  displayName: z.string(),
  phoneNumber: z.string().nullable(),
});

export const OwnerVehicleSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  type: VehicleTypeSchema,
  registrationNumber: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  lengthCm: z.number().nullable(),
  widthCm: z.number().nullable(),
  heightCm: z.number().nullable(),
  photoUrls: z.array(z.string()),
  locationName: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  providerType: VehicleProviderTypeSchema.nullable(),
  providerName: z.string().nullable(),
  assignedWasherName: z.string().nullable(),
  status: VehicleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OwnerVehicle = z.infer<typeof OwnerVehicleSchema>;
