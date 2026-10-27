import type {
  DailyTask,
  DailyTaskException,
  DailyTaskStatus,
  DetailerClient,
  DetailerProfile,
  DetailerVehicle,
  TaskActivity,
  VehicleStatus,
  VehicleType,
  WashSchedule,
  WashScheduleInput,
} from "@autospokes/shared";

export type ProfileWrite = {
  displayName?: string;
  phoneNumber?: string;
  serviceArea?: string;
  contactEmail?: string | null;
};

export type ClientWrite = {
  name?: string;
  phoneNumber?: string;
  notes?: string | null;
  status?: VehicleStatus;
};

export type VehicleWrite = {
  type?: VehicleType;
  registrationNumber?: string;
  registrationNumberNormalized?: string;
  make?: string | null;
  model?: string | null;
  locationName?: string | null;
  status?: VehicleStatus;
};

export type ScheduleWrite = Omit<WashScheduleInput, "effectiveTo" | "weekdays"> & {
  weekdays: number[];
  effectiveTo: string | null;
};

/** A vehicle eligible for task generation, with its schedules. Dates are IST calendar dates. */
export type GenerationCandidate = {
  vehicleId: string;
  startDate: string;
  schedules: WashSchedule[];
};

export type NewTask = {
  vehicleId: string;
  scheduleId: string | null;
  activity: TaskActivity;
  taskDate: string;
  status: DailyTaskStatus;
  exception: DailyTaskException | null;
};

export type ExceptionChange = {
  date: string;
  exception: DailyTaskException;
  vehicleId: string | null;
  active: boolean;
};

export interface DetailerRepository {
  findProfile(roleProfileId: string, accountId: string): Promise<DetailerProfile | null>;
  updateProfile(
    roleProfileId: string,
    accountId: string,
    input: ProfileWrite,
  ): Promise<DetailerProfile | null>;

  listClients(accountId: string): Promise<DetailerClient[]>;
  findClient(accountId: string, clientId: string): Promise<DetailerClient | null>;
  createClient(
    accountId: string,
    input: { name: string; phoneNumber: string; notes: string | null },
  ): Promise<DetailerClient>;
  updateClient(
    accountId: string,
    clientId: string,
    input: ClientWrite,
  ): Promise<DetailerClient | null>;

  listVehicles(accountId: string, clientId: string): Promise<DetailerVehicle[]>;
  findVehicle(accountId: string, vehicleId: string): Promise<DetailerVehicle | null>;
  /** Returns null when the client does not belong to the account. */
  createVehicle(
    accountId: string,
    clientId: string,
    input: Required<Pick<VehicleWrite, "type" | "registrationNumber" | "registrationNumberNormalized">> &
      Pick<VehicleWrite, "make" | "model" | "locationName">,
  ): Promise<DetailerVehicle | null>;
  updateVehicle(
    accountId: string,
    vehicleId: string,
    input: VehicleWrite,
  ): Promise<DetailerVehicle | null>;

  listSchedules(accountId: string, vehicleId: string): Promise<WashSchedule[]>;
  /**
   * Upserts one schedule per activity and discards only not-yet-actioned future tasks
   * (on or after `today`) of the saved schedules. Past and actioned tasks are history.
   * Returns null when the vehicle does not belong to the account.
   */
  saveSchedules(
    accountId: string,
    vehicleId: string,
    schedules: ScheduleWrite[],
    today: string,
  ): Promise<WashSchedule[] | null>;

  listGenerationCandidates(accountId: string, date: string): Promise<GenerationCandidate[]>;
  /** Idempotent: rows that already exist for (vehicle, date, activity) are skipped. */
  createTasks(accountId: string, tasks: NewTask[]): Promise<void>;
  listTasks(accountId: string, date: string): Promise<DailyTask[]>;
  findTask(accountId: string, taskId: string): Promise<DailyTask | null>;
  /** Atomic compare-and-set on status; returns null when the task changed meanwhile. */
  updateTask(
    accountId: string,
    taskId: string,
    expected: DailyTaskStatus,
    change: { status: DailyTaskStatus; note: string | null; completedAt: Date | null },
  ): Promise<DailyTask | null>;
  /** Returns null when a different exception already applies (mutual exclusivity). */
  setException(accountId: string, change: ExceptionChange): Promise<{ updated: number } | null>;
}
