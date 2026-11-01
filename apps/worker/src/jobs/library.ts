import { announce } from "../live/announce";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import { buildEdlRender, extractFrameAt, findRenderFonts, probeFile, runChecked, runWithProgress, type CaptionLine, type EdlSegmentMedia } from "@slot1/analysis";
import { Edl } from "@slot1/contracts";
import {
  createRecordingSource,
  getAsset,
  getLibraryItem,
  getLibraryItemForRecording,
  getProject,
  getRecording,
  getRecordingBySession,
  getSession,
  getSettings,
  getSource,
  insertAsset,
  insertLibraryItem,
  listExpiredRecordings,
  listProjectsReferencingSession,
  listSources,
  markRecordingReady,
  setRecordingStatus,
  setSourceProbe,
  updateJobRun,
  updateLibraryItem,
  updateProject,
  type ProbeJson,
  type RecordingRow,
  type RecordingRun,
} from "@slot1/db";
import { sanitizeErrorMessage, storageKeys, type StorageDriver } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

/* ------------------------------------------------------------------------------------------ */
/* Stored media                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** A local path for fs storage (ffmpeg seeks in place) or a signed URL for S3. */
async function readableInput(storage: StorageDriver, key: string, contentType: string): Promise<string> {
  const local = (storage as StorageDriver & { localPath?: (k: string) => string }).localPath;
  return local ? local.call(storage, key) : storage.signedGetUrl(key, 3600, contentType);
}

interface StoredMedia {
  input: string;
  probe: ProbeJson;
}

