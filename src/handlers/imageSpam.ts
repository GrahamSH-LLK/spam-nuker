import crypto from "node:crypto";

import { fromRgba } from "@stabilityprotocol.com/phash";
import sharp from "sharp";

import { getRedisClient } from "../redis.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import type { Attachment, ButtonInteraction, Message } from "discord.js";
const DEFAULT_PHASH_DISTANCE = 6;
const STORE_IMAGE_HASH_BUTTON_PREFIX = "spam-nuker:store-img:";
const PENDING_IMAGE_HASH_TTL_SECONDS = 7 * 24 * 60 * 60;

function storedImageHashesKey(guildId: string) {
  return `stored_img_hashes:${guildId}`;
}

function pendingImageHashesKey(token: string) {
  return `pending_img_hashes:${token}`;
}

function uniqueHashes(hashes: string[]) {
  return [...new Set(hashes)];
}

/**
 * Returns true when an attachment is an image.
 *
 * @param {import('discord.js').Attachment} attachment
 * @returns {boolean}
 */
export function isImageAttachment(attachment: Attachment) {
  return Boolean(
    attachment.contentType && attachment.contentType.startsWith("image/"),
  );
}

/**
 * Returns image URLs from attachments and embeds.
 *
 * @param {import('discord.js').Message} message
 * @returns {string[]}
 */
export function getImageUrls(message: Message) {
  const urls = [];

  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment)) urls.push(attachment.url);
  }

  for (const embed of message.embeds) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return urls;
}

/**
 * Computes the Hamming distance between two hex-encoded perceptual hashes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function hammingDistance(a: string, b: string) {
  let distance = Math.abs(a.length - b.length) * 4;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    distance += (Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16))
      .toString(2)
      .replaceAll("0", "").length;
  }

  return distance;
}

/**
 * Downloads an image URL, decodes it into RGBA pixels, and computes a pHash.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function hashImageUrl(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return fromRgba(Uint8ClampedArray.from(data), info.width, info.height);
  } catch (err: any) {
    console.warn(`[spam-nuker] Failed to hash image ${url}:`, err.message);
    return null;
  }
}

export async function storeImageHashes(guildId: string, hashes: string[]) {
  const safeHashes = uniqueHashes(hashes).filter(Boolean);
  if (safeHashes.length === 0) return 0;

  return getRedisClient().sadd(storedImageHashesKey(guildId), safeHashes);
}

export async function findStoredImageHashMatch(
  guildId: string,
  hashes: string[],
  maxDistance = DEFAULT_PHASH_DISTANCE,
) {
  if (hashes.length === 0) return null;

  const storedHashes = await getRedisClient().smembers(
    storedImageHashesKey(guildId),
  );
  for (const hash of hashes) {
    const matchedHash = storedHashes.find(
      (storedHash) => hammingDistance(hash, storedHash) <= maxDistance,
    );
    if (matchedHash) return { hash, matchedHash };
  }

  return null;
}

/**
 * Try to delete messages given channel/message id pairs.
 * @param {import('discord.js').Guild | null | undefined} guild
 * @param {{channelId: string, messageId: string}[]} entries
 */
