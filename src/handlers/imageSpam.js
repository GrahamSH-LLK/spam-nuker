import crypto from 'node:crypto';

import { fromRgba } from '@stabilityprotocol.com/phash';
import sharp from 'sharp';

import { getRedisClient } from '../redis.js';

// Domains that belong to Discord's own CDN – images from these are NOT "external"
const DISCORD_DOMAINS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net',
  'discord.com',
]);
const DEFAULT_PHASH_DISTANCE = 6;

/**
 * Returns true when `url` should count as "external" for image-spam checks.
 * Discord CDN URLs are treated as internal; CDN path IDs are not reliable
 * server identifiers.
 * @param {string} url
 * @returns {boolean}
 */
export function isExternalImageUrl(url) {
  try {
    const parsed = new URL(url);
    return !DISCORD_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Counts the number of external-domain images contained in a message
 * (attachments whose content type starts with "image/" and embed thumbnails /
 * images whose URLs resolve to an external host).
 *
 * @param {import('discord.js').Message} message
 * @returns {number}
 */
export function countExternalImages(message) {
  let count = 0;
  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment) && isExternalImageUrl(attachment.url)) {
      count++;
    }
  }

  for (const embed of message.embeds) {
    if (embed.image && isExternalImageUrl(embed.image.url)) count++;
    if (embed.thumbnail && isExternalImageUrl(embed.thumbnail.url)) count++;
  }

  return count;
}

/**
 * Returns true when an attachment is an image.
 *
 * @param {import('discord.js').Attachment} attachment
 * @returns {boolean}
 */
export function isImageAttachment(attachment) {
  return Boolean(attachment.contentType && attachment.contentType.startsWith('image/'));
}

/**
 * Counts all images contained in a message, regardless of where Discord hosts
 * them. This is intentionally broader than `countExternalImages`.
 *
 * @param {import('discord.js').Message} message
 * @returns {number}
 */
export function countImages(message) {
  return getImageUrls(message).length;
}

/**
 * Returns image URLs from attachments and embeds.
 *
 * @param {import('discord.js').Message} message
 * @returns {string[]}
 */
export function getImageUrls(message) {
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
export function hammingDistance(a, b) {
  let distance = Math.abs(a.length - b.length) * 4;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    distance += (Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16))
      .toString(2)
      .replaceAll('0', '').length;
  }

  return distance;
}

/**
 * Downloads an image URL, decodes it into RGBA pixels, and computes a pHash.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function hashImageUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return fromRgba(data, info.width, info.height);
  } catch (err) {
    console.warn(`[spam-nuker] Failed to hash image ${url}:`, err.message);
    return null;
  }
}

/**
 * Checks whether the author of `message` has exceeded the external-image
 * threshold in the configured sliding window.  If they have, times them out
 * and posts an alert.
 *
 * @param {import('discord.js').Message} message
 * @param {object} options
 * @param {number} options.threshold  Max external images allowed in the window
 * @param {number} options.window     Window length in seconds
 * @param {number} options.timeoutMs  Timeout duration in milliseconds
 * @param {string|null} options.logChannelId  Optional alert channel ID
 * @returns {Promise<boolean>} true if the user was timed out
 */
export async function handleImageSpam(message, { threshold, window, timeoutMs, logChannelId }) {
  const externalCount = countExternalImages(message);
  if (externalCount === 0) return false;

  const redis = getRedisClient();
  const key = `img_spam:${message.guild.id}:${message.author.id}`;
  const now = Date.now();

  // Each entry is a timestamp stored in a sorted set; score = timestamp (ms)
  const pipeline = redis.pipeline();
  // Add `externalCount` entries with the current timestamp as both score and member
  // Use a unique member to avoid deduplication: `<timestamp>:<random>`
  for (let i = 0; i < externalCount; i++) {
    pipeline.zadd(key, now, `${now}:${i}:${crypto.randomBytes(8).toString('hex')}`);
  }
  // Remove entries older than the window
  pipeline.zremrangebyscore(key, '-inf', now - window * 1000);
  // Count remaining entries
  pipeline.zcard(key);
  // Refresh TTL so the key expires naturally
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();

  const total = results[results.length - 2][1]; // zcard result

  if (total < threshold) return false;

  // Delete the tracking key so the user gets a clean slate after the timeout
  await redis.del(key);

  return applyTimeout(message, 'image-spam', timeoutMs, logChannelId, {
    detail: `Sent ${total} external image(s) within ${window}s`,
  });
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
  message,
  {
    imageThreshold,
    channelThreshold,
    maxDistance = DEFAULT_PHASH_DISTANCE,
    window,
    timeoutMs,
    logChannelId,
  },
) {
  const imageUrls = getImageUrls(message);
  if (imageUrls.length === 0) return false;

  const hashes = (await Promise.all(imageUrls.map((url) => hashImageUrl(url)))).filter(Boolean);
  if (hashes.length === 0) return false;

  const redis = getRedisClient();
  const key = `xch_img_spam:${message.guild.id}:${message.author.id}`;
  const now = Date.now();

  const pipeline = redis.pipeline();
  for (let i = 0; i < hashes.length; i++) {
    pipeline.zadd(
      key,
      now,
      `${message.channelId}:${hashes[i]}:${now}:${i}:${crypto.randomBytes(8).toString('hex')}`,
    );
  }
  pipeline.zremrangebyscore(key, '-inf', now - window * 1000);
  pipeline.zrange(key, 0, -1);
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();

  const members = results[results.length - 2][1];
  const entries = members.map((member) => {
    const [channelId, hash] = member.split(':', 2);
    return { channelId, hash };
  });

  for (const hash of hashes) {
    const matches = entries.filter((entry) => hammingDistance(hash, entry.hash) <= maxDistance);
    const distinctChannels = new Set(matches.map((entry) => entry.channelId)).size;

    if (matches.length >= imageThreshold && distinctChannels >= channelThreshold) {
      await redis.del(key);

      return applyTimeout(message, 'cross-channel-image-spam', timeoutMs, logChannelId, {
        detail:
          `Sent matching image in ${distinctChannels} channel(s) within ${window}s ` +
          `(pHash distance <= ${maxDistance})`,
      });
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
 * @param {{detail?: string}} [extra]
 * @returns {Promise<boolean>}
 */
export async function applyTimeout(message, reason, timeoutMs, logChannelId, extra = {}) {
  const member = message.member;
  if (!member || !member.moderatable) return false;

  try {
    await member.timeout(timeoutMs, `[spam-nuker] ${reason}: ${extra.detail ?? ''}`);
    console.log(
      `[spam-nuker] Timed out ${message.author.tag} (${message.author.id}) in ${message.guild.name} — reason: ${reason}`,
    );

    if (logChannelId) {
      const logChannel = message.guild.channels.cache.get(logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel.send(
          `⚠️ **Spam detected** | User: <@${message.author.id}> (\`${message.author.tag}\`) | ` +
            `Reason: \`${reason}\` | ${extra.detail ?? ''} | ` +
            `Timed out for ${timeoutMs / 1000}s`,
        );
      }
    }
    return true;
  } catch (err) {
    console.error(`[spam-nuker] Failed to timeout ${message.author.tag}:`, err.message);
    return false;
  }
}
