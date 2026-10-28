import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseServerConfig } from "../src/config.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";
import { MemoryOwnerRepository } from "./support/memory-owner-repository.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
const JWT_SECRET = "test-only-secret-with-more-than-thirty-two-characters";
const allowedOrigin = "https://web.autospokes.example";

function makeApp(options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const app = buildApp({
    authRepository: new MemoryAuthRepository(),
    ownerRepository: new MemoryOwnerRepository(),
    jwtSecret: JWT_SECRET,
    nodeEnv: "test",
    ...options,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("CORS and security headers", () => {
  it("allows exact configured origins and credentials, rejects untrusted origins, and leaves non-browser clients alone", async () => {
    const app = makeApp({ nodeEnv: "production", corsOrigins: [allowedOrigin] });
    const trusted = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: allowedOrigin },
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://attacker.example" },
    });
    const noOrigin = await app.inject({ method: "GET", url: "/health" });

    expect(trusted.statusCode).toBe(200);
    expect(trusted.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(trusted.headers["access-control-allow-credentials"]).toBe("true");
    expect(trusted.headers.vary).toContain("Origin");
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    expect(noOrigin.statusCode).toBe(200);
  });

  it("validates preflight methods and headers before granting CORS", async () => {
    const app = makeApp({ corsOrigins: [allowedOrigin] });
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/auth/refresh",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-csrf-token",
      },
    });
    const badMethod = await app.inject({
      method: "OPTIONS",
      url: "/auth/refresh",
      headers: { origin: allowedOrigin, "access-control-request-method": "TRACE" },
    });
    const badHeader = await app.inject({
      method: "OPTIONS",
      url: "/auth/refresh",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-unknown-header",
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-methods"]).toContain("POST");
    expect(allowed.headers["access-control-allow-headers"]).toContain("authorization");
    expect(badMethod.statusCode).toBe(403);
    expect(badHeader.statusCode).toBe(403);
  });

  it("sets production security headers and a CSP compatible with the local app assets", async () => {
    const app = makeApp({ nodeEnv: "production", corsOrigins: [allowedOrigin] });
    const response = await app.inject({ method: "GET", url: "/health" });
    const csp = String(response.headers["content-security-policy"]);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("redacts authentication, cookie, CSRF and response cookie values from logs", async () => {
    let output = "";
    const app = makeApp({
      nodeEnv: "development",
      loggerStream: { write: (message) => { output += message; } },
    });
    await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: "Bearer AUTH_SECRET_VALUE",
        cookie: "refresh=COOKIE_SECRET_VALUE",
        "x-csrf-token": "CSRF_SECRET_VALUE",
      },
    });
    /*
    app.log.info({
      req: { headers: {
        authorization: "Bearer AUTH_SECRET_VALUE",
        cookie: "refresh=COOKIE_SECRET_VALUE",
        "x-csrf-token": "CSRF_SECRET_VALUE",
      } },
      res: { headers: { "set-cookie": "refresh=SET_COOKIE_SECRET_VALUE" } },
    }, "security redaction probe");
    */

    await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: "Bearer AUTH_SECRET_VALUE",
        cookie: "refresh=COOKIE_SECRET_VALUE",
        "x-csrf-token": "CSRF_SECRET_VALUE",
      },
    });

    expect(output).not.toContain("AUTH_SECRET_VALUE");
    expect(output).not.toContain("COOKIE_SECRET_VALUE");
    expect(output).not.toContain("CSRF_SECRET_VALUE");
    expect(output).not.toContain("SET_COOKIE_SECRET_VALUE");
  });
});

describe("rate limiting and proxy trust", () => {
  it("returns 429 at the configured global limit and ignores spoofed X-Forwarded-For by default", async () => {
    const app = makeApp({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    const third = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "192.0.2.9" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it("uses forwarded addresses only when the immediate proxy is explicitly trusted", async () => {
    const app = makeApp({ trustProxy: ["127.0.0.1"], rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("applies a stricter configurable limit to authentication endpoints", async () => {
    const app = makeApp({ authRateLimitMax: 1, authRateLimitWindowMs: 60_000 });
    const login = () =>
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "missing@example.test", password: "wrong-password" },
      });

    expect((await login()).statusCode).toBe(401);
    const limited = await login();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().statusCode).toBe(429);
  });
});

describe("production configuration", () => {
  const validProductionEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PORT: "3001",
    HOST: "0.0.0.0",
    JWT_SECRET,
    DATABASE_URL: "postgresql://app:secret@db.example.test:5432/autospokes",
    CORS_ORIGINS: "https://app.autospokes.example,https://admin.autospokes.example",
    TRUSTED_PROXY_ADDRESSES: "10.0.0.1,10.10.0.0/16",
  };

  it("requires explicit HTTPS production origins and validates proxy addresses", () => {
    const config = parseServerConfig(validProductionEnv);

    expect(config.corsOrigins).toEqual(["https://app.autospokes.example", "https://admin.autospokes.example"]);
    expect(config.trustedProxyAddresses).toEqual(["10.0.0.1", "10.10.0.0/16"]);
    expect(config.rateLimitMax).toBe(120);
    expect(config.authRateLimitMax).toBe(5);
    expect(() => parseServerConfig({ ...validProductionEnv, CORS_ORIGINS: undefined })).toThrow(/CORS_ORIGINS/);
    expect(() => parseServerConfig({ ...validProductionEnv, CORS_ORIGINS: "https://app.example/path" })).toThrow(/CORS_ORIGINS/);
    expect(() => parseServerConfig({ ...validProductionEnv, CORS_ORIGINS: "*" })).toThrow(/CORS_ORIGINS/);
    expect(() => parseServerConfig({ ...validProductionEnv, TRUSTED_PROXY_ADDRESSES: "attacker.example" })).toThrow(/TRUSTED_PROXY_ADDRESSES/);
    expect(() => parseServerConfig({ ...validProductionEnv, ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP: "true" })).toThrow(/ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP/);
  });

  it("uses only loopback development origins and never includes secret values in configuration errors", () => {
    const config = parseServerConfig({
      NODE_ENV: "development",
      JWT_SECRET,
      DATABASE_URL: "postgresql://app:secret@127.0.0.1:5432/autospokes",
    });

    expect(config.corsOrigins).toContain("http://localhost:5173");
    expect(() => parseServerConfig({
      NODE_ENV: "development",
      JWT_SECRET: "short-secret",
      DATABASE_URL: "not-a-url",
      CORS_ORIGINS: "https://attacker.example",
    })).toThrow(/JWT_SECRET/);
    try {
      parseServerConfig({
        ...validProductionEnv,
        JWT_SECRET: "short-super-secret-value",
        DATABASE_URL: "postgresql://db.example.test:5432/autospokes",
      });
      expect.fail("expected invalid secret length");
    } catch (error) {
      expect(String(error)).toContain("JWT_SECRET");
      expect(String(error)).not.toContain("short-super-secret-value");
    }
  });
});
