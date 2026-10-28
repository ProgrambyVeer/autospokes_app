import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/security.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryMarketplaceRepository } from "./support/memory-marketplace-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

type Actor = { authorization: string; accountId: string; userId: string };
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const PASSWORD = "phase9-test-password-123";

async function setup() {
  const clock = new Date("2030-01-01T06:00:00.000Z");
  const authRepository = new MemoryAuthRepository();
  const app = buildApp({
    authRepository,
    ownerRepository: new MemoryOwnerRepository(),
    marketplaceRepository: new MemoryMarketplaceRepository(),
    clock: () => clock,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);

  const register = async (email: string, role: string): Promise<Actor> => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: PASSWORD, displayName: `P9 ${role}`, role },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { authorization: ["Bearer", body.accessToken].join(" "), accountId: body.user.accountId, userId: body.user.id };
  };
  await authRepository.createSuperadmin({
    email: "p9-admin@example.test",
    passwordHash: await hashPassword("p9-admin-password-test-only"),
    displayName: "P9 Admin",
  });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "p9-admin@example.test", password: "p9-admin-password-test-only" },
  });
  expect(login.statusCode).toBe(200);
  const admin: Actor = {
    authorization: ["Bearer", login.json().accessToken].join(" "),
    accountId: "",
    userId: login.json().user.id,
  };

  const call = (actor: Actor | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: { ...(actor ? { authorization: actor.authorization } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const vendor = await register("p9-vendor@example.test", "MARKETPLACE_VENDOR");
  const owner = await register("p9-owner@example.test", "OWNER");
  const otherOwner = await register("p9-other-owner@example.test", "OWNER");
  const detailer = await register("p9-detailer@example.test", "INDEPENDENT_DETAILER");
  const society = await register("p9-society@example.test", "SOCIETY_VENDOR");

  await call(vendor, "PUT", "/marketplace/profile", {
    businessName: "P9 Test Garage",
    category: "GARAGE",
    contactPhone: "9876543210",
    city: "Pune",
    latitude: 18.5204,
    longitude: 73.8567,
    serviceRadiusKm: 15,
    supportedVehicleTypes: ["FOUR_WHEELER"],
  });
  const service = (
    await call(vendor, "POST", "/marketplace/services", {
      name: "Full exterior wash",
      category: "EXTERIOR_WASH",
      vehicleTypes: ["FOUR_WHEELER"],
      pricePaise: 50_000,
      durationMinutes: 60,
    })
  ).json();
  const vehicle = (await call(owner, "POST", "/owner/vehicles", { type: "FOUR_WHEELER", registrationNumber: "MH 12 AB 9999" })).json();

  let counter = 0;
  const completed = async () => {
    counter += 1;
    const start = new Date(clock.getTime() + 2 * 3_600_000);
    const created = await call(
      owner,
      "POST",
      "/owner/marketplace/bookings",
      {
        vehicleId: vehicle.id,
        serviceId: service.id,
        windowStart: start.toISOString(),
        windowEnd: new Date(start.getTime() + 3_600_000).toISOString(),
        serviceLocation: "Flat 4, Test Society, Pune",
      },
      { "idempotency-key": `p9-booking-key-${counter}` },
    );
    expect(created.statusCode).toBe(201);
    const id = created.json().booking.id as string;
    for (const [step, body] of [["accept", {}], ["start", {}], ["complete", { notes: "Washed and dried" }]] as const) {
      expect((await call(vendor, "POST", `/marketplace/bookings/${id}/${step}`, body)).statusCode).toBe(200);
    }
    return id;
  };
  const ownerPost = (id: string, path: string, body: unknown = {}) => call(owner, "POST", `/owner/marketplace/bookings/${id}/${path}`, body);
  const adminPost = (path: string, body: unknown = {}) => call(admin, "POST", `/admin/marketplace/${path}`, body);
  const adminDetail = async (id: string) => (await call(admin, "GET", `/admin/marketplace/bookings/${id}`)).json();

  return { app, authRepository, admin, owner, otherOwner, vendor, detailer, society, call, completed, ownerPost, adminPost, adminDetail };
}

describe("readiness", () => {
  it("reports ready, and 503 without leaking details when the database check fails", async () => {
    const base = {
      authRepository: new MemoryAuthRepository(),
      ownerRepository: new MemoryOwnerRepository(),
      jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
      nodeEnv: "test",
    };
    const ok = buildApp({ ...base, readinessCheck: async () => undefined });
    const down = buildApp({
      ...base,
      readinessCheck: async () => {
        throw new Error("password authentication failed for user postgres");
      },
    });
    apps.push(ok, down);
    expect((await ok.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const failed = await down.inject({ method: "GET", url: "/ready" });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toMatch(/password|postgres/i);
  });
});

describe("superadmin authorization", () => {
  it("rejects unauthenticated and non-admin access to every admin route", async () => {
    const ctx = await setup();
    const routes: Array<["GET" | "POST", string]> = [
      ["GET", "/admin/accounts"],
      ["GET", `/admin/accounts/${ctx.owner.userId}`],
      ["POST", `/admin/accounts/${ctx.owner.userId}/suspend`],
      ["POST", `/admin/accounts/${ctx.owner.userId}/reactivate`],
      ["GET", "/admin/audit-events"],
      ["GET", "/admin/marketplace/payments"],
      ["GET", "/admin/marketplace/disputes"],
    ];
    for (const [method, url] of routes) {
      expect((await ctx.call(null, method, url, method === "POST" ? { reason: "no access here" } : undefined)).statusCode).toBe(401);
      for (const actor of [ctx.owner, ctx.vendor, ctx.detailer, ctx.society]) {
        const response = await ctx.call(actor, method, url, method === "POST" ? { reason: "no access here" } : undefined);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
  });
});

describe("account review, suspension and reactivation", () => {
  it("lists and filters accounts across roles without exposing secrets", async () => {
    const ctx = await setup();
    const all = await ctx.call(ctx.admin, "GET", "/admin/accounts");
    expect(all.statusCode).toBe(200);
    const roles = new Set(all.json().accounts.map((a: { role: string }) => a.role));
    expect(roles).toEqual(new Set(["OWNER", "INDEPENDENT_DETAILER", "SOCIETY_VENDOR", "MARKETPLACE_VENDOR", "SUPERADMIN"]));
    expect(all.body).not.toMatch(/passwordHash|argon2|refresh/i);
    const owners = (await ctx.call(ctx.admin, "GET", "/admin/accounts?role=OWNER")).json().accounts;
    expect(owners).toHaveLength(2);
    const found = (await ctx.call(ctx.admin, "GET", "/admin/accounts?q=other-owner")).json().accounts;
    expect(found).toHaveLength(1);
    expect((await ctx.call(ctx.admin, "GET", "/admin/accounts?role=NOPE")).statusCode).toBe(400);
    expect((await ctx.call(ctx.admin, "GET", "/admin/accounts/not-a-uuid")).statusCode).toBe(404);
  });

  it("requires a reason, suspends immediately, blocks login and revokes sessions, then reactivates", async () => {
    const ctx = await setup();
    const url = `/admin/accounts/${ctx.owner.userId}`;
    expect((await ctx.call(ctx.admin, "POST", `${url}/suspend`, {})).statusCode).toBe(400);
    expect((await ctx.call(ctx.admin, "POST", `${url}/suspend`, { reason: "abc" })).statusCode).toBe(400);
    expect((await ctx.call(ctx.admin, "POST", `${url}/reactivate`, { reason: "Not suspended yet" })).statusCode).toBe(409);

    const suspended = await ctx.call(ctx.admin, "POST", `${url}/suspend`, { reason: "Chargeback investigation" });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().account).toMatchObject({ status: "DISABLED", suspension: { reason: "Chargeback investigation" } });
    expect((await ctx.call(ctx.admin, "POST", `${url}/suspend`, { reason: "Duplicate request" })).statusCode).toBe(409);

    expect((await ctx.call(ctx.owner, "GET", "/owner/vehicles")).statusCode).toBe(401);
    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "p9-owner@example.test", password: PASSWORD, role: "OWNER" },
    });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);

    const reactivated = await ctx.call(ctx.admin, "POST", `${url}/reactivate`, { reason: "Investigation closed" });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().account.status).toBe("ACTIVE");
    const relogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "p9-owner@example.test", password: PASSWORD, role: "OWNER" },
    });
    expect(relogin.statusCode).toBe(200);

    const audit = (await ctx.call(ctx.admin, "GET", "/admin/audit-events?action=ACCOUNT_SUSPENDED")).json().events;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: ctx.admin.userId, details: { reason: "Chargeback investigation" } });
    const all = (await ctx.call(ctx.admin, "GET", "/admin/audit-events")).json().events;
    expect(all.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["ACCOUNT_SUSPENDED", "ACCOUNT_REACTIVATED"]),
    );
  });

  it("protects Superadmin accounts and the acting admin, and 404s unknown users", async () => {
    const ctx = await setup();
    const self = await ctx.call(ctx.admin, "POST", `/admin/accounts/${ctx.admin.userId}/suspend`, { reason: "Locking myself out" });
    expect(self.statusCode).toBe(403);
    const unknown = await ctx.call(ctx.admin, "POST", "/admin/accounts/11111111-1111-4111-8111-111111111111/suspend", { reason: "Does not exist" });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("dispute withdrawal", () => {
  it("lets the Owner withdraw, preserves history, restores the booking and allows re-dispute", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    expect((await ctx.ownerPost(id, "dispute", { reason: "Rear bumper still dirty" })).statusCode).toBe(200);
    await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/dispute/respond`, { message: "Cleaned again on site" });

    const withdrawn = await ctx.ownerPost(id, "dispute/withdraw", { note: "Resolved directly with vendor" });
    expect(withdrawn.statusCode).toBe(200);
    const detail = await ctx.adminDetail(id);
    expect(detail.booking.status).toBe("PROVIDER_REPORTED_COMPLETION");
    expect(detail.disputes[0].status).toBe("WITHDRAWN");
    expect(detail.disputes[0].entries.map((e: { kind: string }) => e.kind)).toEqual(["OPENED", "VENDOR_RESPONSE", "WITHDRAWN"]);

    expect((await ctx.ownerPost(id, "dispute/withdraw", {})).statusCode).toBe(409);
    expect((await ctx.ownerPost(id, "accept-completion")).statusCode).toBe(200);
  });

  it("allows a fresh dispute after withdrawal", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "dispute", { reason: "First complaint" });
    await ctx.ownerPost(id, "dispute/withdraw", {});
    expect((await ctx.ownerPost(id, "dispute", { reason: "Second complaint" })).statusCode).toBe(200);
    expect((await ctx.adminDetail(id)).disputes).toHaveLength(2);
  });

  it("blocks other owners, other roles and resolved disputes from withdrawing", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "dispute", { reason: "Dirty interior" });
    const path = `/owner/marketplace/bookings/${id}/dispute/withdraw`;
    expect((await ctx.call(ctx.otherOwner, "POST", path, {})).statusCode).toBe(404);
    expect((await ctx.call(ctx.vendor, "POST", path, {})).statusCode).toBe(403);
    expect((await ctx.call(ctx.admin, "POST", path, {})).statusCode).toBe(403);
    expect((await ctx.call(null, "POST", path, {})).statusCode).toBe(401);

    const disputeId = (await ctx.adminDetail(id)).disputes[0].id;
    await ctx.adminPost(`disputes/${disputeId}/resolve`, { outcome: "REWORK_REQUIRED", rationale: "Vendor must redo the interior" });
    expect((await ctx.ownerPost(id, "dispute/withdraw", {})).statusCode).toBe(409);
  });

  it("does not let the vendor respond to a withdrawn dispute", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "dispute", { reason: "Dirty" });
    await ctx.ownerPost(id, "dispute/withdraw", {});
    const late = await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/dispute/respond`, { message: "Late reply" });
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("dispute-driven cancellation and payment review", () => {
  it("records a DISPUTE_RESOLUTION cancellation when resolution cancels the booking", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "dispute", { reason: "Wrong service performed" });
    const disputeId = (await ctx.adminDetail(id)).disputes[0].id;
    const resolved = await ctx.adminPost(`disputes/${disputeId}/resolve`, {
      outcome: "CANCELLED_NO_CHARGE",
      rationale: "Service was never performed",
    });
    expect(resolved.statusCode).toBe(200);
    const detail = await ctx.adminDetail(id);
    expect(detail.booking.status).toBe("CANCELLED");
    expect(detail.cancellation).toMatchObject({ kind: "DISPUTE_RESOLUTION", feePaise: 0, initiatorRole: "SUPERADMIN" });
  });

  it("lists payments for review without references or evidence, and still requires evidence to verify", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "accept-completion");
    const payment = (
      await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/payments`, { amountPaise: 50_000, method: "UPI", reference: "SECRET-UPI-REF" })
    ).json();

    const list = await ctx.call(ctx.admin, "GET", "/admin/marketplace/payments?status=RECORDED_UNVERIFIED");
    expect(list.statusCode).toBe(200);
    expect(list.json().payments).toHaveLength(1);
    expect(list.body).not.toContain("SECRET-UPI-REF");
    expect((await ctx.call(ctx.admin, "GET", "/admin/marketplace/payments?status=BOGUS")).statusCode).toBe(400);

    expect((await ctx.adminPost(`payments/${payment.id}/verify`, {})).statusCode).toBe(400);
    expect((await ctx.adminPost(`payments/${payment.id}/verify`, { evidenceReference: "bank-statement-line-7" })).statusCode).toBe(200);
    const verified = (await ctx.call(ctx.admin, "GET", "/admin/marketplace/payments?status=VERIFIED")).json().payments;
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ hasEvidence: true });
  });
});
