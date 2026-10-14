import "dotenv/config";
import { hashPassword } from "../src/auth/security.js";
import { PrismaAuthRepository } from "../src/auth/prisma-repository.js";
import { PrismaClient } from "@prisma/client";
import { verifyDedicatedDatabase } from "../src/database.js";
import { z } from "zod";

const emailSchema = z.string().email().max(254);
const prisma = new PrismaClient();

try {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "production") {
    throw new Error("Set NODE_ENV to development or production before bootstrapping");
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP !== "true"
  ) {
    throw new Error(
      "Production bootstrap requires ALLOW_PRODUCTION_SUPERADMIN_BOOTSTRAP=true for this one-time command",
    );
  }

  const databaseName = await verifyDedicatedDatabase(prisma);
  const email = emailSchema.parse(process.env.BOOTSTRAP_SUPERADMIN_EMAIL).toLowerCase();
  const password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD;
  const displayName = process.env.BOOTSTRAP_SUPERADMIN_DISPLAY_NAME?.trim();

  if (!password || password.length < 16 || password.length > 128) {
    throw new Error("BOOTSTRAP_SUPERADMIN_PASSWORD must be 16 to 128 characters");
  }
  if (!displayName || displayName.length > 80) {
    throw new Error("BOOTSTRAP_SUPERADMIN_DISPLAY_NAME must be 1 to 80 characters");
  }
  await new PrismaAuthRepository(prisma).createSuperadmin({
    email,
    passwordHash: await hashPassword(password),
    displayName,
  });
  console.log(`Created the initial Superadmin on ${databaseName}.`);
} finally {
  await prisma.$disconnect();
}
