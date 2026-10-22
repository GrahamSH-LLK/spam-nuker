import sharp from "sharp";
import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";
import type {
  Attachment,
  ChatInputCommandInteraction,
  Message,
  SendableChannels,
} from "discord.js";

import { getGuildConfig } from "../config.js";
import { getRedisClient } from "../redis.js";

export const EMOJI_SUBMIT_COMMAND_NAME = "submit-emoji";

/** Discord's upload limit for custom emoji. */
export const MAX_EMOJI_BYTES = 256 * 1024;
/** Largest upload we'll try to compress down to the emoji limit. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const FORMATS: Record<string, EmojiFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};
/** Bounding boxes to try, largest first. Discord shows emoji at up to 128px. */
const COMPRESSION_SIZES = [256, 128, 96, 64];
const COMPRESSION_QUALITIES = [80, 60, 40];
/** How many emoji each member may submit per server. */
export const MAX_SUBMISSIONS_PER_USER = 2;
const NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;
const NO_MENTIONS = { parse: [] as [] };

type EmojiFormat = "png" | "jpeg" | "gif" | "webp";

export const emojiSubmitCommand = new SlashCommandBuilder()
  .setName(EMOJI_SUBMIT_COMMAND_NAME)
  .setDescription("Submit an emoji for the server to vote on")
  .setContexts(InteractionContextType.Guild)
  .addAttachmentOption((opt) =>
    opt
      .setName("image")
      .setDescription("PNG, JPEG, GIF or WebP (shrunk to 256 KB if larger)")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("Emoji name (2-32 letters, numbers or underscores)")
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(32),
  );

/** Returns an error message when the attachment can't be used as an emoji. */
export function validateEmojiSubmission(
  attachment: Pick<Attachment, "contentType" | "size">,
  name: string,
): string | null {
  if (!NAME_PATTERN.test(name)) {
    return "Emoji names must be 2-32 characters of letters, numbers or underscores.";
  }
  if (!emojiFormat(attachment.contentType)) {
    return "Emoji must be a PNG, JPEG, GIF or WebP image.";
  }
  if (attachment.size > MAX_UPLOAD_BYTES) {
    return "Emoji images must be 8 MB or smaller.";
  }
  return null;
}

function emojiFormat(contentType: string | null): EmojiFormat | null {
  return FORMATS[contentType?.split(";")[0].trim() ?? ""] ?? null;
}

function encode(image: sharp.Sharp, format: EmojiFormat, step: number) {
  const quality = COMPRESSION_QUALITIES[step];
  switch (format) {
    case "png":
      return image.png({ palette: true, quality, compressionLevel: 9, effort: 10 });
    case "jpeg":
      return image.jpeg({ quality, mozjpeg: true });
    case "webp":
      return image.webp({ quality, effort: 6 });
    case "gif":
      return image.gif({ colours: 128 >> step, effort: 10 });
  }
}

/**
 * Shrinks an image to fit Discord's emoji size limit, keeping its format (and
 * animation). Returns the original buffer when it already fits, or null when
 * it can't be made small enough.
 */
export async function compressEmoji(
  input: Buffer,
  contentType: string | null,
): Promise<Buffer | null> {
  if (input.length <= MAX_EMOJI_BYTES) return input;
  const format = emojiFormat(contentType);
  if (!format) return null;

  for (const size of COMPRESSION_SIZES) {
    for (let step = 0; step < COMPRESSION_QUALITIES.length; step++) {
      const image = sharp(input, { animated: true }).resize(size, size, {
        fit: "inside",
        withoutEnlargement: true,
      });
      const output = await encode(image, format, step).toBuffer();
      if (output.length <= MAX_EMOJI_BYTES) return output;
    }
  }
  return null;
}

function submissionCountKey(guildId: string, userId: string) {
  return `emoji_submissions:${guildId}:${userId}`;
}

/**
 * Atomically claims one of the member's submission slots. Returns false when
 * they have none left.
 */
async function claimSubmissionSlot(guildId: string, userId: string) {
  const redis = getRedisClient();
  const key = submissionCountKey(guildId, userId);
  const count = await redis.incr(key);
  if (count <= MAX_SUBMISSIONS_PER_USER) return true;
  await redis.decr(key);
  return false;
}

async function releaseSubmissionSlot(guildId: string, userId: string) {
  await getRedisClient().decr(submissionCountKey(guildId, userId));
}

/**
 * Handles /submit-emoji. Returns true when the interaction was for this
 * command (whether or not it succeeded).
 */
export async function handleEmojiSubmitCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (interaction.commandName !== EMOJI_SUBMIT_COMMAND_NAME) return false;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return true;
  }

  const attachment = interaction.options.getAttachment("image", true);
  const name = interaction.options.getString("name", true);

  const error = validateEmojiSubmission(attachment, name);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return true;
  }

  const { emojiChannelId } = await getGuildConfig(guildId);
  if (!emojiChannelId) {
    await interaction.reply({
      content: "Emoji submissions aren't set up on this server yet.",
      ephemeral: true,
    });
    return true;
  }

  const channel = await interaction.client.channels
    .fetch(emojiChannelId)
    .catch(() => null);
  if (!channel?.isSendable()) {
    await interaction.reply({
      content: "I can't post in the emoji submission channel. Ask a moderator to check its permissions.",
      ephemeral: true,
    });
    return true;
  }

  if (!(await claimSubmissionSlot(guildId, interaction.user.id))) {
    await interaction.reply({
      content: `You've already used all ${MAX_SUBMISSIONS_PER_USER} of your emoji submissions.`,
      ephemeral: true,
    });
    return true;
  }

  // Hand the slot back if we don't end up posting, so failures don't count.
  let submission: Message | null = null;
  try {
    submission = await postSubmission(interaction, channel, attachment, name);
  } finally {
    if (!submission) {
      await releaseSubmissionSlot(guildId, interaction.user.id).catch(() => {});
    }
  }
  if (!submission) return true;

  try {
    await submission.react("👍");
    await submission.react("👎");
  } catch (err: any) {
    console.error("[spam-nuker] Failed to add emoji vote reactions:", err?.message ?? err);
  }

  await interaction.editReply({
    content: `Submitted \`:${name}:\` for voting: ${submission.url}`,
  });
  return true;
}

/** Downloads, compresses and posts the emoji. Returns null if it can't. */
async function postSubmission(
  interaction: ChatInputCommandInteraction,
  channel: SendableChannels,
  attachment: Attachment,
  name: string,
) {
  await interaction.deferReply({ ephemeral: true });

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Failed to download emoji: HTTP ${response.status}`);
  const image = await compressEmoji(
    Buffer.from(await response.arrayBuffer()),
    attachment.contentType,
  );
  if (!image) {
    await interaction.editReply({
      content: "I couldn't shrink that image to 256 KB. Try a smaller or simpler one.",
    });
    return null;
  }

  // Upload the file rather than linking the interaction attachment, whose CDN
  // URL expires.
  const format = emojiFormat(attachment.contentType);
  const fileName = `${name}.${format === "jpeg" ? "jpg" : format}`;
  const embed = new EmbedBuilder()
    .setTitle(`:${name}:`)
    .setDescription(`Submitted by <@${interaction.user.id}>`)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  return channel.send({
    embeds: [embed],
    files: [{ attachment: image, name: fileName }],
    allowedMentions: NO_MENTIONS,
  });
}
