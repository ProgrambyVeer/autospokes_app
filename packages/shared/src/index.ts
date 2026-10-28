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
export const RegistrationNumberSchema = z.string().trim()
  .min(3, "Registration number must be at least 3 characters")
  .max(32, "Registration number must be 32 characters or fewer")
  .regex(/^[A-Za-z0-9 -]+$/, "Registration number may only contain letters, numbers, spaces and hyphens")
  .refine(
    (value) => value.replace(/[\s-]+/g, "").length >= 3,
    "Registration number must include at least 3 letters or numbers",
  );

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

export type FieldErrors = Record<string, string[]>;

// Only field paths and validation messages are returned, never submitted values.
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    let field = issue.path.length > 0 ? String(issue.path[0]) : "form";
    if (issue.code === "unrecognized_keys") {
      field = "form";
    }
    const message = issue.code === "unrecognized_keys"
      ? `Unsupported field: ${issue.keys.join(", ")}`
      : issue.message;
    (fieldErrors[field] ??= []).push(message);
  }
  return fieldErrors;
}

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

// ---------------------------------------------------------------------------
// Independent Detailer
// ---------------------------------------------------------------------------

export const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;

/** Calendar date (YYYY-MM-DD) in India Standard Time, independent of the host time zone. */
export function istDateString(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** ISO weekday for a YYYY-MM-DD date: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

/** Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX), or returns null. */
export function normalizeIndianPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, "");
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  return match ? `+91${match[1]}` : null;
}

export const IndianPhoneSchema = z.string().trim().refine(
  (value) => normalizeIndianPhone(value) !== null,
  "Enter a valid 10-digit Indian mobile number",
);

const DateStringSchema = z.string().refine(isRealDate, "Enter a valid date as YYYY-MM-DD");

export const DetailerProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  phoneNumber: IndianPhoneSchema.optional(),
  serviceArea: z.string().trim().min(1).max(160).optional(),
  contactEmail: z.string().trim().email().max(254).optional().nullable(),
}).strict().refine((fields) => Object.keys(fields).length > 0, "At least one field must be provided");
export type DetailerProfileUpdateInput = z.infer<typeof DetailerProfileUpdateSchema>;

export const CreateDetailerClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  phoneNumber: IndianPhoneSchema,
  notes: optionalLabel(500),
}).strict();
export const UpdateDetailerClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100).optional(),
  phoneNumber: IndianPhoneSchema.optional(),
  notes: optionalLabel(500),
  status: VehicleStatusSchema.optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0, "At least one field must be provided");
export type CreateDetailerClientInput = z.infer<typeof CreateDetailerClientSchema>;
export type UpdateDetailerClientInput = z.infer<typeof UpdateDetailerClientSchema>;

export const CreateDetailerVehicleSchema = z.object({
  type: VehicleTypeSchema,
  registrationNumber: RegistrationNumberSchema,
  make: optionalLabel(80),
  model: optionalLabel(80),
  locationName: optionalLabel(100),
}).strict();
export const UpdateDetailerVehicleSchema = z.object({
  type: VehicleTypeSchema.optional(),
  registrationNumber: RegistrationNumberSchema.optional(),
  make: optionalLabel(80),
  model: optionalLabel(80),
  locationName: optionalLabel(100),
  status: VehicleStatusSchema.optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0, "At least one field must be provided");
export type CreateDetailerVehicleInput = z.infer<typeof CreateDetailerVehicleSchema>;
export type UpdateDetailerVehicleInput = z.infer<typeof UpdateDetailerVehicleSchema>;

export const WashActivitySchema = z.enum(["EXTERIOR_WASH", "INTERIOR_CLEANING", "TYRE_POLISH"]);
export type WashActivity = z.infer<typeof WashActivitySchema>;
export const TaskActivitySchema = z.enum([
  "DUSTING",
  "EXTERIOR_WASH",
  "INTERIOR_CLEANING",
  "TYRE_POLISH",
]);
export type TaskActivity = z.infer<typeof TaskActivitySchema>;
export const ScheduleFrequencySchema = z.enum(["DAILY", "SELECTED_DAYS"]);
export type ScheduleFrequency = z.infer<typeof ScheduleFrequencySchema>;

export const WashScheduleInputSchema = z.object({
  activity: WashActivitySchema,
  frequency: ScheduleFrequencySchema,
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  effectiveFrom: DateStringSchema,
  effectiveTo: DateStringSchema.nullable().optional(),
  isActive: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.weekdays).size !== value.weekdays.length) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Each weekday can be selected once" });
  }
  if (value.frequency === "SELECTED_DAYS" && value.weekdays.length === 0) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Select at least one weekday" });
  }
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "End date cannot be before the start date" });
  }
});
export const SaveSchedulesSchema = z.object({
  schedules: z.array(WashScheduleInputSchema).min(1).max(3),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const schedule of value.schedules) {
    if (seen.has(schedule.activity)) {
      context.addIssue({
        code: "custom",
        path: ["schedules"],
        message: `${schedule.activity} is listed more than once`,
      });
    }
    seen.add(schedule.activity);
  }
});
export type WashScheduleInput = z.infer<typeof WashScheduleInputSchema>;

