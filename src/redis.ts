import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
let client: RedisType | undefined;

/**
 * Returns a shared Redis client, creating it on the first call.
 */
export function getRedisClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });

    client.on("error", (err: Error) => {
      console.error("[Redis] Connection error:", err.message);
    });
  }
  return client;
}
