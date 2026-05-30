import crypto from "node:crypto";

import { getRedisClient } from "../redis.js";
import { applyTimeout, deleteMessages } from "./imageSpam.js";

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

  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, `${channelId}:${message.id}`);
  pipeline.zremrangebyscore(key, "-inf", now - window * 1000);
  pipeline.zrange(key, 0, -1);
  pipeline.expire(key, window * 2);
  const results = await pipeline.exec();
  const members = (results?.[results.length - 2]?.[1] as string[]) ?? [];

  if (members.length === 0) return false;

  const entries = members.map((m) => {
    const [chan, msgId] = (m as string).split(":", 2);
    return { channelId: chan, messageId: msgId };
  });

  const distinctChannels = new Set(entries.map((e) => e.channelId)).size;
  if (distinctChannels < threshold) return false;

  await redis.del(key);

  // try to delete matching all spam messages in the chain
  try {
    await deleteMessages(message.guild, entries);
  } catch (err: any) {
    console.warn("[spam-nuker] Failed to delete some messages:", err?.message ?? err);
  }

  return applyTimeout(message, "cross-channel-spam", timeoutMs, logChannelId, {
    detail: `Sent identical message in ${distinctChannels} channel(s) within ${window}s`,
  });
}

