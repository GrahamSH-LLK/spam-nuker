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
  selfHarm: {
    label: "self-harm reference",
    threshold: 0.7,
    instructions: "Does this message mention or suggest suicide, self-injury, an urge or plan to hurt oneself, or concern that someone may hurt themselves?",
    criteria: {
      true: "Any direct or indirect reference to self-harm, suicidal thoughts, an attempt, encouragement, or concern about someone at risk; a request for help also counts.",
      false: "No reference to self-harm or suicide; sadness or frustration alone does not count.",
    },
  },
  alcohol: {
    label: "alcohol reference",
    threshold: 0.7,
    instructions: "Does this message mention or suggest drinking alcohol, being drunk, alcohol misuse, or obtaining alcoholic drinks?",
    criteria: {
      true: "A literal reference to alcoholic drinks, drinking, intoxication, or alcohol-related harm, including casual mentions.",
      false: "No literal alcohol reference; unrelated uses of words such as 'drunk' as a metaphor do not count.",
    },
  },
  drugs: {
    label: "drug reference",
    threshold: 0.7,
    instructions: "Does this message mention or suggest recreational drugs, misuse of medication, drug sales, intoxication, or overdose?",
    criteria: {
      true: "A literal reference to nonmedical drug use, drug supply, substance misuse, or overdose, including concern about someone else.",
      false: "No such drug reference; routine discussion of prescribed treatment used as directed does not count.",
    },
  },
  otherSubstances: {
    label: "other substance reference",
    threshold: 0.7,
    instructions: "Does this message mention or suggest using or obtaining nicotine, tobacco, vapes, inhalants, or another intoxicating substance not covered by alcohol or recreational drugs?",
    criteria: {
      true: "A literal reference to smoking, vaping, nicotine, tobacco, inhalant use, or another intoxicating substance, including casual mentions or concern about someone else.",
      false: "No such substance reference; unrelated uses of words like 'smoke' or 'vape' do not count.",
    },
  },
  unwantedBehavior: {
    label: "reported unwanted behavior",
    threshold: 0.7,
    instructions: "Does the author say or imply that someone else is doing something unwanted to them or crossing their boundaries?",
    criteria: {
      true: "The author reports, hints at, or asks for help with another person's unwanted contact, conduct, tone, harassment, stalking, coercion, threats, bullying, or sexual attention toward them.",
      false: "No unwanted behavior toward the author is described or implied; ordinary disagreement without a boundary concern does not count.",
    },
  },
  moderatorHelp: {
    label: "moderator assistance requested",
    threshold: 0.7,
    instructions: "Is the author explicitly or implicitly asking for a moderator or server staff member to step in?",
    criteria: {
      true: "A direct request for a mod or staff member, a request to report or enforce server rules, or a contextual appeal for someone in authority to handle a problem.",
      false: "No request for moderator intervention; merely mentioning a moderator or discussing moderation in general does not count.",
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