export async function deleteMessages(guild: any, entries: { channelId: string; messageId: string }[]) {
  if (!guild) return;

  // dedupe by channel+message
  const seen = new Set();
  for (const { channelId, messageId } of entries) {
    const key = `${channelId}:${messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      let channel = guild.channels.cache.get(channelId);
      if (!channel) {
        channel = await guild.channels.fetch(channelId).catch(() => null);
      }
      if (!channel || !channel.isTextBased || !channel.isTextBased()) continue;

      const fetched = await channel.messages.fetch(messageId).catch(() => null);
      if (fetched) {
        await fetched.delete().catch((err: any) => {
          console.warn(`[spam-nuker] Failed to delete message ${messageId} in ${channelId}:`, err?.message ?? err);
        });
      }
    } catch (err: any) {
      console.warn("[spam-nuker] deleteMessages error:", err?.message ?? err);
    }
  }
}

/**
 * Checks whether the author of `message` has sent the same image across
 * multiple channels within the configured sliding window.
 *
 * @param {import('discord.js').Message} message
 * @param {object} options
 * @param {number} options.imageThreshold    Number of images that trigger the rule
 * @param {number} options.channelThreshold  Number of distinct channels required
 * @param {number} [options.maxDistance]     Max pHash Hamming distance to match
 * @param {number} options.window            Window length in seconds
 * @param {number} options.timeoutMs         Timeout duration in milliseconds
 * @param {string|null} options.logChannelId Optional alert channel ID
 * @returns {Promise<boolean>} true if the user was timed out
 */
export async function handleCrossChannelImageSpam(
  message: Message,
  {
    imageThreshold,
    channelThreshold,
    maxDistance = DEFAULT_PHASH_DISTANCE,
    window,
    timeoutMs,
    logChannelId,
  }: {
    imageThreshold: number;
    channelThreshold: number;
    maxDistance?: number;
    window: number;
    timeoutMs: number;
    logChannelId: string | null;
  },
) {
  if (!message.guild) return false;

  const imageUrls = getImageUrls(message);
  if (imageUrls.length === 0) return false;

  const hashes = (
    await Promise.all(imageUrls.map((url) => hashImageUrl(url)))
  ).filter((x): x is string => !!x && x !== null);
  if (hashes.length === 0) return false;

  const storedMatch = await findStoredImageHashMatch(
    message.guild.id,
    hashes,
    maxDistance,
  );
  if (storedMatch) {
    await deleteMessages(message.guild, [
      { channelId: message.channelId, messageId: message.id },
    ]);

    return applyTimeout(
      message,
      "stored-image-hash",
      timeoutMs,
      logChannelId,
      {
        detail: `Sent image matching stored hash (pHash distance <= ${maxDistance})`,
      },
    );
  }

  const redis = getRedisClient();
  const key = `xch_img_spam:${message.guild.id}:${message.author.id}`;
  const now = Date.now();

  const pipeline = redis.pipeline();
  for (let i = 0; i < hashes.length; i++) {
    pipeline.zadd(
      key,
      now,
      `${message.channelId}:${message.id}:${hashes[i]}:${now}:${i}:${crypto.randomBytes(8).toString("hex")}`,
    );
  }
  pipeline.zremrangebyscore(key, "-inf", now - window * 1000);
  pipeline.zrange(key, 0, -1);
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();
  if (!results) return false;

  const members: string[] = results[results.length - 2][1] as string[]; // zrange result
  if (!members) return false;
  const entries = members.map((member) => {
    const parts = member.split(":");
    const channelId = parts[0];
    const messageId = parts[1];
    const hash = parts[2];
    return { channelId, messageId, hash };
  });

  for (const hash of hashes) {
    const matches = entries.filter(
      (entry) => hammingDistance(hash, entry.hash) <= maxDistance,
    );
    const distinctChannels = new Set(matches.map((entry) => entry.channelId))
      .size;

    if (
      matches.length >= imageThreshold &&
      distinctChannels >= channelThreshold
    ) {
      await redis.del(key);

      // delete matching messages including the first ones (best-effort)
      try {
        await deleteMessages(message.guild, matches.map((m) => ({
          channelId: m.channelId,
          messageId: m.messageId,
        })));
      } catch (err: any) {
        console.warn("[spam-nuker] Failed to delete some messages:", err?.message ?? err);
      }

      return applyTimeout(
        message,
        "cross-channel-image-spam",
        timeoutMs,
        logChannelId,
        {
          detail:
            `Sent matching image in ${distinctChannels} channel(s) within ${window}s ` +
            `(pHash distance <= ${maxDistance})`,
          imageHashes: hashes,
        },
      );
    }
  }

  return false;
}

/**
 * Applies a timeout to the message author and optionally posts an alert.
 *
 * @param {import('discord.js').Message} message
 * @param {string} reason
 * @param {number} timeoutMs
 * @param {string|null} logChannelId
 * @param {{detail?: string, imageHashes?: string[]}} [extra]
 * @returns {Promise<boolean>}
 */
export async function applyTimeout(
  message: Message,
  reason: string,
  timeoutMs: number,
  logChannelId: string | null,
  extra: { detail?: string; imageHashes?: string[] } = {},
) {
  const member = message.member;
  if (!member || !member.moderatable) return false;

  try {
    await member.timeout(
      timeoutMs,
      `[spam-nuker] ${reason}: ${extra.detail ?? ""}`,
    );
    console.log(
      `[spam-nuker] Timed out ${message.author.tag} (${message.author.id}) in ${message?.guild?.name} — reason: ${reason}`,
    );

    if (logChannelId) {
      const logChannel = message.guild?.channels.cache.get(logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        const components = [];
        const imageHashes = uniqueHashes(extra.imageHashes ?? []);

        if (message.guild && imageHashes.length > 0) {
          const token = crypto.randomBytes(16).toString("hex");
          await getRedisClient().set(
            pendingImageHashesKey(token),
            JSON.stringify({
              guildId: message.guild.id,
              hashes: imageHashes,
            }),
            "EX",
            PENDING_IMAGE_HASH_TTL_SECONDS,
          );

          components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`${STORE_IMAGE_HASH_BUTTON_PREFIX}${token}`)
                .setLabel("Automatically moderate all matching images in the future")
                .setStyle(ButtonStyle.Danger),
            ),
          );
        }

        await logChannel.send({
          content:
            `⚠️ **Spam detected** | User: <@${message.author.id}> (\`${message.author.tag}\`) | ` +
            `Reason: \`${reason}\` | ${extra.detail ?? ""} | ` +
            `Timed out for ${timeoutMs / 1000}s`,
          components,
        });
      }
    }
    return true;
  } catch (err: any) {
    console.error(
      `[spam-nuker] Failed to timeout ${message.author.tag}:`,
      err.message,
    );
    return false;
  }
}