export const DailyTaskStatusSchema = z.enum(["SCHEDULED", "COMPLETED", "MISSED", "UNAVAILABLE"]);
export type DailyTaskStatus = z.infer<typeof DailyTaskStatusSchema>;
export const DailyTaskExceptionSchema = z.enum([
  "VEHICLE_UNAVAILABLE",
  "WASH_MISSED",
  "DETAILER_ON_LEAVE",
]);
export type DailyTaskException = z.infer<typeof DailyTaskExceptionSchema>;

export const TaskQuerySchema = z.object({ date: DateStringSchema.optional() }).strict();
export const UpdateTaskSchema = z.object({
  status: DailyTaskStatusSchema,
  note: optionalLabel(500),
}).strict();
export const TaskExceptionRequestSchema = z.object({
  date: DateStringSchema,
  exception: DailyTaskExceptionSchema,
  vehicleId: z.string().uuid().optional(),
  active: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.exception === "DETAILER_ON_LEAVE" && value.vehicleId) {
    context.addIssue({ code: "custom", path: ["vehicleId"], message: "Leave applies to the whole day, not one vehicle" });
  }
  if (value.exception !== "DETAILER_ON_LEAVE" && !value.vehicleId) {
    context.addIssue({ code: "custom", path: ["vehicleId"], message: "Choose the vehicle this applies to" });
  }
});
export type TaskExceptionRequest = z.infer<typeof TaskExceptionRequestSchema>;

export type DetailerProfile = {
  displayName: string;
  phoneNumber: string | null;
  serviceArea: string | null;
  contactEmail: string | null;
  onboardingComplete: boolean;
};
export type DetailerClient = {
  id: string;
  name: string;
  phoneNumber: string;
  notes: string | null;
  status: VehicleStatus;
  vehicleCount: number;
};
export type DetailerVehicle = {
  id: string;
  clientId: string;
  type: VehicleType;
  registrationNumber: string;
  make: string | null;
  model: string | null;
  locationName: string | null;
  status: VehicleStatus;
};
export type WashSchedule = {
  id: string;
  vehicleId: string;
  activity: WashActivity;
  frequency: ScheduleFrequency;
  weekdays: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
};
export type DailyTask = {
  id: string;
  vehicleId: string;
  scheduleId: string | null;
  activity: TaskActivity;
  taskDate: string;
  status: DailyTaskStatus;
  exception: DailyTaskException | null;
  completedAt: string | null;
  note: string | null;
  registrationNumber: string;
  make: string | null;
  model: string | null;
  locationName: string | null;
  clientName: string;
};

// ---------------------------------------------------------------------------
// Society Vendor
// ---------------------------------------------------------------------------

