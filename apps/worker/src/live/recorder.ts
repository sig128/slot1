import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ensureRecording, insertAsset, updateRecordingRun, type MediaSourceRow, type StreamSessionRow } from "@slot1/db";
import { sanitizeErrorMessage, storageKeys } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

const SEGMENT_SECONDS = 6;

/**
 * Full-stream recording for one live reader run. ffmpeg writes copy-only segments next to the
 * frame sampler (same input, same clock); completed segments are uploaded to storage as they
 * appear in the run's segment list, so any worker can finalize the recording later.
 */
export class LiveRecorder {
  private readonly uploaded = new Set<string>();
  private syncing: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly ctx: ServerContext,
    private readonly session: StreamSessionRow,
    readonly recordingId: string,
    readonly runId: string,
    readonly dir: string,
  ) {}

  static async start(ctx: ServerContext, session: StreamSessionRow, source: MediaSourceRow): Promise<LiveRecorder> {
    const rec = await ensureRecording(ctx.db, { broadcasterId: session.broadcaster_id, sessionId: session.id, liveSourceId: source.id });
    const runId = `r${Date.now().toString(36)}`;
    const dir = path.resolve(ctx.config.env.INGEST_SEGMENT_DIR, source.id, "recording", runId);
    await mkdir(dir, { recursive: true });
    await updateRecordingRun(ctx.db, rec.id, runId, (r) => r, new Date().toISOString());
    return new LiveRecorder(ctx, session, rec.id, runId, dir);
  }

  options() {
    return { dir: this.dir, runId: this.runId, segmentSeconds: SEGMENT_SECONDS };
  }

  /** Upload segments the muxer has finished (it lists a segment only once it is complete). */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.syncOnce()).catch((err: unknown) => {
      this.ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message), run: this.runId }, "recording sync failed");
    });
    return this.syncing;
  }

  private async syncOnce() {
    let csv: string;
    try {
      csv = await readFile(path.join(this.dir, `${this.runId}.csv`), "utf8");
    } catch {
      return; // nothing complete yet
    }
    const b = this.session.broadcaster_id;
    const s = this.session.id;
    for (const line of csv.trim().split(/\r?\n/)) {
      const [name, start, end] = line.split(",");
      if (!name || !new RegExp(`^${this.runId}-\\d{5}\\.ts$`).test(name) || this.uploaded.has(name)) continue;
      const file = path.join(this.dir, name);
      const size = await stat(file).then((x) => x.size).catch(() => 0);
      if (size === 0) continue;
      const startMs = Math.round(Number(start) * 1000);
      const endMs = Math.round(Number(end) * 1000);
      const key = storageKeys.recordingSegment(b, s, this.runId, name);
      const { bytes } = await this.ctx.storage.putFile(key, file, "video/mp2t");
      await insertAsset(this.ctx.db, {
        broadcasterId: b,
        sessionId: s,
        sourceId: null,
        kind: "recording_segment",
        storageKey: key,
        contentType: "video/mp2t",
        bytes,
        durationMs: endMs - startMs,
        mediaPtsMs: startMs,
      });
      await updateRecordingRun(this.ctx.db, this.recordingId, this.runId, (r) => ({
        ...r,
        segments: [...r.segments.filter((x) => x.key !== key), { key, startMs, endMs, bytes }].sort((a, c) => a.startMs - c.startMs),
      }));
      this.uploaded.add(name);
      await rm(file, { force: true });
    }
  }

  /** After the reader exits: upload the last segment, close the run, clear local files. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.sync();
    await updateRecordingRun(this.ctx.db, this.recordingId, this.runId, (r) => ({ ...r, wallEnd: new Date().toISOString() }));
    await rm(this.dir, { recursive: true, force: true });
  }
}
