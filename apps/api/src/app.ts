import cookie from "@fastify/cookie";
import { STATUS_CODES } from "node:http";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { verify } from "@node-rs/argon2";
import {
  HealthResponseSchema,
  AccountIdSchema,
  CreateVehicleSchema,
  LoginSchema,
  OwnerProfileUpdateSchema,
  RegisterSchema,
  UpdateVehicleSchema,
  normalizeRegistrationNumber,
  toFieldErrors,
  type ApiRole,
  type FieldErrors,
} from "@autospokes/shared";
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";
import type { AuthRepository, SessionRecord } from "./auth/repository.js";
import { buildOwnerDashboard } from "./owner/dashboard.js";
import type { OwnerRepository } from "./owner/repository.js";
import type { DetailerRepository } from "./detailer/repository.js";
import { registerDetailerRoutes } from "./detailer/routes.js";
import type { SocietyRepository } from "./society/repository.js";
import { registerSocietyRoutes } from "./society/routes.js";
import type { MarketplaceRepository } from "./marketplace/repository.js";
import { registerMarketplaceRoutes } from "./marketplace/routes.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CSRF_COOKIE,
  DUMMY_PASSWORD_HASH,
  REFRESH_COOKIE,
  REFRESH_TOKEN_TTL_MS,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  matchesSecret,
} from "./auth/security.js";

type AccessClaims = {
  sub: string;
  sid: string;
  aid: string | null;
  pid: string;
  role: ApiRole;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
  }
}

type BuildAppOptions = {
  authRepository: AuthRepository;
  ownerRepository: OwnerRepository;
  detailerRepository?: DetailerRepository;
  societyRepository?: SocietyRepository;
  marketplaceRepository?: MarketplaceRepository;
  clock?: () => Date;
  jwtSecret: string;
  nodeEnv: string;
};

const AUTH_RATE_LIMIT = {
  max: 5,
  timeWindow: 15 * 60 * 1000,
};

function refreshCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/auth",
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  };
}

