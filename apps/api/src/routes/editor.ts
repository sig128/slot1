import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { probeFile } from "@slot1/analysis";
import { Edl, GeneratedCaptionsView, readSequences, SequenceId, sequenceEdl, SPRITE_TILE, SPRITE_TIERS, type ProjectMediaView, type SpriteSheetView, type WaveformView } from "@slot1/contracts";
import { createJobRun, deleteProjectMedia, getProject, getProjectMedia, getSession, insertProjectMedia, iso, listProjectMedia, listSources, type ProjectMediaRow } from "@slot1/db";
import { QUEUES, randomToken, storageKeys } from "@slot1/platform";
import { playbackUrlTtl, projectCaptionsKey, sessionSpritesKey, sessionWaveformKey, type ServerContext } from "@slot1/services";
import { ApiProblem, badRequest, conflict, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const IdParam = z.object({ id: z.string().uuid() });

/** Uploads for edits: music beds, voice-overs, logos and stickers the creator owns. */
const MEDIA_TYPES: Record<string, { kind: "audio" | "image"; contentType: string }> = {
  ".mp3": { kind: "audio", contentType: "audio/mpeg" },
  ".m4a": { kind: "audio", contentType: "audio/mp4" },
  ".aac": { kind: "audio", contentType: "audio/aac" },
  ".wav": { kind: "audio", contentType: "audio/wav" },
  ".ogg": { kind: "audio", contentType: "audio/ogg" },
  ".opus": { kind: "audio", contentType: "audio/ogg" },
  ".flac": { kind: "audio", contentType: "audio/flac" },
  ".png": { kind: "image", contentType: "image/png" },
  ".jpg": { kind: "image", contentType: "image/jpeg" },
  ".jpeg": { kind: "image", contentType: "image/jpeg" },
  ".webp": { kind: "image", contentType: "image/webp" },
  ".gif": { kind: "image", contentType: "image/gif" },
};
const AUDIO_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const AUDIO_MAX_MS = 20 * 60_000;
const MEDIA_MAX_FILES = 200;
const AUDIO_FORMATS = /^(mp3|wav|ogg|flac|aac|mov,mp4,m4a,3gp,3g2,mj2|matroska,webm)$/;
const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "gif"]);

const MediaFields = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
  rightsConfirmed: z.literal("true", { error: "Confirm that you own this file or have the rights to use it in your videos" }),
});

async function readJson<T>(ctx: ServerContext, key: string): Promise<T | null> {
  try {
    const obj = await ctx.storage.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of obj.stream) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function projectMediaView(ctx: ServerContext, m: ProjectMediaRow): Promise<ProjectMediaView> {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    durationMs: m.duration_ms,
    width: m.width,
    height: m.height,
    bytes: m.bytes,
    url: await ctx.storage.signedGetUrl(m.storage_key, playbackUrlTtl(ctx.config), m.content_type).catch(() => null),
    createdAt: iso(m.created_at)!,
  };
}

/** Creator deleted everything: uploaded edit media goes too. */
export async function deleteAllProjectMedia(ctx: ServerContext, broadcasterId: string) {
  for (const m of await listProjectMedia(ctx.db, broadcasterId)) {
    await ctx.storage.deletePrefix(storageKeys.libraryPrefix(broadcasterId, m.id)).catch(() => 0);
    await deleteProjectMedia(ctx.db, m.id);
  }
}

