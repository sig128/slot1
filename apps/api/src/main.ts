import { Queue } from "bullmq";
import { createPool, runMigrations } from "@slot1/db";
import { createBullConnection, createRedis, DEFAULT_JOB_OPTIONS, loadConfig, QUEUES, sanitizeErrorMessage } from "@slot1/platform";
import { buildServerContext, type Enqueue } from "@slot1/services";
import { buildApp } from "./app";
import { EventHub } from "./lib/hub";

const config = loadConfig();
const env = config.env;
const db = createPool(env.DATABASE_URL, 20);
const redis = createRedis(env.REDIS_URL);
const queues = new Map<string, Queue>();
for (const name of Object.values(QUEUES)) queues.set(name, new Queue(name, { connection: createBullConnection(env.REDIS_URL), defaultJobOptions: DEFAULT_JOB_OPTIONS }));

const enqueue: Enqueue = async (queue, name, data, opts) => {
  const q = queues.get(queue);
  if (!q) throw new Error(`Unknown queue ${queue}`);
  await q.add(name, data, { ...(opts?.jobId ? { jobId: opts.jobId } : {}), ...(opts?.delay ? { delay: opts.delay } : {}), ...(opts?.attempts ? { attempts: opts.attempts } : {}) });
};

async function main() {
  const ctx = buildServerContext({ config, db, redis, enqueue, service: "slot1-api" });
  const applied = await runMigrations(db);
  if (applied.length) ctx.log.info({ applied }, "migrations applied");
  for (const p of config.problems) ctx.log.warn(p);
  const hub = new EventHub(createRedis(env.REDIS_URL));
  const app = await buildApp({ ctx, hub });
  await app.listen({ port: env.SLOT1_API_PORT, host: env.SLOT1_API_HOST });
  ctx.log.info({ port: env.SLOT1_API_PORT, capabilities: Object.fromEntries(Object.entries(config.capabilities).map(([k, v]) => [k, typeof v === "object" && v && "available" in v ? v.available : v])) }, "SLOT1 API listening");
  const shutdown = async () => {
    await app.close();
    await hub.close();
    await Promise.all([...queues.values()].map((q) => q.close()));
    await redis.quit();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(`API failed to start: ${sanitizeErrorMessage((err as Error).message)}`);
  process.exit(1);
});
