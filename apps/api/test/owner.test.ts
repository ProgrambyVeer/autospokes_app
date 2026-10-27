import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

const apps: ReturnType<typeof buildApp>[] = [];

function createApp() {
  const authRepository = new MemoryAuthRepository();
  const ownerRepository = new MemoryOwnerRepository();
  const app = buildApp({
    authRepository,
    ownerRepository,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);
  return { app, authRepository, ownerRepository };
}

async function createOwner(
  app: ReturnType<typeof buildApp>,
  authRepository: MemoryAuthRepository,
  ownerRepository: MemoryOwnerRepository,
  email: string,
  role = "OWNER",
) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password: "owner-test-password-123",
      displayName: "Taylor Owner",
      role,
    },
  });
  const body = response.json();
  const credential = await authRepository.findCredentialByEmail(email);
  const profile = credential?.profiles.find((item) => item.role === role);
  if (!profile || !body.accessToken) throw new Error("Test registration did not create a session");
  if (profile.accountId) {
    ownerRepository.addProfile(profile.id, profile.accountId, profile.displayName);
  }
  return {
    accountId: profile.accountId,
    authorization: `Bearer ${body.accessToken as string}`,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("owner profile and vehicle operations", () => {
  it("requires an authenticated owner role for every owner route", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const detailer = await createOwner(
      app,
      authRepository,
      ownerRepository,
      "detailer@example.test",
      "INDEPENDENT_DETAILER",
    );
    const unauthenticated = await app.inject({ method: "GET", url: "/owner/vehicles" });
    const forbidden = await app.inject({
      method: "GET",
      url: "/owner/vehicles",
      headers: { authorization: detailer.authorization },
    });
    const forbiddenProfileUpdate = await app.inject({
      method: "PATCH",
      url: "/owner/profile",
      headers: { authorization: detailer.authorization },
      payload: { displayName: "Changed" },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(forbiddenProfileUpdate.statusCode).toBe(403);
  });

  it("supports owner profile reads and updates without accepting another account context", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "profile@example.test");
    const profile = await app.inject({
      method: "GET",
      url: "/owner/profile",
      headers: { authorization: owner.authorization },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: "/owner/profile",
      headers: { authorization: owner.authorization },
      payload: { displayName: "Taylor Driver", phoneNumber: "+1 555 0100" },
    });
    const invalid = await app.inject({
      method: "PATCH",
      url: "/owner/profile",
      headers: { authorization: owner.authorization },
      payload: { accountId: "another-account" },
    });

    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual({ displayName: "Taylor Owner", phoneNumber: null });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      displayName: "Taylor Driver",
      phoneNumber: "+1 555 0100",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("creates multiple vehicle types with optional fields and supports detail and edits", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "garage@example.test");
    const first = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "FOUR_WHEELER",
        registrationNumber: "MH 12 AB-1234",
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "TWO_WHEELER",
        registrationNumber: "KA 03 XY 9876",
        providerType: "INDEPENDENT_WASHER",
        providerName: "Local Washer",
      },
    });
    const third = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "OTHER",
        registrationNumber: "GA 01 ZZ 0042",
        providerType: "MARKETPLACE_VENDOR",
        providerName: "Marketplace Care",
      },
    });
    const list = await app.inject({
      method: "GET",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
    });
    const vehicleId = first.json().id as string;
    const detail = await app.inject({
      method: "GET",
      url: `/owner/vehicles/${vehicleId}`,
      headers: { authorization: owner.authorization },
    });
    const update = await app.inject({
      method: "PATCH",
      url: `/owner/vehicles/${vehicleId}`,
      headers: { authorization: owner.authorization },
      payload: {
        make: "Toyota",
        model: "Corolla",
        lengthCm: 4630,
        widthCm: 1780,
        heightCm: 1435,
        photoUrls: ["https://images.example.test/car.jpg"],
        locationName: "Home garage",
        address: "12 Main Street",
        city: "Pune",
        postalCode: "411001",
        providerType: "SOCIETY_VENDOR",
        providerName: "Green Society Care",
        assignedWasherName: "Sam",
        status: "INACTIVE",
      },
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      registrationNumber: "MH 12 AB-1234",
      make: null,
      providerType: null,
      status: "ACTIVE",
    });
    expect(second.statusCode).toBe(201);
    expect(list.json().vehicles).toHaveLength(3);
    expect(second.json()).toMatchObject({ providerType: "INDEPENDENT_WASHER" });
    expect(third.json()).toMatchObject({ providerType: "MARKETPLACE_VENDOR" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().serviceSummary).toEqual({
      upcomingService: null,
      currentWashStatus: null,
      recentServiceHistory: [],
      invoices: null,
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      make: "Toyota",
      model: "Corolla",
      lengthCm: 4630,
      photoUrls: ["https://images.example.test/car.jpg"],
      city: "Pune",
      providerType: "SOCIETY_VENDOR",
      assignedWasherName: "Sam",
      status: "INACTIVE",
    });
  });

  it("isolates vehicle reads and edits across owner accounts", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const firstOwner = await createOwner(
      app,
      authRepository,
      ownerRepository,
      "first@example.test",
    );
    const secondOwner = await createOwner(
      app,
      authRepository,
      ownerRepository,
      "second@example.test",
    );
    const created = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: firstOwner.authorization },
      payload: { type: "OTHER", registrationNumber: "DL 01 AB 4321" },
    });
    const vehicleId = created.json().id as string;
    const secondList = await app.inject({
      method: "GET",
      url: "/owner/vehicles",
      headers: { authorization: secondOwner.authorization },
    });
    const crossAccountRead = await app.inject({
      method: "GET",
      url: `/owner/vehicles/${vehicleId}`,
      headers: { authorization: secondOwner.authorization },
    });
    const crossAccountEdit = await app.inject({
      method: "PATCH",
      url: `/owner/vehicles/${vehicleId}`,
      headers: { authorization: secondOwner.authorization },
      payload: { make: "Not theirs" },
    });

    expect(secondList.json().vehicles).toEqual([]);
    expect(crossAccountRead.statusCode).toBe(404);
    expect(crossAccountEdit.statusCode).toBe(404);
  });

  it("normalizes registration numbers and rejects ambiguous ownership conflicts without disclosing data", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const firstOwner = await createOwner(app, authRepository, ownerRepository, "plate1@example.test");
    const secondOwner = await createOwner(app, authRepository, ownerRepository, "plate2@example.test");
    const create = (authorization: string, registrationNumber: string) =>
      app.inject({
        method: "POST",
        url: "/owner/vehicles",
        headers: { authorization },
        payload: { type: "FOUR_WHEELER", registrationNumber },
      });
    const original = await create(firstOwner.authorization, "GJ 01 AB-2222");
    const anotherVehicle = await create(secondOwner.authorization, "GJ 02 CD-3333");
    const conflict = await create(secondOwner.authorization, "gj01ab2222");
    const malformed = await create(secondOwner.authorization, "- -");
    const updateConflict = await app.inject({
      method: "PATCH",
      url: `/owner/vehicles/${anotherVehicle.json().id as string}`,
      headers: { authorization: secondOwner.authorization },
      payload: { registrationNumber: "GJ 01 AB 2222" },
    });

    expect(original.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      statusCode: 409,
      error: "Conflict",
      message: "This registration number needs ownership verification before it can be registered",
    });
    expect(JSON.stringify(conflict.json())).not.toContain(firstOwner.accountId);
    expect(malformed.statusCode).toBe(400);
    expect(updateConflict.statusCode).toBe(409);
  });

  it("accepts the Add Vehicle form payload and rejects the former status \"null\" mismatch with field errors", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "form@example.test");
    const formPayload = {
      type: "FOUR_WHEELER",
      registrationNumber: "MH 12 AB 1234",
      make: null,
      model: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      photoUrls: [],
      locationName: null,
      address: null,
      city: null,
      postalCode: null,
      providerType: null,
      providerName: null,
      assignedWasherName: null,
    };
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/owner/vehicles",
        headers: { authorization: owner.authorization },
        payload: payload as Record<string, unknown>,
      });

    const created = await post(formPayload);
    const stringNull = await post({ ...formPayload, registrationNumber: "MH 12 AB 9999", status: "null" });
    const unknown = await post({ ...formPayload, registrationNumber: "MH 12 AB 9998", ownerId: "x" });
    const invalid = await post({
      type: "BOAT",
      registrationNumber: "--",
      lengthCm: 0,
      photoUrls: ["ftp://example.test/a.png"],
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "ACTIVE", providerType: null, make: null });
    expect(stringNull.statusCode).toBe(400);
    expect(stringNull.json().fieldErrors.status).toHaveLength(1);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().fieldErrors.form[0]).toContain("ownerId");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ statusCode: 400, message: "Invalid vehicle details" });
    expect(Object.keys(invalid.json().fieldErrors).sort()).toEqual(
      ["lengthCm", "photoUrls", "registrationNumber", "type"],
    );
  });

  it("rejects invalid optional fields and provider combinations", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "invalid@example.test");
    const badDimension = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "TWO_WHEELER",
        registrationNumber: "MH 14 XY 1010",
        widthCm: -2,
      },
    });
    const badPhoto = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "TWO_WHEELER",
        registrationNumber: "MH 14 XY 1011",
        photoUrls: ["javascript:alert(1)"],
      },
    });
    const invalidWasher = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: {
        type: "TWO_WHEELER",
        registrationNumber: "MH 14 XY 1012",
        providerType: "INDEPENDENT_WASHER",
        assignedWasherName: "Someone",
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers: { authorization: owner.authorization },
      payload: { type: "TWO_WHEELER", registrationNumber: "MH 14 XY 1013" },
    });
    const invalidUpdatedRegistration = await app.inject({
      method: "PATCH",
      url: `/owner/vehicles/${created.json().id as string}`,
      headers: { authorization: owner.authorization },
      payload: { registrationNumber: "- -" },
    });

    expect(badDimension.statusCode).toBe(400);
    expect(badPhoto.statusCode).toBe(400);
    expect(invalidWasher.statusCode).toBe(400);
    expect(invalidUpdatedRegistration.statusCode).toBe(400);
  });
});

