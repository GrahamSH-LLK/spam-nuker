import type { Guild, GuildBan } from "discord.js";

import { getRedisClient } from "../redis.js";

const RECENT_ALERTS_TTL_SECONDS = 24 * 60 * 60;
const RECENT_ALERTS_LIMIT = 50;
const BAN_MARKER_TTL_SECONDS = 60;
const BANNED_LABEL = "\n🚫 **User banned**";

function recentAlertsKey(guildId: string, userId: string) {
  return `spam_recent_alerts:${guildId}:${userId}`;
}

function recentBanKey(guildId: string, userId: string) {
  return `spam_recent_ban:${guildId}:${userId}`;
}

async function markAlertBanned(guild: Guild, channelId: string, alertId: string) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased()) return;
  const alert = await channel.messages.fetch(alertId);
  if (!alert.content.includes(BANNED_LABEL)) {
    await alert.edit({ content: `${alert.content}${BANNED_LABEL}`, allowedMentions: { parse: [] } });
  }
}

export async function recordSpamAlert(guild: Guild, userId: string, channelId: string, alertId: string) {
  const redis = getRedisClient();
  const alertsKey = recentAlertsKey(guild.id, userId);
  await redis.lpush(alertsKey, JSON.stringify({ channelId, alertId, createdAt: Date.now() }));
  await redis.ltrim(alertsKey, 0, RECENT_ALERTS_LIMIT - 1);
  await redis.expire(alertsKey, RECENT_ALERTS_TTL_SECONDS);
  // A ban can arrive while the alert is still being sent.
  if (await redis.get(recentBanKey(guild.id, userId))) {
    await markAlertBanned(guild, channelId, alertId);
  }
}

export async function handleSpamBan(ban: GuildBan) {
  const redis = getRedisClient();
  const guildId = ban.guild.id;
  const userId = ban.user.id;
  await redis.set(recentBanKey(guildId, userId), "1", "EX", BAN_MARKER_TTL_SECONDS);
  const alerts = await redis.lrange(recentAlertsKey(guildId, userId), 0, -1);
  for (const entry of alerts) {
    try {
      const { channelId, alertId, createdAt } = JSON.parse(entry) as {
        channelId: string;
        alertId: string;
        createdAt: number;
      };
      if (Date.now() - createdAt > RECENT_ALERTS_TTL_SECONDS * 1000) continue;
      await markAlertBanned(ban.guild, channelId, alertId);
    } catch (error) {
      console.error(`[spam-nuker] Failed to mark a spam alert for banned user ${userId}:`, error);
    }
  }
}

export async function handleSpamUnban(ban: GuildBan) {
  await getRedisClient().del(recentBanKey(ban.guild.id, ban.user.id));
}
