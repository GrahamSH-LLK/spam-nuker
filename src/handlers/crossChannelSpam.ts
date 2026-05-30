import crypto from "node:crypto";

import { getRedisClient } from "../redis.js";
import { applyTimeout } from "./imageSpam.js";

/**
 * Creates a short, stable hash of the message content so we can use it as a
 * Redis key segment without worrying about special characters or key length.
 *
 * @param {string} content
 * @returns {string} 16-character hex digest
 */
export function hashContent(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Checks whether the author of `message` has sent the same content to multiple
 * channels within the configured sliding window.  If the threshold is exceeded,
 * times them out and posts an alert.
 */
export async function handleCrossChannelSpam(
  message: any,
  { threshold, window, timeoutMs, logChannelId }: any,
) {
  const content = message.content.trim();

  const redis = getRedisClient();
  const msgHash = hashContent(content);
  const key = `xch_spam:${message.guild.id}:${message.author.id}:${msgHash}`;
  const channelId = message.channelId;
  const now = Date.now();
  console.log(msgHash);

  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, channelId);
  pipeline.zremrangebyscore(key, "-inf", now - window * 1000);
  pipeline.zcard(key);
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();
  const distinctChannels = results?.[results.length - 2]?.[1] ?? 0; // zcard result

  if (distinctChannels < threshold) return false;

  await redis.del(key);

  return applyTimeout(message, "cross-channel-spam", timeoutMs, logChannelId, {
    detail: `Sent identical message in ${distinctChannels} channel(s) within ${window}s`,
  });
}
