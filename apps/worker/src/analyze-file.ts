import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  blackCandidates,
  coverageCandidate,
  createTranscriptionProvider,
  createVisionProvider,
  dedupeOverlap,
  DEFAULT_PROBE_LIMITS,
  extractAudioChunk,
  FileSourceAdapter,
  getProfile,
  mediaFactsCandidate,
  ObservationPipeline,
  planAudioChunks,
  sceneCandidates,
  TesseractOcr,
  type MediaProbe,
} from "@slot1/analysis";
import type { ChannelSettings } from "@slot1/contracts";
import {
  addMeasuredSceneLabels,
  getSessionIncludingDeleted,
  insertAsset,
  insertObservation,
  insertTranscript,
  recordUsage,
  setSessionDuration,
  setSourceProbe,
  type MediaSourceRow,
  type StreamSessionRow,
} from "@slot1/db";
import { storageKeys } from "@slot1/platform";
import { createPipelineSink, emitObservation, type ServerContext } from "@slot1/services";
import { loadActiveGtaModel } from "./gta/onnx-model";

export interface AnalyzeFileInput {
  session: StreamSessionRow;
  source: MediaSourceRow;
  file: string;
  settings: ChannelSettings;
  onProgress: (step: string, progress: number | null) => Promise<void>;
}

export interface AnalyzeFileResult {
  probe: MediaProbe;
  frames: number;
  analyzedFrames: number;
  observations: number;
  analyzers: string[];
  visionErrors: number;
  transcribedChunks: number;
  summary: string;
}

/**
 * Analyze a media file we actually possess (an upload or a downloaded Twitch clip) through the
 * shared observation pipeline. Without AI credentials it still produces real evidence frames and
 * deterministic measurements, and says plainly that AI is not configured.
 */
