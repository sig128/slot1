import type { Redis } from "ioredis";
import { AdminLearning, type AdminLearning as AdminLearningT } from "@slot1/contracts";

/**
 * Admin → Learning: whether SLOT1 watches and learns from the featured channels' live streams.
 * On unless an admin turns it off. The API reads and sets it; the watcher (added-watch.ts) obeys it.
 */
export const LEARNING_SWITCH_KEY = "slot1:admin:learning";
/** Set once the watcher has closed what it had open after learning went off; cleared on every change. */
export const LEARNING_PAUSED_KEY = "slot1:added-watch:paused";

const ON: AdminLearningT = { on: true, changedAt: null };

export async function readLearningSwitch(redis: Redis): Promise<AdminLearningT> {
  const raw = await redis.get(LEARNING_SWITCH_KEY);
  if (!raw) return ON;
  try {
    const parsed = AdminLearning.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : ON;
  } catch {
    return ON;
  }
}

export async function writeLearningSwitch(redis: Redis, on: boolean): Promise<AdminLearningT> {
  const value: AdminLearningT = { on, changedAt: new Date().toISOString() };
  await redis.multi().set(LEARNING_SWITCH_KEY, JSON.stringify(value)).del(LEARNING_PAUSED_KEY).exec();
  return value;
}
