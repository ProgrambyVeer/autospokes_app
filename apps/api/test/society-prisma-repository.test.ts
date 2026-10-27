import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaSocietyRepository } from "../src/society/prisma-repository.js";

const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const societyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const vehicleId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const washerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const assignmentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

describe("Society Vendor Prisma repository", () => {
  it("generates independently due activities and uses database uniqueness for concurrent retries", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      societyVehicle: {
        findMany: vi.fn().mockResolvedValue([{ id: vehicleId, societyId }]),
      },
      societyWashSchedule: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "schedule-exterior",
            vehicleId,
            activity: "WASH",
            frequency: "SELECTED_DAYS",
            weekdays: [2],
            effectiveFrom: new Date("2030-03-01T00:00:00.000Z"),
            effectiveTo: null,
            status: "ACTIVE",
          },
          {
            id: "schedule-interior",
            vehicleId,
            activity: "INTERIOR_CLEANING",
            frequency: "SELECTED_DAYS",
            weekdays: [1],
            effectiveFrom: new Date("2030-03-01T00:00:00.000Z"),
            effectiveTo: null,
            status: "ACTIVE",
          },
          {
            id: "schedule-tyre",
            vehicleId,
            activity: "TYRE_POLISH",
            frequency: "DAILY",
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            effectiveFrom: new Date("2030-03-01T00:00:00.000Z"),
            effectiveTo: null,
            status: "ACTIVE",
          },
        ]),
      },
      societyWasherAssignment: {
        findFirst: vi.fn().mockResolvedValue({ id: assignmentId, washerId }),
      },
      societyWashTask: { createMany, findMany },
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    await Promise.all([
      repository.execute(accountId, actorId, { type: "tasks.list", societyId, date: "2030-03-12" }),
      repository.execute(accountId, actorId, { type: "tasks.list", societyId, date: "2030-03-12" }),
    ]);

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(prisma.societyWashSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ accountId, status: "ACTIVE" }),
    }));
    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({
        accountId,
        societyId,
        vehicleId,
        scheduleId: "schedule-exterior",
        assignmentId,
        washerId,
        activity: "WASH",
        taskDate: new Date("2030-03-12T00:00:00.000Z"),
      }),
      expect.objectContaining({
        accountId,
        societyId,
        vehicleId,
        scheduleId: "schedule-tyre",
        activity: "TYRE_POLISH",
        taskDate: new Date("2030-03-12T00:00:00.000Z"),
      }),
    ]);
  });

  it("exposes persisted WASH task history as EXTERIOR_WASH without rewriting stored rows", async () => {
    const stored = [
      { id: "legacy", activity: "WASH", scheduleId: null, status: "COMPLETED" },
      { id: "scheduled", activity: "WASH", scheduleId: "schedule-exterior", status: "SCHEDULED" },
      { id: "interior", activity: "INTERIOR_CLEANING", scheduleId: null, status: "SCHEDULED" },
    ];
    const prisma = {
      societyVehicle: { findMany: vi.fn().mockResolvedValue([]) },
      societyWashTask: {
        createMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue(stored),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    const listed = await repository.execute(accountId, actorId, { type: "tasks.list", societyId, date: "2030-03-12" });
    const earnings = await repository.execute(accountId, actorId, { type: "earnings.list", societyId });

    expect(listed).toEqual([
      expect.objectContaining({ id: "legacy", activity: "EXTERIOR_WASH" }),
      expect.objectContaining({ id: "scheduled", activity: "EXTERIOR_WASH" }),
      expect.objectContaining({ id: "interior", activity: "INTERIOR_CLEANING" }),
    ]);
    expect(earnings).toEqual(expect.arrayContaining([expect.objectContaining({ id: "legacy", activity: "EXTERIOR_WASH" })]));
    expect(stored.map((task) => task.activity)).toEqual(["WASH", "WASH", "INTERIOR_CLEANING"]);
    expect(prisma.societyWashTask.updateMany).not.toHaveBeenCalled();
  });

  it("returns the public activity name from task updates", async () => {
    const task = { id: "task-id", societyId, status: "SCHEDULED", activity: "WASH", assignment: null };
    const tx = {
      societyWashTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ ...task, status: "MISSED" }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    const result = await repository.execute(accountId, actorId, {
      type: "tasks.update",
      taskId: "task-id",
      input: { status: "MISSED", note: "No access" },
    });

    expect(result).toMatchObject({ activity: "EXTERIOR_WASH", status: "MISSED" });
  });

  it("upserts attendance within the signed-in account and records an audit event", async () => {
    const attendanceUpsert = vi.fn().mockResolvedValue({ id: "attendance-id", societyId, washerId });
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      societyWasher: { findFirst: vi.fn().mockResolvedValue({ id: washerId }) },
      societyAttendance: { upsert: attendanceUpsert },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    const result = await repository.execute(accountId, actorId, {
      type: "attendance.record",
      input: { societyId, washerId, workDate: "2030-03-12", status: "PRESENT", note: null },
    });

    expect(result).toMatchObject({ societyId, washerId });
    expect(tx.societyWasher.findFirst).toHaveBeenCalledWith({
      where: { id: washerId, societyId, accountId },
    });
    expect(attendanceUpsert).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it("reassigns only scheduled tasks and keeps completed task attribution immutable", async () => {
    const taskUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      societyVehicle: {
        findFirst: vi.fn().mockResolvedValue({ id: vehicleId, societyId }),
      },
      societyWasher: {
        findFirst: vi.fn().mockResolvedValue({ id: "new-washer-id" }),
      },
      societyWasherAssignment: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({
            id: assignmentId,
            startsAt: new Date("2030-03-12T00:00:00.000Z"),
          })
          .mockResolvedValueOnce(null),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({ id: "new-assignment-id", washer: { id: "new-washer-id", name: "New" } }),
      },
      societyWashTask: { updateMany: taskUpdateMany },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    await repository.execute(accountId, actorId, {
      type: "assignments.create",
      input: { vehicleId, washerId: "new-washer-id", startsAt: "2030-03-12" },
    });

    expect(tx.societyWasherAssignment.update).toHaveBeenCalledWith({
      where: { id: assignmentId },
      data: { endsAt: new Date("2030-03-12T00:00:00.000Z") },
    });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: {
        accountId,
        vehicleId,
        taskDate: { gte: new Date("2030-03-12T00:00:00.000Z") },
        status: "SCHEDULED",
      },
      data: { assignmentId: "new-assignment-id", washerId: "new-washer-id" },
    });
  });

  it("records task earnings from the assigned washer's rate snapshot at completion", async () => {
    const task = {
      id: "task-id",
      societyId,
      status: "SCHEDULED",
      assignment: { washer: { ratePerTaskPaise: 3200 } },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      societyWashTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        updateMany,
        findUnique: vi.fn().mockResolvedValue({ ...task, status: "COMPLETED", earningRatePaise: 3200 }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma, () => new Date("2030-03-12T12:00:00.000Z"));

    const result = await repository.execute(accountId, actorId, {
      type: "tasks.update",
      taskId: "task-id",
      input: { status: "COMPLETED", note: null },
    });

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "task-id", accountId, status: "SCHEDULED" },
      data: expect.objectContaining({ status: "COMPLETED", earningRatePaise: 3200 }),
    }));
    expect(result).toMatchObject({ status: "COMPLETED", earningRatePaise: 3200 });
  });

  it("prevents overpayment before creating a payment record", async () => {
    const paymentCreate = vi.fn();
    const tx = {
      societyInvoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: "invoice-id",
          totalPaise: 10000,
          payments: [{ amountPaise: 7000 }],
        }),
      },
      societyPayment: { create: paymentCreate },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaSocietyRepository(prisma);

    await expect(repository.execute(accountId, actorId, {
      type: "payments.create",
      invoiceId: "invoice-id",
      input: { amountPaise: 3001, method: "CASH", note: null, reference: null },
    })).rejects.toThrow("Payment exceeds the outstanding invoice balance");
    expect(paymentCreate).not.toHaveBeenCalled();
  });
});
