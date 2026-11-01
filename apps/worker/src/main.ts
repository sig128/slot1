import { hostname } from "node:os";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { createPool, runMigrations } from "@slot1/db";
import { createBullConnection, createRedis, DEFAULT_JOB_OPTIONS, loadConfig, QUEUES, sanitizeErrorMessage } from "@slot1/platform";
import { buildServerContext, reconcileEventSub, type Enqueue } from "@slot1/services";
import { createLiveClip, createVodClip, downloadAndAnalyzeClip, renderOwnedClip } from "./jobs/clips";
import { handleChatCommand, postReply } from "./jobs/chat";
import { processEventSub } from "./jobs/eventsub";
import { deleteSession, refreshDirectory, retentionSweep, validateGrants } from "./jobs/maintenance";
import { analyzeUpload } from "./jobs/upload";
import { finalizeRecording, renderProject, takeScreenshot } from "./jobs/library";
import { RelaySupervisor } from "./live/relay";
import { LiveSupervisor } from "./live/supervisor";

const config = loadConfig();
const env = config.env;
const db = createPool(env.DATABASE_URL, 10);
const redis = createRedis(env.REDIS_URL);
const queues = new Map<string, Queue>();
for (const name of Object.values(QUEUES)) queues.set(name, new Queue(name, { connection: createBullConnection(env.REDIS_URL), defaultJobOptions: DEFAULT_JOB_OPTIONS }));

const enqueue: Enqueue = async (queue, name, data, opts) => {
  const q = queues.get(queue);
  if (!q) throw new Error(`Unknown queue ${queue}`);
  await q.add(name, data, { ...(opts?.jobId ? { jobId: opts.jobId } : {}), ...(opts?.delay ? { delay: opts.delay } : {}), ...(opts?.attempts ? { attempts: opts.attempts } : {}) });
};

const ctx = buildServerContext({ config, db, redis, enqueue, service: "slot1-worker" });
const log = ctx.log;

type Handler = (job: Job) => Promise<unknown>;
const handlers: Record<string, Record<string, Handler>> = {
  [QUEUES.media]: {
    "analyze-upload": (j) => analyzeUpload(ctx, j.data),
    "render-clip": (j) => renderOwnedClip(ctx, j.data),
  },
  [QUEUES.twitch]: {
    "create-live-clip": (j) => createLiveClip(ctx, j.data),
    "create-vod-clip": (j) => createVodClip(ctx, j.data),
    "download-clip": (j) => downloadAndAnalyzeClip(ctx, j.data),
    "eventsub-process": (j) => processEventSub(ctx, j.data),
    "eventsub-reconcile": async (j) => (j.data.broadcasterId ? reconcileEventSub(ctx, j.data.broadcasterId) : null),
    "validate-grants": () => validateGrants(ctx),
    "refresh-directory": () => refreshDirectory(ctx),
  },
  [QUEUES.chat]: {
    "handle-command": (j) => handleChatCommand(ctx, j.data),
    "post-reply": (j) => postReply(ctx, j.data),
  },
  [QUEUES.library]: {
    "finalize-recording": (j) => finalizeRecording(ctx, j.data),
    screenshot: (j) => takeScreenshot(ctx, j.data),
    "render-project": (j) => renderProject(ctx, j.data, j.attemptsMade + 1, j.opts.attempts ?? 1),
  },
  [QUEUES.maintenance]: {
    "retention-sweep": () => retentionSweep(ctx),
    "delete-session": (j) => deleteSession(ctx, j.data),
  },
};

const concurrency: Record<string, number> = {
  [QUEUES.media]: env.WORKER_MEDIA_CONCURRENCY,
  [QUEUES.twitch]: 4,
  [QUEUES.chat]: 4,
  [QUEUES.maintenance]: 1,
  [QUEUES.library]: env.WORKER_LIBRARY_CONCURRENCY,
};

async function main() {
  const applied = await runMigrations(db);
  if (applied.length) log.info({ applied }, "migrations applied");
  for (const p of config.problems) log.warn(p);

  const workers: Worker[] = [];
  for (const [queue, table] of Object.entries(handlers)) {
    const w = new Worker(
      queue,
      async (job) => {
        const h = table[job.name];
        if (!h) throw new UnrecoverableError(`No handler for ${queue}/${job.name}`);
        try {
          return await h(job);
        } catch (err) {
          const e = err as Error & { permanent?: boolean };
          if (e.permanent) throw new UnrecoverableError(sanitizeErrorMessage(e.message));
          throw err;
        }
      },
      { connection: createBullConnection(env.REDIS_URL), concurrency: concurrency[queue] ?? 1, lockDuration: 120_000 },
    );
    w.on("failed", (job, err) => log.warn({ queue, job: job?.name, id: job?.id, err: sanitizeErrorMessage(err.message) }, "job failed"));
    w.on("error", (err) => log.error({ queue, err: sanitizeErrorMessage(err.message) }, "worker error"));
    workers.push(w);
  }

  // Repeatable maintenance: Twitch requires hourly token validation.
  const twitchQ = queues.get(QUEUES.twitch)!;
  const maintQ = queues.get(QUEUES.maintenance)!;
  await twitchQ.upsertJobScheduler("validate-grants", { every: 3_600_000 }, { name: "validate-grants", data: {} });
  await twitchQ.upsertJobScheduler("refresh-directory", { every: 60_000 }, { name: "refresh-directory", data: {} });
  await maintQ.upsertJobScheduler("retention-sweep", { every: 3_600_000 }, { name: "retention-sweep", data: {} });

  // Reconcile EventSub subscriptions for every connected channel on start.
  if (config.capabilities.eventsub.available) {
    const { rows } = await db.query<{ broadcaster_id: string }>(`SELECT broadcaster_id FROM broadcaster_connections WHERE status = 'active'`);
    for (const r of rows) await enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: r.broadcaster_id, reason: "startup" });
  }

  const supervisor = new LiveSupervisor(ctx, `${hostname()}:${process.pid}`);
  supervisor.start();
  // Forwarding to Twitch/YouTube/Kick runs independently of analysis: a failing destination never
  // touches recording or the AI, and forwarding works even when the agent is off.
  const relays = new RelaySupervisor(ctx, `${hostname()}:${process.pid}`);
  relays.start();
  log.info(
    {
      vision: config.capabilities.vision.available ? config.capabilities.vision.model : config.capabilities.vision.reason,
      ocr: config.capabilities.ocr.available,
      ingest: config.capabilities.ingest.available ? config.capabilities.ingest.gateway : config.capabilities.ingest.reason,
      twitch: config.capabilities.twitch.available,
    },
    "SLOT1 worker started",
  );

  const shutdown = async () => {
    log.info("worker shutting down");
    await supervisor.stopAll();
    await relays.stopAll();
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([...queues.values()].map((q) => q.close()));
    await redis.quit();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  log.error({ err: sanitizeErrorMessage((err as Error).message) }, "worker failed to start");
  process.exit(1);
});
