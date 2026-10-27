import { randomUUID } from "node:crypto";
import {
  istDateString,
  type DailyTask,
  type DetailerClient,
  type DetailerProfile,
  type DetailerVehicle,
  type WashSchedule,
} from "@autospokes/shared";
import type {
  DetailerRepository,
  GenerationCandidate,
  NewTask,
} from "../../src/detailer/repository.js";

type ClientRow = Omit<DetailerClient, "vehicleCount"> & { accountId: string };
type VehicleRow = DetailerVehicle & {
  accountId: string;
  registrationNumberNormalized: string;
  createdAt: Date;
};
type ScheduleRow = WashSchedule & { accountId: string };
type TaskRow = Omit<
  DailyTask,
  "registrationNumber" | "make" | "model" | "locationName" | "clientName"
> & { accountId: string };

const uniqueViolation = (): Error => Object.assign(new Error("Unique constraint"), { code: "P2002" });

export class MemoryDetailerRepository implements DetailerRepository {
  readonly profiles = new Map<string, DetailerProfile & { accountId: string }>();
  readonly clients: ClientRow[] = [];
  readonly vehicles: VehicleRow[] = [];
  readonly schedules: ScheduleRow[] = [];
  readonly tasks: TaskRow[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  addProfile(roleProfileId: string, accountId: string, displayName: string): void {
    this.profiles.set(roleProfileId, {
      accountId,
      displayName,
      phoneNumber: null,
      serviceArea: null,
      contactEmail: null,
      onboardingComplete: false,
    });
  }

  async findProfile(roleProfileId: string, accountId: string) {
    const profile = this.profiles.get(roleProfileId);
    if (!profile || profile.accountId !== accountId) return null;
    return {
      displayName: profile.displayName,
      phoneNumber: profile.phoneNumber,
      serviceArea: profile.serviceArea,
      contactEmail: profile.contactEmail,
      onboardingComplete: profile.onboardingComplete,
    };
  }

  async updateProfile(
    roleProfileId: string,
    accountId: string,
    input: Parameters<DetailerRepository["updateProfile"]>[2],
  ) {
    const profile = this.profiles.get(roleProfileId);
    if (!profile || profile.accountId !== accountId) return null;
    Object.assign(profile, input);
    profile.onboardingComplete = Boolean(profile.phoneNumber && profile.serviceArea);
    return this.findProfile(roleProfileId, accountId);
  }

  private clientView(client: ClientRow): DetailerClient {
    return {
      id: client.id,
      name: client.name,
      phoneNumber: client.phoneNumber,
      notes: client.notes,
      status: client.status,
      vehicleCount: this.vehicles.filter((v) => v.clientId === client.id).length,
    };
  }

  async listClients(accountId: string) {
    return this.clients
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => this.clientView(c));
  }

  async findClient(accountId: string, clientId: string) {
    const client = this.clients.find((c) => c.id === clientId && c.accountId === accountId);
    return client ? this.clientView(client) : null;
  }

  async createClient(accountId: string, input: { name: string; phoneNumber: string; notes: string | null }) {
    if (this.clients.some((c) => c.accountId === accountId && c.phoneNumber === input.phoneNumber)) {
      throw uniqueViolation();
    }
    const client: ClientRow = { id: randomUUID(), accountId, status: "ACTIVE", ...input };
    this.clients.push(client);
    return this.clientView(client);
  }

  async updateClient(accountId: string, clientId: string, input: Parameters<DetailerRepository["updateClient"]>[2]) {
    const client = this.clients.find((c) => c.id === clientId && c.accountId === accountId);
    if (!client) return null;
    if (
      input.phoneNumber !== undefined &&
      this.clients.some((c) => c.accountId === accountId && c.id !== clientId && c.phoneNumber === input.phoneNumber)
    ) {
      throw uniqueViolation();
    }
    Object.assign(client, input);
    return this.clientView(client);
  }

