import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  DailyTask,
  DetailerClient,
  DetailerProfile,
  DetailerVehicle,
  WashSchedule,
} from "@autospokes/shared";
import type { DetailerRepository, GenerationCandidate } from "./repository.js";

const toDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const fromDate = (value: Date): string => value.toISOString().slice(0, 10);

const vehicleSelect = {
  id: true,
  clientId: true,
  type: true,
  registrationNumber: true,
  make: true,
  model: true,
  locationName: true,
  status: true,
} satisfies Prisma.DetailerVehicleSelect;

const scheduleSelect = {
  id: true,
  vehicleId: true,
  activity: true,
  frequency: true,
  weekdays: true,
  effectiveFrom: true,
  effectiveTo: true,
  isActive: true,
} satisfies Prisma.WashScheduleSelect;

const taskSelect = {
  id: true,
  vehicleId: true,
  scheduleId: true,
  activity: true,
  taskDate: true,
  status: true,
  exception: true,
  completedAt: true,
  note: true,
  vehicle: {
    select: {
      registrationNumber: true,
      make: true,
      model: true,
      locationName: true,
      client: { select: { name: true } },
    },
  },
} satisfies Prisma.DailyTaskSelect;

type SelectedSchedule = Prisma.WashScheduleGetPayload<{ select: typeof scheduleSelect }>;
type SelectedTask = Prisma.DailyTaskGetPayload<{ select: typeof taskSelect }>;

function scheduleView(schedule: SelectedSchedule): WashSchedule {
  return {
    ...schedule,
    effectiveFrom: fromDate(schedule.effectiveFrom),
    effectiveTo: schedule.effectiveTo ? fromDate(schedule.effectiveTo) : null,
  };
}

function taskView(task: SelectedTask): DailyTask {
  const { vehicle, ...rest } = task;
  return {
    ...rest,
    taskDate: fromDate(task.taskDate),
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    registrationNumber: vehicle.registrationNumber,
    make: vehicle.make,
    model: vehicle.model,
    locationName: vehicle.locationName,
    clientName: vehicle.client.name,
  };
}

function readString(data: Prisma.JsonValue, key: string): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function profileView(profile: { displayName: string; profileData: Prisma.JsonValue }): DetailerProfile {
  const phoneNumber = readString(profile.profileData, "phoneNumber");
  const serviceArea = readString(profile.profileData, "serviceArea");
  return {
    displayName: profile.displayName,
    phoneNumber,
    serviceArea,
    contactEmail: readString(profile.profileData, "contactEmail"),
    onboardingComplete: Boolean(phoneNumber && serviceArea),
  };
}

const profileWhere = { role: "INDEPENDENT_DETAILER" as const };