describe("owner dashboard", () => {
  const dashboardUrl = "/owner/dashboard";

  it("requires an authenticated Owner and rejects other roles", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const detailer = await createOwner(app, authRepository, ownerRepository, "dash-detailer@example.test", "INDEPENDENT_DETAILER");
    const society = await createOwner(app, authRepository, ownerRepository, "dash-society@example.test", "SOCIETY_VENDOR");
    const anonymous = await app.inject({ method: "GET", url: dashboardUrl });
    const asDetailer = await app.inject({ method: "GET", url: dashboardUrl, headers: { authorization: detailer.authorization } });
    const asSociety = await app.inject({ method: "GET", url: dashboardUrl, headers: { authorization: society.authorization } });

    expect(anonymous.statusCode).toBe(401);
    expect(asDetailer.statusCode).toBe(403);
    expect(asSociety.statusCode).toBe(403);
  });

  it("returns an honest empty dashboard for an Owner without vehicles", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "dash-empty@example.test");
    const response = await app.inject({ method: "GET", url: dashboardUrl, headers: { authorization: owner.authorization } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      summary: {
        totalVehicles: 0,
        activeVehicles: 0,
        inactiveVehicles: 0,
        vehiclesWithoutProvider: 0,
        providerCounts: { INDEPENDENT_WASHER: 0, SOCIETY_VENDOR: 0, MARKETPLACE_VENDOR: 0 },
      },
      vehicles: [],
      recentActivity: [],
      availability: {
        bookings: { available: false },
        billing: { available: false },
        notifications: { available: false },
      },
    });
  });

  it("keeps per-vehicle status separate across multiple vehicles and never invents service or billing data", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const owner = await createOwner(app, authRepository, ownerRepository, "dash-multi@example.test");
    const headers = { authorization: owner.authorization };
    const bare = await app.inject({ method: "POST", url: "/owner/vehicles", headers, payload: { type: "FOUR_WHEELER", registrationNumber: "MH 12 DA 0001" } });
    const withProvider = await app.inject({
      method: "POST",
      url: "/owner/vehicles",
      headers,
      payload: { type: "TWO_WHEELER", registrationNumber: "MH 12 DA 0002", providerType: "SOCIETY_VENDOR", providerName: "Test Society", assignedWasherName: "Washer One" },
    });
    const inactive = await app.inject({ method: "POST", url: "/owner/vehicles", headers, payload: { type: "OTHER", registrationNumber: "MH 12 DA 0003", providerType: "MARKETPLACE_VENDOR", providerName: "Market" } });
    await app.inject({ method: "PATCH", url: `/owner/vehicles/${inactive.json().id as string}`, headers, payload: { status: "INACTIVE" } });

    const response = await app.inject({ method: "GET", url: dashboardUrl, headers });
    const body = response.json();
    const byId = Object.fromEntries(body.vehicles.map((item: { vehicleId: string }) => [item.vehicleId, item]));

    expect(response.statusCode).toBe(200);
    expect(body.summary).toMatchObject({
      totalVehicles: 3,
      activeVehicles: 2,
      inactiveVehicles: 1,
      vehiclesWithoutProvider: 1,
      providerCounts: { INDEPENDENT_WASHER: 0, SOCIETY_VENDOR: 1, MARKETPLACE_VENDOR: 1 },
    });
    expect(byId[bare.json().id]).toMatchObject({ serviceStatus: "NO_PROVIDER", providerType: null, providerVerified: false });
    expect(byId[withProvider.json().id]).toMatchObject({ serviceStatus: "PROVIDER_RECORDED", providerType: "SOCIETY_VENDOR", providerVerified: false });
    expect(byId[inactive.json().id]).toMatchObject({ serviceStatus: "INACTIVE" });
    for (const item of body.vehicles) {
      expect(item).toMatchObject({ upcomingService: null, currentWashStatus: null });
    }
    expect(body.availability).toEqual({
      bookings: { available: false },
      billing: { available: false },
      notifications: { available: false },
    });
    expect(body.recentActivity.every((item: { kind: string }) => ["VEHICLE_ADDED", "VEHICLE_UPDATED"].includes(item.kind))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/invoice|balance|paid/i);
  });

  it("derives data only from the session account and ignores client-supplied account context", async () => {
    const { app, authRepository, ownerRepository } = createApp();
    const first = await createOwner(app, authRepository, ownerRepository, "dash-one@example.test");
    const second = await createOwner(app, authRepository, ownerRepository, "dash-two@example.test");
    await app.inject({ method: "POST", url: "/owner/vehicles", headers: { authorization: first.authorization }, payload: { type: "FOUR_WHEELER", registrationNumber: "MH 12 DB 1111", providerName: "Private Provider" } });

    const spoofed = await app.inject({
      method: "GET",
      url: `${dashboardUrl}?accountId=${first.accountId as string}`,
      headers: { authorization: second.authorization, "x-account-id": first.accountId as string },
    });

    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.json().summary.totalVehicles).toBe(0);
    expect(spoofed.json().vehicles).toEqual([]);
    expect(spoofed.json().recentActivity).toEqual([]);
    expect(JSON.stringify(spoofed.json())).not.toContain("MH 12 DB 1111");
  });
});