  private vehicleView(vehicle: VehicleRow): DetailerVehicle {
    return {
      id: vehicle.id,
      clientId: vehicle.clientId,
      type: vehicle.type,
      registrationNumber: vehicle.registrationNumber,
      make: vehicle.make,
      model: vehicle.model,
      locationName: vehicle.locationName,
      status: vehicle.status,
    };
  }

  async listVehicles(accountId: string, clientId: string) {
    return this.vehicles
      .filter((v) => v.accountId === accountId && v.clientId === clientId)
      .map((v) => this.vehicleView(v));
  }

  async findVehicle(accountId: string, vehicleId: string) {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId && v.accountId === accountId);
    return vehicle ? this.vehicleView(vehicle) : null;
  }

  async createVehicle(accountId: string, clientId: string, input: Parameters<DetailerRepository["createVehicle"]>[2]) {
    if (!this.clients.some((c) => c.id === clientId && c.accountId === accountId)) return null;
    if (
      this.vehicles.some(
        (v) =>
          v.accountId === accountId &&
          v.registrationNumberNormalized === input.registrationNumberNormalized,
      )
    ) {
      throw uniqueViolation();
    }
    const vehicle: VehicleRow = {
      id: randomUUID(),
      accountId,
      clientId,
      type: input.type,
      registrationNumber: input.registrationNumber,
      registrationNumberNormalized: input.registrationNumberNormalized,
      make: input.make ?? null,
      model: input.model ?? null,
      locationName: input.locationName ?? null,
      status: "ACTIVE",
      createdAt: this.clock(),
    };
    this.vehicles.push(vehicle);
    return this.vehicleView(vehicle);
  }

  async updateVehicle(accountId: string, vehicleId: string, input: Parameters<DetailerRepository["updateVehicle"]>[2]) {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId && v.accountId === accountId);
    if (!vehicle) return null;
    if (
      input.registrationNumberNormalized !== undefined &&
      this.vehicles.some(
        (v) =>
          v.accountId === accountId &&
          v.id !== vehicleId &&
          v.registrationNumberNormalized === input.registrationNumberNormalized,
      )
    ) {
      throw uniqueViolation();
    }
    Object.assign(vehicle, input);
    return this.vehicleView(vehicle);
  }

  private scheduleView(row: ScheduleRow): WashSchedule {
    return {
      id: row.id,
      vehicleId: row.vehicleId,
      activity: row.activity,
      frequency: row.frequency,
      weekdays: [...row.weekdays],
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isActive: row.isActive,
    };
  }

  async listSchedules(accountId: string, vehicleId: string) {
    return this.schedules
      .filter((s) => s.accountId === accountId && s.vehicleId === vehicleId)
      .map((s) => this.scheduleView(s));
  }

  async saveSchedules(
    accountId: string,
    vehicleId: string,
    schedules: Parameters<DetailerRepository["saveSchedules"]>[2],
    today: string,
  ) {
    if (!this.vehicles.some((v) => v.id === vehicleId && v.accountId === accountId)) return null;
    const saved: WashSchedule[] = [];
    for (const input of schedules) {
      let row = this.schedules.find((s) => s.vehicleId === vehicleId && s.activity === input.activity);
      if (row) Object.assign(row, input);
      else {
        row = { id: randomUUID(), accountId, vehicleId, ...input };
        this.schedules.push(row);
      }
      const scheduleId = row.id;
      for (let i = this.tasks.length - 1; i >= 0; i--) {
        const t = this.tasks[i]!;
        if (t.scheduleId === scheduleId && t.status === "SCHEDULED" && !t.exception && t.taskDate >= today) {
          this.tasks.splice(i, 1);
        }
      }
      saved.push(this.scheduleView(row));
    }
    return saved;
  }

  async listGenerationCandidates(accountId: string): Promise<GenerationCandidate[]> {
    return this.vehicles
      .filter((v) => {
        const client = this.clients.find((c) => c.id === v.clientId);
        return v.accountId === accountId && v.status === "ACTIVE" && client?.status === "ACTIVE";
      })
      .map((v) => ({
        vehicleId: v.id,
        startDate: istDateString(v.createdAt),
        schedules: this.schedules.filter((s) => s.vehicleId === v.id).map((s) => this.scheduleView(s)),
      }));
  }

  async createTasks(accountId: string, tasks: NewTask[]) {
    for (const task of tasks) {
      if (
        task.scheduleId !== null &&
        !this.schedules.some(
          (schedule) =>
            schedule.id === task.scheduleId &&
            schedule.accountId === accountId &&
            schedule.vehicleId === task.vehicleId &&
            schedule.activity === task.activity,
        )
      ) {
        throw Object.assign(new Error("Foreign key constraint"), { code: "P2003" });
      }
    }
    for (const task of tasks) {
      const exists = this.tasks.some(
        (t) => t.vehicleId === task.vehicleId && t.taskDate === task.taskDate && t.activity === task.activity,
      );
      if (exists) continue;
      this.tasks.push({ id: randomUUID(), accountId, completedAt: null, note: null, ...task });
    }
  }

  private taskView(row: TaskRow): DailyTask {
    const vehicle = this.vehicles.find((v) => v.id === row.vehicleId)!;
    const client = this.clients.find((c) => c.id === vehicle.clientId)!;
    return {
      id: row.id,
      vehicleId: row.vehicleId,
      scheduleId: row.scheduleId,
      activity: row.activity,
      taskDate: row.taskDate,
      status: row.status,
      exception: row.exception,
      completedAt: row.completedAt,
      note: row.note,
      registrationNumber: vehicle.registrationNumber,
      make: vehicle.make,
      model: vehicle.model,
      locationName: vehicle.locationName,
      clientName: client.name,
    };
  }

  async listTasks(accountId: string, date: string) {
    return this.tasks
      .filter((t) => t.accountId === accountId && t.taskDate === date)
      .map((t) => this.taskView(t));
  }

  async findTask(accountId: string, taskId: string) {
    const task = this.tasks.find((t) => t.id === taskId && t.accountId === accountId);
    return task ? this.taskView(task) : null;
  }

  async updateTask(
    accountId: string,
    taskId: string,
    expected: DailyTask["status"],
    change: Parameters<DetailerRepository["updateTask"]>[3],
  ) {
    const task = this.tasks.find((t) => t.id === taskId && t.accountId === accountId);
    if (!task || task.status !== expected || task.exception) return null;
    task.status = change.status;
    task.note = change.note;
    task.completedAt = change.completedAt ? change.completedAt.toISOString() : null;
    return this.taskView(task);
  }

  async setException(accountId: string, change: Parameters<DetailerRepository["setException"]>[1]) {
    const inScope = (t: TaskRow) =>
      t.accountId === accountId &&
      t.taskDate === change.date &&
      (change.vehicleId === null || t.vehicleId === change.vehicleId);
    if (!change.active) {
      let updated = 0;
      for (const t of this.tasks.filter((x) => inScope(x) && x.exception === change.exception)) {
        t.exception = null;
        t.status = "SCHEDULED";
        t.completedAt = null;
        updated++;
      }
      return { updated };
    }
    const conflict = this.tasks.some(
      (t) =>
        t.accountId === accountId &&
        t.taskDate === change.date &&
        t.exception !== null &&
        t.exception !== change.exception &&
        (change.exception === "DETAILER_ON_LEAVE" ||
          t.vehicleId === change.vehicleId ||
          t.exception === "DETAILER_ON_LEAVE"),
    );
    if (conflict) return null;
    let updated = 0;
    for (const t of this.tasks.filter((x) => inScope(x) && !x.exception && x.status === "SCHEDULED")) {
      t.exception = change.exception;
      t.status = change.exception === "WASH_MISSED" ? "MISSED" : "UNAVAILABLE";
      updated++;
    }
    return { updated };
  }
}
