import type { Redis } from "ioredis";
import type pg from "pg";
import type { MediaTools } from "@slot1/analysis";
import type { Publisher } from "@slot1/db";
import { createLogger, createStorage, TokenCipher, type AppConfig, type Logger, type StorageDriver } from "@slot1/platform";
import { HelixClient, type OAuthClient } from "@slot1/twitch";

/** Shared server-side dependencies for the API and the worker. */
export interface ServerContext {
  config: AppConfig;
  db: pg.Pool;
  redis: Redis;
  publisher: Publisher;
  storage: StorageDriver;
  cipher: TokenCipher;
  /** Null when Twitch is not configured — features must report that, not fake it. */
  helix: HelixClient | null;
  oauth: OAuthClient | null;
  tools: MediaTools;
  log: Logger;
  enqueue: Enqueue;
}

export interface Enqueue {
  (queue: string, name: string, data: Record<string, unknown>, opts?: { jobId?: string; delay?: number; attempts?: number }): Promise<void>;
}

export function buildServerContext(input: { config: AppConfig; db: pg.Pool; redis: Redis; enqueue: Enqueue; service: string; storage?: StorageDriver }): ServerContext {
  const { config } = input;
  const env = config.env;
  const twitchOk = config.capabilities.twitch.available;
  return {
    config,
    db: input.db,
    redis: input.redis,
    publisher: { publish: (channel, message) => input.redis.publish(channel, message) },
    storage: input.storage ?? createStorage(config),
    cipher: new TokenCipher(config.encryptionKeys),
    helix: twitchOk && env.TWITCH_CLIENT_ID ? new HelixClient(env.TWITCH_CLIENT_ID, env.TWITCH_API_BASE) : null,
    oauth:
      twitchOk && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
        ? { idBase: env.TWITCH_ID_BASE, clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET }
        : null,
    tools: { ffmpeg: env.FFMPEG_PATH, ffprobe: env.FFPROBE_PATH, timeoutMs: env.FFMPEG_TIMEOUT_SEC * 1000 },
    log: createLogger(input.service, env.LOG_LEVEL),
    enqueue: input.enqueue,
  };
}
