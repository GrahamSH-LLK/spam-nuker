import { getRedisClient } from "./redis.js";

export interface GuildConfig {
  timeoutDuration: number;
  imageThreshold: number;
  imageChannelThreshold: number;
  imageMaxDistance: number;
  imageWindow: number;
  messageThreshold: number;
  messageWindow: number;
  logChannelId: string | null;
}

export type NumericConfigKey = Exclude<keyof GuildConfig, "logChannelId">;

export interface NumericSetting {
  key: NumericConfigKey;
  /** Value used in slash-command choices, e.g. `image-threshold`. */
  choice: string;
  description: string;
  min: number;
  max?: number;
  unit?: string;
}

export const NUMERIC_SETTINGS: NumericSetting[] = [
  {
    key: "timeoutDuration",
    choice: "timeout-duration",
    description: "Timeout length in seconds",
    min: 1,
    max: 28 * 24 * 60 * 60, // Discord's maximum timeout is 28 days
    unit: "s",
  },
  {
    key: "imageThreshold",
    choice: "image-threshold",
    description: "Matching images before flagging",
    min: 1,
  },
  {
    key: "imageChannelThreshold",
    choice: "image-channel-threshold",
    description: "Distinct channels required for image spam",
    min: 1,
  },
  {
    key: "imageMaxDistance",
    choice: "image-max-distance",
    description: "Max pHash Hamming distance for image matches",
    min: 0,
    max: 64,
  },
  {
    key: "imageWindow",
    choice: "image-window",
    description: "Sliding window in seconds for image spam",
    min: 1,
    unit: "s",
  },
  {
    key: "messageThreshold",
    choice: "message-threshold",
    description: "Distinct channels before duplicate messages are flagged",
    min: 2,
  },
  {
    key: "messageWindow",
    choice: "message-window",
    description: "Sliding window in seconds for duplicate messages",
    min: 1,
    unit: "s",
  },
];

function envInt(name: string, fallback: number) {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Global defaults, taken from the environment. These apply to every guild
 * that has not overridden a setting via /spam-config.
 */
export function getDefaultConfig(): GuildConfig {
  return {
    timeoutDuration: envInt("TIMEOUT_DURATION", 600),
    imageThreshold: envInt("CROSS_CHANNEL_IMAGE_THRESHOLD", 2),
    imageChannelThreshold: envInt("CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD", 2),
    imageMaxDistance: envInt("CROSS_CHANNEL_IMAGE_MAX_DISTANCE", 6),
    imageWindow: envInt("CROSS_CHANNEL_IMAGE_WINDOW", 60),
    messageThreshold: envInt("CROSS_CHANNEL_THRESHOLD", 3),
    messageWindow: envInt("CROSS_CHANNEL_WINDOW", 60),
    logChannelId: process.env.LOG_CHANNEL_ID || null,
  };
}

function guildConfigKey(guildId: string) {
  return `guild_config:${guildId}`;
}

/**
 * Merges stored per-guild overrides (raw Redis hash values) over the defaults.
 * An empty-string `logChannelId` means alerts were explicitly disabled.
 */
export function mergeGuildConfig(
  defaults: GuildConfig,
  stored: Record<string, string>,
): GuildConfig {
  const config = { ...defaults };

  for (const setting of NUMERIC_SETTINGS) {
    const raw = stored[setting.key];
    if (raw === undefined) continue;
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) config[setting.key] = parsed;
  }

  if ("logChannelId" in stored) {
    config.logChannelId = stored.logChannelId || null;
  }

  return config;
}

/** Raw per-guild overrides, without defaults applied. */
export async function getStoredGuildConfig(guildId: string) {
  return getRedisClient().hgetall(guildConfigKey(guildId));
}

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const stored = await getStoredGuildConfig(guildId);
  return mergeGuildConfig(getDefaultConfig(), stored);
}

export async function setGuildConfigValue(
  guildId: string,
  key: keyof GuildConfig,
  value: string,
) {
  await getRedisClient().hset(guildConfigKey(guildId), key, value);
}

/** Removes one override, or all of them when `key` is omitted. */
export async function resetGuildConfig(guildId: string, key?: keyof GuildConfig) {
  const redis = getRedisClient();
  if (key) {
    await redis.hdel(guildConfigKey(guildId), key);
  } else {
    await redis.del(guildConfigKey(guildId));
  }
}
