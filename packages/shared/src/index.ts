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
