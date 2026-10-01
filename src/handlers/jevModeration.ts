import { ChannelType, escapeMarkdown } from "discord.js";
import type { Message, TextChannel } from "discord.js";

import { getRedisClient } from "../redis.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 10_000;
const JEV_THREAD_NAME = "classifier moderation";
const pendingThreads = new Map<string, Promise<Awaited<ReturnType<TextChannel["threads"]["create"]>>>>();

async function findOrCreateJevThread(logChannel: TextChannel) {
  const redis = getRedisClient();
  const key = `jev_moderation_thread:${logChannel.id}`;
  const threadId = await redis.get(key);
  if (threadId) {
    const thread = await logChannel.threads.fetch(threadId).catch(() => null);
    if (thread && thread.parentId === logChannel.id) {
      if (thread.archived) await thread.setArchived(false);
      return thread;
    }
  }

  const thread = await logChannel.threads.create({
    name: JEV_THREAD_NAME,
    autoArchiveDuration: 1440,
  });
  await redis.set(key, thread.id);
  return thread;
}

function jevThread(logChannel: TextChannel) {
  let pending = pendingThreads.get(logChannel.id);
  if (!pending) {
    pending = findOrCreateJevThread(logChannel);
    pendingThreads.set(logChannel.id, pending);
    void pending.finally(() => pendingThreads.delete(logChannel.id)).catch(() => {});
  }
  return pending;
}

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
  misleadingLink: {
    label: "misleading link",
    threshold: 0.8,
    instructions: "Does this message present a link as belonging to a named service, company, or organization when the actual destination URL points to an unrelated or lookalike domain? Compare the claimed identity in the message, link text, or embed with the URL's hostname.",
    criteria: {
      true: "A link is presented as an official destination, login, offer, or support page for a named entity, but its destination hostname clearly does not belong to that entity and appears intended to mislead readers.",
      false: "No link or no claimed official identity; the destination matches the claimed entity, is a clearly disclosed third-party site, or the message is warning about or discussing a suspicious link rather than promoting it. Do not infer a mismatch when the relationship between the entity and hostname is uncertain.",
    },
  },
  hostility: {
    label: "hostility",
    threshold: 0.9,
    instructions: "Is the author seriously directing abuse, bullying, or intimidation at another participant or identifiable community member? Judge the message's meaning and target, not profanity alone.",
    criteria: {
      true: "A clear personal attack, bullying, or intimidation aimed at a participant or community member.",
      false: "Criticism of ideas, governments, companies, public figures outside the conversation, playful banter, venting, quotations, and profanity without a local target do not count.",
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
  selfHarm: {
    label: "self-harm reference",
    threshold: 0.85,
    instructions: "Does this message convey a genuine concern about suicide or intentional self-injury, including an urge, plan, attempt, encouragement, or request for help? Read the actual sentence in context rather than matching words like 'die', 'jump', or 'hurt'.",
    criteria: {
      true: "A concrete or plausible expression of suicidal or self-injurious intent, an attempt, encouragement, or concern for someone at risk.",
      false: "Figurative frustration, obvious hyperbole or jokes, descriptions of accidental danger, and phrases such as 'I'm dying', 'do that to yourself', or 'danger to themselves' in an unrelated context do not count. A future time reference alone is not evidence of self-harm.",
    },
  },
  alcohol: {
    label: "alcohol reference",
    threshold: 0.85,
    instructions: "Is the message about someone drinking, obtaining, promoting, or being impaired by alcoholic beverages? Mere mention of an alcohol-related word is insufficient.",
    criteria: {
      true: "A meaningful reference to alcohol consumption, access, intoxication, or alcohol-related harm.",
      false: "Passing examples such as 'drinking, voting, driving', a wine company's sponsorship, liquor stores as locations, and figurative uses do not count unless the message actually discusses alcohol use or access.",
    },
  },
  drugs: {
    label: "drug reference",
    threshold: 0.85,
    instructions: "Is the message actually about recreational drugs, medication misuse, drug sales, intoxication, or overdose? Resolve ambiguous words using the surrounding technical or conversational context.",
    criteria: {
      true: "A clear reference to nonmedical drug use, supply, misuse, or overdose, including concern about someone else.",
      false: "Song titles, jokes about a previous classifier result, calculator models such as 30X or 84 Plus CE, robotics joints, OPI robot hardware, software names, and ordinary prescribed treatment do not count. Do not infer drugs from an unfamiliar acronym or product name.",
    },
  },
  otherSubstances: {
    label: "other substance reference",
    threshold: 0.85,
    instructions: "Is the message actually about using or obtaining nicotine, tobacco, vapes, inhalants, or another intoxicating substance? Resolve unfamiliar words in context.",
    criteria: {
      true: "A clear reference to substance use or access, such as someone vaping or intentionally inhaling fumes.",
      false: "Robotics parts (SPARK Flex, SPARK Lite, VRM, VIM, NEO, Vortex), calculator models, VEX prices, chemistry classes, and unrelated commands or abbreviations do not count. An incidental mention of workshop fumes alone does not establish intoxicant use.",
    },
  },
  unwantedBehavior: {
    label: "reported unwanted behavior",
    threshold: 0.85,
    instructions: "Is the author seriously reporting harmful, coercive, or persistent unwanted conduct toward themselves, or asking for help with it? Distinguish a report of mistreatment from an ordinary complaint or hypothetical example.",
    criteria: {
      true: "The author describes credible harassment, coercion, threats, bullying, or repeated boundary violations affecting them.",
      false: "One-off annoyances, joking banter, ordinary disagreement, requests about pings, 'stop reminding me', hypothetical scenarios, and neutral accounts of someone else's conduct do not count. A simple 'go away' or 'don't do that' is not a report by itself.",
    },
  },
  moderatorHelp: {
    label: "moderator assistance requested",
    threshold: 0.85,
    instructions: "Is the author actually asking a moderator or server staff member to take an action? Distinguish a request from a command sent to a bot, discussion of moderation, or the word 'ban' in ordinary conversation.",
    criteria: {
      true: "A direct, current request for a moderator to intervene or take a server action, including a request to pin or post something.",
      false: "Bot commands such as '&ban 123...', questions about ban appeals, and references to moderators or moderation without a request for staff action do not count.",
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
  if (/^\s*&(?:ban|kick|timeout|mute|warn|unban)\b/i.test(message.content)) return false;

  const scores = await assessMessage(message, apiKey, fetcher);
  const { flagged, deleteMessage } = moderationActions(scores);
  if (flagged.length === 0) return false;

  const reasons = flagged.map((category) => `${MODERATION_RULES[category].label} (${scores[category].toFixed(2)})`);
  try {
    const logChannel = await message.guild?.channels.fetch(logChannelId);
    if (logChannel?.type !== ChannelType.GuildText) {
      throw new Error(`Alert channel ${logChannelId} is unavailable`);
    }
    const excerpt = escapeMarkdown(message.content.slice(0, 700).replace(/\s+/g, " "));
    const thread = await jevThread(logChannel);
    await thread.send({
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