function csrfCookieOptions(secure: boolean) {
  return {
    httpOnly: false,
    secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function validationError(
  message: string,
  zodError?: Parameters<typeof toFieldErrors>[0],
  fieldErrors?: FieldErrors,
): Error & { statusCode: number; fieldErrors: FieldErrors } {
  return Object.assign(httpError(400, message), {
    fieldErrors: zodError ? toFieldErrors(zodError) : (fieldErrors ?? {}),
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function setAuthCookies(
  reply: FastifyReply,
  refreshToken: string,
  csrfToken: string,
  secure: boolean,
): void {
  reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(secure));
  reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(secure));
}

function clearAuthCookies(reply: FastifyReply): void {
  const secure = process.env.NODE_ENV === "production";
  reply.clearCookie(REFRESH_COOKIE, { path: "/auth", sameSite: "strict", secure });
  reply.clearCookie(CSRF_COOKIE, { path: "/", sameSite: "strict", secure });
}

function requireCsrf(request: FastifyRequest): void {
  const header = request.headers["x-csrf-token"];
  const supplied = Array.isArray(header) ? header[0] : header;
  if (!matchesSecret(request.cookies[CSRF_COOKIE], supplied)) {
    throw httpError(403, "A valid CSRF token is required");
  }
}

function publicSession(session: SessionRecord) {
  return {
    id: session.userId,
    email: session.email,
    role: session.role,
    displayName: session.displayName,
    accountId: session.accountId,
  };
}

async function issueSession(
  reply: FastifyReply,
  repository: AuthRepository,
  jwtSign: (claims: AccessClaims) => string,
  secureCookies: boolean,
  input: {
    userId: string;
    roleProfileId: string;
    accountId: string | null;
  },
) {
  const refreshToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const session = await repository.createSession({
    ...input,
    refreshTokenHash: hashOpaqueToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  const accessToken = jwtSign({
    sub: session.userId,
    sid: session.id,
    aid: session.accountId,
    pid: session.roleProfileId,
    role: session.role,
  });
  setAuthCookies(reply, refreshToken, csrfToken, secureCookies);
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    csrfToken,
    user: publicSession(session),
  };
}

export function buildApp({
  authRepository,
  ownerRepository,
  detailerRepository,
  societyRepository,
  marketplaceRepository,
  clock = () => new Date(),
  jwtSecret,
  nodeEnv,
}: BuildAppOptions) {
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }

  const app = Fastify({ logger: nodeEnv !== "test" });
  const dummyPasswordHash = DUMMY_PASSWORD_HASH;
  const secureCookies = nodeEnv === "production";

  app.register(cookie);
  app.register(jwt, { secret: jwtSecret });
  app.register(rateLimit, { global: false });
  app.setErrorHandler((error: Error & { statusCode?: number; fieldErrors?: FieldErrors }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(statusCode).send({
        statusCode,
        error: "Internal Server Error",
        message: "Something went wrong",
      });
    }
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode] ?? "Error",
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    });
  });

  app.decorate("authenticate", async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw httpError(401, "Authentication required");
    }

    const claims = request.user;
    const session = await authRepository.findSessionById(claims.sid);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.userStatus !== "ACTIVE" ||
      session.userId !== claims.sub ||
      session.roleProfileId !== claims.pid ||
      session.accountId !== claims.aid ||
      session.role !== claims.role
    ) {
      throw httpError(401, "Authentication required");
    }
  });

  const requireRole =
    (...roles: ApiRole[]): preHandlerHookHandler =>
    async (request) => {
      if (!roles.includes(request.user.role)) {
        throw httpError(403, "This role is not allowed to access this resource");
      }
    };

  const ownerAccountId = (request: FastifyRequest): string => {
    if (request.user.role !== "OWNER" || !request.user.aid) {
      throw httpError(403, "An owner account is required");
    }
    return request.user.aid;
  };
  const ownerOnly = [app.authenticate, requireRole("OWNER")];

  app.get("/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      service: "autospokes-api",
    }),
  );

  app.post<{ Body: unknown }>(
    "/auth/register",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      if (nodeEnv !== "development") {
        throw httpError(404, "Not found");
      }

      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) throw httpError(400, "Invalid registration details");

      const input = parsed.data;
      try {
        const user = await authRepository.createDeveloperUser({
          email: normalizeEmail(input.email),
          passwordHash: await hashPassword(input.password),
          role: input.role,
          displayName: input.displayName,
        });
        const profile = user.profiles.find((item) => item.role === input.role);
        if (!profile) throw new Error("Created account is missing its role profile");
        await authRepository.appendAuditEvent({
          actorId: user.id,
          accountId: profile.accountId,
          action: "AUTH_REGISTERED",
          ipAddress: request.ip,
        });
        return reply.code(201).send(
          await issueSession(
            reply,
            authRepository,
            (claims) => app.jwt.sign(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS }),
            secureCookies,
            {
              userId: user.id,
              roleProfileId: profile.id,
              accountId: profile.accountId,
            },
          ),
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(409, "An account with that email already exists");
        }
        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/auth/login",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) throw httpError(400, "Invalid login details");

      const input = parsed.data;
      const email = normalizeEmail(input.email);
      const user = await authRepository.findCredentialByEmail(email);
      const passwordMatches = await verify(
        user?.passwordHash ?? (await dummyPasswordHash),
        input.password,
      );
      const profile = user?.profiles.find(
        (candidate) => !input.role || candidate.role === input.role,
      );
      if (!user || !passwordMatches || user.status !== "ACTIVE" || !profile) {
        await authRepository.appendAuditEvent({
          actorId: user?.id,
          action: "AUTH_LOGIN_FAILED",
          details: { reason: "invalid_credentials" },
          ipAddress: request.ip,
        });
        throw httpError(401, "Invalid email or password");
      }

      await authRepository.appendAuditEvent({
        actorId: user.id,
        accountId: profile.accountId,
        action: "AUTH_LOGIN_SUCCEEDED",
        ipAddress: request.ip,
      });
      return issueSession(
        reply,
        authRepository,
        (claims) => app.jwt.sign(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS }),
        secureCookies,
        { userId: user.id, roleProfileId: profile.id, accountId: profile.accountId },
      );
    },
  );

  app.post("/auth/refresh", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    requireCsrf(request);
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw httpError(401, "Refresh session is not available");

    const nextToken = createOpaqueToken();
    const session = await authRepository.rotateRefreshToken({
      currentHash: hashOpaqueToken(token),
      nextHash: hashOpaqueToken(nextToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      now: new Date(),
    });
    if (!session || session.userStatus !== "ACTIVE") {
      if (session) await authRepository.revokeSession(session.id, new Date());
      clearAuthCookies(reply);
      throw httpError(401, "Refresh session is invalid or expired");
    }

    const csrfToken = createOpaqueToken();
    const accessToken = app.jwt.sign(
      {
        sub: session.userId,
        sid: session.id,
        aid: session.accountId,
        pid: session.roleProfileId,
        role: session.role,
      },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
    setAuthCookies(reply, nextToken, csrfToken, secureCookies);
    await authRepository.appendAuditEvent({
      actorId: session.userId,
      accountId: session.accountId,
      action: "AUTH_REFRESHED",
      ipAddress: request.ip,
    });
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      csrfToken,
      user: publicSession(session),
    };
  });

  app.post(
    "/auth/logout",
    { preHandler: [app.authenticate], config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      requireCsrf(request);
      await authRepository.revokeSession(request.user.sid, new Date());
      await authRepository.appendAuditEvent({
        actorId: request.user.sub,
        accountId: request.user.aid,
        action: "AUTH_LOGGED_OUT",
        ipAddress: request.ip,
      });
      clearAuthCookies(reply);
      return reply.code(204).send();
    },
  );

  app.get(
    "/auth/me",
    { preHandler: [app.authenticate] },
    async (request) => ({
      id: request.user.sub,
      role: request.user.role,
      accountId: request.user.aid,
    }),
  );

  app.get<{ Params: { accountId: string } }>(
    "/accounts/:accountId",
    { preHandler: [app.authenticate] },
    async (request) => {
      const accountId = AccountIdSchema.safeParse(request.params.accountId);
      if (!accountId.success) throw httpError(400, "Invalid account id");
      if (
        request.user.role !== "SUPERADMIN" &&
        request.user.aid !== accountId.data
      ) {
        throw httpError(404, "Account not found");
      }
      const account = await authRepository.findAccountById(accountId.data);
      if (!account) throw httpError(404, "Account not found");
      return { id: account.id, name: account.name };
    },
  );

  app.get(
    "/owner/profile",
    { preHandler: ownerOnly },
    async (request) => {
      const profile = await ownerRepository.findOwnerProfile(
        request.user.pid,
        ownerAccountId(request),
      );
      if (!profile) throw httpError(404, "Owner profile not found");
      return {
        displayName: profile.displayName,
        phoneNumber: profile.phoneNumber,
      };
    },
  );

  app.patch<{ Body: unknown }>(
    "/owner/profile",
    { preHandler: ownerOnly },
    async (request) => {
      const parsed = OwnerProfileUpdateSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid owner profile details", parsed.error);
      const profile = await ownerRepository.updateOwnerProfile(
        request.user.pid,
        ownerAccountId(request),
        parsed.data,
      );
      if (!profile) throw httpError(404, "Owner profile not found");
      return {
        displayName: profile.displayName,
        phoneNumber: profile.phoneNumber,
      };
    },
  );

  app.get(
    "/owner/vehicles",
    { preHandler: ownerOnly },
    async (request) => ({
      vehicles: await ownerRepository.listVehicles(ownerAccountId(request)),
    }),
  );

  app.get(
    "/owner/dashboard",
    { preHandler: ownerOnly },
    async (request) =>
      buildOwnerDashboard(await ownerRepository.listVehicles(ownerAccountId(request))),
  );

  app.post<{ Body: unknown }>(
    "/owner/vehicles",
    { preHandler: ownerOnly },
    async (request, reply) => {
      const parsed = CreateVehicleSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
      const input = parsed.data;
      if (
        input.providerType !== "SOCIETY_VENDOR" &&
        input.assignedWasherName
      ) {
        throw validationError("Invalid vehicle details", undefined, {
          assignedWasherName: ["An assigned washer is only valid for a Society Vendor"],
        });
      }
      try {
        const vehicle = await ownerRepository.createVehicle(ownerAccountId(request), {
          ...input,
          registrationNumber: input.registrationNumber.trim(),
          registrationNumberNormalized: normalizeRegistrationNumber(input.registrationNumber),
          providerName: input.providerType ? input.providerName ?? null : null,
          assignedWasherName:
            input.providerType === "SOCIETY_VENDOR" ? input.assignedWasherName ?? null : null,
        });
        return reply.code(201).send(vehicle);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(
            409,
            "This registration number needs ownership verification before it can be registered",
          );
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { vehicleId: string } }>(
    "/owner/vehicles/:vehicleId",
    { preHandler: ownerOnly },
    async (request) => {
      const vehicleId = AccountIdSchema.safeParse(request.params.vehicleId);
      if (!vehicleId.success) throw httpError(400, "Invalid vehicle id");
      const vehicle = await ownerRepository.findVehicle(
        ownerAccountId(request),
        vehicleId.data,
      );
      if (!vehicle) throw httpError(404, "Vehicle not found");
      return {
        vehicle,
        serviceSummary: {
          upcomingService: null,
          currentWashStatus: null,
          recentServiceHistory: [],
          invoices: null,
        },
      };
    },
  );

  app.patch<{ Params: { vehicleId: string }; Body: unknown }>(
    "/owner/vehicles/:vehicleId",
    { preHandler: ownerOnly },
    async (request) => {
      const vehicleId = AccountIdSchema.safeParse(request.params.vehicleId);
      if (!vehicleId.success) throw httpError(400, "Invalid vehicle id");
      const accountId = ownerAccountId(request);
      const existing = await ownerRepository.findVehicle(accountId, vehicleId.data);
      if (!existing) throw httpError(404, "Vehicle not found");

      const parsed = UpdateVehicleSchema.safeParse(request.body);
      if (!parsed.success) throw validationError("Invalid vehicle details", parsed.error);
      const input = parsed.data;
      const nextProvider = input.providerType !== undefined
        ? input.providerType
        : existing.providerType;
      if (
        nextProvider !== "SOCIETY_VENDOR" &&
        input.assignedWasherName
      ) {
        throw validationError("Invalid vehicle details", undefined, {
          assignedWasherName: ["An assigned washer is only valid for a Society Vendor"],
        });
      }

      const update: typeof input & { registrationNumberNormalized?: string } = {
        ...input,
      };
      if (input.registrationNumber !== undefined) {
        update.registrationNumber = input.registrationNumber.trim();
        update.registrationNumberNormalized = normalizeRegistrationNumber(
          input.registrationNumber,
        );
      }
      if (input.providerType !== undefined && input.providerType !== "SOCIETY_VENDOR") {
        update.assignedWasherName = null;
      }
      if (nextProvider === null) {
        update.providerName = null;
      } else if (input.providerName !== undefined) {
        update.providerName = input.providerName;
      }

      try {
        const vehicle = await ownerRepository.updateVehicle(accountId, vehicleId.data, update);
        if (!vehicle) throw httpError(404, "Vehicle not found");
        return vehicle;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw httpError(
            409,
            "This registration number needs ownership verification before it can be registered",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/admin/audit-events",
    {
      preHandler: [app.authenticate, requireRole("SUPERADMIN")],
    },
    async () => ({ events: await authRepository.listAuditEvents() }),
  );

  if (detailerRepository) {
    registerDetailerRoutes(app, {
      repository: detailerRepository,
      preHandler: [app.authenticate, requireRole("INDEPENDENT_DETAILER")],
      httpError,
      validationError,
      isUniqueConstraintError,
      now: clock,
    });
  }

  if (societyRepository) {
    registerSocietyRoutes(app, {
      repository: societyRepository,
      preHandler: [app.authenticate, requireRole("SOCIETY_VENDOR")],
      httpError,
      validationError,
      isUniqueConstraintError,
      now: clock,
    });
  }

  if (marketplaceRepository) {
    registerMarketplaceRoutes(app, {
      repository: marketplaceRepository,
      ownerRepository,
      vendorPreHandler: [app.authenticate, requireRole("MARKETPLACE_VENDOR")],
      ownerPreHandler: ownerOnly,
      httpError,
      validationError,
      now: clock,
    });
  }

  return app;
}
