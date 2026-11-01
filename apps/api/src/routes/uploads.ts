import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DEFAULT_PROBE_LIMITS, probeFile, validateProbe } from "@slot1/analysis";
import {
  createJobRun,
  createReplaySession,
  createUploadSource,
  getSettings,
  insertAsset,
  setSourceAssets,
  setSourceProbe,
  withTx,
} from "@slot1/db";
import { QUEUES, randomToken, storageKeys } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { ApiProblem, badRequest, conflict } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const ALLOWED_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".ts", ".flv", ".avi"]);

const Fields = z.object({
  title: z.string().trim().min(1).max(120),
  visibility: z.enum(["public", "private"]).default("private"),
  rightsConfirmed: z.literal("true", { error: "Confirm that you own this recording or have the rights to analyze it" }),
});

export const uploadRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Upload a user-owned recording. The file streams to a private temp path with a hard size
     * limit, is checked with ffprobe (local file protocol only), then stored and queued for
     * the worker. It becomes a REPLAY session — never a live broadcast.
     */
    app.post("/api/uploads", { bodyLimit: ctx.config.env.UPLOAD_MAX_BYTES, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req) => {
      const b = requireBroadcaster(req);
      const { rows } = await ctx.db.query<{ active: number; today: number }>(
        `SELECT count(*) FILTER (WHERE state IN ('queued','running'))::int AS active,
                count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today
         FROM job_runs WHERE broadcaster_id = $1 AND name = 'analyze-upload'`,
        [b.id],
      );
      if ((rows[0]?.active ?? 0) >= 3) throw conflict("Three uploads are already processing — wait for one to finish");
      if ((rows[0]?.today ?? 0) >= 30) throw conflict("Daily upload quota reached for this channel");

      const tmpDir = path.resolve(ctx.config.env.UPLOAD_TMP_DIR);
      await mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `up-${randomToken(12)}`);
      const fields: Record<string, string> = {};
      let fileExt: string | null = null;
      let truncated = false;
      try {
        for await (const part of req.parts()) {
          if (part.type === "field") {
            if (typeof part.value === "string") fields[part.fieldname] = part.value;
            continue;
          }
          if (fileExt) throw badRequest("Only one file per upload");
          // Never trust the client filename for paths; only its extension is considered.
          const ext = path.extname(part.filename ?? "").toLowerCase();
          if (!ALLOWED_EXT.has(ext)) throw badRequest("Unsupported file type. Use MP4, MOV, MKV, WebM, TS, FLV or AVI.");
          fileExt = ext;
          await pipeline(part.file, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
          truncated = part.file.truncated;
        }
        if (!fileExt) throw badRequest("Attach a video file");
        if (truncated) throw new ApiProblem(413, "too_large", `File exceeds the ${Math.round(ctx.config.env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB upload limit`);
        const meta = Fields.parse(fields);
        const size = (await stat(tmp)).size;
        if (size < 1024) throw badRequest("File is empty or too small to be a video");

        const probe = await probeFile({ ...ctx.tools, timeoutMs: 60_000 }, tmp).catch(() => null);
        if (!probe) throw badRequest("Couldn't read this file as video. It may be corrupted or not a media file.");
        const problems = validateProbe(probe, { ...DEFAULT_PROBE_LIMITS, maxDurationMs: ctx.config.env.UPLOAD_MAX_DURATION_SEC * 1000 });
        if (problems.length) throw badRequest(problems.join(" "));

        const settings = await getSettings(ctx.db, b.id);
        const visibility = settings.visibility === "public" ? meta.visibility : "private";
        const { session, source, job } = await withTx(ctx.db, async (tx) => {
          const session = await createReplaySession(tx, b.id, meta.title, visibility);
          const source = await createUploadSource(tx, b.id, session.id, meta.title);
          const job = await createJobRun(tx, { broadcasterId: b.id, sessionId: session.id, queue: QUEUES.media, name: "analyze-upload" });
          return { session, source, job };
        });
        const key = storageKeys.original(b.id, session.id, source.id, fileExt.slice(1));
        await ctx.storage.putFile(key, tmp, "application/octet-stream");
        const asset = await insertAsset(ctx.db, {
          broadcasterId: b.id,
          sessionId: session.id,
          sourceId: source.id,
          kind: "original",
          storageKey: key,
          contentType: "application/octet-stream",
          bytes: size,
          width: probe.video?.width ?? null,
          height: probe.video?.height ?? null,
          durationMs: probe.durationMs,
          expiresAt: new Date(Date.now() + settings.retentionDays * 86_400_000),
        });
        await setSourceAssets(ctx.db, source.id, asset.id, null);
        await setSourceProbe(ctx.db, source.id, {
          durationMs: probe.durationMs,
          width: probe.video?.width ?? null,
          height: probe.video?.height ?? null,
          fps: probe.video?.fps ?? null,
          videoCodec: probe.video?.codec ?? null,
          audioCodec: probe.audio?.codec ?? null,
          hasAudio: probe.audio !== null,
          sizeBytes: size,
          formatName: probe.formatName,
        });
        await ctx.enqueue(QUEUES.media, "analyze-upload", { jobRunId: job.id, broadcasterId: b.id, sessionId: session.id, sourceId: source.id }, { jobId: `upload-${source.id}`, attempts: 2 });
        return { sessionId: session.id, sourceId: source.id, jobId: job.id, label: "replay", visibility };
      } finally {
        await rm(tmp, { force: true });
      }
    });
  };
