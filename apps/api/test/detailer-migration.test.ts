import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20261027112000_phase4_task_schedule_integrity/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Detailer task-schedule integrity migration", () => {
  it("runs enum and task-link preflight checks before any DDL", () => {
    const preflightEndMatch = /END\s*\$\$;/i.exec(migration);
    const preflightEnd = preflightEndMatch?.index ?? -1;
    const firstDdl = migration.search(/\b(?:ALTER TABLE|CREATE (?:UNIQUE )?INDEX)\b/);

    expect(migration.startsWith("-- Validate enum mappings")).toBe(true);
    expect(preflightEnd).toBeGreaterThan(0);
    expect(firstDdl).toBeGreaterThan(preflightEnd);
    expect(migration.slice(0, preflightEnd)).toMatch(/t\.typname = 'WashActivity'/);
    expect(migration.slice(0, preflightEnd)).toMatch(/tt\.typname = 'TaskActivity'/);
    expect(migration.slice(0, preflightEnd)).toMatch(/WashActivity labels do not map to TaskActivity/);
    expect(migration.slice(0, preflightEnd)).toMatch(/task\."accountId" IS DISTINCT FROM schedule\."accountId"/);
    expect(migration.slice(0, preflightEnd)).toMatch(/task\."vehicleId" IS DISTINCT FROM schedule\."vehicleId"/);
    expect(migration.slice(0, preflightEnd)).toMatch(/task\."activity"::text IS DISTINCT FROM schedule\."activity"::text/);
    expect(migration.slice(0, preflightEnd)).toMatch(/existing DailyTask rows reference a missing or mismatched WashSchedule/);
  });

  it("backfills schedule activity keys without changing schedule activities", () => {
    expect(migration).toMatch(
      /UPDATE "WashSchedule"\s+SET "taskActivityKey" = "activity"::text::"TaskActivity"/,
    );
    expect(migration).toMatch(
      /"activity"::text = "taskActivityKey"::text/,
    );
    expect(migration).toMatch(/"taskActivityKey" <> 'DUSTING'::"TaskActivity"/);
  });

  it("references the schedule by account, vehicle, and matching activity", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "WashSchedule_id_accountId_vehicleId_taskActivityKey_key"\s+ON "WashSchedule"\("id", "accountId", "vehicleId", "taskActivityKey"\)/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("scheduleId", "accountId", "vehicleId", "activity"\)\s+REFERENCES "WashSchedule"\("id", "accountId", "vehicleId", "taskActivityKey"\)/,
    );
  });
});
