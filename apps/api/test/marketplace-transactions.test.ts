import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/security.js";
import { DEFAULT_CANCELLATION_POLICY, assertRefundable, planCancellation, summarizePayments } from "../src/marketplace/rules.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryMarketplaceRepository } from "./support/memory-marketplace-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

type App = ReturnType<typeof buildApp>;
type Actor = { authorization: string; accountId: string };

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const clockState = { now: new Date("2030-01-01T06:00:00.000Z") };

async function setup() {
  clockState.now = new Date("2030-01-01T06:00:00.000Z");
  const authRepository = new MemoryAuthRepository();
  const marketplaceRepository = new MemoryMarketplaceRepository();
  const app = buildApp({
    authRepository,
    ownerRepository: new MemoryOwnerRepository(),
    marketplaceRepository,
    clock: () => clockState.now,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv: "development",
  });
  apps.push(app);

  const register = async (email: string, role: string): Promise<Actor> => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "marketplace-test-password-123", displayName: "Test User", role },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { authorization: ["Bearer", body.accessToken].join(" "), accountId: body.user.accountId };
  };
  await authRepository.createSuperadmin({
    email: "admin@example.test",
    passwordHash: await hashPassword("admin-password-for-test-only"),
    displayName: "Test Admin",
  });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "admin@example.test", password: "admin-password-for-test-only" },
  });
  const admin: Actor = { authorization: ["Bearer", login.json().accessToken].join(" "), accountId: "" };

  const call = (actor: Actor | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: { ...(actor ? { authorization: actor.authorization } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const vendor = await register("vendor@example.test", "MARKETPLACE_VENDOR");
  const owner = await register("owner@example.test", "OWNER");
  const otherOwner = await register("other-owner@example.test", "OWNER");
  const otherVendor = await register("other-vendor@example.test", "MARKETPLACE_VENDOR");
  expect((await call(vendor, "PUT", "/marketplace/profile", {
    businessName: "P8 Test Garage",
    category: "GARAGE",
    contactPhone: "9876543210",
    city: "Pune",
    latitude: 18.5204,
    longitude: 73.8567,
    serviceRadiusKm: 15,
    supportedVehicleTypes: ["FOUR_WHEELER"],
  })).statusCode).toBe(200);
  const service = (await call(vendor, "POST", "/marketplace/services", {
    name: "Full exterior wash",
    category: "EXTERIOR_WASH",
    vehicleTypes: ["FOUR_WHEELER"],
    pricePaise: 50_000,
    durationMinutes: 60,
  })).json();
  const vehicle = (await call(owner, "POST", "/owner/vehicles", { type: "FOUR_WHEELER", registrationNumber: "MH 12 AB 1234" })).json();

  let counter = 0;
  const book = async () => {
    counter += 1;
    const start = new Date(clockState.now.getTime() + 2 * 3_600_000);
    const response = await call(owner, "POST", "/owner/marketplace/bookings", {
      vehicleId: vehicle.id,
      serviceId: service.id,
      windowStart: start.toISOString(),
      windowEnd: new Date(start.getTime() + 3_600_000).toISOString(),
      serviceLocation: "Flat 4, Test Society, Pune",
    }, { "idempotency-key": `p8-booking-key-${counter}` });
    expect(response.statusCode).toBe(201);
    return response.json().booking.id as string;
  };
  const vendorPost = (id: string, path: string, body: unknown = {}) => call(vendor, "POST", `/marketplace/bookings/${id}/${path}`, body);
  const ownerPost = (id: string, path: string, body: unknown = {}) => call(owner, "POST", `/owner/marketplace/bookings/${id}/${path}`, body);
  const adminPost = (path: string, body: unknown = {}) => call(admin, "POST", `/admin/marketplace/${path}`, body);

  const completed = async () => {
    const id = await book();
    expect((await vendorPost(id, "accept")).statusCode).toBe(200);
    expect((await vendorPost(id, "start")).statusCode).toBe(200);
    expect((await vendorPost(id, "complete", { notes: "Washed and dried" })).statusCode).toBe(200);
    return id;
  };
  const accepted = async () => {
    const id = await completed();
    expect((await ownerPost(id, "accept-completion")).statusCode).toBe(200);
    return id;
  };
  const recordPayment = async (id: string, amountPaise: number, key?: string) =>
    call(vendor, "POST", `/marketplace/bookings/${id}/payments`, { amountPaise, method: "UPI", reference: "UPI-REF-1" }, key ? { "idempotency-key": key } : {});
  const verify = (paymentId: string) => adminPost(`payments/${paymentId}/verify`, { evidenceReference: "bank-statement-line-1" });
  const adminDetail = async (id: string) => (await call(admin, "GET", `/admin/marketplace/bookings/${id}`)).json();

  return { app, marketplaceRepository, vendor, owner, otherOwner, otherVendor, admin, call, book, vendorPost, ownerPost, adminPost, completed, accepted, recordPayment, verify, adminDetail };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function verifiedPayment(ctx: Ctx, id: string, amount = 50_000) {
  const payment = (await ctx.recordPayment(id, amount)).json();
  expect((await ctx.verify(payment.id)).statusCode).toBe(200);
  return payment.id as string;
}

describe("payment lifecycle", () => {
  it("records payments as unverified and keeps them separate from booking status", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const response = await ctx.recordPayment(id, 20_000);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "RECORDED_UNVERIFIED", currency: "INR" });
    const detail = await ctx.adminDetail(id);
    expect(detail.booking.status).toBe("CUSTOMER_ACCEPTED");
    expect(detail.payment).toMatchObject({ state: "RECORDED_UNVERIFIED", verifiedPaise: 0, recordedPaise: 20_000 });
  });

  it("does not let vendors or owners verify payments, and rejects forged verification fields", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const paymentId = (await ctx.recordPayment(id, 50_000)).json().id;
    const body = { evidenceReference: "forged" };
    expect((await ctx.call(ctx.vendor, "POST", `/admin/marketplace/payments/${paymentId}/verify`, body)).statusCode).toBe(403);
    expect((await ctx.call(ctx.owner, "POST", `/admin/marketplace/payments/${paymentId}/verify`, body)).statusCode).toBe(403);
    expect((await ctx.call(null, "POST", `/admin/marketplace/payments/${paymentId}/verify`, body)).statusCode).toBe(401);
    const forged = await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/payments`, { amountPaise: 100, method: "UPI", status: "VERIFIED" });
    expect(forged.statusCode).toBe(400);
    expect((await ctx.adminPost(`payments/${paymentId}/verify`, {})).statusCode).toBe(400);
  });

  it("verifies once, and a verified payment cannot be rejected or verified again", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const paymentId = (await ctx.recordPayment(id, 50_000)).json().id;
    expect((await ctx.verify(paymentId)).statusCode).toBe(200);
    expect((await ctx.verify(paymentId)).statusCode).toBe(409);
    expect((await ctx.adminPost(`payments/${paymentId}/reject`, { reason: "late reversal" })).statusCode).toBe(409);
    const detail = await ctx.adminDetail(id);
    expect(detail.payment.state).toBe("VERIFIED");
    expect(detail.payments[0].verificationSource).toBe("PLATFORM_RECONCILIATION");
  });

  it("handles concurrent verification so only one request wins", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const paymentId = (await ctx.recordPayment(id, 50_000)).json().id;
    const results = await Promise.all([ctx.verify(paymentId), ctx.verify(paymentId), ctx.verify(paymentId)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
  });

  it("supports partial payments but prevents overpayment", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    expect((await ctx.recordPayment(id, 30_000)).statusCode).toBe(201);
    expect((await ctx.recordPayment(id, 20_001)).statusCode).toBe(409);
    expect((await ctx.recordPayment(id, 20_000)).statusCode).toBe(201);
    expect((await ctx.recordPayment(id, 1)).statusCode).toBe(409);
  });

  it("frees capacity when a payment fails", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const first = (await ctx.recordPayment(id, 50_000)).json().id;
    expect((await ctx.recordPayment(id, 1)).statusCode).toBe(409);
    expect((await ctx.adminPost(`payments/${first}/reject`, { reason: "not found in statement" })).statusCode).toBe(200);
    expect((await ctx.adminPost(`payments/${first}/verify`, { evidenceReference: "xyz" })).statusCode).toBe(409);
    expect((await ctx.recordPayment(id, 50_000)).statusCode).toBe(201);
  });

  it("replays an idempotent payment request without double recording", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    const first = await ctx.recordPayment(id, 10_000, "payment-key-0001");
    const replay = await ctx.recordPayment(id, 10_000, "payment-key-0001");
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, replayed: true });
    const concurrent = await Promise.all([1, 2, 3].map(() => ctx.recordPayment(id, 10_000, "payment-key-0002")));
    expect(new Set(concurrent.map((r) => r.json().id)).size).toBe(1);
    expect((await ctx.adminDetail(id)).payment.recordedPaise).toBe(20_000);
  });

  it("hides verification evidence from vendors and owners", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    await verifiedPayment(ctx, id);
    const asOwner = (await ctx.call(ctx.owner, "GET", `/owner/marketplace/bookings/${id}`)).json();
    const asVendor = (await ctx.call(ctx.vendor, "GET", `/marketplace/bookings/${id}`)).json();
    expect(asOwner.payments[0].status).toBe("VERIFIED");
    expect(JSON.stringify(asOwner)).not.toContain("bank-statement-line-1");
    expect(JSON.stringify(asVendor)).not.toContain("bank-statement-line-1");
  });
});

describe("settlement and closure", () => {
  it("blocks settlement before acceptance and before verified payment", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(409);
    await ctx.ownerPost(id, "accept-completion");
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(409);
    const paymentId = (await ctx.recordPayment(id, 50_000)).json().id;
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(409);
    await ctx.verify(paymentId);
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(201);
  });

  it("restricts settlement and closure to Superadmin", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    await verifiedPayment(ctx, id);
    for (const actor of [ctx.vendor, ctx.owner, ctx.otherOwner]) {
      expect((await ctx.call(actor, "POST", `/admin/marketplace/bookings/${id}/settle`, {})).statusCode).toBe(403);
      expect((await ctx.call(actor, "POST", `/admin/marketplace/bookings/${id}/close`, {})).statusCode).toBe(403);
    }
    expect((await ctx.vendorPost(id, "settle")).statusCode).toBe(404);
  });

  it("creates exactly one settlement under retries and concurrency, then closes", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    await verifiedPayment(ctx, id);
    const results = await Promise.all([1, 2, 3, 4].map(() => ctx.adminPost(`bookings/${id}/settle`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
    expect(results.every((r) => r.json().settlement.externalTransfer === false)).toBe(true);
    expect(ctx.marketplaceRepository.settlements.size).toBe(1);
    const detail = await ctx.adminDetail(id);
    expect(detail.settlement.agreedPricePaise).toBe(50_000);
    expect((await ctx.adminPost(`bookings/${id}/close`)).statusCode).toBe(200);
    expect((await ctx.adminPost(`bookings/${id}/close`)).statusCode).toBe(200);
    expect((await ctx.adminDetail(id)).booking.status).toBe("CLOSED");
  });

  it("preserves append-only booking events through the lifecycle", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    await verifiedPayment(ctx, id);
    await ctx.adminPost(`bookings/${id}/settle`);
    const kinds = (await ctx.adminDetail(id)).events.map((e: { kind: string }) => e.kind);
    expect(kinds[0]).toBe("requested");
    expect(kinds).toContain("settle");
    expect(new Set(kinds).size).toBeGreaterThan(4);
  });
});

describe("disputes", () => {
  it("runs open, respond and resolve while preserving history", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    expect((await ctx.ownerPost(id, "dispute", {})).statusCode).toBe(400);
    const opened = await ctx.ownerPost(id, "dispute", { reason: "Rear bumper still dirty", category: "INCOMPLETE_WORK", evidenceUrls: ["https://example.test/photo.jpg"] });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().booking.status).toBe("DISPUTED");

    const response = await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/dispute/respond`, { message: "Cleaned again on site" });
    expect(response.statusCode).toBe(200);
    expect((await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/dispute/respond`, { message: "Second" })).statusCode).toBe(409);

    const disputeId = (await ctx.adminDetail(id)).disputes[0].id;
    expect((await ctx.adminPost(`disputes/${disputeId}/resolve`, { outcome: "UPHELD_COMPLETION", rationale: "short" })).statusCode).toBe(400);
    const resolved = await ctx.adminPost(`disputes/${disputeId}/resolve`, { outcome: "UPHELD_COMPLETION", rationale: "Photos show the work was completed" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ bookingStatus: "CUSTOMER_ACCEPTED", disputeStatus: "RESOLVED" });
    expect((await ctx.adminPost(`disputes/${disputeId}/resolve`, { outcome: "REWORK_REQUIRED", rationale: "Changing my mind later" })).statusCode).toBe(409);

    const dispute = (await ctx.adminDetail(id)).disputes[0];
    expect(dispute.entries.map((e: { kind: string }) => e.kind)).toEqual(["OPENED", "VENDOR_RESPONSE", "RESOLVED"]);
    expect(dispute.outcome).toBe("UPHELD_COMPLETION");
  });

  it("blocks settlement and closure while a dispute is unresolved", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    await ctx.ownerPost(id, "dispute", { reason: "Not finished" });
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(409);
    expect((await ctx.adminPost(`bookings/${id}/close`)).statusCode).toBe(409);
    expect((await ctx.ownerPost(id, "accept-completion")).statusCode).toBe(409);
    expect((await ctx.ownerPost(id, "cancel", { reason: "Changed my mind" })).statusCode).toBe(409);
  });

  it("maps resolution outcomes to booking states", async () => {
    const ctx = await setup();
    const rework = await ctx.completed();
    await ctx.ownerPost(rework, "dispute", { reason: "Dirty interior" });
    const reworkDispute = (await ctx.adminDetail(rework)).disputes[0].id;
    const result = await ctx.adminPost(`disputes/${reworkDispute}/resolve`, { outcome: "REWORK_REQUIRED", rationale: "Vendor must redo the interior" });
    expect(result.json().bookingStatus).toBe("IN_PROGRESS");

    const cancelled = await ctx.completed();
    await ctx.ownerPost(cancelled, "dispute", { reason: "Wrong service" });
    const cancelledDispute = (await ctx.adminDetail(cancelled)).disputes[0].id;
    const second = await ctx.adminPost(`disputes/${cancelledDispute}/resolve`, { outcome: "CANCELLED_NO_CHARGE", rationale: "Service was never performed" });
    expect(second.json().bookingStatus).toBe("CANCELLED");
  });

  it("isolates disputes between accounts and roles", async () => {
    const ctx = await setup();
    const id = await ctx.completed();
    expect((await ctx.call(ctx.otherOwner, "POST", `/owner/marketplace/bookings/${id}/dispute`, { reason: "Not mine" })).statusCode).toBe(404);
    await ctx.ownerPost(id, "dispute", { reason: "Dirty" });
    expect((await ctx.call(ctx.otherVendor, "POST", `/marketplace/bookings/${id}/dispute/respond`, { message: "Not mine" })).statusCode).toBe(404);
    expect((await ctx.call(ctx.otherOwner, "GET", `/owner/marketplace/bookings/${id}`)).statusCode).toBe(404);
    const disputeId = (await ctx.adminDetail(id)).disputes[0].id;
    for (const actor of [ctx.owner, ctx.vendor, ctx.otherOwner]) {
      expect((await ctx.call(actor, "POST", `/admin/marketplace/disputes/${disputeId}/resolve`, { outcome: "UPHELD_COMPLETION", rationale: "I am not an admin" })).statusCode).toBe(403);
      expect((await ctx.call(actor, "GET", "/admin/marketplace/disputes")).statusCode).toBe(403);
    }
    expect((await ctx.call(ctx.admin, "GET", "/admin/marketplace/disputes?status=OPEN")).json().disputes).toHaveLength(1);
  });
});

describe("cancellation, refunds and no-shows", () => {
  it("applies the default no-fee policy and records initiator and policy", async () => {
    const ctx = await setup();
    const id = await ctx.book();
    expect((await ctx.ownerPost(id, "cancel", {})).statusCode).toBe(400);
    const response = await ctx.ownerPost(id, "cancel", { reason: "Plans changed" });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.status).toBe("CANCELLED");
    const detail = await ctx.adminDetail(id);
    expect(detail.cancellation).toMatchObject({ kind: "OWNER_CANCELLED", feePaise: 0, policyKey: "default-no-fee" });
    expect(detail.refunds).toEqual([]);
    expect((await ctx.ownerPost(id, "cancel", { reason: "Again" })).statusCode).toBe(409);
  });

  it("limits who may cancel and when", async () => {
    const ctx = await setup();
    const id = await ctx.book();
    expect((await ctx.call(ctx.otherOwner, "POST", `/owner/marketplace/bookings/${id}/cancel`, { reason: "Not mine" })).statusCode).toBe(404);
    expect((await ctx.call(ctx.otherVendor, "POST", `/marketplace/bookings/${id}/cancel`, { reason: "Not mine" })).statusCode).toBe(404);
    expect((await ctx.call(ctx.vendor, "POST", `/owner/marketplace/bookings/${id}/cancel`, { reason: "x" })).statusCode).toBe(403);
    // Vendors reject REQUESTED bookings instead of cancelling them.
    expect((await ctx.call(ctx.vendor, "POST", `/marketplace/bookings/${id}/cancel`, { reason: "No capacity" })).statusCode).toBe(409);
    await ctx.vendorPost(id, "accept");
    await ctx.vendorPost(id, "start");
    expect((await ctx.ownerPost(id, "cancel", { reason: "Too late" })).statusCode).toBe(409);
  });

  it("allows no-show only after the window starts", async () => {
    const ctx = await setup();
    const id = await ctx.book();
    await ctx.vendorPost(id, "accept");
    expect((await ctx.ownerPost(id, "cancel", { reason: "Vendor absent", noShow: true })).statusCode).toBe(409);
    clockState.now = new Date(clockState.now.getTime() + 3 * 3_600_000);
    const response = await ctx.ownerPost(id, "cancel", { reason: "Vendor absent", noShow: true });
    expect(response.statusCode).toBe(200);
    expect((await ctx.adminDetail(id)).cancellation).toMatchObject({ kind: "VENDOR_NO_SHOW", feePaise: 0 });
  });

  it("refunds only verified payments on cancelled bookings, once, with external confirmation", async () => {
    const ctx = await setup();
    const id = await ctx.book();
    await ctx.vendorPost(id, "accept");
    const paymentId = await verifiedPayment(ctx, id, 20_000);
    expect((await ctx.adminPost(`payments/${paymentId}/refund`, { reason: "Booking cancelled" })).statusCode).toBe(409);
    await ctx.ownerPost(id, "cancel", { reason: "Plans changed" });
    expect((await ctx.adminDetail(id)).refundState).toBe("REVIEW_REQUIRED");
    expect((await ctx.call(ctx.owner, "POST", `/admin/marketplace/payments/${paymentId}/refund`, { reason: "x" })).statusCode).toBe(403);

    const refunds = await Promise.all([1, 2].map(() => ctx.adminPost(`payments/${paymentId}/refund`, { reason: "Booking cancelled" })));
    expect(refunds.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const refund = refunds.find((r) => r.statusCode === 201)?.json().refund;
    expect(refund).toMatchObject({ status: "APPROVED_PENDING_EXTERNAL_TRANSFER", amountPaise: 20_000 });
    expect((await ctx.adminDetail(id)).refundState).toBe("REVIEW_REQUIRED");

    expect((await ctx.adminPost(`refunds/${refund.id}/confirm`, {})).statusCode).toBe(400);
    expect((await ctx.adminPost(`refunds/${refund.id}/confirm`, { evidenceReference: "bank-ref-77" })).statusCode).toBe(200);
    expect((await ctx.adminPost(`refunds/${refund.id}/confirm`, { evidenceReference: "bank-ref-77" })).statusCode).toBe(409);
    const detail = await ctx.adminDetail(id);
    expect(detail.payments[0].status).toBe("REFUNDED");
    expect(detail.refundState).toBe("RESOLVED");
    expect((await ctx.adminPost(`payments/${paymentId}/refund`, { reason: "again" })).statusCode).toBe(409);
  });

  it("does not allow cancelling a settled booking to bypass financial records", async () => {
    const ctx = await setup();
    const id = await ctx.accepted();
    await verifiedPayment(ctx, id);
    await ctx.adminPost(`bookings/${id}/settle`);
    expect((await ctx.ownerPost(id, "cancel", { reason: "Too late" })).statusCode).toBe(409);
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(200);
  });

  it("blocks settlement of a cancelled booking", async () => {
    const ctx = await setup();
    const id = await ctx.book();
    await ctx.ownerPost(id, "cancel", { reason: "Plans changed" });
    expect((await ctx.adminPost(`bookings/${id}/settle`)).statusCode).toBe(409);
  });
});

describe("pure rules", () => {
  const booking = { status: "ACCEPTED" as const, windowStart: new Date("2030-01-01T10:00:00Z"), servicePricePaise: 50_000 };

  it("never charges a fee or refunds automatically under the default policy", () => {
    expect(DEFAULT_CANCELLATION_POLICY.feePaise).toBe(0);
    expect(DEFAULT_CANCELLATION_POLICY.refundMode).toBe("MANUAL_REVIEW");
    const plan = planCancellation(booking, "OWNER", { reason: "x", noShow: false }, DEFAULT_CANCELLATION_POLICY, new Date("2030-01-01T06:00:00Z"), 0);
    expect(plan.kind).toBe("OWNER_CANCELLED");
  });

  it("refuses a refund without a verified payment or cancellation", () => {
    const payment = { status: "RECORDED_UNVERIFIED" } as Parameters<typeof assertRefundable>[1];
    expect(() => assertRefundable({ status: "CANCELLED" }, payment, false)).toThrow();
    expect(() => assertRefundable({ status: "ACCEPTED" }, { status: "VERIFIED" } as typeof payment, false)).toThrow();
    expect(() => assertRefundable({ status: "CANCELLED" }, { status: "VERIFIED" } as typeof payment, true)).toThrow();
  });

  it("summarizes payment state from verified amounts only", () => {
    const base = { amountPaise: 10_000 } as Parameters<typeof summarizePayments>[0][number];
    expect(summarizePayments([], 50_000).state).toBe("NONE");
    expect(summarizePayments([{ ...base, status: "RECORDED_UNVERIFIED" }], 50_000)).toMatchObject({ state: "RECORDED_UNVERIFIED", verifiedPaise: 0 });
    expect(summarizePayments([{ ...base, status: "VERIFIED" }], 50_000)).toMatchObject({ state: "PARTIALLY_VERIFIED", verifiedPaise: 10_000, outstandingPaise: 40_000 });
    expect(summarizePayments([{ ...base, amountPaise: 50_000, status: "VERIFIED" }], 50_000).state).toBe("VERIFIED");
  });
});

describe("owner dashboard integration", () => {
  it("shows only the Owner's real bookings with payment and dispute state", async () => {
    const ctx = await setup();
    const empty = (await ctx.call(ctx.owner, "GET", "/owner/dashboard")).json();
    expect(empty.availability.bookings.available).toBe(true);
    expect(empty.marketplace.bookings).toEqual([]);
    expect(empty.vehicles[0].upcomingService).toBeNull();
    expect(empty.availability.billing.available).toBe(false);

    const confirmed = await ctx.book();
    await ctx.vendorPost(confirmed, "accept");
    await verifiedPayment(ctx, confirmed, 10_000);
    const disputed = await ctx.completed();
    await ctx.ownerPost(disputed, "dispute", { reason: "Dirty" });

    const dashboard = (await ctx.call(ctx.owner, "GET", "/owner/dashboard")).json();
    expect(dashboard.marketplace.counts).toMatchObject({ total: 2, confirmed: 1, disputed: 1 });
    const byId = Object.fromEntries(dashboard.marketplace.bookings.map((b: { id: string }) => [b.id, b]));
    expect(byId[confirmed]).toMatchObject({ status: "ACCEPTED", dispute: "NONE", servicePricePaise: 50_000, vendorBusinessName: "P8 Test Garage" });
    expect(byId[confirmed].payment).toMatchObject({ state: "PARTIALLY_VERIFIED", verifiedPaise: 10_000, outstandingPaise: 40_000 });
    expect(byId[disputed].dispute).toBe("OPEN");
    expect(dashboard.vehicles[0].upcomingService).toMatchObject({ bookingId: confirmed, status: "ACCEPTED" });
    expect(JSON.stringify(dashboard)).not.toContain("staffId");

    const other = (await ctx.call(ctx.otherOwner, "GET", "/owner/dashboard")).json();
    expect(other.marketplace.bookings).toEqual([]);
    expect((await ctx.call(ctx.vendor, "GET", "/owner/dashboard")).statusCode).toBe(403);
    expect((await ctx.call(null, "GET", "/owner/dashboard")).statusCode).toBe(401);
  });
});
