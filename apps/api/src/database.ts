import type { PrismaClient } from "@prisma/client";

export function expectedAutospokesDatabaseName(connectionString: string | undefined): string {
  if (!connectionString) {
    throw new Error("DATABASE_URL must target a dedicated Autospokes PostgreSQL database");
  }

  let databaseName: string;
  try {
    const url = new URL(connectionString);
    databaseName = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error("unsupported database protocol");
    }
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection string");
  }

  if (!/^autospokes(?:[_-][a-z0-9]+)*$/i.test(databaseName)) {
    throw new Error(
      "Refusing database access: DATABASE_URL must name a dedicated Autospokes database such as autospokes_dev",
    );
  }
  return databaseName;
}

export async function verifyDedicatedDatabase(
  prisma: PrismaClient,
  connectionString = process.env.DATABASE_URL,
): Promise<string> {
  const expectedName = expectedAutospokesDatabaseName(connectionString);
  await prisma.$connect();
  const rows = await prisma.$queryRaw<{ database_name: string }[]>`
    SELECT current_database() AS database_name
  `;
  const connectedName = rows[0]?.database_name;
  if (connectedName !== expectedName) {
    throw new Error(
      `Refusing database operation: connection resolved to "${connectedName ?? "unknown"}", expected "${expectedName}"`,
    );
  }
  return connectedName;
}