export const SocietyProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  phoneNumber: IndianPhoneSchema.optional(),
  contactEmail: z.string().trim().email().max(254).optional().nullable(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const SocietyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: optionalLabel(240),
}).strict();
export const SocietyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: optionalLabel(240),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const SocietyResidentInputSchema = z.object({
  societyId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  phoneNumber: IndianPhoneSchema,
  unit: optionalLabel(40),
  email: z.string().trim().email().max(254).optional().nullable(),
}).strict();
export const SocietyResidentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phoneNumber: IndianPhoneSchema.optional(),
  unit: optionalLabel(40),
  email: z.string().trim().email().max(254).optional().nullable(),
  status: VehicleStatusSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const SocietyVehicleInputSchema = z.object({
  societyId: z.string().uuid(),
  residentId: z.string().uuid(),
  type: VehicleTypeSchema,
  registrationNumber: RegistrationNumberSchema,
  monthlyRatePaise: z.number().int().min(0).max(100_000_000),
}).strict();
export const SocietyVehicleUpdateSchema = z.object({
  type: VehicleTypeSchema.optional(),
  registrationNumber: RegistrationNumberSchema.optional(),
  monthlyRatePaise: z.number().int().min(0).max(100_000_000).optional(),
  status: VehicleStatusSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const SocietyWasherInputSchema = z.object({
  societyId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  phoneNumber: IndianPhoneSchema,
  ratePerTaskPaise: z.number().int().min(0).max(10_000_000),
}).strict();
export const SocietyWasherUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phoneNumber: IndianPhoneSchema.optional(),
  ratePerTaskPaise: z.number().int().min(0).max(10_000_000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const SocietyAssignmentInputSchema = z.object({
  vehicleId: z.string().uuid(),
  washerId: z.string().uuid(),
  startsAt: DateStringSchema,
}).strict();

export const SocietyAttendanceInputSchema = z.object({
  societyId: z.string().uuid(),
  washerId: z.string().uuid(),
  workDate: DateStringSchema,
  status: z.enum(["PRESENT", "ABSENT", "LEAVE"]),
  note: optionalLabel(500),
}).strict();

export const SocietyTaskQuerySchema = z.object({
  societyId: z.string().uuid().optional(),
  date: DateStringSchema.optional(),
}).strict();

export const SocietyTaskUpdateSchema = z.object({
  status: z.enum(["COMPLETED", "MISSED", "UNAVAILABLE"]),
  note: optionalLabel(500),
}).strict();

export const SocietyScheduleActivitySchema = z.enum([
  "EXTERIOR_WASH",
  "INTERIOR_CLEANING",
  "TYRE_POLISH",
]);
export const SocietyWashScheduleInputSchema = z.object({
  frequency: ScheduleFrequencySchema,
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  effectiveFrom: DateStringSchema,
  effectiveTo: DateStringSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.weekdays).size !== value.weekdays.length) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Each weekday can be selected once" });
  }
  if (value.frequency === "SELECTED_DAYS" && value.weekdays.length === 0) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Select at least one weekday" });
  }
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "End date cannot be before the start date" });
  }
});
export const SocietyWashScheduleStatusSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "STOPPED"]),
}).strict();
export type SocietyWashScheduleInput = z.infer<typeof SocietyWashScheduleInputSchema>;
export type SocietyScheduleActivity = z.infer<typeof SocietyScheduleActivitySchema>;

export const SocietyInvoiceGenerationSchema = z.object({
  societyId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Enter a month as YYYY-MM").refine((value) => {
    const [year, month] = value.split("-").map(Number);
    return year >= 2000 && month >= 1 && month <= 12;
  }, "Enter a valid calendar month"),
}).strict();

export const SocietyPaymentInputSchema = z.object({
  amountPaise: z.number().int().positive().max(100_000_000),
  method: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"]),
  reference: optionalLabel(120),
  note: optionalLabel(500),
}).strict();

export const SocietyReminderInputSchema = z.object({
  note: optionalLabel(500),
}).strict();

