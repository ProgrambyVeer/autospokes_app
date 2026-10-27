-- Validate enum mappings and existing task links before any schema changes.
DO $$
DECLARE
  wash_activity_count integer;
  task_activity_count integer;
  unmapped_activities text;
BEGIN
  SELECT count(*) INTO wash_activity_count
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema()
    AND t.typname = 'WashActivity';

  SELECT count(*) INTO task_activity_count
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema()
    AND t.typname = 'TaskActivity';

  IF wash_activity_count = 0 OR task_activity_count = 0 THEN
    RAISE EXCEPTION
      'Preflight failed: WashActivity or TaskActivity enum is missing or has no labels in schema %',
      current_schema();
  END IF;

  SELECT string_agg(w.enumlabel::text, ', ' ORDER BY w.enumsortorder)
  INTO unmapped_activities
  FROM pg_enum w
  JOIN pg_type wt ON wt.oid = w.enumtypid
  JOIN pg_namespace wn ON wn.oid = wt.typnamespace
  WHERE wn.nspname = current_schema()
    AND wt.typname = 'WashActivity'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_enum t
      JOIN pg_type tt ON tt.oid = t.enumtypid
      JOIN pg_namespace tn ON tn.oid = tt.typnamespace
      WHERE tn.nspname = current_schema()
        AND tt.typname = 'TaskActivity'
        AND t.enumlabel = w.enumlabel
    );

  IF unmapped_activities IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight failed: WashActivity labels do not map to TaskActivity: %',
      unmapped_activities;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DailyTask" task
    LEFT JOIN "WashSchedule" schedule
      ON schedule."id" = task."scheduleId"
    WHERE task."scheduleId" IS NOT NULL
      AND (
        schedule."id" IS NULL
        OR task."accountId" IS DISTINCT FROM schedule."accountId"
        OR task."vehicleId" IS DISTINCT FROM schedule."vehicleId"
        OR task."activity"::text IS DISTINCT FROM schedule."activity"::text
      )
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: existing DailyTask rows reference a missing or mismatched WashSchedule (accountId, vehicleId, or activity)';
  END IF;
END
$$;

-- Keep the existing WashActivity column while adding a TaskActivity-typed
-- key so PostgreSQL can enforce the task's vehicle and activity association.
ALTER TABLE "WashSchedule"
  ADD COLUMN "taskActivityKey" "TaskActivity";

UPDATE "WashSchedule"
SET "taskActivityKey" = "activity"::text::"TaskActivity";

ALTER TABLE "WashSchedule"
  ALTER COLUMN "taskActivityKey" SET NOT NULL,
  ADD CONSTRAINT "WashSchedule_taskActivityKey_check"
    CHECK (
      "taskActivityKey" <> 'DUSTING'::"TaskActivity" AND
      "activity"::text = "taskActivityKey"::text
    );

CREATE UNIQUE INDEX "WashSchedule_id_accountId_vehicleId_taskActivityKey_key"
  ON "WashSchedule"("id", "accountId", "vehicleId", "taskActivityKey");

ALTER TABLE "DailyTask"
  DROP CONSTRAINT "DailyTask_scheduleId_accountId_fkey",
  ADD CONSTRAINT "DailyTask_scheduleId_accountId_vehicleId_activity_fkey"
    FOREIGN KEY ("scheduleId", "accountId", "vehicleId", "activity")
    REFERENCES "WashSchedule"("id", "accountId", "vehicleId", "taskActivityKey")
    ON UPDATE CASCADE
    ON DELETE NO ACTION;
