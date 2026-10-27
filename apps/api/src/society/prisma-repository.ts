import { Prisma, type PrismaClient } from "@prisma/client";
import { istDateString, normalizeRegistrationNumber } from "@autospokes/shared";
import {
  assertPaymentWithinBalance,
  assignmentEndDate,
  canChangeSocietyScheduleStatus,
  canSetSocietyTaskStatus,
  earningSnapshot,
  invoiceTotalPaise,
  outstandingBalancePaise,
  societyScheduleDueOn,
} from "./business-rules.js";
import type { SocietyRepository, SocietyAction } from "./repository.js";

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const dateString = (value: Date): string => value.toISOString().slice(0, 10);
const activityToDatabase = (activity: "EXTERIOR_WASH" | "INTERIOR_CLEANING" | "TYRE_POLISH") =>
  activity === "EXTERIOR_WASH" ? "WASH" : activity;
const activityToApi = (activity: "WASH" | "INTERIOR_CLEANING" | "TYRE_POLISH") =>
  activity === "WASH" ? "EXTERIOR_WASH" : activity;

function societyScheduleView<T extends {
  activity: "WASH" | "INTERIOR_CLEANING" | "TYRE_POLISH";
  effectiveFrom: Date;
  effectiveTo: Date | null;
}>(schedule: T) {
  return {
    ...schedule,
    activity: activityToApi(schedule.activity),
    effectiveFrom: dateString(schedule.effectiveFrom),
    effectiveTo: schedule.effectiveTo ? dateString(schedule.effectiveTo) : null,
  };
}

// Persisted task rows keep the legacy "WASH" value; the public API always exposes "EXTERIOR_WASH".
function societyTaskView<T extends { activity: "WASH" | "INTERIOR_CLEANING" | "TYRE_POLISH" }>(task: T) {
  return { ...task, activity: activityToApi(task.activity) };
}

function jsonObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}

