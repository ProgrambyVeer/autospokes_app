import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BOOKING_TRANSITIONS, planTransition } from "../src/marketplace/rules.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryMarketplaceRepository } from "./support/memory-marketplace-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

const apps: ReturnType<typeof buildApp>[] = [];
type App = ReturnType<typeof buildApp>;
type Actor = { authorization: string; accountId: string };

function setup() {
  const marketplaceRepository = new MemoryMarketplaceRepository();
  const app = buildApp({
    authRepository: new MemoryAuthRepository(),
    ownerRepository: new MemoryOwnerRepository(),
    marketplaceRepository,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);
  return { app, marketplaceRepository };
}

async function register(app: App, email: string, role: string): Promise<Actor> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "marketplace-test-password-123", displayName: "Test User", role },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { authorization: ["Bearer", body.accessToken].join(" "), accountId: body.user.accountId };
}

async function call(app: App, actor: Actor | null, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: { ...(actor ? { authorization: actor.authorization } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const profileInput = {
  businessName: "Test Garage",
  category: "GARAGE",
  contactPhone: "9876543210",
  city: "Pune",
  latitude: 18.5204,
  longitude: 73.8567,
  serviceRadiusKm: 15,
  supportedVehicleTypes: ["FOUR_WHEELER", "TWO_WHEELER"],
};
const serviceInput = {
  name: "Full exterior wash",
  category: "EXTERIOR_WASH",
  vehicleTypes: ["FOUR_WHEELER"],
  pricePaise: 50_000,
  durationMinutes: 60,
};

const hours = (days: number) => new Date(Date.now() + days * 86_400_000);

async function seed() {
  const ctx = setup();
  const vendor = await register(ctx.app, "vendor@example.test", "MARKETPLACE_VENDOR");
  const owner = await register(ctx.app, "owner@example.test", "OWNER");
  expect((await call(ctx.app, vendor, "PUT", "/marketplace/profile", profileInput)).statusCode).toBe(200);
  const service = (await call(ctx.app, vendor, "POST", "/marketplace/services", serviceInput)).json();
  const vehicle = (await call(ctx.app, owner, "POST", "/owner/vehicles", {
    type: "FOUR_WHEELER",
    registrationNumber: "MH 12 AB 1234",
  })).json();
  return { ...ctx, vendor, owner, service, vehicle };
}

const fixedStart = hours(2);

async function book(ctx: Awaited<ReturnType<typeof seed>>, key = "key-booking-0001", extra: Record<string, unknown> = {}) {
  const start = fixedStart;
  return call(ctx.app, ctx.owner, "POST", "/owner/marketplace/bookings", {
    vehicleId: ctx.vehicle.id,
    serviceId: ctx.service.id,
    windowStart: start.toISOString(),
    windowEnd: new Date(start.getTime() + 3_600_000).toISOString(),
    serviceLocation: "Flat 4, Test Society, Pune",
    accessNotes: "Gate code 1234",
    ...extra,
  }, { "idempotency-key": key });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("marketplace authorization", () => {
  it("requires authentication and the right role on every route family", async () => {
    const { app } = setup();
    const vendor = await register(app, "v@example.test", "MARKETPLACE_VENDOR");
    const owner = await register(app, "o@example.test", "OWNER");
    const detailer = await register(app, "d@example.test", "INDEPENDENT_DETAILER");

    for (const url of ["/marketplace/profile", "/marketplace/services", "/marketplace/staff", "/marketplace/bookings", "/marketplace/dashboard"]) {
      expect((await call(app, null, "GET", url)).statusCode).toBe(401);
      expect((await call(app, owner, "GET", url)).statusCode).toBe(403);
      expect((await call(app, detailer, "GET", url)).statusCode).toBe(403);
      expect((await call(app, vendor, "GET", url)).statusCode).toBe(200);
    }
    for (const url of ["/owner/marketplace/services?city=Pune", "/owner/marketplace/bookings"]) {
      expect((await call(app, null, "GET", url)).statusCode).toBe(401);
      expect((await call(app, vendor, "GET", url)).statusCode).toBe(403);
      expect((await call(app, owner, "GET", url)).statusCode).toBe(200);
    }
  });

  it("does not let clients set verification status or an account id", async () => {
    const { app, marketplaceRepository } = setup();
    const vendor = await register(app, "v@example.test", "MARKETPLACE_VENDOR");
    const rejected = await call(app, vendor, "PUT", "/marketplace/profile", { ...profileInput, verificationStatus: "VERIFIED" });
    expect(rejected.statusCode).toBe(400);
    const accepted = await call(app, vendor, "PUT", "/marketplace/profile", profileInput);
    expect(accepted.json().profile.verificationStatus).toBe("PENDING");
    expect(marketplaceRepository.profiles.get(vendor.accountId)?.accountId).toBe(vendor.accountId);
  });
});

describe("marketplace catalogue and staff", () => {
  it("validates prices and durations and isolates vendors", async () => {
    const { app } = setup();
    const a = await register(app, "a@example.test", "MARKETPLACE_VENDOR");
    const b = await register(app, "b@example.test", "MARKETPLACE_VENDOR");
    expect((await call(app, a, "POST", "/marketplace/services", { ...serviceInput, pricePaise: -5 })).statusCode).toBe(400);
    expect((await call(app, a, "POST", "/marketplace/services", { ...serviceInput, pricePaise: 0 })).statusCode).toBe(400);
    expect((await call(app, a, "POST", "/marketplace/services", { ...serviceInput, durationMinutes: 1 })).statusCode).toBe(400);
    const created = await call(app, a, "POST", "/marketplace/services", serviceInput);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await call(app, b, "GET", `/marketplace/services/${id}`)).statusCode).toBe(404);
    expect((await call(app, b, "PATCH", `/marketplace/services/${id}`, { pricePaise: 1 })).statusCode).toBe(404);
    expect((await call(app, b, "POST", `/marketplace/services/${id}/status`, { status: "INACTIVE" })).statusCode).toBe(404);
    expect((await call(app, b, "GET", "/marketplace/services")).json().services).toHaveLength(0);
  });

  it("treats archived services as terminal", async () => {
    const { app } = setup();
    const a = await register(app, "a@example.test", "MARKETPLACE_VENDOR");
    const id = (await call(app, a, "POST", "/marketplace/services", serviceInput)).json().id;
    expect((await call(app, a, "POST", `/marketplace/services/${id}/status`, { status: "ARCHIVED" })).statusCode).toBe(200);
    expect((await call(app, a, "POST", `/marketplace/services/${id}/status`, { status: "ACTIVE" })).statusCode).toBe(409);
    expect((await call(app, a, "PATCH", `/marketplace/services/${id}`, { name: "Renamed" })).statusCode).toBe(409);
  });

  it("isolates staff between vendors", async () => {
    const { app } = setup();
    const a = await register(app, "a@example.test", "MARKETPLACE_VENDOR");
    const b = await register(app, "b@example.test", "MARKETPLACE_VENDOR");
    const staff = (await call(app, a, "POST", "/marketplace/staff", { name: "Ravi", phoneNumber: "9876543211" })).json();
    expect(staff.phoneNumber).toBe("+919876543211");
    expect((await call(app, b, "PATCH", `/marketplace/staff/${staff.id}`, { name: "X" })).statusCode).toBe(404);
    expect((await call(app, b, "GET", "/marketplace/staff")).json().staff).toHaveLength(0);
  });
});

describe("owner discovery", () => {
  it("asks for a location, then returns honest results and never ranks by fabricated data", async () => {
    const ctx = await seed();
    const none = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services");
    expect(none.json().status).toBe("LOCATION_REQUIRED");
    expect(none.json().results).toEqual([]);

    const near = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services?latitude=18.53&longitude=73.85");
    expect(near.json().results).toHaveLength(1);
    expect(near.json().results[0].distanceKm).toBeGreaterThanOrEqual(0);
    expect(near.json().results[0].vendor.verificationStatus).toBe("PENDING");
    expect(near.json().unsupported).toContain("rating");

    const far = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services?latitude=28.61&longitude=77.2");
    expect(far.json().results).toEqual([]);
    expect(far.json().noResultsWithinRadius).toBe(true);

    const wrongType = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services?city=Pune&vehicleType=TWO_WHEELER");
    expect(wrongType.json().results).toEqual([]);
    const byCity = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services?city=pune");
    expect(byCity.json().results).toHaveLength(1);
    expect(byCity.json().results[0].distanceKm).toBeNull();
  });

  it("excludes inactive and archived services", async () => {
    const ctx = await seed();
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/services/${ctx.service.id}/status`, { status: "INACTIVE" });
    const response = await call(ctx.app, ctx.owner, "GET", "/owner/marketplace/services?city=Pune");
    expect(response.json().results).toEqual([]);
  });
});

describe("marketplace bookings", () => {
  it("creates a booking from the owner's own vehicle and snapshots the agreed terms", async () => {
    const ctx = await seed();
    const response = await book(ctx);
    expect(response.statusCode).toBe(201);
    const booking = response.json().booking;
    expect(booking.status).toBe("REQUESTED");
    expect(booking.servicePricePaise).toBe(50_000);
    expect(booking.ownerAccountId).toBeUndefined();
    expect(booking.idempotencyKey).toBeUndefined();

    await call(ctx.app, ctx.vendor, "PATCH", `/marketplace/services/${ctx.service.id}`, { pricePaise: 90_000, name: "Changed" });
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/services/${ctx.service.id}/status`, { status: "ARCHIVED" });
    const detail = (await call(ctx.app, ctx.owner, "GET", `/owner/marketplace/bookings/${booking.id}`)).json();
    expect(detail.booking.servicePricePaise).toBe(50_000);
    expect(detail.booking.serviceName).toBe("Full exterior wash");
  });

  it("is idempotent and rejects a reused key with a different request", async () => {
    const ctx = await seed();
    const first = await book(ctx);
    const replay = await book(ctx);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().booking.id).toBe(first.json().booking.id);
    const mismatch = await book(ctx, "key-booking-0001", { serviceLocation: "Somewhere else" });
    expect(mismatch.statusCode).toBe(409);
    expect(ctx.marketplaceRepository.bookings.size).toBe(1);
    const missing = await call(ctx.app, ctx.owner, "POST", "/owner/marketplace/bookings", {});
    expect(missing.statusCode).toBe(400);
  });

  it("rejects vehicles the owner does not own, unsupported types and past windows", async () => {
    const ctx = await seed();
    const other = await register(ctx.app, "other@example.test", "OWNER");
    const foreign = (await call(ctx.app, other, "POST", "/owner/vehicles", { type: "FOUR_WHEELER", registrationNumber: "KA 01 ZZ 9999" })).json();
    expect((await book(ctx, "key-booking-0002", { vehicleId: foreign.id })).statusCode).toBe(404);

    const bike = (await call(ctx.app, ctx.owner, "POST", "/owner/vehicles", { type: "TWO_WHEELER", registrationNumber: "MH 12 CD 4321" })).json();
    expect((await book(ctx, "key-booking-0003", { vehicleId: bike.id })).statusCode).toBe(409);

    const past = new Date(Date.now() - 3_600_000);
    expect((await book(ctx, "key-booking-0004", {
      windowStart: past.toISOString(),
      windowEnd: new Date(past.getTime() + 3_600_000).toISOString(),
    })).statusCode).toBe(400);
  });

  it("masks vehicle and location details from the vendor until acceptance", async () => {
    const ctx = await seed();
    const id = (await book(ctx)).json().booking.id;
    const before = (await call(ctx.app, ctx.vendor, "GET", `/marketplace/bookings/${id}`)).json().booking;
    expect(before.vehicleRegistration).not.toContain("MH12");
    expect(before.serviceLocation).not.toContain("Pune");
    expect(before.accessNotes).toBeNull();
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${id}/accept`, {});
    const after = (await call(ctx.app, ctx.vendor, "GET", `/marketplace/bookings/${id}`)).json().booking;
    expect(after.serviceLocation).toContain("Pune");
  });

  it("isolates bookings between owners and vendors", async () => {
    const ctx = await seed();
    const id = (await book(ctx)).json().booking.id;
    const otherOwner = await register(ctx.app, "o2@example.test", "OWNER");
    const otherVendor = await register(ctx.app, "v2@example.test", "MARKETPLACE_VENDOR");
    expect((await call(ctx.app, otherOwner, "GET", `/owner/marketplace/bookings/${id}`)).statusCode).toBe(404);
    expect((await call(ctx.app, otherOwner, "POST", `/owner/marketplace/bookings/${id}/dispute`, { reason: "x" })).statusCode).toBe(404);
    expect((await call(ctx.app, otherVendor, "GET", `/marketplace/bookings/${id}`)).statusCode).toBe(404);
    expect((await call(ctx.app, otherVendor, "POST", `/marketplace/bookings/${id}/accept`, {})).statusCode).toBe(404);
    expect((await call(ctx.app, otherVendor, "POST", `/marketplace/bookings/${id}/payments`, { amountPaise: 100, method: "CASH" })).statusCode).toBe(404);
    expect((await call(ctx.app, otherOwner, "GET", "/owner/marketplace/bookings")).json().bookings).toHaveLength(0);
    expect((await call(ctx.app, otherVendor, "GET", "/marketplace/bookings")).json().bookings).toHaveLength(0);
  });
});

describe("booking lifecycle", () => {
  it("runs request to customer acceptance and refuses invalid or role-crossing transitions", async () => {
    const ctx = await seed();
    const id = (await book(ctx)).json().booking.id;
    const vendorPost = (path: string, body: unknown = {}) => call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${id}/${path}`, body);
    const ownerPost = (path: string, body: unknown = {}) => call(ctx.app, ctx.owner, "POST", `/owner/marketplace/bookings/${id}/${path}`, body);

    expect((await vendorPost("start")).statusCode).toBe(409);
    expect((await vendorPost("complete", { notes: "done" })).statusCode).toBe(409);
    expect((await ownerPost("accept-completion")).statusCode).toBe(409);
    expect((await vendorPost("reject", {})).statusCode).toBe(400);
    expect((await vendorPost("accept")).statusCode).toBe(200);
    expect((await vendorPost("accept")).statusCode).toBe(409);
    expect((await vendorPost("start")).statusCode).toBe(200);
    expect((await vendorPost("complete", {})).statusCode).toBe(400);
    expect((await vendorPost("complete", { notes: "Washed and dried" })).statusCode).toBe(200);
    expect((await ownerPost("accept-completion")).statusCode).toBe(200);
    expect((await ownerPost("dispute", { reason: "late" })).statusCode).toBe(409);
    expect((await vendorPost("settle")).statusCode).toBe(404);
    expect((await vendorPost("close")).statusCode).toBe(404);

    const detail = (await call(ctx.app, ctx.owner, "GET", `/owner/marketplace/bookings/${id}`)).json();
    expect(detail.booking.status).toBe("CUSTOMER_ACCEPTED");
    expect(detail.events.map((event: { kind: string }) => event.kind)).toEqual([
      "requested", "accept", "start", "report_completion", "customer_accept",
    ]);
  });

  it("supports rejection with a reason and disputes with a reason, both terminal", async () => {
    const ctx = await seed();
    const rejectedId = (await book(ctx, "key-booking-0010")).json().booking.id;
    expect((await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${rejectedId}/reject`, { reason: "Fully booked" })).statusCode).toBe(200);
    expect((await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${rejectedId}/accept`, {})).statusCode).toBe(409);

    const disputedId = (await book(ctx, "key-booking-0011")).json().booking.id;
    for (const step of ["accept", "start"]) {
      await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${disputedId}/${step}`, {});
    }
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${disputedId}/complete`, { notes: "Done" });
    expect((await call(ctx.app, ctx.owner, "POST", `/owner/marketplace/bookings/${disputedId}/dispute`, {})).statusCode).toBe(400);
    expect((await call(ctx.app, ctx.owner, "POST", `/owner/marketplace/bookings/${disputedId}/dispute`, { reason: "Not clean" })).statusCode).toBe(200);
    expect((await call(ctx.app, ctx.owner, "POST", `/owner/marketplace/bookings/${disputedId}/accept-completion`, {})).statusCode).toBe(409);
  });

  it("keeps settlement behind a verified payment process", () => {
    const booking = { status: "CUSTOMER_ACCEPTED" as const, servicePricePaise: 50_000 };
    const now = new Date();
    expect(() => planTransition(booking, "settle", "VENDOR", {}, now)).toThrow(/role/);
    expect(() => planTransition(booking, "settle", "OWNER", {}, now)).toThrow(/role/);
    expect(() => planTransition(booking, "settle", "VERIFIED_PAYMENT_PROCESS", {}, now, { verifiedPaidPaise: 49_999 })).toThrow(/verified payment/);
    expect(planTransition(booking, "settle", "VERIFIED_PAYMENT_PROCESS", {}, now, { verifiedPaidPaise: 50_000 }).to).toBe("SETTLED");
    expect(BOOKING_TRANSITIONS.settle.actor).toBe("VERIFIED_PAYMENT_PROCESS");
  });
});

