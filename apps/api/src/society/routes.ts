import {
  AccountIdSchema,
  SocietyAssignmentInputSchema,
  SocietyAttendanceInputSchema,
  SocietyDeductionDecisionSchema,
  SocietyDeductionInputSchema,
  SocietyExtraWorkDecisionSchema,
  SocietyExtraWorkInputSchema,
  SocietyInputSchema,
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
  SocietyTaskQuerySchema,
  SocietyTaskUpdateSchema,
  SocietyVehicleInputSchema,
  SocietyVehicleUpdateSchema,
  SocietyWasherInputSchema,
  SocietyWasherUpdateSchema,
  normalizeIndianPhone,
  istDateString,
  type FieldErrors,
} from "@autospokes/shared";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { SocietyRepository } from "./repository.js";

type HttpError = Error & { statusCode: number };
type RouteDeps = {
  repository: SocietyRepository;
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

const READ_LIMIT = { max: 300, timeWindow: 60_000 };
const WRITE_LIMIT = { max: 120, timeWindow: 60_000 };

export function registerSocietyRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { repository, preHandler, httpError, validationError, isUniqueConstraintError, now } = deps;
  const read = { preHandler, config: { rateLimit: READ_LIMIT } };
  const write = { preHandler, config: { rateLimit: WRITE_LIMIT } };

  const accountOf = (request: FastifyRequest): string => {
    if (request.user.role !== "SOCIETY_VENDOR" || !request.user.aid) {
      throw httpError(403, "A Society Vendor account is required");
    }
    return request.user.aid;
  };
  const idOf = (value: string, label: string): string => {
    const parsed = AccountIdSchema.safeParse(value);
    if (!parsed.success) throw httpError(400, `Invalid ${label} id`);
    return parsed.data;
  };
  const invoke = async (
    accountId: string,
    request: FastifyRequest,
    action: Parameters<SocietyRepository["execute"]>[2],
  ) => repository.execute(accountId, request.user.sub, action);
  const conflict = (error: unknown): never => {
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "A record with the same account-scoped details already exists");
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2034"
    ) {
      throw httpError(409, "A related record changed concurrently; refresh and try again");
    }
    if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
      throw error;
    }
    throw error;
  };

  app.get("/society/profile", read, async (request) => {
    const profile = await invoke(accountOf(request), request, {
      type: "profile.read",
      roleProfileId: request.user.pid,
    });
    if (!profile) throw httpError(404, "Society Vendor profile not found");
    return profile;
  });

  app.patch<{ Body: unknown }>("/society/profile", write, async (request) => {
    const parsed = SocietyProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid Society Vendor profile", parsed.error);
    const profile = await invoke(accountOf(request), request, {
      type: "profile.update",
      roleProfileId: request.user.pid,
      input: {
        ...parsed.data,
        ...(parsed.data.phoneNumber !== undefined
          ? { phoneNumber: normalizeIndianPhone(parsed.data.phoneNumber) ?? parsed.data.phoneNumber }
          : {}),
      },
    });
    if (!profile) throw httpError(404, "Society Vendor profile not found");
    return profile;
  });

  app.get("/society/societies", read, async (request) => ({
    societies: await invoke(accountOf(request), request, { type: "societies.list" }),
  }));
  app.post<{ Body: unknown }>("/society/societies", write, async (request, reply) => {
    const parsed = SocietyInputSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid society details", parsed.error);
    return reply.code(201).send(await invoke(accountOf(request), request, {
      type: "societies.create",
      input: parsed.data,
    }));
  });
  app.patch<{ Params: { societyId: string }; Body: unknown }>("/society/societies/:societyId", write, async (request) => {
    const societyId = idOf(request.params.societyId, "society");
    const parsed = SocietyUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid society details", parsed.error);
    const result = await invoke(accountOf(request), request, { type: "societies.update", societyId, input: parsed.data });
    if (!result) throw httpError(404, "Society not found");
    return result;
  });

  app.get<{ Params: { societyId: string } }>("/society/societies/:societyId/residents", read, async (request) => ({
    residents: await invoke(accountOf(request), request, {
      type: "residents.list",
      societyId: idOf(request.params.societyId, "society"),
    }),
  }));
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/residents",
    write,
    async (request, reply) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyResidentInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid resident details", parsed.error);
      try {
        const resident = await invoke(accountOf(request), request, {
          type: "residents.create",
          input: {
            ...parsed.data,
            phoneNumber: normalizeIndianPhone(parsed.data.phoneNumber) ?? parsed.data.phoneNumber,
          },
        });
        if (!resident) throw httpError(404, "Society not found");
        return reply.code(201).send(resident);
      } catch (error) {
        conflict(error);
      }
    },
  );
  app.patch<{ Params: { residentId: string }; Body: unknown }>("/society/residents/:residentId", write, async (request) => {
    const residentId = idOf(request.params.residentId, "resident");
    const parsed = SocietyResidentUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid resident details", parsed.error);
    try {
      const { phoneNumber, ...rest } = parsed.data;
      const result = await invoke(accountOf(request), request, {
        type: "residents.update",
        residentId,
        input: {
          ...rest,
          ...(phoneNumber !== undefined
            ? { phoneNumber: normalizeIndianPhone(phoneNumber) ?? phoneNumber }
            : {}),
        },
      });
      if (!result) throw httpError(404, "Resident not found");
      return result;
    } catch (error) {
      conflict(error);
    }
  });

  app.get<{ Params: { societyId: string }; Querystring: { residentId?: string } }>(
    "/society/societies/:societyId/vehicles",
    read,
    async (request) => ({
      vehicles: await invoke(accountOf(request), request, {
        type: "vehicles.list",
        societyId: idOf(request.params.societyId, "society"),
        ...(request.query.residentId ? { residentId: idOf(request.query.residentId, "resident") } : {}),
      }),
    }),
  );
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/vehicles",
    write,
    async (request, reply) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyVehicleInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
      try {
        const vehicle = await invoke(accountOf(request), request, {
          type: "vehicles.create",
          input: {
            ...parsed.data,
            registrationNumber: parsed.data.registrationNumber.trim(),
          },
        });
        if (!vehicle) throw httpError(404, "Resident not found");
        return reply.code(201).send(vehicle);
      } catch (error) {
        conflict(error);
      }
    },
  );
  app.patch<{ Params: { vehicleId: string }; Body: unknown }>("/society/vehicles/:vehicleId", write, async (request) => {
    const vehicleId = idOf(request.params.vehicleId, "vehicle");
    const parsed = SocietyVehicleUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
    try {
      const result = await invoke(accountOf(request), request, { type: "vehicles.update", vehicleId, input: parsed.data });
      if (!result) throw httpError(404, "Vehicle not found");
      return result;
    } catch (error) {
      conflict(error);
    }
  });

  app.get<{ Params: { societyId: string } }>("/society/societies/:societyId/washers", read, async (request) => ({
    washers: await invoke(accountOf(request), request, {
      type: "washers.list",
      societyId: idOf(request.params.societyId, "society"),
    }),
  }));
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/washers",
    write,
    async (request, reply) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyWasherInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid washer details", parsed.error);
      try {
        const washer = await invoke(accountOf(request), request, {
          type: "washers.create",
          input: {
            ...parsed.data,
            phoneNumber: normalizeIndianPhone(parsed.data.phoneNumber) ?? parsed.data.phoneNumber,
          },
        });
        if (!washer) throw httpError(404, "Society not found");
        return reply.code(201).send(washer);
      } catch (error) {
        conflict(error);
      }
    },
  );
  app.patch<{ Params: { washerId: string }; Body: unknown }>("/society/washers/:washerId", write, async (request) => {
    const washerId = idOf(request.params.washerId, "washer");
    const parsed = SocietyWasherUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid washer details", parsed.error);
    try {
      const { phoneNumber, ...rest } = parsed.data;
      const result = await invoke(accountOf(request), request, {
        type: "washers.update",
        washerId,
        input: {
          ...rest,
          ...(phoneNumber !== undefined
            ? { phoneNumber: normalizeIndianPhone(phoneNumber) ?? phoneNumber }
            : {}),
        },
      });
      if (!result) throw httpError(404, "Washer not found");
      return result;
    } catch (error) {
      conflict(error);
    }
  });

  app.get<{ Params: { vehicleId: string } }>(
    "/society/vehicles/:vehicleId/assignments",
    read,
    async (request) => {
      const vehicleId = idOf(request.params.vehicleId, "vehicle");
      return { assignments: await invoke(accountOf(request), request, {
        type: "assignments.list",
        vehicleId,
      }) };
    },
  );
  app.post<{ Params: { vehicleId: string }; Body: unknown }>(
    "/society/vehicles/:vehicleId/assignments",
    write,
    async (request, reply) => {
      const parsed = SocietyAssignmentInputSchema.safeParse({
        ...request.body as object,
        vehicleId: request.params.vehicleId,
      });
      if (!parsed.success) throw validationError("Invalid washer assignment", parsed.error);
      try {
        const assignment = await invoke(accountOf(request), request, {
          type: "assignments.create",
          input: parsed.data,
        });
        if (!assignment) throw httpError(404, "Vehicle or washer not found");
        return reply.code(201).send(assignment);
      } catch (error) {
        conflict(error);
      }
    },
  );

  app.get<{ Params: { societyId: string }; Querystring: { date?: string } }>(
    "/society/societies/:societyId/attendance",
    read,
    async (request) => {
      const query = SocietyTaskQuerySchema.safeParse({ date: request.query.date });
      if (!query.success) throw validationError("Invalid attendance date", query.error);
      return {
        attendance: await invoke(accountOf(request), request, {
          type: "attendance.list",
          societyId: idOf(request.params.societyId, "society"),
          date: query.data.date ?? istDateString(now()),
        }),
      };
    },
  );
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/attendance",
    write,
    async (request) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyAttendanceInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid attendance record", parsed.error);
      const attendance = await invoke(accountOf(request), request, {
        type: "attendance.record",
        input: parsed.data,
      });
      if (!attendance) throw httpError(404, "Washer not found");
      return attendance;
    },
  );

  app.get<{ Params: { vehicleId: string } }>("/society/vehicles/:vehicleId/schedules", read, async (request) => {
    const schedules = await invoke(accountOf(request), request, {
      type: "schedules.list",
      vehicleId: idOf(request.params.vehicleId, "vehicle"),
    });
    if (!schedules) throw httpError(404, "Vehicle not found");
    return { schedules };
  });
  app.put<{ Params: { vehicleId: string; activity: string }; Body: unknown }>(
    "/society/vehicles/:vehicleId/schedules/:activity",
    write,
    async (request) => {
      const vehicleId = idOf(request.params.vehicleId, "vehicle");
      const activity = SocietyScheduleActivitySchema.safeParse(request.params.activity);
      if (!activity.success) throw validationError("Invalid schedule activity", activity.error);
      const parsed = SocietyWashScheduleInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid wash schedule", parsed.error);
      const schedule = await invoke(accountOf(request), request, {
        type: "schedules.save",
        vehicleId,
        activity: activity.data,
        input: {
          ...parsed.data,
          weekdays: parsed.data.frequency === "DAILY"
            ? [1, 2, 3, 4, 5, 6, 7]
            : [...parsed.data.weekdays].sort((a, b) => a - b),
        },
      });
      if (!schedule) throw httpError(404, "Vehicle not found");
      return schedule;
    },
  );
  app.patch<{ Params: { scheduleId: string }; Body: unknown }>(
    "/society/schedules/:scheduleId/status",
    write,
    async (request) => {
      const scheduleId = idOf(request.params.scheduleId, "schedule");
      const parsed = SocietyWashScheduleStatusSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid schedule status", parsed.error);
      const schedule = await invoke(accountOf(request), request, {
        type: "schedules.status",
        scheduleId,
        input: parsed.data,
      });
      if (!schedule) throw httpError(404, "Schedule not found or changed concurrently");
      return schedule;
    },
  );

  app.get<{ Querystring: { societyId?: string; date?: string } }>("/society/tasks", read, async (request) => {
    const parsed = SocietyTaskQuerySchema.safeParse(request.query);
    if (!parsed.success) throw validationError("Invalid task query", parsed.error);
    const date = parsed.data.date ?? istDateString(now());
    if (date > istDateString(now())) {
      throw validationError("Invalid task date", undefined, { date: ["Only today's and past tasks can be generated"] });
    }
    return {
      date,
      tasks: await invoke(accountOf(request), request, {
        type: "tasks.list",
        date,
        ...(parsed.data.societyId ? { societyId: parsed.data.societyId } : {}),
      }),
    };
  });
  app.patch<{ Params: { taskId: string }; Body: unknown }>("/society/tasks/:taskId", write, async (request) => {
    const taskId = idOf(request.params.taskId, "task");
    const parsed = SocietyTaskUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid task update", parsed.error);
    const task = await invoke(accountOf(request), request, { type: "tasks.update", taskId, input: parsed.data });
    if (!task) throw httpError(404, "Task not found or already updated");
    return task;
  });

  app.post<{ Body: unknown }>("/society/invoices/generate", write, async (request) => {
    const parsed = SocietyInvoiceGenerationSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("Invalid invoice period", parsed.error);
    try {
      const result = await invoke(accountOf(request), request, { type: "invoices.generate", input: parsed.data });
      if (!result) throw httpError(404, "Society not found");
      return result;
    } catch (error) {
      conflict(error);
    }
  });
  app.get<{ Querystring: { societyId?: string } }>("/society/invoices", read, async (request) => ({
    invoices: await invoke(accountOf(request), request, {
      type: "invoices.list",
      societyId: idOf(request.query.societyId ?? "", "society"),
    }),
  }));
  app.post<{ Params: { invoiceId: string }; Body: unknown }>(
    "/society/invoices/:invoiceId/payments",
    write,
    async (request, reply) => {
      const invoiceId = idOf(request.params.invoiceId, "invoice");
      const parsed = SocietyPaymentInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid payment record", parsed.error);
      try {
        const payment = await invoke(accountOf(request), request, {
          type: "payments.create",
          invoiceId,
          input: parsed.data,
        });
        if (!payment) throw httpError(404, "Invoice not found");
        return reply.code(201).send(payment);
      } catch (error) {
        conflict(error);
      }
    },
  );
  app.post<{ Params: { invoiceId: string }; Body: unknown }>(
    "/society/invoices/:invoiceId/reminders",
    write,
    async (request, reply) => {
      const invoiceId = idOf(request.params.invoiceId, "invoice");
      const parsed = SocietyReminderInputSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid reminder note", parsed.error);
      const reminder = await invoke(accountOf(request), request, {
        type: "reminders.create",
        invoiceId,
        input: parsed.data,
      });
      if (!reminder) throw httpError(404, "Invoice not found");
      return reply.code(201).send(reminder);
    },
  );

  app.get<{ Params: { societyId: string }; Querystring: { washerId?: string } }>(
    "/society/societies/:societyId/earnings",
    read,
    async (request) => ({
      earnings: await invoke(accountOf(request), request, {
        type: "earnings.list",
        societyId: idOf(request.params.societyId, "society"),
        ...(request.query.washerId ? { washerId: idOf(request.query.washerId, "washer") } : {}),
      }),
    }),
  );
  app.get<{ Params: { societyId: string }; Querystring: { washerId?: string } }>(
    "/society/societies/:societyId/deductions",
    read,
    async (request) => ({
      deductions: await invoke(accountOf(request), request, {
        type: "deductions.list",
        societyId: idOf(request.params.societyId, "society"),
        ...(request.query.washerId ? { washerId: idOf(request.query.washerId, "washer") } : {}),
      }),
    }),
  );
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/deductions",
    write,
    async (request, reply) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyDeductionInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid washer deduction", parsed.error);
      const deduction = await invoke(accountOf(request), request, {
        type: "deductions.create",
        input: parsed.data,
      });
      if (!deduction) throw httpError(404, "Washer not found");
      return reply.code(201).send(deduction);
    },
  );
  app.patch<{ Params: { deductionId: string }; Body: unknown }>(
    "/society/deductions/:deductionId/decision",
    write,
    async (request) => {
      const deductionId = idOf(request.params.deductionId, "deduction");
      const parsed = SocietyDeductionDecisionSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid deduction decision", parsed.error);
      const deduction = await invoke(accountOf(request), request, {
        type: "deductions.decide",
        deductionId,
        input: parsed.data,
      });
      if (!deduction) throw httpError(409, "Deduction is not pending or was not found");
      return deduction;
    },
  );
  app.get<{ Params: { societyId: string } }>("/society/societies/:societyId/extra-work", read, async (request) => ({
    extraWork: await invoke(accountOf(request), request, {
      type: "extra-work.list",
      societyId: idOf(request.params.societyId, "society"),
    }),
  }));
  app.post<{ Params: { societyId: string }; Body: unknown }>(
    "/society/societies/:societyId/extra-work",
    write,
    async (request, reply) => {
      const societyId = idOf(request.params.societyId, "society");
      const parsed = SocietyExtraWorkInputSchema.safeParse({ ...request.body as object, societyId });
      if (!parsed.success) throw validationError("Invalid extra work details", parsed.error);
      const work = await invoke(accountOf(request), request, { type: "extra-work.create", input: parsed.data });
      if (!work) throw httpError(404, "Resident vehicle not found");
      return reply.code(201).send(work);
    },
  );
  app.patch<{ Params: { extraWorkId: string }; Body: unknown }>(
    "/society/extra-work/:extraWorkId/decision",
    write,
    async (request) => {
      const extraWorkId = idOf(request.params.extraWorkId, "extra work");
      const parsed = SocietyExtraWorkDecisionSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid extra work decision", parsed.error);
      const work = await invoke(accountOf(request), request, {
        type: "extra-work.decide",
        extraWorkId,
        input: parsed.data,
      });
      if (!work) throw httpError(409, "Extra work is not pending or was not found");
      return work;
    },
  );
}
