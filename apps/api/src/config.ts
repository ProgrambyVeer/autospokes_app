import { isIP } from "node:net";

const DEVELOPMENT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5180",
  "http://127.0.0.1:5180",
];

export type ServerConfig = {
  port: number;
  host: string;
  jwtSecret: string;
  nodeEnv: "development" | "production";
  databaseUrl: string;
  corsOrigins: string[];
  trustedProxyAddresses: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
};

function configError(name: string, expectation: string): never {
  throw new Error(`Invalid production/server configuration: ${name} ${expectation}`);
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return configError(name, "must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return configError(name, `must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseCorsOrigins(raw: string | undefined, nodeEnv: "development" | "production"): string[] {
  if (!raw?.trim()) {
    if (nodeEnv === "production") return configError("CORS_ORIGINS", "must explicitly list allowed HTTPS origins");
    return DEVELOPMENT_ORIGINS;
  }

  const origins = raw.split(",").map((origin) => origin.trim());
  if (origins.some((origin) => !origin)) return configError("CORS_ORIGINS", "contains an empty origin");
  const parsed = origins.map((origin) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return configError("CORS_ORIGINS", "must contain valid origins");
    }
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (nodeEnv === "production" && url.protocol !== "https:")
    ) {
      return configError(
        "CORS_ORIGINS",
        nodeEnv === "production"
          ? "must contain exact HTTPS origins without paths or credentials"
          : "must contain exact origins without paths or credentials",
      );
    }
    if (
      nodeEnv === "development" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return configError("CORS_ORIGINS", "must use localhost or a loopback address in development");
    }
    return url.origin;
  });
  if (new Set(parsed).size !== parsed.length) return configError("CORS_ORIGINS", "must not contain duplicates");
  return parsed;
}

function parseTrustedProxyAddresses(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const addresses = raw.split(",").map((address) => address.trim());
  if (addresses.some((address) => !address)) {
    return configError("TRUSTED_PROXY_ADDRESSES", "contains an empty address");
  }
  for (const address of addresses) {
    const [host, prefix, extra] = address.split("/");
    const version = isIP(host ?? "");
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : 0;
    if (
      extra !== undefined ||
      version === 0 ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > maxPrefix))
    ) {
      return configError("TRUSTED_PROXY_ADDRESSES", "must contain IP addresses or CIDRs");
    }
  }
  return addresses;
}

export function parseServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "production") {
    return configError("NODE_ENV", "must be development or production");
  }
  const port = parseInteger(env, "PORT", 3001, 1, 65535);
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) return configError("JWT_SECRET", "must contain at least 32 characters");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return configError("DATABASE_URL", "is required");
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    return configError("DATABASE_URL", "must be a valid PostgreSQL connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol)) {
    return configError("DATABASE_URL", "must use PostgreSQL");
  }
  if (nodeEnv === "production" && env.ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP === "true") {
    return configError("ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP", "must not be enabled while the API server is running");
  }
  return {
    port,
    host: env.HOST || "127.0.0.1",
    jwtSecret,
    nodeEnv,
    databaseUrl,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, nodeEnv),
    trustedProxyAddresses: parseTrustedProxyAddresses(env.TRUSTED_PROXY_ADDRESSES),
    rateLimitMax: parseInteger(env, "RATE_LIMIT_MAX", 120, 1, 10000),
    rateLimitWindowMs: parseInteger(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1000, 3_600_000),
    authRateLimitMax: parseInteger(env, "AUTH_RATE_LIMIT_MAX", 5, 1, 100),
    authRateLimitWindowMs: parseInteger(env, "AUTH_RATE_LIMIT_WINDOW_MS", 900_000, 1000, 3_600_000),
  };
}
