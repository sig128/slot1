import type { Redis } from "ioredis";
import { WipeStatus, type WipeStatus as WipeStatusT } from "@slot1/contracts";
import { wipeStreamAndLearningData } from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import type { ServerContext } from "./context";

/**
 * Admin → Wipe data. The API checks and queues it; the maintenance worker runs it. Its status
 * lives in Redis so the Admin page can follow it.
 */

const STATUS_KEY = "slot1:admin:wipe";

export const WIPE_IDLE: WipeStatusT = { state: "idle", requestedAt: null, finishedAt: null, deleted: null, filesRemoved: null, error: null };

export async function readWipeStatus(redis: Redis): Promise<WipeStatusT> {
  const raw = await redis.get(STATUS_KEY);
  if (!raw) return WIPE_IDLE;
  try {
    const parsed = WipeStatus.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : WIPE_IDLE;
  } catch {
    return WIPE_IDLE;
  }
}

export async function writeWipeStatus(redis: Redis, status: WipeStatusT): Promise<void> {
  await redis.set(STATUS_KEY, JSON.stringify(status));
}

/**
 * Delete what the AI found, kept, heard and learned, then those files. Streams stay. The database
 * goes first, in one transaction, so nothing deleted can still show; files follow. The live
 * "what the AI sees" pictures in Redis go too. Safe to run again: a retry finds nothing left.
 */
export async function runWipe(ctx: ServerContext): Promise<WipeStatusT> {
  const before = await readWipeStatus(ctx.redis);
  await writeWipeStatus(ctx.redis, { ...before, state: "running", error: null });
  try {
    const { deleted, prefixes, keys } = await wipeStreamAndLearningData(ctx.db);
    let filesRemoved = 0;
    for (const prefix of prefixes) filesRemoved += await ctx.storage.deletePrefix(prefix).catch(() => 0);
    for (const key of keys) {
      const gone = await ctx.storage
        .delete(key)
        .then(() => true)
        .catch(() => false);
      if (gone) filesRemoved += 1;
    }
    await dropKeys(ctx.redis, "slot1:aiview:*");
    const done: WipeStatusT = {
      state: "done",
      requestedAt: before.requestedAt,
      finishedAt: new Date().toISOString(),
      deleted,
      filesRemoved,
      error: null,
    };
    await writeWipeStatus(ctx.redis, done);
    ctx.log.warn({ deleted, filesRemoved }, "admin wipe: learning data deleted, streams kept");
    return done;
  } catch (err) {
    await writeWipeStatus(ctx.redis, {
      ...before,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: sanitizeErrorMessage((err as Error).message),
    });
    throw err;
  }
}

/** Delete every Redis key matching a pattern. Used to drop the live AI-view pictures after a wipe. */
async function dropKeys(redis: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}
