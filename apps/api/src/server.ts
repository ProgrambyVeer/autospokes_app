import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { PrismaAuthRepository } from "./auth/prisma-repository.js";
import { verifyDedicatedDatabase } from "./database.js";
import { PrismaOwnerRepository } from "./owner/prisma-repository.js";
import { PrismaDetailerRepository } from "./detailer/prisma-repository.js";
import { PrismaSocietyRepository } from "./society/prisma-repository.js";
import { PrismaMarketplaceRepository } from "./marketplace/prisma-repository.js";
import { parseServerConfig } from "./config.js";

const config = parseServerConfig(process.env);

const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
await verifyDedicatedDatabase(prisma);
const app = buildApp({
  authRepository: new PrismaAuthRepository(prisma),
  ownerRepository: new PrismaOwnerRepository(prisma),
  detailerRepository: new PrismaDetailerRepository(prisma),
  societyRepository: new PrismaSocietyRepository(prisma),
  marketplaceRepository: new PrismaMarketplaceRepository(prisma),
  jwtSecret: config.jwtSecret,
  nodeEnv: config.nodeEnv,
  corsOrigins: config.corsOrigins,
  trustProxy: config.trustedProxyAddresses,
  rateLimitMax: config.rateLimitMax,
  rateLimitWindowMs: config.rateLimitWindowMs,
  authRateLimitMax: config.authRateLimitMax,
  authRateLimitWindowMs: config.authRateLimitWindowMs,
  readinessCheck: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
});
app.addHook("onClose", async () => prisma.$disconnect());
await app.listen({ port: config.port, host: config.host });
