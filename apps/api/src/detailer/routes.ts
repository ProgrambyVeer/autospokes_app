import {
  AccountIdSchema,
  CreateDetailerClientSchema,
  CreateDetailerVehicleSchema,
  DetailerProfileUpdateSchema,
  SaveSchedulesSchema,
  TaskExceptionRequestSchema,
  TaskQuerySchema,
  UpdateDetailerClientSchema,
  UpdateDetailerVehicleSchema,
  UpdateTaskSchema,
  addDays,
  istDateString,
  normalizeIndianPhone,
  normalizeRegistrationNumber,
  type FieldErrors,
} from "@autospokes/shared";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { DetailerRepository, ScheduleWrite } from "./repository.js";
import {
  MAX_GENERATION_DAYS_AHEAD,
  canTransition,
  isGenerationAllowed,
  planMissingTasks,
} from "./scheduling.js";

type HttpError = Error & { statusCode: number };

export type DetailerRouteDeps = {
  repository: DetailerRepository;
  preHandler: preHandlerHookHandler[];
  httpError: (statusCode: number, message: string) => HttpError;
  validationError: (
    message: string,
    zodError?: Parameters<typeof import("@autospokes/shared").toFieldErrors>[0],
    fieldErrors?: FieldErrors,
  ) => HttpError;
  isUniqueConstraintError: (error: unknown) => boolean;
  now: () => Date;
};

