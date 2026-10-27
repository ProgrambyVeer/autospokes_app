import type {
  SocietyAssignmentInputSchema,
  SocietyAttendanceInputSchema,
  SocietyDeductionDecisionSchema,
  SocietyDeductionInputSchema,
  SocietyExtraWorkDecisionSchema,
  SocietyExtraWorkInputSchema,
  SocietyInvoiceGenerationSchema,
  SocietyPaymentInputSchema,
  SocietyProfileUpdateSchema,
  SocietyReminderInputSchema,
  SocietyResidentInputSchema,
  SocietyResidentUpdateSchema,
  SocietyScheduleActivitySchema,
  SocietyWashScheduleInputSchema,
  SocietyWashScheduleStatusSchema,
  SocietyUpdateSchema,
  SocietyTaskUpdateSchema,
  SocietyVehicleInputSchema,
  SocietyVehicleUpdateSchema,
  SocietyWasherInputSchema,
  SocietyWasherUpdateSchema,
} from "@autospokes/shared";
import type { z } from "zod";

type SocietyAction =
  | { type: "profile.read"; roleProfileId: string }
  | { type: "profile.update"; roleProfileId: string; input: z.infer<typeof SocietyProfileUpdateSchema> }
  | { type: "societies.list" }
  | { type: "societies.create"; input: { name: string; address?: string | null } }
  | { type: "societies.update"; societyId: string; input: z.infer<typeof SocietyUpdateSchema> }
  | { type: "residents.list"; societyId: string }
  | { type: "residents.create"; input: z.infer<typeof SocietyResidentInputSchema> }
  | { type: "residents.update"; residentId: string; input: z.infer<typeof SocietyResidentUpdateSchema> }
  | { type: "vehicles.list"; societyId: string; residentId?: string }
  | { type: "vehicles.create"; input: z.infer<typeof SocietyVehicleInputSchema> }
  | { type: "vehicles.update"; vehicleId: string; input: z.infer<typeof SocietyVehicleUpdateSchema> }
  | { type: "washers.list"; societyId: string }
  | { type: "washers.create"; input: z.infer<typeof SocietyWasherInputSchema> }
  | { type: "washers.update"; washerId: string; input: z.infer<typeof SocietyWasherUpdateSchema> }
  | { type: "assignments.list"; societyId?: string; vehicleId: string }
  | { type: "assignments.create"; input: z.infer<typeof SocietyAssignmentInputSchema> }
  | { type: "attendance.list"; societyId: string; date: string }
  | { type: "attendance.record"; input: z.infer<typeof SocietyAttendanceInputSchema> }
  | { type: "schedules.list"; vehicleId: string }
  | { type: "schedules.save"; vehicleId: string; activity: z.infer<typeof SocietyScheduleActivitySchema>; input: z.infer<typeof SocietyWashScheduleInputSchema> }
  | { type: "schedules.status"; scheduleId: string; input: z.infer<typeof SocietyWashScheduleStatusSchema> }
  | { type: "tasks.list"; societyId?: string; date: string }
  | { type: "tasks.update"; taskId: string; input: z.infer<typeof SocietyTaskUpdateSchema> }
  | { type: "invoices.generate"; input: z.infer<typeof SocietyInvoiceGenerationSchema> }
  | { type: "invoices.list"; societyId: string }
  | { type: "payments.create"; invoiceId: string; input: z.infer<typeof SocietyPaymentInputSchema> }
  | { type: "reminders.create"; invoiceId: string; input: z.infer<typeof SocietyReminderInputSchema> }
  | { type: "earnings.list"; societyId: string; washerId?: string }
  | { type: "deductions.list"; societyId: string; washerId?: string }
  | { type: "deductions.create"; input: z.infer<typeof SocietyDeductionInputSchema> }
  | { type: "deductions.decide"; deductionId: string; input: z.infer<typeof SocietyDeductionDecisionSchema> }
  | { type: "extra-work.list"; societyId: string }
  | { type: "extra-work.create"; input: z.infer<typeof SocietyExtraWorkInputSchema> }
  | { type: "extra-work.decide"; extraWorkId: string; input: z.infer<typeof SocietyExtraWorkDecisionSchema> };

export interface SocietyRepository {
  execute(accountId: string, actorId: string, action: SocietyAction): Promise<unknown>;
}

export type {
  SocietyAction,
};
