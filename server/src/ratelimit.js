import { getRedis } from './redis.js';

const buckets = new Map();

function keyOf(kind, id) {
  return `${kind}:${id}`;
}

export async function rateLimit(kind, id, limit, windowMs) {
  const r = getRedis();
  if (r) {
    const key = keyOf(kind, id);
    const ttlSec = Math.ceil(windowMs / 1000);
    const res = await r.multi().incr(key).expire(key, ttlSec).exec();
    const count = res?.[0]?.[1] || 0;
    return count <= limit;
  }
  const k = keyOf(kind, id);
  const now = Date.now();
  const until = now + windowMs;
  const bucket = buckets.get(k) || { count: 0, resetAt: until };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = until;
  }
  bucket.count += 1;
  buckets.set(k, bucket);
  return bucket.count <= limit;
}

export async function remaining(kind, id, limit, windowMs) {
  const r = getRedis();
  if (r) {
    const key = keyOf(kind, id);
    const current = Number(await r.get(key)) || 0;
    return Math.max(0, limit - current);
  }
  const k = keyOf(kind, id);
  const now = Date.now();
  const bucket = buckets.get(k) || { count: 0, resetAt: now + windowMs };
  return Math.max(0, limit - bucket.count);
}
