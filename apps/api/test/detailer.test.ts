import { afterEach, describe, expect, it } from "vitest";
import {
  SaveSchedulesSchema,
  TaskExceptionRequestSchema,
  istDateString,
  isoWeekday,
  normalizeIndianPhone,
} from "@autospokes/shared";
import { buildApp } from "../src/app.js";
import type { NewTask } from "../src/detailer/repository.js";
import { canTransition, isGenerationAllowed, scheduleDueOn } from "../src/detailer/scheduling.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryDetailerRepository } from "./support/memory-detailer-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

const apps: ReturnType<typeof buildApp>[] = [];
// 2030-01-01 is a Tuesday. 05:00Z is 10:30 IST on the same day.
const START = "2030-01-01T05:00:00.000Z";

function setup() {
  let current = new Date(START);
  const authRepository = new MemoryAuthRepository();
  const ownerRepository = new MemoryOwnerRepository();
  const detailerRepository = new MemoryDetailerRepository(() => current);
  const app = buildApp({
    authRepository,
    ownerRepository,
    detailerRepository,
    clock: () => current,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);
  return {
    app,
    authRepository,
    ownerRepository,
    detailerRepository,
    setNow: (iso: string) => {
      current = new Date(iso);
    },
  };
}
type Ctx = ReturnType<typeof setup>;

async function register(ctx: Ctx, email: string, role: "OWNER" | "INDEPENDENT_DETAILER") {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "detailer-test-password-123", displayName: "Test User", role },
  });
  const body = response.json();
  const credential = await ctx.authRepository.findCredentialByEmail(email);
  const profile = credential?.profiles.find((item) => item.role === role);
  if (!profile || !body.accessToken) throw new Error("Registration failed");
  if (profile.accountId) {
    if (role === "OWNER") {
      ctx.ownerRepository.addProfile(profile.id, profile.accountId, profile.displayName);
    } else {
      ctx.detailerRepository.addProfile(profile.id, profile.accountId, profile.displayName);
    }
  }
  return { headers: { authorization: "Bearer " + String(body.accessToken) } };
}

const call = (ctx: Ctx, auth: { headers: Record<string, string> }, method: string, url: string, payload?: unknown) =>
  ctx.app.inject({ method: method as "GET", url, headers: auth.headers, payload: payload as object });

async function addClientAndVehicle(ctx: Ctx, auth: { headers: Record<string, string> }, phone = "98765 43210", reg = "KA 01 AB 1234") {
  const client = (await call(ctx, auth, "POST", "/detailer/clients", { name: "Asha", phoneNumber: phone })).json();
  const vehicle = (
    await call(ctx, auth, "POST", `/detailer/clients/${client.id}/vehicles`, {
      type: "FOUR_WHEELER",
      registrationNumber: reg,
    })
  ).json();
  return { client, vehicle };
}