export class PrismaDetailerRepository implements DetailerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findProfile(roleProfileId: string, accountId: string) {
    const profile = await this.prisma.roleProfile.findFirst({
      where: { id: roleProfileId, accountId, ...profileWhere },
      select: { displayName: true, profileData: true },
    });
    return profile ? profileView(profile) : null;
  }

  async updateProfile(
    roleProfileId: string,
    accountId: string,
    input: Parameters<DetailerRepository["updateProfile"]>[2],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.roleProfile.findFirst({
        where: { id: roleProfileId, accountId, ...profileWhere },
        select: { displayName: true, profileData: true },
      });
      if (!profile) return null;
      const current =
        typeof profile.profileData === "object" &&
        profile.profileData !== null &&
        !Array.isArray(profile.profileData)
          ? profile.profileData
          : {};
      const profileData = { ...current } as Record<string, Prisma.JsonValue>;
      if (input.phoneNumber !== undefined) profileData.phoneNumber = input.phoneNumber;
      if (input.serviceArea !== undefined) profileData.serviceArea = input.serviceArea;
      if (input.contactEmail !== undefined) profileData.contactEmail = input.contactEmail;
      const updated = await tx.roleProfile.update({
        where: { id: roleProfileId },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          profileData: profileData as Prisma.InputJsonValue,
        },
        select: { displayName: true, profileData: true },
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_PROFILE_UPDATED" } });
      return profileView(updated);
    });
  }

  private clientView(client: {
    id: string;
    name: string;
    phoneNumber: string;
    notes: string | null;
    status: DetailerClient["status"];
    _count: { vehicles: number };
  }): DetailerClient {
    const { _count, ...rest } = client;
    return { ...rest, vehicleCount: _count.vehicles };
  }

  private readonly clientSelect = {
    id: true,
    name: true,
    phoneNumber: true,
    notes: true,
    status: true,
    _count: { select: { vehicles: true } },
  } satisfies Prisma.DetailerClientSelect;

  async listClients(accountId: string) {
    const clients = await this.prisma.detailerClient.findMany({
      where: { accountId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: this.clientSelect,
    });
    return clients.map((client) => this.clientView(client));
  }

  async findClient(accountId: string, clientId: string) {
    const client = await this.prisma.detailerClient.findFirst({
      where: { id: clientId, accountId },
      select: this.clientSelect,
    });
    return client ? this.clientView(client) : null;
  }

  async createClient(accountId: string, input: { name: string; phoneNumber: string; notes: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.detailerClient.create({
        data: { ...input, accountId },
        select: this.clientSelect,
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_CLIENT_CREATED" } });
      return this.clientView(client);
    });
  }

  async updateClient(
    accountId: string,
    clientId: string,
    input: Parameters<DetailerRepository["updateClient"]>[2],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.detailerClient.updateMany({
        where: { id: clientId, accountId },
        data: input,
      });
      if (result.count !== 1) return null;
      const client = await tx.detailerClient.findFirstOrThrow({
        where: { id: clientId, accountId },
        select: this.clientSelect,
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_CLIENT_UPDATED" } });
      return this.clientView(client);
    });
  }

  async listVehicles(accountId: string, clientId: string): Promise<DetailerVehicle[]> {
    return this.prisma.detailerVehicle.findMany({
      where: { accountId, clientId },
      orderBy: [{ registrationNumber: "asc" }, { id: "asc" }],
      select: vehicleSelect,
    });
  }

  async findVehicle(accountId: string, vehicleId: string): Promise<DetailerVehicle | null> {
    return this.prisma.detailerVehicle.findFirst({
      where: { id: vehicleId, accountId },
      select: vehicleSelect,
    });
  }

  async createVehicle(
    accountId: string,
    clientId: string,
    input: Parameters<DetailerRepository["createVehicle"]>[2],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.detailerClient.findFirst({
        where: { id: clientId, accountId },
        select: { id: true },
      });
      if (!client) return null;
      const vehicle = await tx.detailerVehicle.create({
        data: { ...input, accountId, clientId },
        select: vehicleSelect,
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_VEHICLE_CREATED" } });
      return vehicle;
    });
  }

  async updateVehicle(
    accountId: string,
    vehicleId: string,
    input: Parameters<DetailerRepository["updateVehicle"]>[2],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.detailerVehicle.updateMany({
        where: { id: vehicleId, accountId },
        data: input,
      });
      if (result.count !== 1) return null;
      const vehicle = await tx.detailerVehicle.findFirstOrThrow({
        where: { id: vehicleId, accountId },
        select: vehicleSelect,
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_VEHICLE_UPDATED" } });
      return vehicle;
    });
  }

  async listSchedules(accountId: string, vehicleId: string) {
    const schedules = await this.prisma.washSchedule.findMany({
      where: { accountId, vehicleId },
      orderBy: { activity: "asc" },
      select: scheduleSelect,
    });
    return schedules.map(scheduleView);
  }

  async saveSchedules(
    accountId: string,
    vehicleId: string,
    schedules: Parameters<DetailerRepository["saveSchedules"]>[2],
    today: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.detailerVehicle.findFirst({
        where: { id: vehicleId, accountId },
        select: { id: true },
      });
      if (!vehicle) return null;
      const saved: SelectedSchedule[] = [];
      for (const schedule of schedules) {
        const data = {
          taskActivityKey: schedule.activity,
          frequency: schedule.frequency,
          weekdays: schedule.weekdays,
          effectiveFrom: toDate(schedule.effectiveFrom),
          effectiveTo: schedule.effectiveTo ? toDate(schedule.effectiveTo) : null,
          isActive: schedule.isActive,
        };
        const row = await tx.washSchedule.upsert({
          where: { vehicleId_activity: { vehicleId, activity: schedule.activity } },
          create: { ...data, accountId, vehicleId, activity: schedule.activity },
          update: data,
          select: scheduleSelect,
        });
        saved.push(row);
        await tx.dailyTask.deleteMany({
          where: {
            accountId,
            scheduleId: row.id,
            status: "SCHEDULED",
            exception: null,
            taskDate: { gte: toDate(today) },
          },
        });
      }
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_SCHEDULE_SAVED" } });
      return saved.map(scheduleView);
    });
  }

  async listGenerationCandidates(accountId: string): Promise<GenerationCandidate[]> {
    const vehicles = await this.prisma.detailerVehicle.findMany({
      where: { accountId, status: "ACTIVE", client: { status: "ACTIVE" } },
      select: { id: true, createdAt: true, schedules: { select: scheduleSelect } },
    });
    return vehicles.map((vehicle) => ({
      vehicleId: vehicle.id,
      // Dusting begins on the IST calendar day the vehicle was added.
      startDate: fromDate(new Date(vehicle.createdAt.getTime() + 330 * 60_000)),
      schedules: vehicle.schedules.map(scheduleView),
    }));
  }

  async createTasks(accountId: string, tasks: Parameters<DetailerRepository["createTasks"]>[1]) {
    if (tasks.length === 0) return;
    await this.prisma.dailyTask.createMany({
      data: tasks.map((task) => ({
        accountId,
        vehicleId: task.vehicleId,
        scheduleId: task.scheduleId,
        activity: task.activity,
        taskDate: toDate(task.taskDate),
        status: task.status,
        exception: task.exception,
      })),
      skipDuplicates: true,
    });
  }

  async listTasks(accountId: string, date: string) {
    const tasks = await this.prisma.dailyTask.findMany({
      where: { accountId, taskDate: toDate(date) },
      orderBy: [{ vehicle: { registrationNumber: "asc" } }, { activity: "asc" }, { id: "asc" }],
      select: taskSelect,
    });
    return tasks.map(taskView);
  }

  async findTask(accountId: string, taskId: string) {
    const task = await this.prisma.dailyTask.findFirst({
      where: { id: taskId, accountId },
      select: taskSelect,
    });
    return task ? taskView(task) : null;
  }

  async updateTask(
    accountId: string,
    taskId: string,
    expected: Parameters<DetailerRepository["updateTask"]>[2],
    change: Parameters<DetailerRepository["updateTask"]>[3],
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.dailyTask.updateMany({
        where: { id: taskId, accountId, status: expected, exception: null },
        data: { status: change.status, note: change.note, completedAt: change.completedAt },
      });
      if (result.count !== 1) return null;
      const task = await tx.dailyTask.findFirstOrThrow({
        where: { id: taskId, accountId },
        select: taskSelect,
      });
      await tx.auditEvent.create({ data: { accountId, action: "DETAILER_TASK_UPDATED" } });
      return taskView(task);
    });
  }

  async setException(accountId: string, change: Parameters<DetailerRepository["setException"]>[1]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const scope: Prisma.DailyTaskWhereInput = {
            accountId,
            taskDate: toDate(change.date),
            ...(change.vehicleId ? { vehicleId: change.vehicleId } : {}),
          };
          if (!change.active) {
            const cleared = await tx.dailyTask.updateMany({
              where: { ...scope, exception: change.exception },
              data: { exception: null, status: "SCHEDULED", completedAt: null },
            });
            await tx.auditEvent.create({ data: { accountId, action: "DETAILER_EXCEPTION_CLEARED" } });
            return { updated: cleared.count };
          }
          // Leave blocks every vehicle exception on the day, and vice versa.
          const conflict = await tx.dailyTask.findFirst({
            where: {
              accountId,
              taskDate: toDate(change.date),
              exception: { not: null },
              NOT: { exception: change.exception },
              ...(change.exception === "DETAILER_ON_LEAVE"
                ? {}
                : {
                    OR: [{ vehicleId: change.vehicleId ?? undefined }, { exception: "DETAILER_ON_LEAVE" }],
                  }),
            },
            select: { id: true },
          });
          if (conflict) return null;
          const updated = await tx.dailyTask.updateMany({
            where: { ...scope, exception: null, status: "SCHEDULED" },
            data: {
              exception: change.exception,
              status: change.exception === "WASH_MISSED" ? "MISSED" : "UNAVAILABLE",
            },
          });
          await tx.auditEvent.create({ data: { accountId, action: "DETAILER_EXCEPTION_SET" } });
          return { updated: updated.count };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const isSerializationConflict =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2034";
        if (!isSerializationConflict || attempt >= 2) throw error;
      }
    }
  }
}
