import { expect, test, vi } from "vitest";

const { threadIds } = vi.hoisted(() => ({ threadIds: new Map<string, string>() }));
vi.mock("../redis.js", () => ({
  getRedisClient: () => ({
    get: async (key: string) => threadIds.get(key) ?? null,
    set: async (key: string, value: string) => { threadIds.set(key, value); },
  }),
}));

import {
  assessMessage,
  handleJevModeration,
  moderationActions,
  MODERATION_RULES,
  type ModerationCategory,
  type ModerationScores,
} from "../handlers/jevModeration.js";

const categories = Object.keys(MODERATION_RULES) as ModerationCategory[];

function scores(overrides: Partial<ModerationScores> = {}): ModerationScores {
  return Object.fromEntries(categories.map((category) => [category, overrides[category] ?? 0.01])) as ModerationScores;
}

function fetchWithScores(values: ModerationScores): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({
    answers: Object.fromEntries(categories.map((category) => [category, {
      type: "noul", noul: values[category],
    }])),
  }), { status: 200 })) as typeof fetch;
}

function message() {
  const send = vi.fn(async (_payload: { content: string; allowedMentions: { parse: string[] } }) => undefined);
  const thread = { id: "thread-1", parentId: "logs", archived: false, send, setArchived: vi.fn(async () => undefined) };
  const threads = {
    fetch: vi.fn(async (id: string) => id === thread.id ? thread : null),
    create: vi.fn(async () => thread),
  };
  const deletion = vi.fn(async () => undefined);
  const msg = {
    content: "example message",
    embeds: [],
    attachments: new Map(),
    author: { id: "user-1" },
    channelId: "channel-1",
    id: "message-1",
    url: "https://discord.com/channels/guild-1/channel-1/message-1",
    guild: { channels: { fetch: vi.fn(async () => ({ type: 0, id: "logs", threads })) } },
    delete: deletion,
  } as any;
  return { msg, send, deletion, thread, threads };
}

test("Jev receives one batch of independent Noul questions", async () => {
  const { msg } = message();
  const fetcher = fetchWithScores(scores());
  await assessMessage(msg, "test-key", fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(fetcher).mock.calls[0];
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe("jev-latest");
  expect(body.state.content).toBe("example message");
  expect(Object.keys(body.questions)).toEqual(categories);
  expect(body.questions.hate.type).toBe("noul");
});

test("only high probability hate speech causes deletion", async () => {
  threadIds.clear();
  expect(moderationActions(scores({ hate: 0.94 })).deleteMessage).toBe(false);
  expect(moderationActions(scores({ hate: 0.95 })).deleteMessage).toBe(true);
  const { msg, send, deletion, threads } = message();
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ hate: 0.98, scam: 0.94 })));
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].content).toContain("hate speech (0.98)");
  expect(send.mock.calls[0][0].content).toContain("scam or phishing (0.94)");
  expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  expect(threads.create).toHaveBeenCalledOnce();
  expect(deletion).toHaveBeenCalledOnce();
});

test("JEV reuses its log thread and reopens it when archived", async () => {
  threadIds.clear();
  const { msg, send, thread, threads } = message();
  const fetcher = fetchWithScores(scores({ scam: 0.95 }));
  await handleJevModeration(msg, "logs", "test-key", fetcher);
  thread.archived = true;
  await handleJevModeration(msg, "logs", "test-key", fetcher);
  expect(threads.create).toHaveBeenCalledOnce();
  expect(threads.fetch).toHaveBeenCalledWith("thread-1");
  expect(thread.setArchived).toHaveBeenCalledWith(false);
  expect(send).toHaveBeenCalledTimes(2);
});

test("JEV replaces a deleted log thread", async () => {
  threadIds.clear();
  threadIds.set("jev_moderation_thread:logs", "deleted-thread");
  const { msg, threads, send } = message();
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ scam: 0.95 })));
  expect(threads.fetch).toHaveBeenCalledWith("deleted-thread");
  expect(threads.create).toHaveBeenCalledOnce();
  expect(threadIds.get("jev_moderation_thread:logs")).toBe("thread-1");
  expect(send).toHaveBeenCalledOnce();
});

test("simultaneous JEV alerts share one log thread", async () => {
  threadIds.clear();
  const { msg, threads, send } = message();
  const fetcher = fetchWithScores(scores({ scam: 0.95 }));
  await Promise.all([
    handleJevModeration(msg, "logs", "test-key", fetcher),
    handleJevModeration(msg, "logs", "test-key", fetcher),
  ]);
  expect(threads.create).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledTimes(2);
});

test("scams, misleading links, and hostility flag without deleting", async () => {
  const { msg, send, deletion } = message();
  msg.content = "Sign in to Example at https://example-login.test";
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ scam: 0.93, misleadingLink: 0.84, hostility: 0.9 })));
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].content).toContain("misleading link (0.84)");
  expect(deletion).not.toHaveBeenCalled();
  expect(moderationActions(scores({ misleadingLink: 0.79 })).flagged).toEqual([]);
});

test("safety references, unwanted behavior, and requests for a moderator alert without deleting", async () => {
  const { msg, send, deletion } = message();
  const newCategories = {
    selfHarm: 0.84,
    alcohol: 0.79,
    drugs: 0.91,
    otherSubstances: 0.82,
    unwantedBehavior: 0.88,
    moderatorHelp: 0.95,
  };
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores(newCategories)));
  expect(send).toHaveBeenCalledOnce();
  for (const category of Object.keys(newCategories) as (keyof typeof newCategories)[]) {
    expect(send.mock.calls[0][0].content).toContain(MODERATION_RULES[category].label);
  }
  expect(deletion).not.toHaveBeenCalled();
  expect(moderationActions(scores({ selfHarm: 0.69, moderatorHelp: 0.69 })).flagged).toEqual([]);
});

test("hate speech deletion is still attempted when an alert fails", async () => {
  const { msg, deletion } = message();
  msg.guild.channels.fetch = vi.fn(async () => { throw new Error("missing channel"); });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ hate: 0.99 })));
    expect(deletion).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalled();
  } finally {
    errorLog.mockRestore();
  }
});

test("malformed responses never cause an automatic deletion", async () => {
  const { msg, send, deletion } = message();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: { hate: { type: "noul", noul: 1 } } }))) as typeof fetch;
  await expect(handleJevModeration(msg, "logs", "test-key", fetcher)).rejects.toThrow("Missing Jev answer");
  expect(send).not.toHaveBeenCalled();
  expect(deletion).not.toHaveBeenCalled();
});
