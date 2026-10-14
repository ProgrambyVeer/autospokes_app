import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { verifyDedicatedDatabase } from "../src/database.js";

const prisma = new PrismaClient();

try {
  const databaseName = await verifyDedicatedDatabase(prisma);
  console.log(`Verified dedicated Autospokes database: ${databaseName}`);
} finally {
  await prisma.$disconnect();
}
