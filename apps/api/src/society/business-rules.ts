export type SocietyTaskState = "SCHEDULED" | "COMPLETED" | "MISSED" | "UNAVAILABLE";
export type SocietyWashScheduleState = "ACTIVE" | "PAUSED" | "STOPPED";

export function societyScheduleDueOn(
  schedule: {
    frequency: "DAILY" | "SELECTED_DAYS";
    weekdays: readonly number[];
    effectiveFrom: string;
    effectiveTo: string | null;
    status: SocietyWashScheduleState;
  },
  date: string,
): boolean {
  if (
    schedule.status !== "ACTIVE" ||
    schedule.effectiveFrom > date ||
    (schedule.effectiveTo !== null && schedule.effectiveTo < date)
  ) return false;
  if (schedule.frequency === "DAILY") return true;
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return schedule.weekdays.includes(day === 0 ? 7 : day);
}

export function canChangeSocietyScheduleStatus(
  from: SocietyWashScheduleState,
  to: SocietyWashScheduleState,
): boolean {
  return from === "ACTIVE"
    ? to === "PAUSED" || to === "STOPPED"
    : from === "PAUSED" && (to === "ACTIVE" || to === "STOPPED");
}

export function canSetSocietyTaskStatus(from: SocietyTaskState, to: SocietyTaskState): boolean {
  return from === "SCHEDULED" && ["COMPLETED", "MISSED", "UNAVAILABLE"].includes(to);
}

export function earningSnapshot(
  status: SocietyTaskState,
  assignedRatePaise: number | null,
): number | null {
  return status === "COMPLETED" && assignedRatePaise !== null ? assignedRatePaise : null;
}

export function invoiceTotalPaise(amounts: readonly number[]): number {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 2_147_483_647) {
    throw Object.assign(new Error("Invoice total is outside the supported amount range"), { statusCode: 409 });
  }
  return total;
}

export function outstandingBalancePaise(totalPaise: number, payments: readonly number[]): number {
  const paid = payments.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(paid) || paid < 0 || paid > totalPaise) {
    throw Object.assign(new Error("Recorded payments exceed the invoice total"), { statusCode: 409 });
  }
  return totalPaise - paid;
}

export function assertPaymentWithinBalance(amountPaise: number, outstandingPaise: number): void {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > outstandingPaise) {
    throw Object.assign(new Error("Payment exceeds the outstanding invoice balance"), { statusCode: 409 });
  }
}

export function assignmentEndDate(currentStart: string, nextStart: string): string {
  if (nextStart < currentStart) {
    throw Object.assign(new Error("Reassignment cannot begin before the current assignment"), { statusCode: 409 });
  }
  if (nextStart === currentStart) return nextStart;
  const end = new Date(`${nextStart}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}
