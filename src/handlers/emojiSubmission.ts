import sharp from "sharp";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  Attachment,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
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
const APPROVE_BUTTON_PREFIX = "spam-nuker:emoji-approve:";
const DENY_BUTTON_PREFIX = "spam-nuker:emoji-deny:";
const REVIEW_LOCK_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Ensures only one moderator's approve/deny click takes effect. */
function reviewLockKey(messageId: string) {
  return `emoji_review:${messageId}`;
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

  const { emojiChannelId, logChannelId } = await getGuildConfig(guildId);
  if (!emojiChannelId || !logChannelId) {
    await interaction.reply({
      content: "Emoji submissions aren't set up on this server yet.",
      ephemeral: true,
    });
    return true;
  }

  const reviewChannel = await fetchSendableChannel(interaction.client, logChannelId);
  if (!reviewChannel) {
    await interaction.reply({
      content: "I can't post in the emoji review channel. Ask a moderator to check its permissions.",
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
  let review: Message | null = null;
  try {
    review = await postForReview(interaction, reviewChannel, attachment, name);
  } finally {
    if (!review) {
      await releaseSubmissionSlot(guildId, interaction.user.id).catch(() => {});
    }
  }
  if (!review) return true;

  await interaction.editReply({
    content: `Submitted \`:${name}:\` for review. If a moderator approves it, it'll be posted in <#${emojiChannelId}> for voting.`,
  });
  return true;
}

async function fetchSendableChannel(client: Client, channelId: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

function emojiFileName(name: string, contentType: string | null) {
  const format = emojiFormat(contentType);
  return `${name}.${format === "jpeg" ? "jpg" : format}`;
}

/**
 * Downloads and compresses the emoji, then posts it in the review channel
 * with approve/deny buttons. Returns null if it can't.
 */
async function postForReview(
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
  const fileName = emojiFileName(name, attachment.contentType);
  const embed = new EmbedBuilder()
    .setTitle(`Emoji submission: :${name}:`)
    .setDescription(`Submitted by <@${interaction.user.id}>`)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();
  const buttonId = `${interaction.user.id}:${name}`;

  return channel.send({
    embeds: [embed],
    files: [{ attachment: image, name: fileName }],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${APPROVE_BUTTON_PREFIX}${buttonId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${DENY_BUTTON_PREFIX}${buttonId}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: NO_MENTIONS,
  });
}

/** Marks the review message as handled and removes its buttons. */
async function closeReview(message: Message, status: string) {
  const embed = EmbedBuilder.from(message.embeds[0]).addFields({
    name: "Status",
    value: status,
  });
  await message.edit({ embeds: [embed], components: [] });
}

/**
 * Handles the approve/deny buttons on emoji review messages. Returns true when
 * the interaction was for one of them.
 */
export async function handleEmojiReviewButton(interaction: ButtonInteraction) {
  const approving = interaction.customId.startsWith(APPROVE_BUTTON_PREFIX);
  if (!approving && !interaction.customId.startsWith(DENY_BUTTON_PREFIX)) {
    return false;
  }

  const guildId = interaction.guildId;
  if (!guildId) return true;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: "You need the Moderate Members permission to review emoji submissions.",
      ephemeral: true,
    });
    return true;
  }

  const prefix = approving ? APPROVE_BUTTON_PREFIX : DENY_BUTTON_PREFIX;
  const [submitterId, name] = interaction.customId.slice(prefix.length).split(":");
  const message = interaction.message;

  const redis = getRedisClient();
  const lockKey = reviewLockKey(message.id);
  if (!(await redis.set(lockKey, interaction.user.id, "PX", REVIEW_LOCK_MS, "NX"))) {
    await interaction.reply({
      content: "This submission has already been reviewed.",
      ephemeral: true,
    });
    return true;
  }

  // Release the lock on failure so another moderator can try again.
  let reviewed = false;
  try {
    if (approving) {
      reviewed = await approveSubmission(interaction, guildId, submitterId, name);
    } else {
      await interaction.deferReply({ ephemeral: true });
      await closeReview(message, `Denied by <@${interaction.user.id}>`);
      await interaction.editReply({ content: `Denied \`:${name}:\`.` });
      reviewed = true;
    }
  } finally {
    if (!reviewed) await redis.del(lockKey).catch(() => {});
  }
  return true;
}

function submissionImageUrl(message: Message | null) {
  return message?.attachments.first()?.url ?? message?.embeds[0]?.image?.url ?? null;
}

async function approveSubmission(
  interaction: ButtonInteraction,
  guildId: string,
  submitterId: string,
  name: string,
) {
  await interaction.deferReply({ ephemeral: true });

  const { emojiChannelId } = await getGuildConfig(guildId);
  const channel = emojiChannelId
    ? await fetchSendableChannel(interaction.client, emojiChannelId)
    : null;
  if (!channel) {
    await interaction.editReply({
      content: "The emoji submission channel isn't set or I can't post in it. Check `/spam-config emoji-channel`.",
    });
    return false;
  }

  // Files referenced by an embed (attachment://) show up as the embed's image
  // rather than in message.attachments.
  // The interaction payload can be partial, so fall back to a fresh fetch.
  const imageUrl =
    submissionImageUrl(interaction.message) ??
    submissionImageUrl(await interaction.message.fetch(true).catch(() => null));
  if (!imageUrl) {
    console.error("[spam-nuker] Emoji review message has no image:", {
      messageId: interaction.message.id,
      attachments: interaction.message.attachments.size,
      embeds: interaction.message.embeds.map((embed) => embed.data),
    });
    await interaction.editReply({ content: "This submission's image is missing." });
    return false;
  }
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download emoji: HTTP ${response.status}`);
  const image = Buffer.from(await response.arrayBuffer());

  // Reuse the extension the review upload was given.
  const extension = new URL(imageUrl).pathname.split(".").pop();
  const fileName = `${name}.${extension}`;
  const embed = new EmbedBuilder()
    .setTitle(`:${name}:`)
    .setDescription(`Submitted by <@${submitterId}>`)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  const submission = await channel.send({
    embeds: [embed],
    files: [{ attachment: image, name: fileName }],
    allowedMentions: NO_MENTIONS,
  });

  try {
    await submission.react("👍");
    await submission.react("👎");
  } catch (err: any) {
    console.error("[spam-nuker] Failed to add emoji vote reactions:", err?.message ?? err);
  }

  // The submission is live from here on, so don't let a failed edit release
  // the lock and allow a second post.
  await closeReview(
    interaction.message,
    `Approved by <@${interaction.user.id}>: ${submission.url}`,
  ).catch((err) =>
    console.error("[spam-nuker] Failed to update emoji review message:", err?.message ?? err),
  );
  await interaction
    .editReply({ content: `Approved \`:${name}:\`: ${submission.url}` })
    .catch(() => {});
  return true;
}