const schedule = (activity: string, extra: object = {}) => ({
  activity,
  frequency: "SELECTED_DAYS",
  weekdays: [1, 2],
  effectiveFrom: "2030-01-01",
  isActive: true,
  ...extra,
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("detailer authorization and isolation", () => {
  it("rejects unauthenticated and owner callers, and owners cannot reach detailer data", async () => {
    const ctx = setup();
    const owner = await register(ctx, "owner@example.test", "OWNER");
    const detailer = await register(ctx, "det@example.test", "INDEPENDENT_DETAILER");
    expect((await ctx.app.inject({ method: "GET", url: "/detailer/clients" })).statusCode).toBe(401);
    expect((await call(ctx, owner, "GET", "/detailer/clients")).statusCode).toBe(403);
    expect((await call(ctx, owner, "GET", "/detailer/tasks")).statusCode).toBe(403);
    expect((await call(ctx, detailer, "GET", "/owner/vehicles")).statusCode).toBe(403);
    expect((await call(ctx, detailer, "GET", "/detailer/clients")).statusCode).toBe(200);
  });

  it("isolates accounts and ignores any client-supplied account id", async () => {
    const ctx = setup();
    const a = await register(ctx, "a@example.test", "INDEPENDENT_DETAILER");
    const b = await register(ctx, "b@example.test", "INDEPENDENT_DETAILER");
    const { client, vehicle } = await addClientAndVehicle(ctx, a);

    expect((await call(ctx, b, "GET", `/detailer/clients/${client.id}`)).statusCode).toBe(404);
    expect((await call(ctx, b, "PATCH", `/detailer/clients/${client.id}`, { name: "X" })).statusCode).toBe(404);
    expect((await call(ctx, b, "GET", `/detailer/vehicles/${vehicle.id}`)).statusCode).toBe(404);
    expect(
      (await call(ctx, b, "PUT", `/detailer/vehicles/${vehicle.id}/schedules`, { schedules: [schedule("EXTERIOR_WASH")] })).statusCode,
    ).toBe(404);
    expect(
      (await call(ctx, b, "POST", `/detailer/clients/${client.id}/vehicles`, { type: "OTHER", registrationNumber: "ZZ99ZZ9999" })).statusCode,
    ).toBe(404);
    expect((await call(ctx, b, "GET", "/detailer/clients")).json().clients).toEqual([]);

    const injected = await call(ctx, b, "POST", "/detailer/clients", {
      name: "Eve",
      phoneNumber: "9000000001",
      accountId: "11111111-1111-4111-8111-111111111111",
    });
    expect(injected.statusCode).toBe(400);
  });

  it("allows account-local duplicates and keeps Detailer vehicles separate from Owner vehicles", async () => {
    const ctx = setup();
    const a = await register(ctx, "a@example.test", "INDEPENDENT_DETAILER");
    const b = await register(ctx, "b@example.test", "INDEPENDENT_DETAILER");
    const owner = await register(ctx, "owner@example.test", "OWNER");
    expect((await addClientAndVehicle(ctx, a)).vehicle.id).toBeTruthy();
    expect((await addClientAndVehicle(ctx, b)).vehicle.id).toBeTruthy();
    const ownerVehicle = await call(ctx, owner, "POST", "/owner/vehicles", {
      type: "FOUR_WHEELER",
      registrationNumber: "KA 01 AB 1234",
    });
    expect(ownerVehicle.statusCode).toBe(201);
  });
});

describe("detailer clients and vehicles", () => {
  it("normalizes phones and rejects duplicates and invalid numbers with field errors", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const first = await call(ctx, d, "POST", "/detailer/clients", { name: "Asha", phoneNumber: "+91 98765-43210" });
    expect(first.statusCode).toBe(201);
    expect(first.json().phoneNumber).toBe("+919876543210");
    const dup = await call(ctx, d, "POST", "/detailer/clients", { name: "Other", phoneNumber: "09876543210" });
    expect(dup.statusCode).toBe(409);
    const bad = await call(ctx, d, "POST", "/detailer/clients", { name: "", phoneNumber: "123" });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().fieldErrors)).toEqual(expect.arrayContaining(["name", "phoneNumber"]));
  });

  it("supports multiple vehicles per client and rejects duplicate normalized registrations", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const { client } = await addClientAndVehicle(ctx, d);
    const second = await call(ctx, d, "POST", `/detailer/clients/${client.id}/vehicles`, {
      type: "TWO_WHEELER",
      registrationNumber: "ka02cd5678",
      make: "Honda",
    });
    expect(second.statusCode).toBe(201);
    const dup = await call(ctx, d, "POST", `/detailer/clients/${client.id}/vehicles`, {
      type: "TWO_WHEELER",
      registrationNumber: "KA-01-ab-1234",
    });
    expect(dup.statusCode).toBe(409);
    const detail = (await call(ctx, d, "GET", `/detailer/clients/${client.id}`)).json();
    expect(detail.vehicles).toHaveLength(2);
    expect(detail.client.vehicleCount).toBe(2);
    const missingReg = await call(ctx, d, "POST", `/detailer/clients/${client.id}/vehicles`, { type: "OTHER" });
    expect(missingReg.json().fieldErrors.registrationNumber).toBeDefined();
  });

  it("updates profile and reports onboarding state", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    expect((await call(ctx, d, "GET", "/detailer/profile")).json().onboardingComplete).toBe(false);
    const updated = await call(ctx, d, "PATCH", "/detailer/profile", {
      displayName: "Sparkle Cars",
      phoneNumber: "98765 43210",
      serviceArea: "Indiranagar",
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ phoneNumber: "+919876543210", onboardingComplete: true });
    expect((await call(ctx, d, "PATCH", "/detailer/profile", { phoneNumber: "1" })).statusCode).toBe(400);
  });
});