/** The replay-able file of a session: an uploaded original or a finalized recording. */
async function storedMediaFor(ctx: ServerContext, sessionId: string): Promise<StoredMedia | null> {
  const session = await getSession(ctx.db, sessionId);
  if (!session) return null;
  const sources = await listSources(ctx.db, session.broadcaster_id);
  const src = sources.find((s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.original_asset_id && s.probe);
  if (!src?.original_asset_id || !src.probe) return null;
  const asset = await getAsset(ctx.db, src.original_asset_id);
  if (!asset || asset.deleted_at) return null;
  return { input: await readableInput(ctx.storage, asset.storage_key, asset.content_type), probe: src.probe };
}

/** Recorded segments of one live run covering [inMs, outMs], concatenated into one local file. */
async function runWindow(ctx: ServerContext, sessionId: string, runId: string, inMs: number, outMs: number, work: string): Promise<EdlSegmentMedia> {
  const rec = await getRecordingBySession(ctx.db, sessionId);
  const run = rec?.runs.find((r) => r.runId === runId);
  if (!run) throw new UnrecoverableError("That live moment wasn't recorded (Recording was off)");
  const segs = run.segments.filter((s) => s.endMs > inMs && s.startMs < outMs);
  const last = run.segments.at(-1);
  if (segs.length === 0 || !last || last.endMs < outMs - 250) {
    if (run.wallEnd) throw new UnrecoverableError("The recording doesn't cover that moment");
    throw new Error("Waiting for the rest of the moment to be recorded");
  }
  const files: string[] = [];
  for (const [i, s] of segs.entries()) {
    const f = path.join(work, `run-${i}.ts`);
    await ctx.storage.downloadToFile(s.key, f);
    files.push(f);
  }
  const list = path.join(work, `run-${runId}.txt`);
  await writeFile(list, files.map((f) => `file '${f}'`).join("\n"));
  const out = path.join(work, `window-${runId}-${inMs}.ts`);
  await runChecked(ctx.tools.ffmpeg, ["-hide_banner", "-nostdin", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file", "-i", list, "-c", "copy", "-y", out], { timeoutMs: 120_000 });
  const p = await probeFile(ctx.tools, out);
  return { path: out, offsetMs: segs[0]!.startMs, width: p.video?.width ?? 1280, height: p.video?.height ?? 720, hasAudio: Boolean(p.audio) };
}

/* ------------------------------------------------------------------------------------------ */
/* Recording finalization                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Where each run starts in the finalized file, and how to map run time onto it. */
export function runOffsets(runs: RecordingRun[]): { runId: string; wallStart: number; wallEnd: number | null; offsetMs: number; firstMs: number; durationMs: number }[] {
  let offset = 0;
  return [...runs]
    .filter((r) => r.segments.length > 0)
    .sort((a, b) => Date.parse(a.wallStart) - Date.parse(b.wallStart))
    .map((r) => {
      const dur = r.segments.reduce((t, s) => t + (s.endMs - s.startMs), 0);
      const o = { runId: r.runId, wallStart: Date.parse(r.wallStart), wallEnd: r.wallEnd ? Date.parse(r.wallEnd) : null, offsetMs: offset, firstMs: r.segments[0]!.startMs, durationMs: dur };
      offset += dur;
      return o;
    });
}

export async function finalizeRecording(ctx: ServerContext, data: { recordingId: string }) {
  const rec = await getRecording(ctx.db, data.recordingId);
  if (!rec || rec.status === "expired") return;
  const session = await getSession(ctx.db, rec.session_id);
  if (!session) return;
  const offsets = runOffsets(rec.runs);
  if (offsets.length === 0) {
    await setRecordingStatus(ctx.db, rec.id, "failed", "No video was recorded");
    return;
  }
  await setRecordingStatus(ctx.db, rec.id, "finalizing");
  const b = session.broadcaster_id;
  const work = await mkdtemp(path.join(tmpdir(), "slot1-rec-"));
  try {
    const files: string[] = [];
    for (const o of offsets) {
      const run = rec.runs.find((r) => r.runId === o.runId)!;
      for (const [i, s] of run.segments.entries()) {
        const f = path.join(work, `${o.runId}-${String(i).padStart(5, "0")}.ts`);
        await ctx.storage.downloadToFile(s.key, f);
        files.push(f);
      }
    }
    const list = path.join(work, "concat.txt");
    await writeFile(list, files.map((f) => `file '${f}'`).join("\n"));
    const mp4 = path.join(work, "recording.mp4");
    // Copy only: no re-encode. faststart puts the index first so playback starts immediately.
    await runChecked(
      ctx.tools.ffmpeg,
      ["-hide_banner", "-nostdin", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file", "-i", list, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-y", mp4],
      { timeoutMs: ctx.tools.timeoutMs },
    );
    const probe = await probeFile(ctx.tools, mp4);
    const durationMs = probe.durationMs ?? offsets.reduce((t, o) => t + o.durationMs, 0);
    const poster = path.join(work, "poster.jpg");
    await extractFrameAt(ctx.tools, mp4, "mov", Math.min(2000, Math.floor(durationMs / 10)), poster, 1280).catch(() => undefined);

    const version = `v${Date.now().toString(36)}`;
    const mKey = storageKeys.recordingFile(b, session.id, version, "recording.mp4");
    const up = await ctx.storage.putFile(mKey, mp4, "video/mp4");
    const live = rec.live_source_id ? await getSource(ctx.db, rec.live_source_id) : null;
    const label: "live" | "test" = live?.label === "test" ? "test" : "live";
    const sourceId = rec.source_id ?? (await createRecordingSource(ctx.db, { broadcasterId: b, sessionId: session.id, label, name: "Recording" })).id;
    const mAsset = await insertAsset(ctx.db, {
      broadcasterId: b,
      sessionId: session.id,
      sourceId,
      kind: "original",
      storageKey: mKey,
      contentType: "video/mp4",
      bytes: up.bytes,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      durationMs,
    });
    let posterId: string | null = null;
    const pKey = storageKeys.recordingFile(b, session.id, version, "poster.jpg");
    const pUp = await ctx.storage.putFile(pKey, poster, "image/jpeg").catch(() => null);
    if (pUp) {
      const pa = await insertAsset(ctx.db, { broadcasterId: b, sessionId: session.id, sourceId, kind: "thumbnail", storageKey: pKey, contentType: "image/jpeg", bytes: pUp.bytes });
      posterId = pa.id;
    }
    // An older finalized file (the publisher came back to the same session) is replaced.
    if (rec.source_id) {
      const prev = await getSource(ctx.db, rec.source_id);
      const old = prev?.original_asset_id ? await getAsset(ctx.db, prev.original_asset_id) : null;
      if (old && old.id !== mAsset.id) {
        await ctx.storage.delete(old.storage_key).catch(() => undefined);
        await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE id = $1`, [old.id]);
      }
    }
    await ctx.db.query(`UPDATE media_sources SET original_asset_id = $2, playback_asset_id = $2, status = 'ready', updated_at = now() WHERE id = $1`, [sourceId, mAsset.id]);
    await setSourceProbe(ctx.db, sourceId, {
      durationMs,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      fps: probe.video?.fps ?? null,
      videoCodec: probe.video?.codec ?? null,
      audioCodec: probe.audio?.codec ?? null,
      hasAudio: Boolean(probe.audio),
      sizeBytes: up.bytes,
      formatName: probe.formatName,
    });

    // Re-base this session's live times (per reader run) onto the file, once per observation.
    const rebasedUntil = await rebaseOntoRecording(ctx, rec, session.id, offsets, durationMs);
    // Live auto clips cut before finalization now point into the file.
    for (const p of await listProjectsReferencingSession(ctx.db, b, session.id)) {
      const edl = Edl.parse(p.edl);
      let changed = false;
      const segments = edl.segments.map((s) => {
        if (s.sessionId !== session.id || !s.runId) return s;
        const o = offsets.find((x) => x.runId === s.runId);
        if (!o) return s;
        changed = true;
        const map = (t: number) => Math.max(0, Math.min(durationMs, Math.round(o.offsetMs + (t - o.firstMs))));
        return { ...s, runId: null, inMs: map(s.inMs), outMs: Math.max(map(s.inMs) + 300, map(s.outMs)) };
      });
      if (changed) await updateProject(ctx.db, p.id, { edl: { ...edl, segments } });
    }

    const settings = await getSettings(ctx.db, b);
    await markRecordingReady(ctx.db, rec.id, {
      sourceId,
      durationMs,
      bytes: up.bytes,
      expiresAt: new Date(Date.now() + settings.recordingRetentionDays * 86_400_000),
      rebasedUntil,
    });
    const title = session.title ? `Recording: ${session.title}`.slice(0, 120) : `Recording ${session.started_at.toISOString().slice(0, 10)}`;
    const existing = await getLibraryItemForRecording(ctx.db, rec.id);
    if (existing) {
      await updateLibraryItem(ctx.db, existing.id, { assetId: mAsset.id, posterAssetId: posterId, durationMs, bytes: up.bytes, width: probe.video?.width ?? null, height: probe.video?.height ?? null, status: "ready" });
    } else {
      await insertLibraryItem(ctx.db, {
        broadcasterId: b,
        kind: "recording",
        title,
        sessionId: session.id,
        recordingId: rec.id,
        assetId: mAsset.id,
        posterAssetId: posterId,
        durationMs,
        bytes: up.bytes,
        width: probe.video?.width ?? null,
        height: probe.video?.height ?? null,
      });
    }
    // Segments are kept while the session can still continue; afterwards the file replaces them.
    const fresh = await getSession(ctx.db, session.id);
    if (fresh?.ended_at) await deleteRecordingSegments(ctx, session.id);
  } catch (err) {
    await setRecordingStatus(ctx.db, rec.id, "failed", sanitizeErrorMessage((err as Error).message));
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function rebaseOntoRecording(
  ctx: ServerContext,
  rec: RecordingRow,
  sessionId: string,
  offsets: ReturnType<typeof runOffsets>,
  durationMs: number,
): Promise<Date | null> {
  const since = rec.rebased_until ?? new Date(0);
  const runFor = (wall: number) => offsets.find((o) => wall >= o.wallStart - 2000 && wall <= (o.wallEnd ?? Date.now()) + 15_000);
  const map = (o: (typeof offsets)[number], t: number) => Math.max(0, Math.min(durationMs, Math.round(o.offsetMs + (t - o.firstMs))));
  const { rows } = await ctx.db.query<{ id: string; media_start_ms: string; media_end_ms: string | null; received_at: Date; evidence: { assetId: string; kind: string; mediaPtsMs: number | null }[] }>(
    `SELECT id, media_start_ms, media_end_ms, received_at, evidence FROM observations
     WHERE session_id = $1 AND media_start_ms IS NOT NULL AND received_at > $2`,
    [sessionId, since],
  );
  for (const r of rows) {
    const o = runFor(r.received_at.getTime());
    if (!o) continue;
    const start = map(o, Number(r.media_start_ms));
    const end = r.media_end_ms === null ? null : Math.max(start, map(o, Number(r.media_end_ms)));
    const evidence = r.evidence.map((e) => (e.mediaPtsMs === null ? e : { ...e, mediaPtsMs: map(o, e.mediaPtsMs) }));
    await ctx.db.query(`UPDATE observations SET media_start_ms = $2, media_end_ms = $3, evidence = $4 WHERE id = $1`, [r.id, start, end, JSON.stringify(evidence)]);
  }
  const frames = await ctx.db.query<{ id: string; media_pts_ms: string; created_at: Date }>(
    `SELECT id, media_pts_ms, created_at FROM evidence_assets WHERE session_id = $1 AND kind = 'frame' AND media_pts_ms IS NOT NULL AND created_at > $2`,
    [sessionId, since],
  );
  for (const f of frames.rows) {
    const o = runFor(f.created_at.getTime());
    if (o) await ctx.db.query(`UPDATE evidence_assets SET media_pts_ms = $2 WHERE id = $1`, [f.id, map(o, Number(f.media_pts_ms))]);
  }
  const ends = offsets.map((o) => o.wallEnd).filter((x): x is number => x !== null);
  return ends.length ? new Date(Math.max(...ends) + 15_000) : null;
}

async function deleteRecordingSegments(ctx: ServerContext, sessionId: string) {
  const { rows } = await ctx.db.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM evidence_assets WHERE session_id = $1 AND kind = 'recording_segment' AND deleted_at IS NULL`,
    [sessionId],
  );
  for (const r of rows) await ctx.storage.delete(r.storage_key).catch(() => undefined);
  await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE session_id = $1 AND kind = 'recording_segment'`, [sessionId]);
}

/** Retention: expired recordings lose their file; clips and screenshots made from them stay. */
export async function sweepRecordings(ctx: ServerContext): Promise<number> {
  let n = 0;
  for (const rec of await listExpiredRecordings(ctx.db)) {
    if (rec.source_id) {
      const src = await getSource(ctx.db, rec.source_id);
      const { rows } = await ctx.db.query<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM evidence_assets WHERE source_id = $1 AND deleted_at IS NULL`, [rec.source_id]);
      for (const a of rows) await ctx.storage.delete(a.storage_key).catch(() => undefined);
      await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE source_id = $1`, [rec.source_id]);
      if (src) await ctx.db.query(`UPDATE media_sources SET status = 'deleted', original_asset_id = NULL, playback_asset_id = NULL, updated_at = now() WHERE id = $1`, [src.id]);
    }
    await deleteRecordingSegments(ctx, rec.session_id);
    await setRecordingStatus(ctx.db, rec.id, "expired", "Recording expired under the channel's retention setting");
    await ctx.db.query(`DELETE FROM library_items WHERE recording_id = $1`, [rec.id]);
    n += 1;
  }
  // Segments of ended sessions whose recording is already finalized.
  const { rows } = await ctx.db.query<{ session_id: string }>(
    `SELECT r.session_id FROM recordings r JOIN stream_sessions s ON s.id = r.session_id
     WHERE r.status = 'ready' AND s.ended_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM evidence_assets a WHERE a.session_id = r.session_id AND a.kind = 'recording_segment' AND a.deleted_at IS NULL)`,
  );
  for (const r of rows) await deleteRecordingSegments(ctx, r.session_id);
  return n;
}

/* ------------------------------------------------------------------------------------------ */
/* Screenshots                                                                                */
/* ------------------------------------------------------------------------------------------ */

export async function takeScreenshot(ctx: ServerContext, data: { itemId: string; sessionId: string; atMs: number }) {
  const item = await getLibraryItem(ctx.db, data.itemId);
  if (!item || item.status !== "processing") return;
  const work = await mkdtemp(path.join(tmpdir(), "slot1-shot-"));
  try {
    const media = await storedMediaFor(ctx, data.sessionId);
    if (!media) throw new UnrecoverableError("This session has no stored video to take a screenshot from");
    const at = Math.max(0, Math.min(data.atMs, Math.max(0, (media.probe.durationMs ?? data.atMs) - 40)));
    const out = path.join(work, "screenshot.jpg");
    // Input-side seek with decoding is frame-accurate; no scaling keeps full resolution.
    const remote = /^https?:\/\//.test(media.input);
    await runChecked(
      ctx.tools.ffmpeg,
      ["-hide_banner", "-nostdin", "-protocol_whitelist", remote ? "file,http,https,tcp,tls,crypto" : "file", "-ss", (at / 1000).toFixed(3), "-i", media.input, "-frames:v", "1", "-an", "-q:v", "2", "-y", out],
      { timeoutMs: 60_000 },
    );
    const key = storageKeys.library(item.broadcaster_id, item.id, "screenshot.jpg");
    const { bytes } = await ctx.storage.putFile(key, out, "image/jpeg");
    const asset = await insertAsset(ctx.db, { broadcasterId: item.broadcaster_id, sessionId: null, sourceId: null, kind: "screenshot", storageKey: key, contentType: "image/jpeg", bytes, width: media.probe.width, height: media.probe.height, mediaPtsMs: at });
    await updateLibraryItem(ctx.db, item.id, { status: "ready", assetId: asset.id, width: media.probe.width, height: media.probe.height, bytes });
  } catch (err) {
    await updateLibraryItem(ctx.db, item.id, { status: "failed", error: sanitizeErrorMessage((err as Error).message) });
    if (!(err instanceof UnrecoverableError)) throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Renders                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export async function renderProject(ctx: ServerContext, data: { itemId: string; projectId: string; jobRunId: string }, attempt = 1, maxAttempts = 1) {
  const item = await getLibraryItem(ctx.db, data.itemId);
  const project = await getProject(ctx.db, data.projectId);
  if (!item || !project || item.status !== "processing") return;
  const work = await mkdtemp(path.join(tmpdir(), "slot1-render-"));
  try {
    await updateJobRun(ctx.db, data.jobRunId, { state: "running", step: "Preparing media", progress: 0 });
    const edl = Edl.parse(project.edl);
    const media: EdlSegmentMedia[] = [];
    const stored = new Map<string, StoredMedia | null>();
    for (const s of edl.segments) {
      const session = await getSession(ctx.db, s.sessionId);
      if (!session || session.broadcaster_id !== project.broadcaster_id) throw new UnrecoverableError("A segment's session no longer exists");
      if (s.runId) {
        media.push(await runWindow(ctx, s.sessionId, s.runId, s.inMs, s.outMs, work));
        continue;
      }
      if (!stored.has(s.sessionId)) stored.set(s.sessionId, await storedMediaFor(ctx, s.sessionId));
      const m = stored.get(s.sessionId);
      if (!m) throw new UnrecoverableError("A segment's video is no longer stored (retention may have removed it)");
      media.push({ path: m.input, offsetMs: 0, width: m.probe.width ?? 1280, height: m.probe.height ?? 720, hasAudio: m.probe.hasAudio });
    }
    const captions: CaptionLine[] = [];
    if (edl.captions) {
      for (const [i, s] of edl.segments.entries()) {
        if (s.runId) continue;
        const { rows } = await ctx.db.query<{ media_start_ms: string; media_end_ms: string; text: string }>(
          `SELECT media_start_ms, media_end_ms, text FROM transcripts WHERE session_id = $1 AND media_end_ms > $2 AND media_start_ms < $3 ORDER BY media_start_ms`,
          [s.sessionId, s.inMs, s.outMs],
        );
        for (const r of rows) captions.push({ segmentIndex: i, startMs: Number(r.media_start_ms), endMs: Number(r.media_end_ms), text: r.text });
      }
    }
    const out = path.join(work, "render.mp4");
    const plan = buildEdlRender({ edl, media, output: out, workDir: work, fonts: findRenderFonts(), captions, encoder: ctx.config.env.FFMPEG_ENCODER });
    for (const f of plan.textFiles) await writeFile(f.path, f.content);
    await updateJobRun(ctx.db, data.jobRunId, { step: "Rendering", progress: 0.02 });
    await runWithProgress(ctx.tools.ffmpeg, plan.args, plan.durationMs, (p) => void updateJobRun(ctx.db, data.jobRunId, { progress: p }), ctx.tools.timeoutMs);
    const poster = path.join(work, "poster.jpg");
    await extractFrameAt(ctx.tools, out, "mov", Math.min(plan.durationMs - 1, edl.coverMs ?? Math.min(1000, Math.floor(plan.durationMs / 3))), poster, 1920).catch(() => undefined);
    const probe = await probeFile(ctx.tools, out);
    const key = storageKeys.library(item.broadcaster_id, item.id, "render.mp4");
    const up = await ctx.storage.putFile(key, out, "video/mp4");
    const asset = await insertAsset(ctx.db, {
      broadcasterId: item.broadcaster_id,
      sessionId: null,
      sourceId: null,
      kind: "render",
      storageKey: key,
      contentType: "video/mp4",
      bytes: up.bytes,
      width: plan.width,
      height: plan.height,
      durationMs: probe.durationMs ?? plan.durationMs,
    });
    let posterId: string | null = null;
    const pKey = storageKeys.library(item.broadcaster_id, item.id, "poster.jpg");
    const pUp = await ctx.storage.putFile(pKey, poster, "image/jpeg").catch(() => null);
    if (pUp) posterId = (await insertAsset(ctx.db, { broadcasterId: item.broadcaster_id, sessionId: null, sourceId: null, kind: "poster", storageKey: pKey, contentType: "image/jpeg", bytes: pUp.bytes })).id;
    await updateLibraryItem(ctx.db, item.id, {
      status: "ready",
      error: null,
      assetId: asset.id,
      posterAssetId: posterId,
      width: plan.width,
      height: plan.height,
      durationMs: probe.durationMs ?? plan.durationMs,
      bytes: up.bytes,
    });
    await updateJobRun(ctx.db, data.jobRunId, { state: "succeeded", step: "Done", progress: 1 });
    if (project.origin === "auto") {
      // Private items stay private: chat only gets a link when the creator shared the clip.
      const shared = item.visibility === "public" || item.visibility === "unlisted";
      const text = shared ? `Auto-clip ready: ${item.title} ${ctx.config.publicOrigin}/v/${item.id}` : `Auto-clip saved to the creator's SLOT1 library: ${item.title}`;
      await announce(ctx, item.broadcaster_id, text, `autoclip:${item.id}`).catch(() => undefined);
    }
  } catch (err) {
    const msg = sanitizeErrorMessage((err as Error).message);
    const final = err instanceof UnrecoverableError || attempt >= maxAttempts;
    if (final) {
      await updateLibraryItem(ctx.db, item.id, { status: "failed", error: msg });
      await updateJobRun(ctx.db, data.jobRunId, { state: "failed", error: msg });
    } else {
      await updateJobRun(ctx.db, data.jobRunId, { step: `Retrying: ${msg}`.slice(0, 200) });
    }
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
