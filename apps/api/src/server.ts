import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { PrismaAuthRepository } from "./auth/prisma-repository.js";
import { verifyDedicatedDatabase } from "./database.js";
import { PrismaOwnerRepository } from "./owner/prisma-repository.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const jwtSecret = process.env.JWT_SECRET;
const nodeEnv = process.env.NODE_ENV;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("Set JWT_SECRET to a random value of at least 32 characters in apps/api/.env");
}
if (nodeEnv !== "development" && nodeEnv !== "production") {
  throw new Error("Set NODE_ENV to development or production in apps/api/.env");
}

const prisma = new PrismaClient();
await verifyDedicatedDatabase(prisma);
const app = buildApp({
  authRepository: new PrismaAuthRepository(prisma),
  ownerRepository: new PrismaOwnerRepository(prisma),
  jwtSecret,
  nodeEnv,
});
app.addHook("onClose", async () => prisma.$disconnect());
await app.listen({ port, host });
