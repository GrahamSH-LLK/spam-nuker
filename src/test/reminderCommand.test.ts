import { describe, expect, it } from "vitest";
import { parseChatReminder, parseReminderTime, reminderConfirmation, reminderTimeUsesDefaultTimezone } from "../handlers/reminderCommand.js";

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

  it("defaults calendar times to Eastern Time and identifies the fallback", () => {
    expect(reminderTimeUsesDefaultTimezone("tomorrow at 9am", now)).toBe(true);
    expect(reminderTimeUsesDefaultTimezone("next Friday", now)).toBe(true);
    expect(parseReminderTime("tomorrow at 9am", now)?.toISOString()).toBe("2026-10-21T13:00:00.000Z");
    expect(reminderTimeUsesDefaultTimezone("in 2 hours", now)).toBe(false);
    expect(reminderTimeUsesDefaultTimezone("in 5 years", now)).toBe(false);
    expect(reminderTimeUsesDefaultTimezone("tomorrow at 9am UTC", now)).toBe(false);
    expect(parseReminderTime("tomorrow at 9am UTC", now)?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(parseReminderTime("tomorrow at 9am", new Date("2026-07-15T12:00:00Z"))?.toISOString()).toBe("2026-07-16T13:00:00.000Z");
  });

  it("names EST or EDT and explains how to reschedule a defaulted time", () => {
    const winter = reminderConfirmation(Date.parse("2026-01-16T14:00:00Z"), "test-id", true);
    const summer = reminderConfirmation(Date.parse("2026-07-16T13:00:00Z"), "test-id", true);
    expect(winter).toContain("Eastern Time (EST)");
    expect(summer).toContain("Eastern Time (EDT)");
    expect(summer).toContain("/cancel id:test-id");
    expect(summer).toContain("tomorrow at 9am UTC");
  });
});

describe("chat reminder parsing", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("accepts both prefixes and conversational phrasing", () => {
    expect(parseChatReminder("v?remind me in 2 hours to call mom", now)).toEqual({
      due: new Date("2026-10-20T14:00:00Z"),
      message: "call mom",
      usesDefaultTimezone: false,
    });
    expect(parseChatReminder("v?rem call mom in 2 hours", now)).toEqual({
      due: new Date("2026-10-20T14:00:00Z"),
      message: "call mom",
      usesDefaultTimezone: false,
    });
    expect(parseChatReminder("v‽remind me in 2 hours to call mom", now)).toEqual({
      due: new Date("2026-10-20T14:00:00Z"),
      message: "call mom",
      usesDefaultTimezone: false,
    });
    expect(parseChatReminder("v‽rem call mom in 2 hours", now)).toEqual({
      due: new Date("2026-10-20T14:00:00Z"),
      message: "call mom",
      usesDefaultTimezone: false,
    });
    expect(parseChatReminder("v?rem call mom tomorrow at 9am", now)).toMatchObject({
      due: new Date("2026-10-21T13:00:00Z"),
      message: "call mom",
      usesDefaultTimezone: true,
    });
  });

  it("ignores messages without a command prefix", () => {
    expect(parseChatReminder("please remind me in 2 hours", now)).toBeNull();
    expect(parseChatReminder("v?reminder in 2 hours", now)).toBeNull();
    expect(parseChatReminder("‽rem in 2 hours to call mom", now)).toBeNull();
  });
});
