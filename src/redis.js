'use strict';

const Redis = require('ioredis');

let client;

/**
 * Returns a shared Redis client, creating it on the first call.
 * @returns {Redis}
 */
function getRedisClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });

    client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }
  return client;
}

module.exports = { getRedisClient };
