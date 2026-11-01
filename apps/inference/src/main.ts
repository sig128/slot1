import { parseExecutionProviders } from "@slot1/gta-runtime";
import { createPool } from "@slot1/db";
import { createLogger, createRedis, createStorage, loadConfig, MODELS_CHANNEL, sanitizeErrorMessage } from "@slot1/platform";
import { ModelManager } from "./models";
import { buildInferenceServer } from "./server";

/**
 * SLOT1 inference service: one process (per GPU) holds the active GTA model and batches frames
 * from every live stream. Workers reach it with INFERENCE_URL + INFERENCE_SHARED_SECRET.
 */
async function main() {
  const config = loadConfig();
  const env = config.env;
  const log = createLogger("slot1-inference", env.LOG_LEVEL);
  const db = createPool(env.DATABASE_URL, 4);
  const storage = createStorage(config);
  const providers = parseExecutionProviders(env.INFERENCE_EXECUTION_PROVIDERS);
  const manager = new ModelManager({ db, storage, log, providers });
  await manager.reload("startup");

  const { app } = await buildInferenceServer({
    secret: env.INFERENCE_SHARED_SECRET ?? "",
    manager,
    batching: {
      maxBatch: Math.max(1, env.INFERENCE_MAX_BATCH),
      maxWaitMs: Math.max(0, env.INFERENCE_MAX_WAIT_MS),
      maxQueue: Math.max(1, env.INFERENCE_MAX_QUEUE),
      maxPerStream: Math.max(1, env.INFERENCE_MAX_PER_STREAM),
      concurrency: Math.max(1, env.INFERENCE_CONCURRENCY),
    },
  });

  // Hot swap: immediately on activation (Redis notice), and by polling as a safety net.
  const sub = createRedis(env.REDIS_URL);
  await sub.subscribe(MODELS_CHANNEL);
  sub.on("message", (channel) => {
    if (channel === MODELS_CHANNEL) void manager.reload("activation notice");
  });
  const poll = setInterval(() => void manager.reload("poll"), Math.max(2000, env.INFERENCE_MODEL_POLL_MS));

  await app.listen({ host: env.INFERENCE_HOST, port: env.INFERENCE_PORT });
  log.info({ host: env.INFERENCE_HOST, port: env.INFERENCE_PORT, providers, model: manager.status().version }, "SLOT1 inference service listening");

  const shutdown = async () => {
    clearInterval(poll);
    await app.close();
    await sub.quit();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(`Inference service failed to start: ${sanitizeErrorMessage((err as Error).message)}`);
  process.exit(1);
});