export const SocietyDeductionInputSchema = z.object({
  societyId: z.string().uuid(),
  washerId: z.string().uuid(),
  amountPaise: z.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const SocietyDeductionDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const SocietyExtraWorkInputSchema = z.object({
  societyId: z.string().uuid(),
  residentId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  description: z.string().trim().min(1).max(180),
  amountPaise: z.number().int().nonnegative().max(100_000_000),
  residentApproverName: z.string().trim().min(1).max(100),
  consentNote: z.string().trim().min(1).max(500),
  workDate: DateStringSchema,
}).strict();

export const SocietyExtraWorkDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type SocietyProfileUpdateInput = z.infer<typeof SocietyProfileUpdateSchema>;
export type SocietyInput = z.infer<typeof SocietyInputSchema>;
export type SocietyResidentInput = z.infer<typeof SocietyResidentInputSchema>;
export type SocietyVehicleInput = z.infer<typeof SocietyVehicleInputSchema>;
export type SocietyWasherInput = z.infer<typeof SocietyWasherInputSchema>;

// ---------------------------------------------------------------------------
// Marketplace Vendor
// ---------------------------------------------------------------------------

export const MarketplaceCategorySchema = z.enum([
  "GARAGE",
  "DETAILING_CENTRE",
  "MOBILE_DETAILER",
  "OTHER",
]);
export const MarketplaceServiceCategorySchema = z.enum([
  "EXTERIOR_WASH",
  "INTERIOR_CLEANING",
  "DETAILING",
  "POLISH_AND_COATING",
  "PERIODIC_SERVICE",
  "REPAIR",
  "TYRE_AND_WHEEL",
  "OTHER",
]);
export const MarketplaceVerificationStatusSchema = z.enum(["PENDING", "VERIFIED", "REJECTED"]);
export const MarketplaceServiceStatusSchema = z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]);
export const MarketplaceBookingStatusSchema = z.enum([
  "REQUESTED",
  "ACCEPTED",
  "REJECTED",
  "IN_PROGRESS",
  "PROVIDER_REPORTED_COMPLETION",
  "CUSTOMER_ACCEPTED",
  "DISPUTED",
  "SETTLED",
  "CLOSED",
  "CANCELLED",
]);
export const MarketplacePaymentStatusSchema = z.enum(["RECORDED_UNVERIFIED", "VERIFIED", "FAILED", "REFUNDED"]);
export const MarketplaceDisputeCategorySchema = z.enum([
  "SERVICE_QUALITY",
  "INCOMPLETE_WORK",
  "PRICE_OR_PAYMENT",
  "DAMAGE",
  "OTHER",
]);
export const MarketplaceDisputeOutcomeSchema = z.enum([
  "UPHELD_COMPLETION",
  "REWORK_REQUIRED",
  "CANCELLED_NO_CHARGE",
]);
export const MarketplaceDisputeStatusSchema = z.enum(["OPEN", "RESPONDED", "RESOLVED", "WITHDRAWN"]);
export const MarketplaceRefundStatusSchema = z.enum(["APPROVED_PENDING_EXTERNAL_TRANSFER", "CONFIRMED_EXTERNALLY"]);
export const MarketplaceCancellationKindSchema = z.enum([
  "OWNER_CANCELLED",
  "VENDOR_CANCELLED",
  "OWNER_NO_SHOW",
  "VENDOR_NO_SHOW",
  "DISPUTE_RESOLUTION",
]);
export const MarketplacePaymentMethodSchema = z.enum([
  "CASH",
  "UPI",
  "BANK_TRANSFER",
  "CARD",
  "OTHER",
]);
export type MarketplaceCategory = z.infer<typeof MarketplaceCategorySchema>;
export type MarketplaceServiceCategory = z.infer<typeof MarketplaceServiceCategorySchema>;
export type MarketplaceVerificationStatus = z.infer<typeof MarketplaceVerificationStatusSchema>;
export type MarketplaceServiceStatus = z.infer<typeof MarketplaceServiceStatusSchema>;
export type MarketplaceBookingStatus = z.infer<typeof MarketplaceBookingStatusSchema>;
export type MarketplacePaymentStatus = z.infer<typeof MarketplacePaymentStatusSchema>;
export type MarketplaceDisputeCategory = z.infer<typeof MarketplaceDisputeCategorySchema>;
export type MarketplaceDisputeOutcome = z.infer<typeof MarketplaceDisputeOutcomeSchema>;
export type MarketplaceDisputeStatus = z.infer<typeof MarketplaceDisputeStatusSchema>;
export type MarketplaceRefundStatus = z.infer<typeof MarketplaceRefundStatusSchema>;
export type MarketplaceCancellationKind = z.infer<typeof MarketplaceCancellationKindSchema>;
export type MarketplacePaymentMethod = z.infer<typeof MarketplacePaymentMethodSchema>;

const HttpUrlSchema = z.string().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Enter an http(s) URL");
const LabelListSchema = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);
const VehicleTypeListSchema = z.array(VehicleTypeSchema).min(1, "Select at least one vehicle type").max(3)
  .refine((value) => new Set(value).size === value.length, "Each vehicle type can be selected once");

export const MARKETPLACE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM in 24-hour time");
export const MarketplaceDayHoursSchema = z.object({
  open: TimeOfDaySchema,
  close: TimeOfDaySchema,
}).strict().refine((value) => value.open < value.close, "Closing time must be after opening time");
export const MarketplaceOperatingHoursSchema = z.object(
  Object.fromEntries(
    MARKETPLACE_WEEKDAYS.map((day) => [day, MarketplaceDayHoursSchema.nullable().optional()]),
  ) as Record<(typeof MARKETPLACE_WEEKDAYS)[number], z.ZodOptional<z.ZodNullable<typeof MarketplaceDayHoursSchema>>>,
).strict();
export type MarketplaceOperatingHours = z.infer<typeof MarketplaceOperatingHoursSchema>;

