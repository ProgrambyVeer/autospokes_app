import {
  addDays,
  isoWeekday,
  type DailyTask,
  type DailyTaskException,
  type DailyTaskStatus,
  type TaskActivity,
  type WashSchedule,
} from "@autospokes/shared";
import type { GenerationCandidate, NewTask } from "./repository.js";

/** Tasks may be generated for today and tomorrow (IST) only; older dates are read-only history. */
export const MAX_GENERATION_DAYS_AHEAD = 1;

export function scheduleDueOn(schedule: WashSchedule, date: string): boolean {
  return (
    schedule.isActive &&
    schedule.effectiveFrom <= date &&
    (schedule.effectiveTo === null || schedule.effectiveTo >= date) &&
    schedule.weekdays.includes(isoWeekday(date))
  );
}

export function statusForException(exception: DailyTaskException): DailyTaskStatus {
  return exception === "WASH_MISSED" ? "MISSED" : "UNAVAILABLE";
}

/**
 * Builds the tasks that should exist for `date` but do not yet. Dusting is daily for every
 * active vehicle; the other activities follow their own schedules. A vehicle-day that already
 * carries an exception (or a leave day) makes new tasks inherit it, so activities stay disabled.
 */
export function planMissingTasks(
  date: string,
  candidates: GenerationCandidate[],
  existing: DailyTask[],
): NewTask[] {
  const have = new Set(existing.map((task) => `${task.vehicleId}:${task.activity}`));
  const leave = existing.some((task) => task.exception === "DETAILER_ON_LEAVE");
  const vehicleException = new Map<string, DailyTaskException>();
  for (const task of existing) {
    if (task.exception && task.exception !== "DETAILER_ON_LEAVE") {
      vehicleException.set(task.vehicleId, task.exception);
    }
  }

  const planned: NewTask[] = [];
  for (const candidate of candidates) {
    const exception: DailyTaskException | null = leave
      ? "DETAILER_ON_LEAVE"
      : (vehicleException.get(candidate.vehicleId) ?? null);
    const add = (activity: TaskActivity, scheduleId: string | null) => {
      if (have.has(`${candidate.vehicleId}:${activity}`)) return;
      planned.push({
        vehicleId: candidate.vehicleId,
        scheduleId,
        activity,
        taskDate: date,
        status: exception ? statusForException(exception) : "SCHEDULED",
        exception,
      });
    };
    if (candidate.startDate <= date) add("DUSTING", null);
    for (const schedule of candidate.schedules) {
      if (scheduleDueOn(schedule, date)) add(schedule.activity, schedule.id);
    }
  }
  return planned;
}

export function isGenerationAllowed(date: string, today: string): boolean {
  return date >= today && date <= addDays(today, MAX_GENERATION_DAYS_AHEAD);
}

const ALLOWED_TRANSITIONS: Record<DailyTaskStatus, DailyTaskStatus[]> = {
  SCHEDULED: ["COMPLETED", "MISSED", "UNAVAILABLE"],
  MISSED: ["SCHEDULED"],
  UNAVAILABLE: ["SCHEDULED"],
  COMPLETED: [],
};

export function canTransition(from: DailyTaskStatus, to: DailyTaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
