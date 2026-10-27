import { randomUUID } from "node:crypto";
import type { SocietyAction, SocietyRepository } from "../src/society/repository.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

type SocietyRow = { id: string; accountId: string; name: string; address: string | null };
type ResidentRow = { id: string; accountId: string; societyId: string; name: string; phoneNumber: string };
type VendorVehicleRow = { id: string; accountId: string; societyId: string; residentId: string; registrationNumber: string; normalized: string };
type ScheduleRow = { id: string; accountId: string; vehicleId: string; activity: string; status: string; [key: string]: unknown };

const conflict = (): Error & { code: string } => Object.assign(new Error("unique"), { code: "P2002" });

class TestSocietyRepository implements SocietyRepository {
  readonly societies: SocietyRow[] = [];
  readonly residents: ResidentRow[] = [];
  readonly vehicles: VendorVehicleRow[] = [];
  readonly schedules: ScheduleRow[] = [];
  readonly requestedTaskDates: string[] = [];

  async execute(accountId: string, _actorId: string, action: SocietyAction): Promise<unknown> {
    switch (action.type) {
      case "tasks.list":
        this.requestedTaskDates.push(action.date);
        return [];
      case "societies.list":
        return this.societies.filter((item) => item.accountId === accountId);
      case "societies.create": {
        const society = { id: randomUUID(), accountId, name: action.input.name, address: action.input.address ?? null };
        this.societies.push(society);
        return society;
      }
      case "residents.list":
        return this.residents.filter((item) => item.accountId === accountId && item.societyId === action.societyId);
      case "residents.create": {
        if (!this.societies.some((item) => item.id === action.input.societyId && item.accountId === accountId)) return null;
        if (this.residents.some((item) =>
          item.accountId === accountId &&
          item.societyId === action.input.societyId &&
          item.phoneNumber === action.input.phoneNumber
        )) throw conflict();
        const resident = {
          id: randomUUID(),
          accountId,
          societyId: action.input.societyId,
          name: action.input.name,
          phoneNumber: action.input.phoneNumber,
        };
        this.residents.push(resident);
        return resident;
      }
      case "vehicles.create": {
        if (!this.residents.some((item) =>
          item.id === action.input.residentId &&
          item.societyId === action.input.societyId &&
          item.accountId === accountId
        )) return null;
        const normalized = action.input.registrationNumber.toUpperCase().replace(/[\s-]+/g, "");
        if (this.vehicles.some((item) => item.accountId === accountId && item.normalized === normalized)) {
          throw conflict();
        }
        const vehicle = {
          id: randomUUID(),
          accountId,
          societyId: action.input.societyId,
          residentId: action.input.residentId,
          registrationNumber: action.input.registrationNumber,
          normalized,
        };
        this.vehicles.push(vehicle);
        return vehicle;
      }
      case "vehicles.list":
        return this.vehicles.filter((item) => item.accountId === accountId && item.societyId === action.societyId);
      case "schedules.list":
        return this.vehicles.some((item) => item.accountId === accountId && item.id === action.vehicleId)
          ? this.schedules.filter((item) => item.accountId === accountId && item.vehicleId === action.vehicleId)
          : null;
      case "schedules.save": {
        if (!this.vehicles.some((item) => item.accountId === accountId && item.id === action.vehicleId)) return null;
        const existing = this.schedules.find((item) =>
          item.accountId === accountId && item.vehicleId === action.vehicleId && item.activity === action.activity
        );
        const schedule: ScheduleRow = {
          ...(existing ?? { id: randomUUID() }),
          accountId,
          vehicleId: action.vehicleId,
          activity: action.activity,
          ...action.input,
          status: "ACTIVE",
        };
        if (existing) this.schedules.splice(this.schedules.indexOf(existing), 1, schedule);
        else this.schedules.push(schedule);
        return schedule;
      }
      case "schedules.status": {
        const schedule = this.schedules.find((item) => item.accountId === accountId && item.id === action.scheduleId);
        if (!schedule) return null;
        schedule.status = action.input.status;
        return schedule;
      }
      default:
        return null;
    }
  }
}

const apps: ReturnType<typeof buildApp>[] = [];

