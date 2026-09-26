import { beforeEach, expect, test, vi } from "vitest";

const { values, lists } = vi.hoisted(() => ({
  values: new Map<string, string>(),
  lists: new Map<string, string[]>(),
}));

vi.mock("../redis.js", () => ({
  getRedisClient: () => ({
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); },
    del: async (key: string) => { values.delete(key); },
    lpush: async (key: string, value: string) => { lists.set(key, [value, ...(lists.get(key) ?? [])]); },
    ltrim: async (key: string, start: number, end: number) => { lists.set(key, (lists.get(key) ?? []).slice(start, end + 1)); },
    lrange: async (key: string, start: number, end: number) => (lists.get(key) ?? []).slice(start, end === -1 ? undefined : end + 1),
    expire: async () => undefined,
  }),
}));

import { handleSpamBan, handleSpamUnban, recordSpamAlert } from "../handlers/banAlerts.js";

beforeEach(() => { values.clear(); lists.clear(); });

function fixture() {
  const alerts = new Map<string, { content: string; edit: ReturnType<typeof vi.fn> }>();
  for (const id of ["alert-1", "alert-2", "other-alert"]) {
    const alert = {
      content: `⚠️ **Spam detected** | ${id}`,
      edit: vi.fn(async (payload: { content: string }) => { alert.content = payload.content; }),
    };
    alerts.set(id, alert);
  }
  const channel = {
    isTextBased: () => true,
    messages: { fetch: vi.fn(async (id: string) => alerts.get(id)) },
  };
  const guild = { id: "guild-1", channels: { fetch: vi.fn(async () => channel) } } as any;
  const ban = { guild, user: { id: "user-1" } } as any;
  return { alerts, ban, channel, guild };
}

test("a ban updates only that user's recent spam alerts, once each", async () => {
  const { alerts, ban, guild } = fixture();
  await recordSpamAlert(guild, "user-1", "logs", "alert-1");
  await recordSpamAlert(guild, "user-1", "logs", "alert-2");
  await recordSpamAlert(guild, "other-user", "logs", "other-alert");

  await handleSpamBan(ban);
  await handleSpamBan(ban);

  for (const id of ["alert-1", "alert-2"]) {
    expect(alerts.get(id)?.content).toContain("🚫 **User banned**");
    expect(alerts.get(id)?.edit).toHaveBeenCalledTimes(1);
    expect(alerts.get(id)?.edit).toHaveBeenCalledWith({
      content: expect.stringContaining("🚫 **User banned**"),
      allowedMentions: { parse: [] },
    });
  }
  expect(alerts.get("other-alert")?.edit).not.toHaveBeenCalled();
});

test("an alert posted during a ban is updated, and unban clears the pending marker", async () => {
  const { alerts, ban, guild } = fixture();
  await handleSpamBan(ban);
  await recordSpamAlert(guild, "user-1", "logs", "alert-1");
  expect(alerts.get("alert-1")?.content).toContain("🚫 **User banned**");

  await handleSpamUnban(ban);
  await recordSpamAlert(guild, "user-1", "logs", "alert-2");
  expect(alerts.get("alert-2")?.edit).not.toHaveBeenCalled();
});

test("a flag older than the recent window is left unchanged", async () => {
  const { alerts, ban, guild } = fixture();
  await recordSpamAlert(guild, "user-1", "logs", "alert-1");
  const key = "spam_recent_alerts:guild-1:user-1";
  const entry = JSON.parse(lists.get(key)![0]);
  entry.createdAt = Date.now() - 25 * 60 * 60 * 1000;
  lists.set(key, [JSON.stringify(entry)]);

  await handleSpamBan(ban);
  expect(alerts.get("alert-1")?.edit).not.toHaveBeenCalled();
});
