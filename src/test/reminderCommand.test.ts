import { describe, expect, it } from "vitest";
import { parseReminderTime } from "../handlers/reminderCommand.js";

describe("reminder time parsing", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("accepts natural language times through five years", () => {
    expect(parseReminderTime("in 2 hours", now)?.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(parseReminderTime("in 5 years", now)?.toISOString()).toBe("2031-10-20T12:00:00.000Z");
  });

  it("rejects invalid, past, and too distant times", () => {
    expect(parseReminderTime("not a date", now)).toBeNull();
    expect(parseReminderTime("yesterday", now)).toBeNull();
    expect(parseReminderTime("in 6 years", now)).toBeNull();
  });
});