export async function handleStoreImageHashesButton(
  interaction: ButtonInteraction,
) {
  if (!interaction.customId.startsWith(STORE_IMAGE_HASH_BUTTON_PREFIX)) {
    return false;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: "Image hashes can only be stored from a server log message.",
      ephemeral: true,
    });
    return true;
  }

  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
  ) {
    await interaction.reply({
      content: "You need the Moderate Members permission to store image hashes.",
      ephemeral: true,
    });
    return true;
  }

  const token = interaction.customId.slice(STORE_IMAGE_HASH_BUTTON_PREFIX.length);
  const redis = getRedisClient();
  const pending = await redis.get(pendingImageHashesKey(token));
  if (!pending) {
    await interaction.reply({
      content: "These image hashes are no longer available to store.",
      ephemeral: true,
    });
    return true;
  }

  let payload: { guildId?: string; hashes?: unknown };
  try {
    payload = JSON.parse(pending);
  } catch {
    await interaction.reply({
      content: "These image hashes could not be read.",
      ephemeral: true,
    });
    return true;
  }

  if (
    payload.guildId !== interaction.guildId ||
    !Array.isArray(payload.hashes)
  ) {
    await interaction.reply({
      content: "These image hashes do not belong to this server.",
      ephemeral: true,
    });
    return true;
  }

  const hashes = payload.hashes.filter(
    (hash): hash is string => typeof hash === "string" && hash.length > 0,
  );
  const added = await storeImageHashes(interaction.guildId, hashes);
  await redis.del(pendingImageHashesKey(token));

  await interaction.reply({
    content:
      added === 0
        ? "Those image hashes were already stored."
        : `Stored ${added} image hash(es). Future matching images will time out automatically.`,
    ephemeral: true,
  });

  return true;
}