describe("staff assignment and payments", () => {
  it("assigns, reassigns and audits staff only on accepted bookings from the same vendor", async () => {
    const ctx = await seed();
    const id = (await book(ctx)).json().booking.id;
    const ravi = (await call(ctx.app, ctx.vendor, "POST", "/marketplace/staff", { name: "Ravi" })).json();
    const asha = (await call(ctx.app, ctx.vendor, "POST", "/marketplace/staff", { name: "Asha" })).json();
    const other = await register(ctx.app, "v2@example.test", "MARKETPLACE_VENDOR");
    const stranger = (await call(ctx.app, other, "POST", "/marketplace/staff", { name: "Stranger" })).json();
    const assign = (staffId: string | null) => call(ctx.app, ctx.vendor, "PUT", `/marketplace/bookings/${id}/staff`, { staffId });

    expect((await assign(ravi.id)).statusCode).toBe(409);
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${id}/accept`, {});
    expect((await assign(stranger.id)).statusCode).toBe(404);
    expect((await assign(ravi.id)).statusCode).toBe(200);
    expect((await assign(asha.id)).statusCode).toBe(200);
    await call(ctx.app, ctx.vendor, "PATCH", `/marketplace/staff/${ravi.id}`, { available: false });
    expect((await assign(ravi.id)).statusCode).toBe(409);

    const kinds = ctx.marketplaceRepository.events.map((event) => event.kind);
    expect(kinds).toContain("staff_assigned");
    expect(kinds).toContain("staff_reassigned");

    const ownerView = (await call(ctx.app, ctx.owner, "GET", `/owner/marketplace/bookings/${id}`)).json();
    expect(ownerView.staffName).toBe("Asha");
    expect(JSON.stringify(ownerView)).not.toContain(asha.id);
    const staffList = (await call(ctx.app, ctx.vendor, "GET", "/marketplace/staff")).json().staff;
    expect(staffList.find((member: { id: string }) => member.id === asha.id).openBookings).toBe(1);
  });

  it("records payments as unverified and never changes booking state", async () => {
    const ctx = await seed();
    const id = (await book(ctx)).json().booking.id;
    const pay = (amountPaise: number) => call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${id}/payments`, { amountPaise, method: "UPI", reference: "UTR123" });

    expect((await pay(10_000)).statusCode).toBe(409);
    await call(ctx.app, ctx.vendor, "POST", `/marketplace/bookings/${id}/accept`, {});
    const recorded = await pay(20_000);
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().status).toBe("RECORDED_UNVERIFIED");
    expect((await pay(30_001)).statusCode).toBe(409);
    expect((await pay(0)).statusCode).toBe(400);
    expect((await pay(30_000)).statusCode).toBe(201);

    const detail = (await call(ctx.app, ctx.owner, "GET", `/owner/marketplace/bookings/${id}`)).json();
    expect(detail.booking.status).toBe("ACCEPTED");
    expect(detail.payment.recordedPaise).toBe(50_000);
    expect(detail.payment.verifiedPaise).toBe(0);
  });
});

describe("vendor dashboard", () => {
  it("reports only real counts", async () => {
    const empty = setup();
    const vendor = await register(empty.app, "v@example.test", "MARKETPLACE_VENDOR");
    const blank = (await call(empty.app, vendor, "GET", "/marketplace/dashboard")).json();
    expect(blank.totalBookings).toBe(0);
    expect(blank.profile).toBeNull();
    expect(blank).not.toHaveProperty("revenue");
    expect(blank).not.toHaveProperty("rating");

    const ctx = await seed();
    await book(ctx);
    const dashboard = (await call(ctx.app, ctx.vendor, "GET", "/marketplace/dashboard")).json();
    expect(dashboard.totalBookings).toBe(1);
    expect(dashboard.bookingCounts.REQUESTED).toBe(1);
    expect(dashboard.services.active).toBe(1);
  });
});

describe("phase 7 migration", () => {
  const migration = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261110100000_phase7_marketplace_vendor/migration.sql"),
    "utf8",
  );

  it("is additive and keeps the guards", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)\b/i);
    expect(migration).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE\s+\S+\s+DROP)\b/i);
    expect(migration).toMatch(/marketplace_booking_snapshot_guard/);
    expect(migration).toMatch(/CHECK/);
  });
});