export class PrismaSocietyRepository implements SocietyRepository {
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  async execute(accountId: string, actorId: string, action: SocietyAction): Promise<unknown> {
    switch (action.type) {
      case "profile.read": {
        const profile = await this.prisma.roleProfile.findFirst({
          where: { id: action.roleProfileId, accountId, role: "SOCIETY_VENDOR" },
          select: { displayName: true, profileData: true },
        });
        if (!profile) return null;
        const data = jsonObject(profile.profileData);
        const phoneNumber = typeof data.phoneNumber === "string" ? data.phoneNumber : null;
        const contactEmail = typeof data.contactEmail === "string" ? data.contactEmail : null;
        return {
          displayName: profile.displayName,
          phoneNumber,
          contactEmail,
          onboardingComplete: Boolean(phoneNumber),
        };
      }
      case "profile.update": {
        return this.prisma.$transaction(async (tx) => {
          const current = await tx.roleProfile.findFirst({
            where: { id: action.roleProfileId, accountId, role: "SOCIETY_VENDOR" },
            select: { profileData: true },
          });
          if (!current) return null;
          const profileData = jsonObject(current.profileData);
          if (action.input.phoneNumber !== undefined) profileData.phoneNumber = action.input.phoneNumber;
          if (action.input.contactEmail !== undefined) profileData.contactEmail = action.input.contactEmail;
          const updated = await tx.roleProfile.update({
            where: { id: action.roleProfileId },
            data: {
              ...(action.input.displayName !== undefined ? { displayName: action.input.displayName } : {}),
              profileData: profileData as Prisma.InputJsonValue,
            },
            select: { displayName: true, profileData: true },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_PROFILE_UPDATED");
          const data = jsonObject(updated.profileData);
          return {
            displayName: updated.displayName,
            phoneNumber: typeof data.phoneNumber === "string" ? data.phoneNumber : null,
            contactEmail: typeof data.contactEmail === "string" ? data.contactEmail : null,
            onboardingComplete: typeof data.phoneNumber === "string",
          };
        });
      }
      case "societies.list":
        return this.prisma.society.findMany({
          where: { accountId },
          orderBy: { name: "asc" },
          include: { _count: { select: { residents: true, vehicles: true, washers: true } } },
        });
      case "societies.create":
        return this.prisma.$transaction(async (tx) => {
          const society = await tx.society.create({
            data: { accountId, name: action.input.name, address: action.input.address ?? null },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_CREATED", { societyId: society.id });
          return society;
        });
      case "societies.update":
        return this.prisma.$transaction(async (tx) => {
          const result = await tx.society.updateMany({
            where: { id: action.societyId, accountId },
            data: action.input,
          });
          if (!result.count) return null;
          await this.audit(tx, accountId, actorId, "SOCIETY_UPDATED", { societyId: action.societyId });
          return tx.society.findFirst({ where: { id: action.societyId, accountId } });
        });
      case "residents.list":
        return this.prisma.societyResident.findMany({
          where: { accountId, societyId: action.societyId },
          orderBy: { name: "asc" },
          include: { _count: { select: { vehicles: true } } },
        });
      case "residents.create":
        return this.prisma.$transaction(async (tx) => {
          if (!(await tx.society.findFirst({ where: { id: action.input.societyId, accountId } }))) return null;
          const resident = await tx.societyResident.create({
            data: {
              accountId,
              societyId: action.input.societyId,
              name: action.input.name,
              phoneNumber: action.input.phoneNumber,
              unit: action.input.unit ?? null,
              email: action.input.email ?? null,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_RESIDENT_CREATED", {
            societyId: resident.societyId,
            residentId: resident.id,
          });
          return resident;
        });
      case "residents.update":
        return this.prisma.$transaction(async (tx) => {
          const result = await tx.societyResident.updateMany({
            where: { id: action.residentId, accountId },
            data: action.input,
          });
          if (!result.count) return null;
          await this.audit(tx, accountId, actorId, "SOCIETY_RESIDENT_UPDATED", {
            residentId: action.residentId,
          });
          return tx.societyResident.findFirst({ where: { id: action.residentId, accountId } });
        });
      case "vehicles.list":
        return this.prisma.societyVehicle.findMany({
          where: {
            accountId,
            societyId: action.societyId,
            ...(action.residentId ? { residentId: action.residentId } : {}),
          },
          orderBy: { registrationNumberNormalized: "asc" },
          include: {
            resident: { select: { id: true, name: true, unit: true } },
            assignments: {
              where: { endsAt: null },
              include: { washer: { select: { id: true, name: true, status: true } } },
              take: 1,
            },
          },
        });
      case "vehicles.create":
        return this.prisma.$transaction(async (tx) => {
          const resident = await tx.societyResident.findFirst({
            where: { id: action.input.residentId, societyId: action.input.societyId, accountId },
            select: { id: true },
          });
          if (!resident) return null;
          const vehicle = await tx.societyVehicle.create({
            data: {
              accountId,
              societyId: action.input.societyId,
              residentId: action.input.residentId,
              type: action.input.type,
              registrationNumber: action.input.registrationNumber.trim(),
              registrationNumberNormalized: normalizeRegistrationNumber(action.input.registrationNumber),
              monthlyRatePaise: action.input.monthlyRatePaise,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_VEHICLE_CREATED", {
            societyId: vehicle.societyId,
            vehicleId: vehicle.id,
          });
          return vehicle;
        });
      case "vehicles.update":
        return this.prisma.$transaction(async (tx) => {
          const { registrationNumber, ...rest } = action.input;
          const result = await tx.societyVehicle.updateMany({
            where: { id: action.vehicleId, accountId },
            data: {
              ...rest,
              ...(registrationNumber !== undefined
                ? {
                    registrationNumber: registrationNumber.trim(),
                    registrationNumberNormalized: normalizeRegistrationNumber(registrationNumber),
                  }
                : {}),
            },
          });
          if (!result.count) return null;
          await this.audit(tx, accountId, actorId, "SOCIETY_VEHICLE_UPDATED", { vehicleId: action.vehicleId });
          return tx.societyVehicle.findFirst({ where: { id: action.vehicleId, accountId } });
        });
      case "washers.list":
        return this.prisma.societyWasher.findMany({
          where: { accountId, societyId: action.societyId },
          orderBy: { name: "asc" },
          include: {
            attendance: { where: { workDate: date(istDateString(this.now())) }, take: 1 },
            assignments: { where: { endsAt: null }, select: { id: true } },
          },
        });
      case "washers.create":
        return this.prisma.$transaction(async (tx) => {
          if (!(await tx.society.findFirst({ where: { id: action.input.societyId, accountId } }))) return null;
          const washer = await tx.societyWasher.create({
            data: {
              accountId,
              societyId: action.input.societyId,
              name: action.input.name,
              phoneNumber: action.input.phoneNumber,
              ratePerTaskPaise: action.input.ratePerTaskPaise,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_WASHER_CREATED", {
            societyId: washer.societyId,
            washerId: washer.id,
          });
          return washer;
        });
      case "washers.update":
        return this.prisma.$transaction(async (tx) => {
          const result = await tx.societyWasher.updateMany({
            where: { id: action.washerId, accountId },
            data: action.input,
          });
          if (!result.count) return null;
          if (action.input.status === "INACTIVE") {
            const today = date(istDateString(this.now()));
            const assignments = await tx.societyWasherAssignment.findMany({
              where: { accountId, washerId: action.washerId, endsAt: null },
              select: { id: true, startsAt: true },
            });
            for (const assignment of assignments) {
              await tx.societyWasherAssignment.update({
                where: { id: assignment.id },
                data: { endsAt: assignment.startsAt > today ? assignment.startsAt : today },
              });
            }
          }
          await this.audit(tx, accountId, actorId, "SOCIETY_WASHER_UPDATED", { washerId: action.washerId });
          return tx.societyWasher.findFirst({ where: { id: action.washerId, accountId } });
        });
      case "assignments.list":
        return this.prisma.societyWasherAssignment.findMany({
          where: {
            accountId,
            vehicleId: action.vehicleId,
            ...(action.societyId ? { societyId: action.societyId } : {}),
          },
          orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
          include: { washer: { select: { id: true, name: true } } },
        });
      case "assignments.create":
        return this.prisma.$transaction(async (tx) => {
          const vehicle = await tx.societyVehicle.findFirst({
            where: { id: action.input.vehicleId, accountId, status: "ACTIVE" },
            select: { id: true, societyId: true },
          });
          const washer = await tx.societyWasher.findFirst({
            where: {
              id: action.input.washerId,
              accountId,
              ...(vehicle ? { societyId: vehicle.societyId } : {}),
              status: "ACTIVE",
            },
            select: { id: true },
          });
          if (!vehicle || !washer) return null;
          const start = date(action.input.startsAt);
          const current = await tx.societyWasherAssignment.findFirst({
            where: { accountId, vehicleId: vehicle.id, endsAt: null },
            orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
          });
          const overlapping = await tx.societyWasherAssignment.findMany({
            where: {
              accountId,
              vehicleId: vehicle.id,
              ...(current ? { id: { not: current.id } } : {}),
              startsAt: { lte: start },
              endsAt: { gte: start },
            },
            select: { startsAt: true },
          });
          if (overlapping.some((item) => dateString(item.startsAt) !== action.input.startsAt)) {
            throw Object.assign(new Error("Reassignment overlaps another scheduled assignment"), { statusCode: 409 });
          }
          const futureAssignment = await tx.societyWasherAssignment.findFirst({
            where: {
              accountId,
              vehicleId: vehicle.id,
              startsAt: { gt: start },
              OR: [{ endsAt: null }, { endsAt: { gte: start } }],
            },
            select: { id: true },
          });
          if (futureAssignment) {
            throw Object.assign(new Error("Reassignment cannot begin before a future scheduled assignment"), { statusCode: 409 });
          }
          if (current) {
            const endDate = date(assignmentEndDate(dateString(current.startsAt), action.input.startsAt));
            await tx.societyWasherAssignment.update({
              where: { id: current.id },
              data: { endsAt: endDate },
            });
          }
          const assignment = await tx.societyWasherAssignment.create({
            data: {
              accountId,
              societyId: vehicle.societyId,
              vehicleId: vehicle.id,
              washerId: washer.id,
              startsAt: start,
              assignedBy: actorId,
            },
            include: { washer: { select: { id: true, name: true } } },
          });
          await tx.societyWashTask.updateMany({
            where: {
              accountId,
              vehicleId: vehicle.id,
              taskDate: { gte: start },
              status: "SCHEDULED",
            },
            data: { assignmentId: assignment.id, washerId: washer.id },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_WASHER_ASSIGNED", {
            societyId: vehicle.societyId,
            vehicleId: vehicle.id,
            washerId: washer.id,
          });
          return assignment;
        });
      case "attendance.list":
        return this.prisma.societyAttendance.findMany({
          where: { accountId, societyId: action.societyId, workDate: date(action.date) },
          include: { washer: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        });
      case "attendance.record":
        return this.prisma.$transaction(async (tx) => {
          const washer = await tx.societyWasher.findFirst({
            where: { id: action.input.washerId, societyId: action.input.societyId, accountId },
          });
          if (!washer) return null;
          const row = await tx.societyAttendance.upsert({
            where: { washerId_workDate: { washerId: washer.id, workDate: date(action.input.workDate) } },
            create: {
              accountId,
              societyId: action.input.societyId,
              washerId: washer.id,
              workDate: date(action.input.workDate),
              status: action.input.status,
              note: action.input.note ?? null,
              recordedBy: actorId,
            },
            update: { status: action.input.status, note: action.input.note ?? null, recordedBy: actorId },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_ATTENDANCE_RECORDED", {
            societyId: row.societyId,
            washerId: row.washerId,
            date: action.input.workDate,
          });
          return row;
        });
      case "schedules.list": {
        const vehicle = await this.prisma.societyVehicle.findFirst({
          where: { id: action.vehicleId, accountId },
          select: { id: true },
        });
        if (!vehicle) return null;
        const schedules = await this.prisma.societyWashSchedule.findMany({
          where: { accountId, vehicleId: vehicle.id },
          orderBy: { activity: "asc" },
        });
        return schedules.map(societyScheduleView);
      }
      case "schedules.save":
        return this.prisma.$transaction(async (tx) => {
          const vehicle = await tx.societyVehicle.findFirst({
            where: { id: action.vehicleId, accountId },
            select: { id: true, societyId: true },
          });
          if (!vehicle) return null;
          const activity = activityToDatabase(action.activity);
          const current = await tx.societyWashSchedule.findUnique({
            where: { vehicleId_activity: { vehicleId: vehicle.id, activity } },
            select: { status: true },
          });
          const row = await tx.societyWashSchedule.upsert({
            where: { vehicleId_activity: { vehicleId: vehicle.id, activity } },
            create: {
              accountId,
              societyId: vehicle.societyId,
              vehicleId: vehicle.id,
              activity,
              frequency: action.input.frequency,
              weekdays: action.input.frequency === "DAILY"
                ? [1, 2, 3, 4, 5, 6, 7]
                : [...action.input.weekdays].sort((a, b) => a - b),
              effectiveFrom: date(action.input.effectiveFrom),
              effectiveTo: action.input.effectiveTo ? date(action.input.effectiveTo) : null,
              status: "ACTIVE",
            },
            update: {
              frequency: action.input.frequency,
              weekdays: action.input.frequency === "DAILY"
                ? [1, 2, 3, 4, 5, 6, 7]
                : [...action.input.weekdays].sort((a, b) => a - b),
              effectiveFrom: date(action.input.effectiveFrom),
              effectiveTo: action.input.effectiveTo ? date(action.input.effectiveTo) : null,
              status: current?.status === "PAUSED" ? "PAUSED" : "ACTIVE",
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_WASH_SCHEDULE_SAVED", {
            societyId: vehicle.societyId,
            vehicleId: vehicle.id,
            activity: action.activity,
            scheduleId: row.id,
          });
          return societyScheduleView(row);
        });
      case "schedules.status":
        return this.prisma.$transaction(async (tx) => {
          const schedule = await tx.societyWashSchedule.findFirst({
            where: { id: action.scheduleId, accountId },
            select: { id: true, status: true, societyId: true, vehicleId: true },
          });
          if (!schedule) return null;
          if (!canChangeSocietyScheduleStatus(schedule.status, action.input.status)) {
            throw Object.assign(new Error("Stopped schedules cannot be resumed"), { statusCode: 409 });
          }
          const updated = await tx.societyWashSchedule.updateMany({
            where: { id: schedule.id, accountId, status: schedule.status },
            data: { status: action.input.status },
          });
          if (!updated.count) return null;
          await this.audit(tx, accountId, actorId, `SOCIETY_WASH_SCHEDULE_${action.input.status}`, {
            societyId: schedule.societyId,
            vehicleId: schedule.vehicleId,
            scheduleId: schedule.id,
          });
          const result = await tx.societyWashSchedule.findFirst({
            where: { id: schedule.id, accountId },
          });
          return result ? societyScheduleView(result) : null;
        });
      case "tasks.list": {
        const targetDate = date(action.date);
        const vehicles = await this.prisma.societyVehicle.findMany({
          where: {
            accountId,
            status: "ACTIVE",
            ...(action.societyId ? { societyId: action.societyId } : {}),
          },
          select: { id: true, societyId: true },
        });
        const schedules = vehicles.length
          ? await this.prisma.societyWashSchedule.findMany({
              where: {
                accountId,
                vehicleId: { in: vehicles.map((vehicle) => vehicle.id) },
                status: "ACTIVE",
                effectiveFrom: { lte: targetDate },
                OR: [{ effectiveTo: null }, { effectiveTo: { gte: targetDate } }],
              },
            })
          : [];
        const dueSchedules = schedules.filter((schedule) => societyScheduleDueOn({
          frequency: schedule.frequency,
          weekdays: schedule.weekdays,
          effectiveFrom: dateString(schedule.effectiveFrom),
          effectiveTo: schedule.effectiveTo ? dateString(schedule.effectiveTo) : null,
          status: schedule.status,
        }, action.date));
        const rows = await Promise.all(dueSchedules.map(async (schedule) => {
          const vehicle = vehicles.find((item) => item.id === schedule.vehicleId);
          if (!vehicle) return null;
          const assignment = await this.prisma.societyWasherAssignment.findFirst({
            where: {
              accountId,
              vehicleId: vehicle.id,
              startsAt: { lte: targetDate },
              OR: [{ endsAt: null }, { endsAt: { gte: targetDate } }],
              washer: { is: { status: "ACTIVE" } },
            },
            orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
            select: { id: true, washerId: true },
          });
          return {
            accountId,
            societyId: vehicle.societyId,
            vehicleId: vehicle.id,
            scheduleId: schedule.id,
            assignmentId: assignment?.id ?? null,
            washerId: assignment?.washerId ?? null,
            activity: schedule.activity,
            taskDate: targetDate,
          };
        }));
        const taskRows = rows.filter((row): row is NonNullable<typeof row> => row !== null);
        if (taskRows.length) {
          await this.prisma.societyWashTask.createMany({
            data: taskRows,
            skipDuplicates: true,
          });
        }
        const listed = await this.prisma.societyWashTask.findMany({
          where: {
            accountId,
            taskDate: targetDate,
            ...(action.societyId ? { societyId: action.societyId } : {}),
          },
          include: {
            vehicle: { select: { registrationNumber: true, resident: { select: { name: true, unit: true } } } },
            assignment: { include: { washer: { select: { name: true } } } },
          },
          orderBy: [{ societyId: "asc" }, { vehicle: { registrationNumberNormalized: "asc" } }],
        });
        return listed.map(societyTaskView);
      }
      case "tasks.update":
        return this.prisma.$transaction(async (tx) => {
          const task = await tx.societyWashTask.findFirst({
            where: { id: action.taskId, accountId },
            include: { assignment: { include: { washer: { select: { ratePerTaskPaise: true } } } } },
          });
          if (!task) return null;
          if (!canSetSocietyTaskStatus(task.status, action.input.status)) {
            throw Object.assign(new Error("Only scheduled tasks can be updated"), { statusCode: 409 });
          }
          const completed = action.input.status === "COMPLETED";
          const updated = await tx.societyWashTask.updateMany({
            where: { id: task.id, accountId, status: "SCHEDULED" },
            data: {
              status: action.input.status,
              note: action.input.note ?? null,
              completedAt: completed ? this.now() : null,
              completedBy: completed ? actorId : null,
              earningRatePaise: earningSnapshot(
                action.input.status,
                task.assignment ? task.assignment.washer.ratePerTaskPaise : null,
              ),
            },
          });
          if (!updated.count) return null;
          await this.audit(tx, accountId, actorId, `SOCIETY_TASK_${action.input.status}`, {
            societyId: task.societyId,
            taskId: task.id,
          });
          const result = await tx.societyWashTask.findUnique({ where: { id: task.id } });
          return result ? societyTaskView(result) : null;
        });
      case "invoices.generate":
        return this.generateInvoices(accountId, actorId, action.input.societyId, action.input.month);
      case "invoices.list":
        return this.invoiceList(accountId, action.societyId);
      case "payments.create":
        return this.prisma.$transaction(async (tx) => {
          const invoice = await tx.societyInvoice.findFirst({
            where: { id: action.invoiceId, accountId, status: "ISSUED" },
            include: { payments: { select: { amountPaise: true } } },
          });
          if (!invoice) return null;
          const outstanding = outstandingBalancePaise(invoice.totalPaise, invoice.payments.map((payment) => payment.amountPaise));
          assertPaymentWithinBalance(action.input.amountPaise, outstanding);
          const payment = await tx.societyPayment.create({
            data: {
              accountId,
              invoiceId: invoice.id,
              amountPaise: action.input.amountPaise,
              method: action.input.method,
              reference: action.input.reference ?? null,
              note: action.input.note ?? null,
              recordedBy: actorId,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_PAYMENT_RECORDED", {
            invoiceId: invoice.id,
            paymentId: payment.id,
            amountPaise: payment.amountPaise,
          });
          return payment;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      case "reminders.create":
        return this.prisma.$transaction(async (tx) => {
          const invoice = await tx.societyInvoice.findFirst({
            where: { id: action.invoiceId, accountId, status: "ISSUED" },
            include: { payments: { select: { amountPaise: true } } },
          });
          if (!invoice) return null;
          const outstanding = outstandingBalancePaise(invoice.totalPaise, invoice.payments.map((payment) => payment.amountPaise));
          if (outstanding <= 0) throw Object.assign(new Error("Paid invoices do not need a reminder"), { statusCode: 409 });
          const reminder = await tx.societyPaymentReminder.create({
            data: { accountId, invoiceId: invoice.id, note: action.input.note ?? null, createdBy: actorId },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_INTERNAL_PAYMENT_REMINDER_CREATED", {
            invoiceId: invoice.id,
            reminderId: reminder.id,
          });
          return { ...reminder, delivery: "internal_record_only" };
        });
      case "earnings.list":
        return (await this.prisma.societyWashTask.findMany({
          where: {
            accountId,
            societyId: action.societyId,
            status: "COMPLETED",
            earningRatePaise: { not: null },
            ...(action.washerId ? { washerId: action.washerId } : {}),
          },
          include: {
            vehicle: { select: { registrationNumber: true } },
            assignment: { include: { washer: { select: { id: true, name: true } } } },
          },
          orderBy: { taskDate: "desc" },
        })).map(societyTaskView);
      case "deductions.list":
        return this.prisma.societyWasherDeduction.findMany({
          where: {
            accountId,
            societyId: action.societyId,
            ...(action.washerId ? { washerId: action.washerId } : {}),
          },
          include: { washer: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        });
      case "deductions.create":
        return this.prisma.$transaction(async (tx) => {
          const washer = await tx.societyWasher.findFirst({
            where: { id: action.input.washerId, societyId: action.input.societyId, accountId },
          });
          if (!washer) return null;
          const deduction = await tx.societyWasherDeduction.create({
            data: {
              accountId,
              societyId: action.input.societyId,
              washerId: washer.id,
              amountPaise: action.input.amountPaise,
              reason: action.input.reason,
              requestedBy: actorId,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_DEDUCTION_REQUESTED", {
            deductionId: deduction.id,
            societyId: deduction.societyId,
            washerId: deduction.washerId,
          });
          return deduction;
        });
      case "deductions.decide":
        return this.prisma.$transaction(async (tx) => {
          const changed = await tx.societyWasherDeduction.updateMany({
            where: { id: action.deductionId, accountId, status: "PENDING" },
            data: {
              status: action.input.decision,
              decidedBy: actorId,
              decidedAt: this.now(),
              decisionReason: action.input.reason,
            },
          });
          if (!changed.count) return null;
          await this.audit(tx, accountId, actorId, `SOCIETY_DEDUCTION_${action.input.decision}`, {
            deductionId: action.deductionId,
            reason: action.input.reason,
          });
          return tx.societyWasherDeduction.findFirst({ where: { id: action.deductionId, accountId } });
        });
      case "extra-work.list":
        return this.prisma.societyExtraWork.findMany({
          where: { accountId, societyId: action.societyId },
          include: { resident: { select: { name: true, unit: true } }, vehicle: { select: { registrationNumber: true } } },
          orderBy: { createdAt: "desc" },
        });
      case "extra-work.create":
        return this.prisma.$transaction(async (tx) => {
          const vehicle = await tx.societyVehicle.findFirst({
            where: {
              id: action.input.vehicleId,
              residentId: action.input.residentId,
              societyId: action.input.societyId,
              accountId,
            },
          });
          if (!vehicle) return null;
          const work = await tx.societyExtraWork.create({
            data: {
              accountId,
              societyId: action.input.societyId,
              residentId: action.input.residentId,
              vehicleId: action.input.vehicleId,
              description: action.input.description,
              amountPaise: action.input.amountPaise,
              residentApproverName: action.input.residentApproverName,
              consentNote: action.input.consentNote,
              workDate: date(action.input.workDate),
              requestedBy: actorId,
            },
          });
          await this.audit(tx, accountId, actorId, "SOCIETY_EXTRA_WORK_RECORDED", {
            extraWorkId: work.id,
            societyId: work.societyId,
            vehicleId: work.vehicleId,
          });
          return work;
        });
      case "extra-work.decide":
        return this.prisma.$transaction(async (tx) => {
          const changed = await tx.societyExtraWork.updateMany({
            where: { id: action.extraWorkId, accountId, status: "PENDING" },
            data: {
              status: action.input.decision,
              decidedBy: actorId,
              decidedAt: this.now(),
              decisionReason: action.input.reason,
            },
          });
          if (!changed.count) return null;
          await this.audit(tx, accountId, actorId, `SOCIETY_EXTRA_WORK_${action.input.decision}`, {
            extraWorkId: action.extraWorkId,
            reason: action.input.reason,
          });
          return tx.societyExtraWork.findFirst({ where: { id: action.extraWorkId, accountId } });
        });
    }
  }

  private async generateInvoices(accountId: string, actorId: string, societyId: string, month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
    const dueDate = new Date(Date.UTC(year, monthNumber, 10));
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.society.findFirst({ where: { id: societyId, accountId } }))) return null;
      const residents = await tx.societyResident.findMany({
        where: { accountId, societyId, status: "ACTIVE" },
        include: {
          vehicles: { where: { status: "ACTIVE" }, select: { id: true, registrationNumber: true, monthlyRatePaise: true } },
          extraWork: {
            where: { status: "APPROVED", workDate: { gte: monthStart, lt: nextMonth } },
            select: { description: true, amountPaise: true },
          },
        },
      });
      const created: string[] = [];
      for (const resident of residents) {
        if (!resident.vehicles.length && !resident.extraWork.length) continue;
        if (await tx.societyInvoice.findFirst({
          where: { accountId, residentId: resident.id, monthStart },
          select: { id: true },
        })) continue;
        const extrasPaise = resident.extraWork.reduce((sum, work) => sum + work.amountPaise, 0);
        const totalPaise = invoiceTotalPaise([
          ...resident.vehicles.map((vehicle) => vehicle.monthlyRatePaise),
          extrasPaise,
        ]);
        const invoice = await tx.societyInvoice.create({
          data: {
            accountId,
            societyId,
            residentId: resident.id,
            monthStart,
            dueDate,
            totalPaise,
            createdBy: actorId,
          },
        });
        await tx.societyInvoiceLine.createMany({
          data: [
            ...resident.vehicles.map((vehicle) => ({
              accountId,
              invoiceId: invoice.id,
              vehicleId: vehicle.id,
              description: `Monthly vehicle plan — ${vehicle.registrationNumber}`,
              amountPaise: vehicle.monthlyRatePaise,
            })),
            ...(resident.extraWork.length
              ? [{
                  accountId,
                  invoiceId: invoice.id,
                  vehicleId: null,
                  description: `Approved extra work: ${resident.extraWork.map((work) => work.description).join(", ")}`.slice(0, 180),
                  amountPaise: extrasPaise,
                }]
              : []),
          ],
        });
        created.push(invoice.id);
        await this.audit(tx, accountId, actorId, "SOCIETY_MONTHLY_INVOICE_ISSUED", {
          invoiceId: invoice.id,
          societyId,
          month,
        });
      }
      return { month, createdCount: created.length, invoiceIds: created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async invoiceList(accountId: string, societyId: string) {
    const invoices = await this.prisma.societyInvoice.findMany({
      where: { accountId, societyId },
      include: {
        resident: { select: { name: true, phoneNumber: true, unit: true } },
        lines: true,
        payments: { orderBy: { receivedAt: "asc" } },
        reminders: { orderBy: { createdAt: "desc" } },
      },
      orderBy: { monthStart: "desc" },
    });
    return invoices.map((invoice) => ({
      ...invoice,
      paidPaise: invoice.totalPaise - outstandingBalancePaise(invoice.totalPaise, invoice.payments.map((payment) => payment.amountPaise)),
      outstandingPaise: outstandingBalancePaise(invoice.totalPaise, invoice.payments.map((payment) => payment.amountPaise)),
    }));
  }

  private async audit(
    tx: Prisma.TransactionClient,
    accountId: string,
    actorId: string,
    action: string,
    details?: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: { accountId, actorId, action, ...(details ? { details } : {}) },
    });
  }
}
