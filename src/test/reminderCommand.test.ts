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

  it("interprets Eastern input the same way on servers in other timezones", () => {
    const originalTimezone = process.env.TZ;
    try {
      for (const timezone of ["UTC", "America/Los_Angeles"]) {
        process.env.TZ = timezone;
        const reference = new Date("2026-10-21T04:17:00Z");
        expect(parseReminderTime("tomorrow at 8am", reference)?.toISOString()).toBe("2026-10-22T12:00:00.000Z");
        expect(parseReminderTime("Jan 15 at 8am", reference)?.toISOString()).toBe("2027-01-15T13:00:00.000Z");
      }
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("names EST or EDT and explains how to reschedule a defaulted time", () => {
    const winter = reminderConfirmation(Date.parse("2026-01-16T14:00:00Z"), "a1b2c3d4e5f6", true);
    const summer = reminderConfirmation(Date.parse("2026-07-16T13:00:00Z"), "a1b2c3d4e5f6", true);
    expect(winter).toContain("Eastern Time (EST)");
    expect(summer).toContain("Eastern Time (EDT)");
    expect(summer.split("\n")).toHaveLength(3);
    expect(summer).toContain("v?cancel a1b2c3d4e5f6");
    expect(summer).toContain("9:00 AM EDT");
    expect(summer).toContain("explicit timezone");
    expect(summer).not.toMatch(/<t:\d+:f>/);
    expect(summer).toContain("I’ll remind you");
    const screenshot = reminderConfirmation(Date.parse("2026-10-22T12:00:00Z"), "a1b2c3d4e5f6", true);
    expect(screenshot).toContain("8:00 AM EDT");
    expect(reminderConfirmation(Date.parse("2026-07-16T13:00:00Z"), "a1b2c3d4e5f6", true, "slash"))
      .toContain("/cancel id:a1b2c3d4e5f6");
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

  it("accepts a time without a custom reminder message", () => {
    expect(parseChatReminder("v?rem tomorrow at 7am", new Date("2026-10-21T12:00:00Z"))).toEqual({
      due: new Date("2026-10-22T11:00:00Z"),
      message: "It’s time.",
      usesDefaultTimezone: true,
    });
  });
});