// Verification status is never client-writable; only an authorized review process may set it.
export const MarketplaceProfileInputSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  category: MarketplaceCategorySchema,
  contactPhone: IndianPhoneSchema,
  contactEmail: z.string().trim().email().max(254).optional().nullable(),
  addressLine: optionalLabel(240),
  city: optionalLabel(100),
  postalCode: optionalLabel(24),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  serviceRadiusKm: z.number().int().min(1).max(200).optional().nullable(),
  serviceAreas: LabelListSchema(20, 100).default([]),
  supportedVehicleTypes: VehicleTypeListSchema,
  operatingHours: MarketplaceOperatingHoursSchema.default({}),
  logoUrl: HttpUrlSchema.optional().nullable(),
  galleryUrls: z.array(HttpUrlSchema).max(10).default([]),
}).strict().superRefine((value, context) => {
  if ((value.latitude == null) !== (value.longitude == null)) {
    context.addIssue({
      code: "custom",
      path: ["latitude"],
      message: "Provide both latitude and longitude, or neither",
    });
  }
  if (value.serviceRadiusKm != null && value.latitude == null) {
    context.addIssue({
      code: "custom",
      path: ["serviceRadiusKm"],
      message: "A service radius needs a business location (latitude and longitude)",
    });
  }
});
export type MarketplaceProfileInput = z.infer<typeof MarketplaceProfileInputSchema>;

const ServiceFieldsShape = {
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  category: MarketplaceServiceCategorySchema,
  vehicleTypes: VehicleTypeListSchema,
  pricePaise: z.number().int().min(1, "Price must be greater than zero").max(100_000_000),
  durationMinutes: z.number().int().min(5, "Duration must be at least 5 minutes").max(1440),
  inclusions: LabelListSchema(20, 120),
  exclusions: LabelListSchema(20, 120),
  terms: z.string().trim().max(2000).optional().nullable(),
  serviceAreas: LabelListSchema(20, 100),
};
export const MarketplaceServiceInputSchema = z.object({
  ...ServiceFieldsShape,
  inclusions: ServiceFieldsShape.inclusions.default([]),
  exclusions: ServiceFieldsShape.exclusions.default([]),
  serviceAreas: ServiceFieldsShape.serviceAreas.default([]),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
}).strict();
export const MarketplaceServiceUpdateSchema = z.object({
  name: ServiceFieldsShape.name.optional(),
  description: ServiceFieldsShape.description,
  category: ServiceFieldsShape.category.optional(),
  vehicleTypes: ServiceFieldsShape.vehicleTypes.optional(),
  pricePaise: ServiceFieldsShape.pricePaise.optional(),
  durationMinutes: ServiceFieldsShape.durationMinutes.optional(),
  inclusions: ServiceFieldsShape.inclusions.optional(),
  exclusions: ServiceFieldsShape.exclusions.optional(),
  terms: ServiceFieldsShape.terms,
  serviceAreas: ServiceFieldsShape.serviceAreas.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
export const MarketplaceServiceStatusInputSchema = z.object({
  status: MarketplaceServiceStatusSchema,
}).strict();
export type MarketplaceServiceInput = z.infer<typeof MarketplaceServiceInputSchema>;
export type MarketplaceServiceUpdate = z.infer<typeof MarketplaceServiceUpdateSchema>;

export const MarketplaceStaffInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phoneNumber: IndianPhoneSchema.optional().nullable(),
  skills: LabelListSchema(20, 60).default([]),
  available: z.boolean().default(true),
}).strict();
export const MarketplaceStaffUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phoneNumber: IndianPhoneSchema.optional().nullable(),
  skills: LabelListSchema(20, 60).optional(),
  available: z.boolean().optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
export type MarketplaceStaffInput = z.infer<typeof MarketplaceStaffInputSchema>;
export type MarketplaceStaffUpdate = z.infer<typeof MarketplaceStaffUpdateSchema>;

