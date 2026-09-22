import { escapeMarkdown } from "discord.js";
import type { Message } from "discord.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 10_000;

export const MODERATION_RULES = {
  hate: {
    label: "hate speech",
    threshold: 0.95,
    instructions: "Does this message itself attack, dehumanize, or advocate hatred or exclusion of people because of a protected identity such as race, ethnicity, religion, nationality, sex, gender identity, sexual orientation, or disability?",
    criteria: {
      true: "The author directs hateful abuse or exclusion at a protected group or a person because of protected identity.",
      false: "No identity-based hateful attack; neutral discussion, quotation, condemnation of hate, and reclaimed language without an attack do not count.",
    },
  },
  scam: {
    label: "scam or phishing",
    threshold: 0.9,
    instructions: "Is this message trying to deceive readers into sending money, credentials, or personal information, or visiting a fraudulent offer or phishing destination?",
    criteria: {
      true: "A deceptive solicitation, impersonation, phishing lure, or fraudulent offer is present.",
      false: "Ordinary promotion, warnings about scams, and legitimate discussion do not count.",
    },
  },
  hostility: {
    label: "hostility",
    threshold: 0.85,
    instructions: "Is this message directly hostile toward another person or group in this conversation?",
    criteria: {
      true: "Direct insults, bullying, intimidation, or sustained antagonism toward a person or group.",
      false: "Civil disagreement, criticism of ideas, joking without a target, and neutral quotation do not count.",
    },
  },
  threats: {
    label: "threat of violence",
    threshold: 0.85,
    instructions: "Does the author threaten physical violence toward a person or group?",
    criteria: {
      true: "A credible or explicit threat of physical harm from the author.",
      false: "No threat; reports, warnings, fiction, and quotations without an author threat do not count.",
    },
  },
  harassment: {
    label: "targeted harassment",
    threshold: 0.85,
    instructions: "Is this message encouraging others to harass, stalk, or dogpile a specific person?",
    criteria: {
      true: "A call to target someone with abuse, unwanted contact, stalking, or coordinated harassment.",
      false: "No call to harass; ordinary criticism or discussion of misconduct does not count.",
    },
  },
  privateInfo: {
    label: "exposed private information",
    threshold: 0.85,
    instructions: "Does this message expose another person's private contact, location, or sensitive identifying information without an apparent legitimate reason?",
    criteria: {
      true: "Another person's nonpublic address, phone, contact, or sensitive identifier is exposed or used to invite targeting.",
      false: "No exposed private information; public business details and one's own volunteered details do not count.",
    },
  },
} as const;

export type ModerationCategory = keyof typeof MODERATION_RULES;
export type ModerationScores = Record<ModerationCategory, number>;

const CATEGORIES = Object.keys(MODERATION_RULES) as ModerationCategory[];

export function moderationActions(scores: ModerationScores) {
  const flagged = CATEGORIES.filter((category) =>
    scores[category] >= MODERATION_RULES[category].threshold,
  );
  return { flagged, deleteMessage: flagged.includes("hate") };
}

function messageState(message: Message) {
  const embeds = message.embeds.map((embed) => ({
    title: embed.title,
    description: embed.description,
    url: embed.url,
  }));
  return {
    content: message.content,
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
    })),
    embeds,
  };
}

function validScores(value: unknown): ModerationScores {
  if (!value || typeof value !== "object") throw new Error("Missing Jev answers");
  const answers = value as Record<string, unknown>;
  const scores = {} as ModerationScores;
  for (const category of CATEGORIES) {
    const answer = answers[category];
    if (!answer || typeof answer !== "object") throw new Error(`Missing Jev answer: ${category}`);
    const { type, noul } = answer as { type?: unknown; noul?: unknown };
    if (type !== "noul" || typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new Error(`Invalid Jev answer: ${category}`);
    }
    scores[category] = noul;
  }
  return scores;
}

export async function assessMessage(
  message: Message,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ModerationScores> {
  const questions = Object.fromEntries(CATEGORIES.map((category) => [category, {
    type: "noul",
    instructions: MODERATION_RULES[category].instructions,
    criteria: MODERATION_RULES[category].criteria,
  }]));
  const response = await fetcher(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, state: messageState(message), questions }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jev request failed: HTTP ${response.status}`);
  const result = await response.json() as { answers?: unknown };
  return validScores(result.answers);
}

export async function handleJevModeration(
  message: Message,
  logChannelId: string | null,
  apiKey = process.env.TYPESAFE_API_KEY,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!apiKey || !logChannelId) return false;
  if (!message.content.trim() && message.embeds.length === 0 && message.attachments.size === 0) return false;

  const scores = await assessMessage(message, apiKey, fetcher);
  const { flagged, deleteMessage } = moderationActions(scores);
  if (flagged.length === 0) return false;

  const reasons = flagged.map((category) => `${MODERATION_RULES[category].label} (${scores[category].toFixed(2)})`);
  try {
    const logChannel = await message.guild?.channels.fetch(logChannelId);
    if (!logChannel?.isTextBased() || !('send' in logChannel)) {
      throw new Error(`Alert channel ${logChannelId} is unavailable`);
    }
    const excerpt = escapeMarkdown(message.content.slice(0, 700).replace(/\s+/g, " "));
    await logChannel.send({
      content: `⚠️ **classifier moderation** | User: <@${message.author.id}> | Channel: <#${message.channelId}> | ${reasons.join(", ")}\nMessage: ${message.url}${excerpt ? `\nExcerpt: ${excerpt}` : ""}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`[spam-nuker] Failed to flag message ${message.id} for moderators:`, error);
  }

  if (deleteMessage) {
    try {
      await message.delete();
    } catch (error) {
      console.error(`[spam-nuker] Failed to delete hate speech message ${message.id}:`, error);
      return true;
    }
  }
  return true;
}