export async function analyzeMediaFile(ctx: ServerContext, input: AnalyzeFileInput): Promise<AnalyzeFileResult> {
  const env = ctx.config.env;
  const caps = ctx.config.capabilities;
  const { session, source, settings } = input;
  const work = await mkdtemp(path.join(tmpdir(), "slot1-analyze-"));
  try {
    const baseIntervalMs = Math.max(2000, Math.min(settings.sampleIntervalMs, 15_000));
    const adapter = new FileSourceAdapter(
      { sourceId: source.id, broadcasterId: session.broadcaster_id, sessionId: session.id, kind: source.kind, label: source.label },
      input.file,
      ctx.tools,
      work,
      {
        baseIntervalMs,
        maxFrames: 600,
        maxEdge: env.VISION_MAX_EDGE_PX,
        limits: { ...DEFAULT_PROBE_LIMITS, maxDurationMs: env.UPLOAD_MAX_DURATION_SEC * 1000 },
      },
    );
    await input.onProgress("Inspecting media", 0.05);
    await adapter.connect();
    const probe = adapter.probe;
    await setSourceProbe(ctx.db, source.id, {
      durationMs: probe.durationMs,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      fps: probe.video?.fps ?? null,
      videoCodec: probe.video?.codec ?? null,
      audioCodec: probe.audio?.codec ?? null,
      hasAudio: probe.audio !== null,
      sizeBytes: probe.sizeBytes,
      formatName: probe.formatName,
    });
    if (probe.durationMs) await setSessionDuration(ctx.db, session.id, probe.durationMs);

    const vision = createVisionProvider(env);
    const ocr = caps.ocr.available ? new TesseractOcr(env.TESSERACT_PATH, ctx.tools) : null;
    const sink = createPipelineSink(ctx, { session, source, settings, retentionDays: settings.retentionDays });
    const pipeline = new ObservationPipeline({
      ocr,
      ocrVersion: "5",
      vision,
      gtaModel: await loadActiveGtaModel(ctx, { live: false, streamId: `file:${source.id}` }),
      profile: getProfile(settings.gameProfile),
      sourceLabel: source.label,
      visionBatchSize: Math.max(1, Math.min(env.VISION_FRAMES_PER_CALL, 8)),
      coverageMsPerFrame: baseIntervalMs,
      workDir: path.join(work, "pipeline"),
      sink,
    });

    const expected = probe.durationMs ? Math.ceil(probe.durationMs / baseIntervalMs) : 1;
    let n = 0;
    for await (const frame of adapter.frames()) {
      if (n % 5 === 0) {
        // Stop promptly if the creator deleted the session mid-processing.
        const current = await getSessionIncludingDeleted(ctx.db, session.id);
        if (!current || current.delete_requested_at) throw new Error("Session was deleted while processing");
      }
      await pipeline.handleFrame(frame);
      n += 1;
      if (n % 3 === 0) await input.onProgress(`Analyzing frames (${n}/${expected})`, 0.1 + 0.75 * Math.min(1, n / expected));
    }
    await pipeline.flush();

    // Deterministic measurements, each backed by a real evidence frame.
    const now = new Date().toISOString();
    const refs = pipeline.frameRefs;
    const first = refs[0];
    if (first) {
      await pipeline.addCandidate(mediaFactsCandidate(probe, first, now, adapter.detections.silence));
      for (const c of sceneCandidates(adapter.detections.scenes, refs, now)) await pipeline.addCandidate(c);
      for (const c of blackCandidates(adapter.detections.black, refs, now)) await pipeline.addCandidate(c);
      // Training pool: frames inside measured black segments get a "loading or black" proposal.
      if (adapter.detections.black.length) await addMeasuredSceneLabels(ctx.db, session.id, adapter.detections.black, "loading_or_black", "Black screen (measured)");
    }

    // Audio transcription — only with a configured provider and a real audio track.
    let transcribedChunks = 0;
    const transcriber = createTranscriptionProvider(env);
    if (transcriber && probe.audio && probe.durationMs) {
      await input.onProgress("Transcribing audio", 0.9);
      let prevText = "";
      for (const chunk of planAudioChunks(probe.durationMs)) {
        const out = path.join(work, "audio", `${chunk.startMs}.mp3`);
        await mkdir(path.dirname(out), { recursive: true });
        if (!(await extractAudioChunk(ctx.tools, input.file, probe.demuxer, chunk.startMs, chunk.durationMs, out))) continue;
        try {
          const r = await transcriber.transcribe(out);
          await recordUsage(ctx.db, {
            broadcasterId: session.broadcaster_id,
            sessionId: session.id,
            kind: "transcription",
            provider: transcriber.provider,
            model: transcriber.model,
            audioSeconds: chunk.durationMs / 1000,
            estimatedCostUsd: env.TRANSCRIPTION_PRICE_PER_MINUTE ? (Number(env.TRANSCRIPTION_PRICE_PER_MINUTE) * chunk.durationMs) / 60_000 : null,
          });
          const text = dedupeOverlap(prevText, r.text);
          prevText = r.text;
          if (!text.trim()) continue;
          const key = storageKeys.audioChunk(session.broadcaster_id, session.id, source.id, chunk.startMs);
          const { bytes } = await ctx.storage.putFile(key, out, "audio/mpeg");
          const asset = await insertAsset(ctx.db, {
            broadcasterId: session.broadcaster_id,
            sessionId: session.id,
            sourceId: source.id,
            kind: "audio_chunk",
            storageKey: key,
            contentType: "audio/mpeg",
            bytes,
            durationMs: chunk.durationMs,
            mediaPtsMs: chunk.startMs,
            expiresAt: new Date(Date.now() + settings.retentionDays * 86_400_000),
          });
          await insertTranscript(ctx.db, {
            broadcasterId: session.broadcaster_id,
            sessionId: session.id,
            sourceId: source.id,
            mediaStartMs: chunk.startMs,
            mediaEndMs: chunk.startMs + chunk.durationMs,
            text,
            segments: r.segments.map((sg) => ({ startMs: sg.startMs + chunk.startMs, endMs: sg.endMs + chunk.startMs, text: sg.text })),
            provider: transcriber.provider,
            model: r.model,
            language: r.language,
          });
          const { observation, created } = await insertObservation(ctx.db, {
            broadcasterId: session.broadcaster_id,
            sessionId: session.id,
            sourceId: source.id,
            mediaStartMs: chunk.startMs,
            mediaEndMs: chunk.startMs + chunk.durationMs,
            capturedAt: null,
            receivedAt: new Date().toISOString(),
            analyzedAt: new Date().toISOString(),
            type: "dialogue",
            description: `Heard: “${text.length > 110 ? `${text.slice(0, 109)}…` : text}”`,
            origin: "audio",
            interpretation: "directly_visible",
            evidence: [{ assetId: asset.id, kind: "audio", mediaPtsMs: chunk.startMs }],
            rawText: text.slice(0, 2000),
            model: { provider: transcriber.provider, version: r.model },
            modelConfidence: null,
            relatedEntities: [],
            dedupeKey: `${source.id}:dialogue:${chunk.startMs}`,
          });
          if (created) await emitObservation(ctx.db, ctx.publisher, session, observation);
          transcribedChunks += 1;
        } catch (err) {
          await sink.problem("transcription", `Transcription failed for chunk at ${Math.round(chunk.startMs / 1000)}s: ${(err as Error).message}`);
        }
      }
    }

    const cov = coverageCandidate(
      refs,
      {
        durationMs: probe.durationMs ?? 0,
        analyzedFrames: pipeline.stats.analyzedFrames,
        visionFrames: pipeline.stats.visionFrames,
        intervalMs: baseIntervalMs,
        analyzers: pipeline.analyzers,
      },
      new Date().toISOString(),
    );
    if (cov) await pipeline.addCandidate(cov);

    const notes: string[] = [];
    if (!vision) notes.push("The AI that describes gameplay isn't switched on yet, so only on-screen text and measurements were analyzed.");
    if (!ocr) notes.push("OCR is unavailable on this worker.");
    if (probe.audio && !transcriber) notes.push("Audio wasn't transcribed (speech-to-text isn't switched on yet).");
    if (!probe.audio) notes.push("The recording has no audio track.");
    const summary = [
      `${pipeline.stats.frames} evidence frames ${pipeline.analyzers.length ? `analyzed by ${pipeline.analyzers.join(" and ")}` : "stored, but no analyzer ran"}.`,
      ...notes,
    ].join(" ");

    return {
      probe,
      frames: pipeline.stats.frames,
      analyzedFrames: pipeline.stats.analyzedFrames,
      observations: pipeline.stats.observations,
      analyzers: pipeline.analyzers,
      visionErrors: pipeline.stats.visionErrors,
      transcribedChunks,
      summary,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