function createApp(clock?: () => Date) {
  const authRepository = new MemoryAuthRepository();
  const societyRepository = new TestSocietyRepository();
  const app = buildApp({
    authRepository,
    ownerRepository: new MemoryOwnerRepository(),
    societyRepository,
    ...(clock ? { clock } : {}),
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);
  return { app, authRepository, societyRepository };
}

async function register(app: ReturnType<typeof buildApp>, email: string, role = "SOCIETY_VENDOR") {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "society-vendor-test-password-123", displayName: "Test Vendor", role },
  });
  expect(response.statusCode).toBe(201);
  return {
    authorization: `Bearer ${response.json().accessToken as string}`,
    accountId: response.json().user.accountId as string,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Society Vendor authorization and account isolation", () => {
  it("allows only authenticated Society Vendor accounts", async () => {
    const { app } = createApp();
    const owner = await register(app, "owner-for-society@example.test", "OWNER");
    const unauthenticated = await app.inject({ method: "GET", url: "/society/societies" });
    const forbidden = await app.inject({
      method: "GET",
      url: "/society/societies",
      headers: { authorization: owner.authorization },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
  });

  it("keeps residents, vehicles and normalized identities within the vendor account", async () => {
    const { app } = createApp();
    const first = await register(app, "vendor-one@example.test");
    const second = await register(app, "vendor-two@example.test");
    const societyResponse = await app.inject({
      method: "POST",
      url: "/society/societies",
      headers: { authorization: first.authorization },
      payload: { name: "Test Society" },
    });
    expect(societyResponse.statusCode).toBe(201);
    const societyId = societyResponse.json().id as string;
    const residentResponse = await app.inject({
      method: "POST",
      url: `/society/societies/${societyId}/residents`,
      headers: { authorization: first.authorization },
      payload: { name: "Test Resident", phoneNumber: "09876543210" },
    });
    expect(residentResponse.statusCode).toBe(201);
    expect(residentResponse.json().phoneNumber).toBe("+919876543210");
    const residentId = residentResponse.json().id as string;

    const duplicatePhone = await app.inject({
      method: "POST",
      url: `/society/societies/${societyId}/residents`,
      headers: { authorization: first.authorization },
      payload: { name: "Duplicate Resident", phoneNumber: "+91 98765 43210" },
    });
    expect(duplicatePhone.statusCode).toBe(409);
    expect(duplicatePhone.json().message).not.toContain("98765");

    const vehicleResponse = await app.inject({
      method: "POST",
      url: `/society/societies/${societyId}/vehicles`,
      headers: { authorization: first.authorization },
      payload: {
        residentId,
        type: "FOUR_WHEELER",
        registrationNumber: "MH 12 AB-1234",
        monthlyRatePaise: 125000,
      },
    });
    expect(vehicleResponse.statusCode).toBe(201);
    const duplicateRegistration = await app.inject({
      method: "POST",
      url: `/society/societies/${societyId}/vehicles`,
      headers: { authorization: first.authorization },
      payload: {
        residentId,
        type: "FOUR_WHEELER",
        registrationNumber: "MH12AB1234",
        monthlyRatePaise: 125000,
      },
    });
    expect(duplicateRegistration.statusCode).toBe(409);

    const isolatedList = await app.inject({
      method: "GET",
      url: `/society/societies/${societyId}/residents`,
      headers: { authorization: second.authorization },
    });
    const crossAccountCreate = await app.inject({
      method: "POST",
      url: `/society/societies/${societyId}/residents`,
      headers: { authorization: second.authorization },
      payload: { name: "Cross Account", phoneNumber: "9876543210" },
    });
    expect(isolatedList.statusCode).toBe(200);
    expect(isolatedList.json().residents).toEqual([]);
    expect(crossAccountCreate.statusCode).toBe(404);
  });

  it("returns field-level phone validation errors without reaching persistence", async () => {
    const { app, societyRepository } = createApp();
    const vendor = await register(app, "invalid-phone@example.test");
    const society = await app.inject({
      method: "POST",
      url: "/society/societies",
      headers: { authorization: vendor.authorization },
      payload: { name: "Validation Society" },
    });
    const result = await app.inject({
      method: "POST",
      url: `/society/societies/${society.json().id as string}/residents`,
      headers: { authorization: vendor.authorization },
      payload: { name: "Bad Phone", phoneNumber: "123" },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().fieldErrors).toHaveProperty("phoneNumber");
    expect(societyRepository.residents).toHaveLength(0);
  });

  it("persists separate activity schedules while enforcing role and account isolation", async () => {
    const { app, societyRepository } = createApp();
    const vendor = await register(app, "schedule-vendor@example.test");
    const otherVendor = await register(app, "schedule-other-vendor@example.test");
    const owner = await register(app, "schedule-owner@example.test", "OWNER");
    const society = await app.inject({
      method: "POST",
      url: "/society/societies",
      headers: { authorization: vendor.authorization },
      payload: { name: "Schedule Society" },
    });
    const resident = await app.inject({
      method: "POST",
      url: `/society/societies/${society.json().id as string}/residents`,
      headers: { authorization: vendor.authorization },
      payload: { name: "Schedule Resident", phoneNumber: "9876543210" },
    });
    const vehicle = await app.inject({
      method: "POST",
      url: `/society/societies/${society.json().id as string}/vehicles`,
      headers: { authorization: vendor.authorization },
      payload: {
        residentId: resident.json().id,
        type: "FOUR_WHEELER",
        registrationNumber: "MH 01 AA 0001",
        monthlyRatePaise: 10000,
      },
    });
    const vehicleId = vehicle.json().id as string;
    const exterior = await app.inject({
      method: "PUT",
      url: `/society/vehicles/${vehicleId}/schedules/EXTERIOR_WASH`,
      headers: { authorization: vendor.authorization },
      payload: { frequency: "SELECTED_DAYS", weekdays: [2, 4], effectiveFrom: "2030-01-01" },
    });
    const interior = await app.inject({
      method: "PUT",
      url: `/society/vehicles/${vehicleId}/schedules/INTERIOR_CLEANING`,
      headers: { authorization: vendor.authorization },
      payload: { frequency: "DAILY", weekdays: [], effectiveFrom: "2030-01-01" },
    });
    const schedules = await app.inject({
      method: "GET",
      url: `/society/vehicles/${vehicleId}/schedules`,
      headers: { authorization: vendor.authorization },
    });
    const crossAccount = await app.inject({
      method: "GET",
      url: `/society/vehicles/${vehicleId}/schedules`,
      headers: { authorization: otherVendor.authorization },
    });
    const ownerAccess = await app.inject({
      method: "GET",
      url: `/society/vehicles/${vehicleId}/schedules`,
      headers: { authorization: owner.authorization },
    });
    const invalidSchedule = await app.inject({
      method: "PUT",
      url: `/society/vehicles/${vehicleId}/schedules/TYRE_POLISH`,
      headers: { authorization: vendor.authorization },
      payload: { frequency: "SELECTED_DAYS", weekdays: [], effectiveFrom: "2030-01-01" },
    });

    expect(exterior.statusCode).toBe(200);
    expect(exterior.json()).toMatchObject({ activity: "EXTERIOR_WASH", weekdays: [2, 4] });
    expect(interior.statusCode).toBe(200);
    expect(interior.json()).toMatchObject({ activity: "INTERIOR_CLEANING", weekdays: [1, 2, 3, 4, 5, 6, 7] });
    expect(schedules.json().schedules).toHaveLength(2);
    expect(crossAccount.statusCode).toBe(404);
    expect(ownerAccess.statusCode).toBe(403);
    expect(invalidSchedule.statusCode).toBe(400);
    expect(invalidSchedule.json().fieldErrors).toHaveProperty("weekdays");
    expect(societyRepository.schedules).toHaveLength(2);
  });

  it("uses the Asia/Kolkata calendar date at the midnight boundary for task generation", async () => {
    const instants = ["2030-03-11T18:29:59.999Z", "2030-03-11T18:30:00.000Z"];
    let index = 0;
    const { app, societyRepository } = createApp(() => new Date(instants[index] as string));
    const vendor = await register(app, "boundary-vendor@example.test");
    const before = await app.inject({ method: "GET", url: "/society/tasks", headers: { authorization: vendor.authorization } });
    index = 1;
    const after = await app.inject({ method: "GET", url: "/society/tasks", headers: { authorization: vendor.authorization } });
    const tomorrow = await app.inject({ method: "GET", url: "/society/tasks?date=2030-03-13", headers: { authorization: vendor.authorization } });
    const today = await app.inject({ method: "GET", url: "/society/tasks?date=2030-03-12", headers: { authorization: vendor.authorization } });

    expect(before.json().date).toBe("2030-03-11");
    expect(after.json().date).toBe("2030-03-12");
    expect(tomorrow.statusCode).toBe(400);
    expect(today.statusCode).toBe(200);
    expect(societyRepository.requestedTaskDates).toEqual(["2030-03-11", "2030-03-12", "2030-03-12"]);
  });

  it("rejects the next IST date one millisecond before IST midnight", async () => {
    const { app } = createApp(() => new Date("2030-03-11T18:29:59.999Z"));
    const vendor = await register(app, "boundary-future@example.test");
    const next = await app.inject({ method: "GET", url: "/society/tasks?date=2030-03-12", headers: { authorization: vendor.authorization } });
    expect(next.statusCode).toBe(400);
    expect(next.json().fieldErrors).toHaveProperty("date");
  });
});
