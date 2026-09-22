import { expect, test, vi } from "vitest";

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
  const deletion = vi.fn(async () => undefined);
  const msg = {
    content: "example message",
    embeds: [],
    attachments: new Map(),
    author: { id: "user-1" },
    channelId: "channel-1",
    id: "message-1",
    url: "https://discord.com/channels/guild-1/channel-1/message-1",
    guild: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) } },
    delete: deletion,
  } as any;
  return { msg, send, deletion };
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
  expect(moderationActions(scores({ hate: 0.94 })).deleteMessage).toBe(false);
  expect(moderationActions(scores({ hate: 0.95 })).deleteMessage).toBe(true);
  const { msg, send, deletion } = message();
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ hate: 0.98, scam: 0.94 })));
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].content).toContain("hate speech (0.98)");
  expect(send.mock.calls[0][0].content).toContain("scam or phishing (0.94)");
  expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  expect(deletion).toHaveBeenCalledOnce();
});

test("scams and hostility flag without deleting", async () => {
  const { msg, send, deletion } = message();
  await handleJevModeration(msg, "logs", "test-key", fetchWithScores(scores({ scam: 0.93, hostility: 0.9 })));
  expect(send).toHaveBeenCalledOnce();
  expect(deletion).not.toHaveBeenCalled();
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
