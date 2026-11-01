import { Redis, type RedisOptions } from "ioredis";

/** Create an ioredis client. BullMQ requires maxRetriesPerRequest = null on its connections. */
export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, { lazyConnect: false, enableReadyCheck: true, ...opts });
}

export function createBullConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export const sessionChannel = (sessionId: string) => `slot1:session:${sessionId}`;
export const broadcasterChannel = (broadcasterId: string) => `slot1:broadcaster:${broadcasterId}`;
/** Published when a GTA model is activated, so inference services hot-swap immediately. */
export const MODELS_CHANNEL = "slot1:models:changed";

/**
 * Small Redis-backed fixed-window limiter + cooldown helpers. Keys expire on their own so
 * nothing accumulates. Works across API/worker replicas.
 */
export class RedisLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = "slot1:rl") {}

  /** Returns true if the action is allowed; records it. */
  async take(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
    const k = `${this.prefix}:${key}`;
    const tx = this.redis.multi();
    tx.incr(k);
    tx.ttl(k);
    const res = await tx.exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    let ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.redis.expire(k, windowSec);
      ttl = windowSec;
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSec: ttl };
  }

  /** Cooldown: allowed if no marker exists; sets a marker for `seconds`. */
  async cooldown(key: string, seconds: number): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const k = `${this.prefix}:cd:${key}`;
    const set = await this.redis.set(k, "1", "EX", seconds, "NX");
    if (set === "OK") return { allowed: true, retryAfterSec: 0 };
    const ttl = await this.redis.ttl(k);
    return { allowed: false, retryAfterSec: Math.max(1, ttl) };
  }

  /** Remember a value for `seconds`; returns false if it was already present (duplicate). */
  async remember(key: string, seconds: number): Promise<boolean> {
    const set = await this.redis.set(`${this.prefix}:seen:${key}`, "1", "EX", seconds, "NX");
    return set === "OK";
  }
}

/** Redis lease used so exactly one worker processes a given live source. */
export class RedisLease {
  constructor(private readonly redis: Redis, private readonly owner: string) {}

  async acquire(name: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(`slot1:lease:${name}`, this.owner, "PX", ttlMs, "NX")) === "OK";
  }

  async renew(name: string, ttlMs: number): Promise<boolean> {
    const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
    return Number(await this.redis.eval(script, 1, `slot1:lease:${name}`, this.owner, String(ttlMs))) === 1;
  }

  async release(name: string): Promise<void> {
    const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    await this.redis.eval(script, 1, `slot1:lease:${name}`, this.owner);
  }
}
