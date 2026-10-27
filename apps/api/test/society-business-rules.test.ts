import { describe, expect, it } from "vitest";
import {
  assertPaymentWithinBalance,
  assignmentEndDate,
  canSetSocietyTaskStatus,
  earningSnapshot,
  invoiceTotalPaise,
  outstandingBalancePaise,
  societyScheduleDueOn,
  canChangeSocietyScheduleStatus,
} from "../src/society/business-rules.js";
import { istDateString } from "@autospokes/shared";

describe("Society Vendor business rules", () => {
  it("allows same-day reassignment while retaining a valid assignment date interval", () => {
    expect(assignmentEndDate("2030-04-02", "2030-04-02")).toBe("2030-04-02");
    expect(assignmentEndDate("2030-04-02", "2030-04-03")).toBe("2030-04-02");
    expect(() => assignmentEndDate("2030-04-03", "2030-04-02")).toThrow(
      "Reassignment cannot begin before the current assignment",
    );
  });

  it("does not accrue earnings except once for an assigned completed task", () => {
    expect(canSetSocietyTaskStatus("SCHEDULED", "COMPLETED")).toBe(true);
    expect(canSetSocietyTaskStatus("COMPLETED", "MISSED")).toBe(false);
    expect(earningSnapshot("COMPLETED", 2750)).toBe(2750);
    expect(earningSnapshot("MISSED", 2750)).toBeNull();
    expect(earningSnapshot("COMPLETED", null)).toBeNull();
  });

  it("calculates flat plan totals and partial payment balances safely", () => {
    const total = invoiceTotalPaise([125_000, 75_000, 20_000]);
    expect(total).toBe(220_000);
    const outstanding = outstandingBalancePaise(total, [100_000, 25_000]);
    expect(outstanding).toBe(95_000);
    expect(() => assertPaymentWithinBalance(95_000, outstanding)).not.toThrow();
    expect(() => assertPaymentWithinBalance(95_001, outstanding)).toThrow(
      "Payment exceeds the outstanding invoice balance",
    );
    expect(() => invoiceTotalPaise([2_147_483_647, 1])).toThrow(
      "Invoice total is outside the supported amount range",
    );
    expect(() => outstandingBalancePaise(100, [101])).toThrow(
      "Recorded payments exceed the invoice total",
    );
  });

  it("uses the authoritative IST calendar date at UTC day boundaries", () => {
    expect(istDateString(new Date("2030-01-01T18:29:59.999Z"))).toBe("2030-01-01");
    expect(istDateString(new Date("2030-01-01T18:30:00.000Z"))).toBe("2030-01-02");
  });

  it("selects schedule weekdays from the IST date across the UTC-evening boundary", () => {
    const schedule = {
      effectiveFrom: "2030-03-01",
      effectiveTo: "2030-03-11",
      status: "ACTIVE" as const,
      frequency: "SELECTED_DAYS" as const,
    };
    // 2030-03-11 is a Monday and 2030-03-12 a Tuesday in IST.
    const beforeMidnight = istDateString(new Date("2030-03-11T18:29:59.999Z"));
    const afterMidnight = istDateString(new Date("2030-03-11T18:30:00.000Z"));
    expect(beforeMidnight).toBe("2030-03-11");
    expect(afterMidnight).toBe("2030-03-12");
    expect(societyScheduleDueOn({ ...schedule, weekdays: [1] }, beforeMidnight)).toBe(true);
    expect(societyScheduleDueOn({ ...schedule, weekdays: [1] }, afterMidnight)).toBe(false);
    expect(societyScheduleDueOn({ ...schedule, effectiveTo: null, weekdays: [2] }, afterMidnight)).toBe(true);
    expect(societyScheduleDueOn({ ...schedule, effectiveTo: null, weekdays: [2] }, beforeMidnight)).toBe(false);
  });

  it("generates each service only on its own active frequency and selected weekdays", () => {
    const active = {
      effectiveFrom: "2030-01-01",
      effectiveTo: null,
      status: "ACTIVE" as const,
      frequency: "SELECTED_DAYS" as const,
    };
    expect(societyScheduleDueOn({ ...active, weekdays: [2] }, "2030-01-01")).toBe(true);
    expect(societyScheduleDueOn({ ...active, weekdays: [1] }, "2030-01-01")).toBe(false);
    expect(societyScheduleDueOn({
      ...active,
      frequency: "DAILY",
      weekdays: [],
    }, "2030-01-01")).toBe(true);
    expect(societyScheduleDueOn({
      ...active,
      weekdays: [2],
      effectiveTo: "2030-01-01",
    }, "2030-01-02")).toBe(false);
    expect(societyScheduleDueOn({ ...active, weekdays: [2], status: "PAUSED" }, "2030-01-01")).toBe(false);
    expect(societyScheduleDueOn({ ...active, weekdays: [2], status: "STOPPED" }, "2030-01-01")).toBe(false);
  });

  it("allows pausing and resuming active schedules but makes stopped schedules terminal", () => {
    expect(canChangeSocietyScheduleStatus("ACTIVE", "PAUSED")).toBe(true);
    expect(canChangeSocietyScheduleStatus("PAUSED", "ACTIVE")).toBe(true);
    expect(canChangeSocietyScheduleStatus("ACTIVE", "STOPPED")).toBe(true);
    expect(canChangeSocietyScheduleStatus("PAUSED", "STOPPED")).toBe(true);
    expect(canChangeSocietyScheduleStatus("STOPPED", "ACTIVE")).toBe(false);
  });
});