export const editorRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /* ---------------------------------- Uploaded media ------------------------------------- */

    app.get("/api/editor/media", async (req): Promise<{ media: ProjectMediaView[] }> => {
      const b = requireBroadcaster(req);
      return { media: await Promise.all((await listProjectMedia(ctx.db, b.id)).map((m) => projectMediaView(ctx, m))) };
    });

    /**
     * Upload music, a voice-over, a logo or a sticker for edits. The creator confirms they own it
     * or have the rights to use it; files are checked with ffprobe (local file protocol only).
     */
    app.post("/api/editor/media", { bodyLimit: AUDIO_MAX_BYTES + 1024 * 1024, config: { rateLimit: { max: 60, timeWindow: "1 hour" } } }, async (req): Promise<ProjectMediaView> => {
      const b = requireBroadcaster(req);
      if ((await listProjectMedia(ctx.db, b.id)).length >= MEDIA_MAX_FILES) throw conflict(`You have ${MEDIA_MAX_FILES} uploaded files for edits. Delete some first`);
      const tmpDir = path.resolve(ctx.config.env.UPLOAD_TMP_DIR);
      await mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `media-${randomToken(12)}`);
      const fields: Record<string, string> = {};
      let ext: string | null = null;
      let original = "";
      let truncated = false;
      try {
        for await (const part of req.parts()) {
          if (part.type === "field") {
            if (typeof part.value === "string") fields[part.fieldname] = part.value;
            continue;
          }
          if (ext) throw badRequest("Only one file per upload");
          const e = path.extname(part.filename ?? "").toLowerCase();
          if (!MEDIA_TYPES[e]) throw badRequest("Unsupported file type. Use MP3, M4A, AAC, WAV, OGG, Opus or FLAC audio, or a PNG, JPG, WebP or GIF image.");
          ext = e;
          original = path.basename(part.filename ?? "", e).slice(0, 120);
          await pipeline(part.file, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
          truncated = part.file.truncated;
        }
        if (!ext) throw badRequest("Attach an audio or image file");
        const type = MEDIA_TYPES[ext]!;
        const meta = MediaFields.parse(fields);
        const size = (await stat(tmp)).size;
        const max = type.kind === "audio" ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES;
        if (truncated || size > max) throw new ApiProblem(413, "too_large", `${type.kind === "audio" ? "Audio" : "Images"} can be up to ${Math.round(max / 1024 / 1024)} MB`);
        if (size < 64) throw badRequest("File is empty");
        if (meta.projectId) {
          const p = await getProject(ctx.db, meta.projectId);
          if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
        }
        const probe = await probeFile({ ...ctx.tools, timeoutMs: 30_000 }, tmp).catch(() => null);
        if (!probe) throw badRequest("Couldn't read this file. It may be corrupted or not a media file.");
        let durationMs: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        if (type.kind === "audio") {
          if (!probe.audio || !AUDIO_FORMATS.test(probe.formatName)) throw badRequest("That file has no audio SLOT1 can use");
          durationMs = probe.durationMs;
          if (!durationMs || durationMs < 200) throw badRequest("That audio is too short");
          if (durationMs > AUDIO_MAX_MS) throw badRequest("Audio for edits can be up to 20 minutes long");
        } else {
          if (!probe.video || !IMAGE_CODECS.has(probe.video.codec)) throw badRequest("That file isn't an image SLOT1 can use");
          width = probe.video.width;
          height = probe.video.height;
          if (width < 8 || height < 8 || width > 4096 || height > 4096) throw badRequest("Images can be 8 to 4096 pixels on each side");
          if (probe.video.codec === "gif") durationMs = probe.durationMs;
        }
        const id = randomUUID();
        const key = storageKeys.library(b.id, id, `media${ext}`);
        const { bytes } = await ctx.storage.putFile(key, tmp, type.contentType);
        const row = await insertProjectMedia(ctx.db, {
          id,
          broadcasterId: b.id,
          projectId: meta.projectId ?? null,
          kind: type.kind,
          name: meta.name ?? (original || (type.kind === "audio" ? "Audio" : "Image")),
          storageKey: key,
          contentType: type.contentType,
          bytes,
          durationMs,
          width,
          height,
        });
        return projectMediaView(ctx, row);
      } finally {
        await rm(tmp, { force: true });
      }
    });

    app.delete("/api/editor/media/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const m = await getProjectMedia(ctx.db, id);
      if (!m || m.broadcaster_id !== b.id) throw notFound("File not found");
      await ctx.storage.deletePrefix(storageKeys.libraryPrefix(b.id, m.id)).catch(() => 0);
      await deleteProjectMedia(ctx.db, m.id);
      return { ok: true };
    });

    /* ------------------------------------ Waveforms ---------------------------------------- */

    /** Peaks of a session's stored audio for the timeline. Built once by the worker, then cached. */
    app.get("/api/editor/waveform/:id", async (req): Promise<WaveformView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const session = await getSession(ctx.db, id);
      if (!session || session.broadcaster_id !== b.id) throw notFound("Session not found");
      const cached = await readJson<{ peaks: number[]; durationMs: number | null; unavailable?: boolean }>(ctx, sessionWaveformKey(b.id, session.id));
      if (cached) return { status: cached.unavailable ? "unavailable" : "ready", peaks: cached.peaks, durationMs: cached.durationMs };
      const stored = (await listSources(ctx.db, b.id)).some((s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.playback_asset_id);
      if (!stored) return { status: "unavailable", peaks: [], durationMs: null };
      await ctx.enqueue(QUEUES.library, "session-waveform", { sessionId: session.id }, { jobId: `waveform-${session.id}`, attempts: 2 });
      return { status: "pending", peaks: [], durationMs: null };
    });

    /**
     * Timeline filmstrip sprite sheets of a session's video for one zoom tier (0: a frame every
     * 2 s, 1: every 10 s, 2: every minute). Built once by the worker, then served from storage.
     */
    app.get("/api/editor/sprites/:id", async (req): Promise<SpriteSheetView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const { tier } = z.object({ tier: z.coerce.number().int().min(0).max(SPRITE_TIERS.length - 1).default(1) }).parse(req.query);
      const session = await getSession(ctx.db, id);
      if (!session || session.broadcaster_id !== b.id) throw notFound("Session not found");
      const base = { tier, intervalMs: SPRITE_TIERS[tier]!, tileWidth: SPRITE_TILE.width, tileHeight: SPRITE_TILE.height, cols: SPRITE_TILE.cols, rows: SPRITE_TILE.rows };
      const src = (await listSources(ctx.db, b.id)).find((s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.playback_asset_id);
      if (!src) return { status: "unavailable", ...base, durationMs: null, sheets: [] };
      const cached = await readJson<{ unavailable: boolean; durationMs: number | null; assetId: string | null; sheets: { key: string; frames: number }[] }>(ctx, sessionSpritesKey(b.id, session.id, tier));
      if (cached && cached.assetId === src.original_asset_id) {
        if (cached.unavailable) return { status: "unavailable", ...base, durationMs: cached.durationMs, sheets: [] };
        const ttl = playbackUrlTtl(ctx.config);
        const sheets = await Promise.all(cached.sheets.map(async (sh) => ({ url: await ctx.storage.signedGetUrl(sh.key, ttl, "image/jpeg"), frames: sh.frames })));
        return { status: "ready", ...base, durationMs: cached.durationMs, sheets };
      }
      await ctx.enqueue(QUEUES.library, "session-sprites", { sessionId: session.id, tier }, { jobId: `sprites-${session.id}-${tier}-${src.original_asset_id ?? "none"}`, attempts: 1 });
      return { status: "pending", ...base, durationMs: null, sheets: [] };
    });

    /* --------------------------------- Generated captions ---------------------------------- */

    app.get("/api/projects/:id/captions", async (req): Promise<GeneratedCaptionsView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const p = await getProject(ctx.db, id);
      if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
      const saved = await readJson<unknown>(ctx, projectCaptionsKey(b.id, p.id));
      const parsed = saved ? GeneratedCaptionsView.safeParse(saved) : null;
      return parsed?.success ? parsed.data : { status: "none", error: null, cues: [], sequenceId: "main" };
    });

    /**
     * Transcribe the edit's audio with the configured provider. Without one, this says exactly
     * what's missing; captions can always be typed by hand.
     */
    app.post("/api/projects/:id/captions", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req): Promise<GeneratedCaptionsView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const p = await getProject(ctx.db, id);
      if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
      const t = ctx.config.capabilities.transcription;
      if (!t.available) {
        throw conflict(
          `Captions can't be generated on this server. ${t.reason ?? "Transcription isn't configured"}`,
          "Whoever runs this SLOT1 sets TRANSCRIPTION_PROVIDER=openai_compatible and TRANSCRIPTION_MODEL (and TRANSCRIPTION_API_KEY for a hosted API). You can still type captions by hand.",
        );
      }
      const { sequenceId } = z.object({ sequenceId: SequenceId.default("main") }).parse(req.body ?? {});
      const edl = sequenceEdl(Edl.parse(p.edl), readSequences(p.sequences), sequenceId);
      if (!edl) throw notFound("That sequence isn't in this edit. Save the edit, then try again");
      if (edl.segments.some((s) => s.runId)) throw conflict("Captions need the finished recording", "Try again after the stream ends");
      const pending: GeneratedCaptionsView = { status: "pending", error: null, cues: [], sequenceId };
      await ctx.storage.putBuffer(projectCaptionsKey(b.id, p.id), Buffer.from(JSON.stringify(pending)), "application/json");
      const job = await createJobRun(ctx.db, { broadcasterId: b.id, sessionId: edl.segments[0]!.sessionId, queue: QUEUES.library, name: "project-captions" });
      await ctx.enqueue(QUEUES.library, "project-captions", { projectId: p.id, jobRunId: job.id, sequenceId }, { jobId: `captions-${job.id}`, attempts: 2 });
      return pending;
    });
  };
