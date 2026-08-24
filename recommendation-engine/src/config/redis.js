/**
 * Redis Connection (ioredis)
 *
 * Two separate connections are exported deliberately:
 *
 *  - `redisClient`   : general-purpose cache reads/writes (GET/SET/DEL) used
 *                      by the recommendation service.
 *  - `bullConnection`: a *dedicated* connection config for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its Redis connection
 * (blocking commands like BRPOPLPUSH would otherwise be killed by ioredis's
 * default retry policy). We do NOT want that setting on our general cache
 * client, so we keep them separate rather than sharing one instance.
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  // Cap reconnect backoff instead of retrying forever at default settings —
  // keeps logs sane during local dev / CI when Redis isn't up, while still
  // reconnecting automatically once it is.
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

let loggedFirstError = false;
redisClient.on('error', (err) => {
  // Avoid log-spamming on every retry attempt; log the first error and
  // then stay quiet until the connection recovers.
  if (!loggedFirstError) {
    // eslint-disable-next-line no-console
    console.error('[redis:cache] connection error', err.message);
    loggedFirstError = true;
  }
});

redisClient.on('ready', () => {
  loggedFirstError = false;
});

redisClient.on('connect', () => {
  // eslint-disable-next-line no-console
  console.log('[redis:cache] connected');
});

// BullMQ-specific connection options (passed to Queue/Worker, not a live client)
const bullConnection = {
  connection: {
    // Re-parse the URL into discrete options so BullMQ manages its own
    // ioredis instance internally with the required settings.
    ...parseRedisUrl(REDIS_URL),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
};

function parseRedisUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      db: parsed.pathname ? Number(parsed.pathname.replace('/', '')) || 0 : 0,
    };
  } catch (e) {
    return { host: 'localhost', port: 6379 };
  }
}

module.exports = { redisClient, bullConnection };
