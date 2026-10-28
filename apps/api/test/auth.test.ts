import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/security.js";
import { CSRF_COOKIE, REFRESH_COOKIE } from "../src/auth/security.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

const activeApps: ReturnType<typeof buildApp>[] = [];

function makeApp(nodeEnv = "development") {
  const repository = new MemoryAuthRepository();
  const ownerRepository = new MemoryOwnerRepository();
  const app = buildApp({
    authRepository: repository,
    ownerRepository,
    jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
    nodeEnv,
    authRateLimitMax: 100,
  });
  activeApps.push(app);
  return { app, repository, ownerRepository };
}

function responseCookies(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.split(";")[0])
    .join("; ");
}

function cookieValue(cookieHeader: string, name: string): string {
  const value = cookieHeader
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value;
}

async function register(app: ReturnType<typeof buildApp>, email: string) {
  return app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password: "correct-horse-battery-staple",
      displayName: "Test Driver",
    },
  });
}

afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
});

describe("authentication and authorization", () => {
  it("registers a development user with a hashed password and authenticated session", async () => {
    const { app, repository } = makeApp();
    const response = await register(app, "Owner@Example.test");
    const body = response.json();
    const session = await repository.findCredentialByEmail("owner@example.test");

    expect(response.statusCode).toBe(201);
    expect(session?.passwordHash).not.toBe("correct-horse-battery-staple");
    expect(body.user).toMatchObject({ email: "owner@example.test", role: "OWNER" });
    expect(body.accessToken).toBeTypeOf("string");
    expect(responseCookies(response)).toContain(`${REFRESH_COOKIE}=`);
    expect(JSON.stringify(response.headers["set-cookie"])).toMatch(/HttpOnly/);
    const setCookieHeaders = response.headers["set-cookie"];
    expect(
      (Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]).some(
        (cookie) =>
          typeof cookie === "string" &&
          cookie.startsWith(`${CSRF_COOKIE}=`) &&
          cookie.includes("Path=/;"),
      ),
    ).toBe(true);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: body.user.id, role: "OWNER" });
  });

  it("rejects malformed or unauthenticated requests and disables registration outside development", async () => {
    const { app } = makeApp("production");
    const registration = await register(app, "owner@example.test");
    const protectedResponse = await app.inject({ method: "GET", url: "/auth/me" });
    const malformed = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "bad", password: "" },
    });

    expect(registration.statusCode).toBe(404);
    expect(protectedResponse.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(400);
  });

  it("authenticates passwords and rotates refresh tokens with CSRF protection", async () => {
    const { app } = makeApp();
    await register(app, "owner@example.test");
    const rejectedLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.test", password: "wrong-password" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "OWNER@example.test", password: "correct-horse-battery-staple" },
    });
    const loginCookies = responseCookies(login);
    const loginBody = login.json();

    expect(rejectedLogin.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(loginBody.user.email).toBe("owner@example.test");

    const blockedRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: loginCookies },
    });
    expect(blockedRefresh.statusCode).toBe(403);

    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        cookie: loginCookies,
        "x-csrf-token": cookieValue(loginCookies, CSRF_COOKIE),
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(responseCookies(refreshed)).not.toContain(
      `${REFRESH_COOKIE}=${cookieValue(loginCookies, REFRESH_COOKIE)}`,
    );

    const replay = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        cookie: loginCookies,
        "x-csrf-token": cookieValue(loginCookies, CSRF_COOKIE),
      },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("blocks access to another account and restricts audit events to Superadmin", async () => {
    const { app } = makeApp();
    const owner = await register(app, "owner@example.test");
    const otherOwner = await register(app, "other@example.test");
    const ownerToken = owner.json().accessToken as string;
    const ownerAccountId = owner.json().user.accountId as string;
    const otherAccountId = otherOwner.json().user.accountId as string;

    const ownAccount = await app.inject({
      method: "GET",
      url: `/accounts/${ownerAccountId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const otherAccount = await app.inject({
      method: "GET",
      url: `/accounts/${otherAccountId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const adminEvents = await app.inject({
      method: "GET",
      url: "/admin/audit-events",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(ownAccount.statusCode).toBe(200);
    expect(otherAccount.statusCode).toBe(404);
    expect(adminEvents.statusCode).toBe(403);

    const invalidAccountId = await app.inject({
      method: "GET",
      url: "/accounts/not-a-uuid",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(invalidAccountId.statusCode).toBe(400);
  });

  it("allows an authenticated Superadmin to read platform audit events", async () => {
    const { app, repository } = makeApp();
    await repository.createSuperadmin({
      email: "admin@example.test",
      passwordHash: await hashPassword("admin-password-for-test-only"),
      displayName: "Test Admin",
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@example.test",
        password: "admin-password-for-test-only",
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/admin/audit-events",
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ role: "SUPERADMIN", accountId: null });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toEqual([
      expect.objectContaining({ action: "AUTH_LOGIN_SUCCEEDED" }),
    ]);
  });

  it("revokes access tokens on logout", async () => {
    const { app } = makeApp();
    const registration = await register(app, "owner@example.test");
    const { accessToken, csrfToken } = registration.json();
    const cookies = responseCookies(registration);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: cookies,
        "x-csrf-token": csrfToken,
      },
    });
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(logout.statusCode).toBe(204);
    expect(me.statusCode).toBe(401);
  });

  it("rejects sessions that are expired or revoked even if their access JWT is otherwise valid", async () => {
    const { app, repository } = makeApp();
    await register(app, "session-check@example.test");
    const user = await repository.findCredentialByEmail("session-check@example.test");
    expect(user).not.toBeNull();
    const profile = user!.profiles[0]!;
    await app.ready();

    for (const kind of ["expired", "revoked"] as const) {
      const session = await repository.createSession({
        userId: user!.id,
        roleProfileId: profile.id,
        accountId: profile.accountId,
        refreshTokenHash: `${kind}-refresh-hash`.padEnd(64, "0"),
        expiresAt: kind === "expired" ? new Date(Date.now() - 60_000) : new Date(Date.now() + 60_000),
      });
      if (kind === "revoked") await repository.revokeSession(session.id, new Date());
      const accessToken = app.jwt.sign({
        sub: user!.id,
        sid: session.id,
        aid: profile.accountId,
        pid: profile.id,
        role: profile.role,
      });
      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode, `${kind} session`).toBe(401);
    }
  });

  it("does not allow role selection or request headers to elevate an ordinary account", async () => {
    const { app } = makeApp();
    const registration = await register(app, "no-role-escalation@example.test");
    expect(registration.statusCode).toBe(201);
    const elevatedLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "no-role-escalation@example.test",
        password: "correct-horse-battery-staple",
        role: "SUPERADMIN",
      },
    });
    const forgedRole = await app.inject({
      method: "GET",
      url: "/admin/audit-events",
      headers: {
        authorization: `Bearer ${registration.json().accessToken}`,
        "x-user-role": "SUPERADMIN",
        "x-account-id": "11111111-1111-4111-8111-111111111111",
      },
    });
    const attemptedRegistration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "forged-admin@example.test",
        password: "correct-horse-battery-staple",
        displayName: "Forged Admin",
        role: "SUPERADMIN",
      },
    });

    expect(elevatedLogin.statusCode).toBe(401);
    expect(forgedRole.statusCode).toBe(403);
    expect(attemptedRegistration.statusCode).toBe(400);
  });
});
