'use strict';

const crypto = require('crypto');
const { getRedisClient } = require('../redis');

// Domains that belong to Discord's own CDN – images from these are NOT "external"
const DISCORD_DOMAINS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net',
  'discord.com',
]);

/**
 * Returns true when `url` should count as "external" for image-spam checks.
 * Discord CDN URLs are usually internal, except when they include an
 * `/attachments/<serverId>/...` path where `serverId` does not match `guildId`.
 * @param {string} url
 * @param {string|null} [guildId]
 * @returns {boolean}
 */
function isExternalImageUrl(url, guildId = null) {
  try {
    const parsed = new URL(url);
    const { hostname, pathname } = parsed;
    if (!DISCORD_DOMAINS.has(hostname)) return true;

    if (!guildId) return false;

    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'attachments' || parts.length < 2) return false;

    const serverId = parts[1];
    if (!/^\d+$/.test(serverId)) return false;

    return serverId !== String(guildId);
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
function countExternalImages(message) {
  let count = 0;
  const guildId = message.guild?.id ?? null;

  for (const attachment of message.attachments.values()) {
    if (
      attachment.contentType &&
      attachment.contentType.startsWith('image/') &&
      isExternalImageUrl(attachment.url, guildId)
    ) {
      count++;
    }
  }

  for (const embed of message.embeds) {
    if (embed.image && isExternalImageUrl(embed.image.url, guildId)) count++;
    if (embed.thumbnail && isExternalImageUrl(embed.thumbnail.url, guildId)) count++;
  }

  return count;
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
async function handleImageSpam(message, { threshold, window, timeoutMs, logChannelId }) {
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
 * Applies a timeout to the message author and optionally posts an alert.
 *
 * @param {import('discord.js').Message} message
 * @param {string} reason
 * @param {number} timeoutMs
 * @param {string|null} logChannelId
 * @param {{detail?: string}} [extra]
 * @returns {Promise<boolean>}
 */
async function applyTimeout(message, reason, timeoutMs, logChannelId, extra = {}) {
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

module.exports = { handleImageSpam, applyTimeout, isExternalImageUrl, countExternalImages };