describe("schedules, IST boundaries and daily tasks", () => {
  it("validates schedules", () => {
    const base = { frequency: "SELECTED_DAYS", effectiveFrom: "2030-01-01", isActive: true };
    expect(SaveSchedulesSchema.safeParse({ schedules: [{ ...base, activity: "TYRE_POLISH", weekdays: [] }] }).success).toBe(false);
    expect(SaveSchedulesSchema.safeParse({ schedules: [{ ...base, activity: "TYRE_POLISH", weekdays: [8] }] }).success).toBe(false);
    expect(SaveSchedulesSchema.safeParse({ schedules: [{ ...base, activity: "DUSTING", weekdays: [1] }] }).success).toBe(false);
    expect(
      SaveSchedulesSchema.safeParse({ schedules: [{ ...base, activity: "TYRE_POLISH", weekdays: [1], effectiveTo: "2029-12-31" }] }).success,
    ).toBe(false);
    expect(
      SaveSchedulesSchema.safeParse({
        schedules: [
          { ...base, activity: "TYRE_POLISH", weekdays: [1] },
          { ...base, activity: "TYRE_POLISH", weekdays: [2] },
        ],
      }).success,
    ).toBe(false);
    expect(
      TaskExceptionRequestSchema.safeParse({ date: "2030-02-30", exception: "DETAILER_ON_LEAVE", active: true }).success,
    ).toBe(false);
  });

  it("uses fixed IST day boundaries regardless of host timezone", () => {
    expect(istDateString(new Date("2030-01-01T18:29:59.000Z"))).toBe("2030-01-01");
    expect(istDateString(new Date("2030-01-01T18:30:00.000Z"))).toBe("2030-01-02");
    expect(isoWeekday("2030-01-01")).toBe(2);
    expect(isoWeekday("2030-01-06")).toBe(7);
    expect(normalizeIndianPhone("5876543210")).toBeNull();
    expect(isGenerationAllowed("2030-01-02", "2030-01-01")).toBe(true);
    expect(isGenerationAllowed("2030-01-03", "2030-01-01")).toBe(false);
    expect(isGenerationAllowed("2029-12-31", "2030-01-01")).toBe(false);
    const due = { id: "s", vehicleId: "v", activity: "TYRE_POLISH", frequency: "SELECTED_DAYS", weekdays: [2], effectiveFrom: "2030-01-01", effectiveTo: "2030-01-01", isActive: true } as const;
    expect(scheduleDueOn({ ...due, weekdays: [2] }, "2030-01-01")).toBe(true);
    expect(scheduleDueOn({ ...due, weekdays: [2] }, "2030-01-08")).toBe(false);
    expect(canTransition("COMPLETED", "SCHEDULED")).toBe(false);
    expect(canTransition("MISSED", "COMPLETED")).toBe(false);
  });

  it("generates dusting and scheduled activities idempotently, including in parallel", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const { vehicle } = await addClientAndVehicle(ctx, d);
    const saved = await call(ctx, d, "PUT", `/detailer/vehicles/${vehicle.id}/schedules`, {
      schedules: [schedule("EXTERIOR_WASH", { frequency: "DAILY", weekdays: [] }), schedule("TYRE_POLISH", { weekdays: [3] })],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().schedules[0].weekdays.length).toBeGreaterThan(0);

    const results = await Promise.all([1, 2, 3].map(() => call(ctx, d, "GET", "/detailer/tasks?date=2030-01-01")));
    results.forEach((r) => expect(r.statusCode).toBe(200));
    const tasks = (await call(ctx, d, "GET", "/detailer/tasks?date=2030-01-01")).json().tasks;
    // Tuesday: dusting + daily exterior; tyre polish is Wednesday only.
    expect(tasks.map((t: { activity: string }) => t.activity).sort()).toEqual(["DUSTING", "EXTERIOR_WASH"]);
    const wed = (await call(ctx, d, "GET", "/detailer/tasks?date=2030-01-02")).json().tasks;
    expect(wed.map((t: { activity: string }) => t.activity).sort()).toEqual(["DUSTING", "EXTERIOR_WASH", "TYRE_POLISH"]);
    expect(wed[0].taskDate).toBe("2030-01-02");
    expect((await call(ctx, d, "GET", "/detailer/tasks?date=2030-01-03")).statusCode).toBe(400);
    expect((await call(ctx, d, "GET", "/detailer/tasks?date=bad")).statusCode).toBe(400);
  });

  it("accepts matching task schedules and rejects mismatched vehicles or activities", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const { client, vehicle } = await addClientAndVehicle(ctx, d);
    const otherVehicle = (
      await call(ctx, d, "POST", `/detailer/clients/${client.id}/vehicles`, {
        type: "TWO_WHEELER",
        registrationNumber: "KA02CD5678",
      })
    ).json();
    const saved = await call(ctx, d, "PUT", `/detailer/vehicles/${vehicle.id}/schedules`, {
      schedules: [schedule("EXTERIOR_WASH", { frequency: "DAILY", weekdays: [] })],
    });
    expect(saved.statusCode).toBe(200);
    const washSchedule = ctx.detailerRepository.schedules.find(
      (item) => item.vehicleId === vehicle.id && item.activity === "EXTERIOR_WASH",
    )!;
    const validTask: NewTask = {
      vehicleId: vehicle.id,
      scheduleId: washSchedule.id,
      activity: "EXTERIOR_WASH",
      taskDate: "2030-01-01",
      status: "SCHEDULED",
      exception: null,
    };

    await expect(
      ctx.detailerRepository.createTasks(washSchedule.accountId, [validTask]),
    ).resolves.toBeUndefined();
    await expect(
      ctx.detailerRepository.createTasks(washSchedule.accountId, [
        { ...validTask, vehicleId: otherVehicle.id, taskDate: "2030-01-02" },
      ]),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      ctx.detailerRepository.createTasks(washSchedule.accountId, [
        { ...validTask, activity: "INTERIOR_CLEANING", taskDate: "2030-01-03" },
      ]),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(ctx.detailerRepository.tasks).toHaveLength(1);
  });

  it("follows IST when the UTC date differs", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    await addClientAndVehicle(ctx, d);
    ctx.setNow("2030-01-01T18:30:00.000Z");
    const response = (await call(ctx, d, "GET", "/detailer/tasks")).json();
    expect(response.today).toBe("2030-01-02");
    expect(response.date).toBe("2030-01-02");
  });

  it("enforces task transitions and preserves history across schedule edits", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const { vehicle } = await addClientAndVehicle(ctx, d);
    const put = (body: object) => call(ctx, d, "PUT", `/detailer/vehicles/${vehicle.id}/schedules`, body);
    await put({ schedules: [schedule("EXTERIOR_WASH", { frequency: "DAILY", weekdays: [] })] });
    const tasks = (await call(ctx, d, "GET", "/detailer/tasks")).json().tasks as { id: string; activity: string }[];
    const exterior = tasks.find((t) => t.activity === "EXTERIOR_WASH")!;
    const dusting = tasks.find((t) => t.activity === "DUSTING")!;

    const noted = await call(ctx, d, "PATCH", `/detailer/tasks/${dusting.id}`, {
      status: "SCHEDULED",
      note: "Park in the visitor bay",
    });
    expect(noted.statusCode).toBe(200);
    expect(noted.json().note).toBe("Park in the visitor bay");

    const done = await call(ctx, d, "PATCH", `/detailer/tasks/${exterior.id}`, { status: "COMPLETED" });
    expect(done.statusCode).toBe(200);
    expect(done.json().completedAt).toBe(START);
    expect((await call(ctx, d, "PATCH", `/detailer/tasks/${exterior.id}`, { status: "MISSED" })).statusCode).toBe(409);

    // Pausing keeps the completed task and removes only pending future ones.
    await put({ schedules: [schedule("EXTERIOR_WASH", { frequency: "DAILY", weekdays: [], isActive: false })] });
    const after = (await call(ctx, d, "GET", "/detailer/tasks")).json().tasks as { activity: string; status: string }[];
    expect(after.find((t) => t.activity === "EXTERIOR_WASH")?.status).toBe("COMPLETED");

    const tomorrow = (await call(ctx, d, "GET", "/detailer/tasks?date=2030-01-02")).json().tasks as { id: string }[];
    expect((await call(ctx, d, "PATCH", `/detailer/tasks/${tomorrow[0]!.id}`, { status: "COMPLETED" })).statusCode).toBe(409);
    expect((await call(ctx, d, "PATCH", `/detailer/tasks/${exterior.id}`, { status: "BOGUS" })).statusCode).toBe(400);
  });

  it("treats exceptions as mutually exclusive and disabling", async () => {
    const ctx = setup();
    const d = await register(ctx, "d@example.test", "INDEPENDENT_DETAILER");
    const { vehicle } = await addClientAndVehicle(ctx, d);
    await call(ctx, d, "PUT", `/detailer/vehicles/${vehicle.id}/schedules`, {
      schedules: [schedule("EXTERIOR_WASH", { frequency: "DAILY", weekdays: [] })],
    });
    const date = "2030-01-01";
    const set = (exception: string, active = true, withVehicle = exception !== "DETAILER_ON_LEAVE") =>
      call(ctx, d, "PUT", "/detailer/tasks/exceptions", { date, exception, active, ...(withVehicle ? { vehicleId: vehicle.id } : {}) });

    const unavailable = await set("VEHICLE_UNAVAILABLE");
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json().tasks.every((t: { status: string }) => t.status === "UNAVAILABLE")).toBe(true);
    expect((await set("WASH_MISSED")).statusCode).toBe(409);
    expect((await set("DETAILER_ON_LEAVE")).statusCode).toBe(409);

    const task = unavailable.json().tasks[0];
    expect((await call(ctx, d, "PATCH", `/detailer/tasks/${task.id}`, { status: "COMPLETED" })).statusCode).toBe(409);

    expect((await set("VEHICLE_UNAVAILABLE", false)).json().tasks.every((t: { status: string }) => t.status === "SCHEDULED")).toBe(true);
    const leave = await set("DETAILER_ON_LEAVE");
    expect(leave.statusCode).toBe(200);
    expect((await set("VEHICLE_UNAVAILABLE")).statusCode).toBe(409);
    const invalid = await call(ctx, d, "PUT", "/detailer/tasks/exceptions", { date, exception: "WASH_MISSED", active: true });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().fieldErrors.vehicleId).toBeDefined();
  });
});
