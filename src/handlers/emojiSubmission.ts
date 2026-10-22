import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { Attachment, ChatInputCommandInteraction } from "discord.js";

import { getGuildConfig } from "../config.js";
import { getRedisClient } from "../redis.js";

export const EMOJI_SUBMIT_COMMAND_NAME = "submit-emoji";

/** Discord's upload limit for custom emoji. */
export const MAX_EMOJI_BYTES = 256 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** How many emoji each member may submit per server. */
export const MAX_SUBMISSIONS_PER_USER = 2;
const NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;
const NO_MENTIONS = { parse: [] as [] };

export const emojiSubmitCommand = new SlashCommandBuilder()
  .setName(EMOJI_SUBMIT_COMMAND_NAME)
  .setDescription("Submit an emoji for the server to vote on")
  .setContexts(InteractionContextType.Guild)
  .addAttachmentOption((opt) =>
    opt
      .setName("image")
      .setDescription("PNG, JPEG, GIF or WebP, up to 256 KB")
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
  const contentType = attachment.contentType?.split(";")[0].trim();
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return "Emoji must be a PNG, JPEG, GIF or WebP image.";
  }
  if (attachment.size > MAX_EMOJI_BYTES) {
    return "Emoji images must be 256 KB or smaller.";
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

  await interaction.deferReply({ ephemeral: true });

  // Re-upload the file rather than linking the interaction attachment, whose
  // CDN URL expires.
  const extension = attachment.name.split(".").pop() ?? "png";
  const fileName = `${name}.${extension}`;
  const embed = new EmbedBuilder()
    .setTitle(`:${name}:`)
    .setDescription(`Submitted by <@${interaction.user.id}>`)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  let submission;
  try {
    submission = await channel.send({
      embeds: [embed],
      files: [{ attachment: attachment.url, name: fileName }],
      allowedMentions: NO_MENTIONS,
    });
  } catch (err) {
    // Give the slot back so a failed post doesn't count against them.
    await releaseSubmissionSlot(guildId, interaction.user.id).catch(() => {});
    throw err;
  }

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
