import Redis from 'ioredis';

let redis = null;
export function getRedis() {
  if (redis !== null) return redis;
  const url = process.env.REDIS_URL;
  if (!url) { redis = undefined; return redis; }
  try {
    redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // best-effort connect
    redis.connect().catch(() => {});
    return redis;
  } catch {
    redis = undefined;
    return redis;
  }
}