export const MARKETPLACE_DEFAULT_RADIUS_KM = 10;
const OptionalNumberQuery = (schema: z.ZodNumber) => z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : Number(value)),
  schema.optional(),
);
export const MarketplaceDiscoveryQuerySchema = z.object({
  latitude: OptionalNumberQuery(z.number().min(-90).max(90)),
  longitude: OptionalNumberQuery(z.number().min(-180).max(180)),
  city: z.string().trim().min(1).max(100).optional(),
  radiusKm: OptionalNumberQuery(z.number().min(1).max(200)),
  category: MarketplaceServiceCategorySchema.optional(),
  vehicleType: VehicleTypeSchema.optional(),
  minPricePaise: OptionalNumberQuery(z.number().int().min(0).max(100_000_000)),
  maxPricePaise: OptionalNumberQuery(z.number().int().min(0).max(100_000_000)),
  sort: z.enum(["price_asc", "distance"]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    context.addIssue({ code: "custom", path: ["latitude"], message: "Provide both latitude and longitude" });
  }
  if (
    value.minPricePaise !== undefined &&
    value.maxPricePaise !== undefined &&
    value.minPricePaise > value.maxPricePaise
  ) {
    context.addIssue({ code: "custom", path: ["minPricePaise"], message: "Minimum price cannot exceed maximum price" });
  }
  if (value.sort === "distance" && value.latitude === undefined) {
    context.addIssue({ code: "custom", path: ["sort"], message: "Sorting by distance needs a coordinate location" });
  }
});
export type MarketplaceDiscoveryQuery = z.infer<typeof MarketplaceDiscoveryQuerySchema>;

export const MarketplaceIdempotencyKeySchema = z.string().regex(
  /^[A-Za-z0-9_-]{8,80}$/,
  "Idempotency-Key must be 8-80 letters, numbers, hyphens or underscores",
);
export const MarketplaceBookingInputSchema = z.object({
  vehicleId: z.string().uuid(),
  serviceId: z.string().uuid(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  serviceLocation: z.string().trim().min(1).max(240),
  accessNotes: z.string().trim().max(500).optional().nullable(),
}).strict().superRefine((value, context) => {
  const start = Date.parse(value.windowStart);
  const end = Date.parse(value.windowEnd);
  if (end <= start) {
    context.addIssue({ code: "custom", path: ["windowEnd"], message: "The window must end after it starts" });
  } else if (end - start > 24 * 60 * 60 * 1000) {
    context.addIssue({ code: "custom", path: ["windowEnd"], message: "The window cannot be longer than 24 hours" });
  }
});
export type MarketplaceBookingInput = z.infer<typeof MarketplaceBookingInputSchema>;

export const MarketplaceRejectInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();
export const MarketplaceCompletionInputSchema = z.object({
  notes: z.string().trim().min(1).max(1000),
  evidenceUrls: z.array(HttpUrlSchema).max(10).default([]),
}).strict();
export const MarketplaceDisputeInputSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  category: MarketplaceDisputeCategorySchema.default("OTHER"),
  description: z.string().trim().max(2000).optional().nullable(),
  evidenceUrls: z.array(HttpUrlSchema).max(10).default([]),
}).strict();
export const MarketplaceDisputeRespondInputSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  evidenceUrls: z.array(HttpUrlSchema).max(10).default([]),
}).strict();
export const MarketplaceDisputeResolveInputSchema = z.object({
  outcome: MarketplaceDisputeOutcomeSchema,
  rationale: z.string().trim().min(10).max(2000),
}).strict();
export const MarketplaceDisputeWithdrawInputSchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
}).strict();
export const AdminSuspensionInputSchema = z.object({
  reason: z.string().trim().min(5).max(500),
}).strict();
export const AdminAccountQuerySchema = z.object({
  role: ApiRoleSchema.optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AdminAuditQuerySchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const AdminPaymentQuerySchema = z.object({
  status: MarketplacePaymentStatusSchema.optional(),
});
export const MarketplaceCancelInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  noShow: z.boolean().default(false),
}).strict();
export const MarketplacePaymentVerifyInputSchema = z.object({
  evidenceReference: z.string().trim().min(3).max(200),
  note: optionalLabel(500),
}).strict();
export const MarketplacePaymentRejectInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();
export const MarketplaceRefundInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();
export const MarketplaceRefundConfirmInputSchema = z.object({
  evidenceReference: z.string().trim().min(3).max(200),
}).strict();
export const MarketplaceSettleInputSchema = z.object({
  note: optionalLabel(500),
}).strict();
export type MarketplaceDisputeInput = z.infer<typeof MarketplaceDisputeInputSchema>;
export const MarketplaceAssignStaffInputSchema = z.object({
  staffId: z.string().uuid().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
}).strict();
export const MarketplacePaymentRecordSchema = z.object({
  amountPaise: z.number().int().positive().max(100_000_000),
  method: MarketplacePaymentMethodSchema,
  reference: optionalLabel(120),
  note: optionalLabel(500),
}).strict();
export type MarketplaceCompletionInput = z.infer<typeof MarketplaceCompletionInputSchema>;
export type MarketplacePaymentRecordInput = z.infer<typeof MarketplacePaymentRecordSchema>;
