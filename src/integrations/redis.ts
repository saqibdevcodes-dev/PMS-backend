import { Redis } from 'ioredis';
import { env } from '../config/env.js';
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
redis.on('error', () => {
  /* Dependency failures are reported by health checks and requests. */
});
export async function throttle(key: string, limit: number, seconds: number) {
  const count = (await redis.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
    1,
    `pms:limit:${key}`,
    seconds,
  )) as number;
  return count <= limit;
}
