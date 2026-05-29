'use strict';

const crypto = require('crypto');
const { getRedisClient } = require('../redis');
const { applyTimeout } = require('./imageSpam');

/**
 * Creates a short, stable hash of the message content so we can use it as a
 * Redis key segment without worrying about special characters or key length.
 *
 * @param {string} content
 * @returns {string} 16-character hex digest
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Checks whether the author of `message` has sent the same content to multiple
 * channels within the configured sliding window.  If the threshold is exceeded,
 * times them out and posts an alert.
 *
 * @param {import('discord.js').Message} message
 * @param {object} options
 * @param {number} options.threshold     Number of distinct channels that trigger the rule
 * @param {number} options.window        Window length in seconds
 * @param {number} options.timeoutMs     Timeout duration in milliseconds
 * @param {string|null} options.logChannelId  Optional alert channel ID
 * @returns {Promise<boolean>} true if the user was timed out
 */
async function handleCrossChannelSpam(message, { threshold, window, timeoutMs, logChannelId }) {
  const content = message.content.trim();
  // Ignore very short or empty messages (reactions, single-word greetings, etc.)
  if (content.length < 5) return false;

  const redis = getRedisClient();
  const msgHash = hashContent(content);
  const key = `xch_spam:${message.guild.id}:${message.author.id}:${msgHash}`;
  const channelId = message.channelId;
  const now = Date.now();

  // Store the channel ID as a member with the current timestamp as score.
  // Using the channelId as the member means each channel is only counted once
  // per hash (we overwrite the score if the user re-posts there, which keeps
  // the most-recent timestamp for that channel).
  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, channelId);
  // Remove entries outside the window
  pipeline.zremrangebyscore(key, '-inf', now - window * 1000);
  // Count distinct channels within the window
  pipeline.zcard(key);
  // Refresh TTL
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();

  const distinctChannels = results[results.length - 2][1]; // zcard result

  if (distinctChannels < threshold) return false;

  // Reset the tracking key
  await redis.del(key);

  return applyTimeout(message, 'cross-channel-spam', timeoutMs, logChannelId, {
    detail: `Sent identical message in ${distinctChannels} channel(s) within ${window}s`,
  });
}

module.exports = { handleCrossChannelSpam, hashContent };