const READ_RATE_LIMIT = { max: 300, timeWindow: 60_000 };
const WRITE_RATE_LIMIT = { max: 120, timeWindow: 60_000 };
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export function registerDetailerRoutes(app: FastifyInstance, deps: DetailerRouteDeps): void {
  const { repository, preHandler, httpError, validationError, isUniqueConstraintError, now } = deps;
  const read = { preHandler, config: { rateLimit: READ_RATE_LIMIT } };
  const write = { preHandler, config: { rateLimit: WRITE_RATE_LIMIT } };

  // The account always comes from the validated session, never from the request.
  const accountOf = (request: FastifyRequest): string => {
    if (request.user.role !== "INDEPENDENT_DETAILER" || !request.user.aid) {
      throw httpError(403, "An Independent Detailer account is required");
    }
    return request.user.aid;
  };
  const idOf = (value: string, label: string): string => {
    const parsed = AccountIdSchema.safeParse(value);
    if (!parsed.success) throw httpError(400, `Invalid ${label} id`);
    return parsed.data;
  };
  const today = (): string => istDateString(now());

  async function ensureGenerated(accountId: string, date: string): Promise<void> {
    if (!isGenerationAllowed(date, today())) return;
    const [candidates, existing] = await Promise.all([
      repository.listGenerationCandidates(accountId, date),
      repository.listTasks(accountId, date),
    ]);
    const missing = planMissingTasks(date, candidates, existing);
    if (missing.length > 0) await repository.createTasks(accountId, missing);
  }

  function requireDateInRange(date: string): void {
    if (date > addDays(today(), MAX_GENERATION_DAYS_AHEAD)) {
      throw validationError("Invalid date", undefined, {
        date: ["Tasks can only be planned up to tomorrow"],
      });
    }
  }

  app.get("/detailer/profile", read, async (request) => {
    const profile = await repository.findProfile(request.user.pid, accountOf(request));
    if (!profile) throw httpError(404, "Detailer profile not found");
    return profile;
  });

  app.patch<{ Body: unknown }>("/detailer/profile", write, async (request) => {
    const accountId = accountOf(request);
    const parsed = DetailerProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid profile details", parsed.error);
    const { phoneNumber, ...rest } = parsed.data;
    const profile = await repository.updateProfile(request.user.pid, accountId, {
      ...rest,
      ...(phoneNumber !== undefined ? { phoneNumber: normalizeIndianPhone(phoneNumber) ?? phoneNumber } : {}),
    });
    if (!profile) throw httpError(404, "Detailer profile not found");
    return profile;
  });

  app.get("/detailer/clients", read, async (request) => ({
    clients: await repository.listClients(accountOf(request)),
  }));

  app.post<{ Body: unknown }>("/detailer/clients", write, async (request, reply) => {
    const accountId = accountOf(request);
    const parsed = CreateDetailerClientSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid client details", parsed.error);
    try {
      const client = await repository.createClient(accountId, {
        name: parsed.data.name,
        phoneNumber: normalizeIndianPhone(parsed.data.phoneNumber) ?? parsed.data.phoneNumber,
        notes: parsed.data.notes ?? null,
      });
      return reply.code(201).send(client);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw httpError(409, "You already have a client with this phone number");
      }
      throw error;
    }
  });

  app.get<{ Params: { clientId: string } }>("/detailer/clients/:clientId", read, async (request) => {
    const accountId = accountOf(request);
    const clientId = idOf(request.params.clientId, "client");
    const client = await repository.findClient(accountId, clientId);
    if (!client) throw httpError(404, "Client not found");
    return { client, vehicles: await repository.listVehicles(accountId, clientId) };
  });

  app.patch<{ Params: { clientId: string }; Body: unknown }>(
    "/detailer/clients/:clientId",
    write,
    async (request) => {
      const accountId = accountOf(request);
      const clientId = idOf(request.params.clientId, "client");
      const parsed = UpdateDetailerClientSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid client details", parsed.error);
      const { phoneNumber, ...rest } = parsed.data;
      try {
        const client = await repository.updateClient(accountId, clientId, {
          ...rest,
          ...(phoneNumber !== undefined ? { phoneNumber: normalizeIndianPhone(phoneNumber) ?? phoneNumber } : {}),
        });
        if (!client) throw httpError(404, "Client not found");
        return client;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(409, "You already have a client with this phone number");
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { clientId: string }; Body: unknown }>(
    "/detailer/clients/:clientId/vehicles",
    write,
    async (request, reply) => {
      const accountId = accountOf(request);
      const clientId = idOf(request.params.clientId, "client");
      const parsed = CreateDetailerVehicleSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
      try {
        const vehicle = await repository.createVehicle(accountId, clientId, {
          type: parsed.data.type,
          registrationNumber: parsed.data.registrationNumber,
          registrationNumberNormalized: normalizeRegistrationNumber(parsed.data.registrationNumber),
          make: parsed.data.make ?? null,
          model: parsed.data.model ?? null,
          locationName: parsed.data.locationName ?? null,
        });
        if (!vehicle) throw httpError(404, "Client not found");
        return reply.code(201).send(vehicle);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(409, "This registration number is already in your vehicle list");
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { vehicleId: string } }>("/detailer/vehicles/:vehicleId", read, async (request) => {
    const accountId = accountOf(request);
    const vehicleId = idOf(request.params.vehicleId, "vehicle");
    const vehicle = await repository.findVehicle(accountId, vehicleId);
    if (!vehicle) throw httpError(404, "Vehicle not found");
    return { vehicle, schedules: await repository.listSchedules(accountId, vehicleId) };
  });

  app.patch<{ Params: { vehicleId: string }; Body: unknown }>(
    "/detailer/vehicles/:vehicleId",
    write,
    async (request) => {
      const accountId = accountOf(request);
      const vehicleId = idOf(request.params.vehicleId, "vehicle");
      const parsed = UpdateDetailerVehicleSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
      try {
        const vehicle = await repository.updateVehicle(accountId, vehicleId, {
          ...parsed.data,
          ...(parsed.data.registrationNumber !== undefined
            ? {
                registrationNumberNormalized: normalizeRegistrationNumber(
                  parsed.data.registrationNumber,
                ),
              }
            : {}),
        });
        if (!vehicle) throw httpError(404, "Vehicle not found");
        return vehicle;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(409, "This registration number is already in your vehicle list");
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { vehicleId: string } }>(
    "/detailer/vehicles/:vehicleId/schedules",
    read,
    async (request) => {
      const accountId = accountOf(request);
      const vehicleId = idOf(request.params.vehicleId, "vehicle");
      if (!(await repository.findVehicle(accountId, vehicleId))) {
        throw httpError(404, "Vehicle not found");
      }
      return { schedules: await repository.listSchedules(accountId, vehicleId) };
    },
  );

  app.put<{ Params: { vehicleId: string }; Body: unknown }>(
    "/detailer/vehicles/:vehicleId/schedules",
    write,
    async (request) => {
      const accountId = accountOf(request);
      const vehicleId = idOf(request.params.vehicleId, "vehicle");
      const parsed = SaveSchedulesSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid schedule", parsed.error);
      const writes: ScheduleWrite[] = parsed.data.schedules.map((schedule) => ({
        activity: schedule.activity,
        frequency: schedule.frequency,
        weekdays:
          schedule.frequency === "DAILY" ? ALL_WEEKDAYS : [...schedule.weekdays].sort((a, b) => a - b),
        effectiveFrom: schedule.effectiveFrom,
        effectiveTo: schedule.effectiveTo ?? null,
        isActive: schedule.isActive,
      }));
      const schedules = await repository.saveSchedules(accountId, vehicleId, writes, today());
      if (!schedules) throw httpError(404, "Vehicle not found");
      return { schedules };
    },
  );

  app.get<{ Querystring: unknown }>("/detailer/tasks", read, async (request) => {
    const accountId = accountOf(request);
    const parsed = TaskQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError("Invalid date", parsed.error);
    const date = parsed.data.date ?? today();
    requireDateInRange(date);
    await ensureGenerated(accountId, date);
    return { date, today: today(), tasks: await repository.listTasks(accountId, date) };
  });

  app.patch<{ Params: { taskId: string }; Body: unknown }>(
    "/detailer/tasks/:taskId",
    write,
    async (request) => {
      const accountId = accountOf(request);
      const taskId = idOf(request.params.taskId, "task");
      const parsed = UpdateTaskSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid task update", parsed.error);
      const task = await repository.findTask(accountId, taskId);
      if (!task) throw httpError(404, "Task not found");
      if (task.taskDate > today()) throw httpError(409, "Future tasks cannot be updated yet");
      if (task.exception) {
        throw httpError(409, "This task is disabled by a day exception; clear the exception first");
      }
      const updatingNoteOnly =
        task.status === parsed.data.status && parsed.data.note !== undefined;
      if (!updatingNoteOnly && !canTransition(task.status, parsed.data.status)) {
        throw httpError(409, `A ${task.status.toLowerCase()} task cannot become ${parsed.data.status.toLowerCase()}`);
      }
      const updated = await repository.updateTask(accountId, taskId, task.status, {
        status: parsed.data.status,
        note: parsed.data.note ?? null,
        completedAt:
          updatingNoteOnly && task.completedAt
            ? new Date(task.completedAt)
            : parsed.data.status === "COMPLETED"
              ? now()
              : null,
      });
      if (!updated) throw httpError(409, "This task was changed elsewhere; refresh and try again");
      return updated;
    },
  );

  app.put<{ Body: unknown }>("/detailer/tasks/exceptions", write, async (request) => {
    const accountId = accountOf(request);
    const parsed = TaskExceptionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid exception", parsed.error);
    const { date, exception, vehicleId, active } = parsed.data;
    requireDateInRange(date);
    if (vehicleId && !(await repository.findVehicle(accountId, vehicleId))) {
      throw httpError(404, "Vehicle not found");
    }
    await ensureGenerated(accountId, date);
    const result = await repository.setException(accountId, {
      date,
      exception,
      vehicleId: vehicleId ?? null,
      active,
    });
    if (!result) {
      throw httpError(409, "A different exception already applies; clear it before choosing another");
    }
    return { date, updated: result.updated, tasks: await repository.listTasks(accountId, date) };
  });
}
