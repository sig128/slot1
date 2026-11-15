import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  languageName,
  LiveSpeechReader,
  soundTags,
  speechCandidate,
  spokenText,
  wavFromPcm,
  type AudioChunk,
  type MediaTools,
  type ObservationPipeline,
  type PipelineSink,
  type TranscriptionProvider,
} from "@slot1/analysis";
import { sanitizeErrorMessage } from "@slot1/platform";

/** Chunks quieter than this (dBFS) are skipped: nothing worth sending to the speech service. */
const SILENCE_DBFS = -50;
const CHUNK_MS = 12_000;

export interface SpeechTimeline {
  /** The latest analyzed frame: its media time and when it arrived (ms since epoch). */
  latest(): { ptsMs: number; at: number } | null;
}

/**
 * What's said on a live stream, in any language: an audio-only reader cuts the stream into 12 s
 * chunks, each chunk with sound goes to the speech-to-text service (which detects the language),
 * and what was said is logged with the original words, the language and transcript evidence.
 * The audio itself is never kept. Runs beside the frame analysis and never blocks it.
 */
export class LiveSpeech {
  private readonly reader: LiveSpeechReader;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  readonly stats = { chunks: 0, silent: 0, transcribed: 0, lines: 0, errors: 0 };
  readonly languages = new Map<string, number>();

  constructor(
    private readonly o: {
      tools: MediaTools;
      readUrl: string;
      workDir: string;
      provider: TranscriptionProvider;
      pipeline: ObservationPipeline;
      sink: PipelineSink;
      timeline: SpeechTimeline;
      log: { warn: (o: object, msg: string) => void };
      /** Seconds of audio sent to the service, for the creator's usage page. */
      usage?: (u: { seconds: number; provider: string; model: string }) => Promise<void>;
    },
  ) {
    this.reader = new LiveSpeechReader(o.tools, { readUrl: o.readUrl, ioTimeoutSec: 15, chunkMs: CHUNK_MS });
  }

  start(): void {
    this.reader.connect();
    this.loop = this.run().catch((err: unknown) => {
      this.o.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "live speech stopped");
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reader.close();
    // The chunk in flight finishes (its words still count), but never holds the reader up long.
    await Promise.race([this.loop ?? Promise.resolve(), new Promise((r) => setTimeout(r, 20_000).unref())]);
  }

  /** Media time of a chunk: the frame timeline, shifted by how much earlier the chunk began. */
  private mediaStart(c: AudioChunk): number {
    const t = this.o.timeline.latest();
    if (!t) return Math.max(0, c.startedAt.getTime() - this.startedAt);
    return Math.max(0, t.ptsMs + (c.startedAt.getTime() - t.at));
  }

  private async run(): Promise<void> {
    await mkdir(this.o.workDir, { recursive: true });
    let reportedAt = 0;
    for await (const chunk of this.reader.chunks()) {
      if (this.stopped) break;
      this.stats.chunks += 1;
      if (!(chunk.dbfs > SILENCE_DBFS)) {
        this.stats.silent += 1;
        continue;
      }
      const mediaStartMs = this.mediaStart(chunk);
      const file = path.join(this.o.workDir, `speech-${chunk.startedAt.getTime()}.wav`);
      try {
        await writeFile(file, wavFromPcm(chunk.pcm));
        const result = await this.o.provider.transcribe(file);
        this.stats.transcribed += 1;
        await this.o.usage?.({ seconds: chunk.durationMs / 1000, provider: result.provider ?? this.o.provider.provider, model: result.model }).catch(() => undefined);
        const said = spokenText(result.text);
        const sounds = soundTags(result);
        if (!said && sounds.length === 0) continue;
        const lang = languageName(result.language);
        if (lang && said) this.languages.set(lang, (this.languages.get(lang) ?? 0) + 1);
        const stored = await this.o.sink.storeTranscript?.({
          mediaStartMs,
          durationMs: chunk.durationMs,
          receivedAt: chunk.startedAt,
          language: result.language,
          languageName: lang,
          text: result.text,
          segments: result.segments,
          sounds,
          provider: result.provider ?? this.o.provider.provider,
          model: result.model,
        });
        if (!stored) continue;
        const c = speechCandidate(
          { result, mediaStartMs, durationMs: chunk.durationMs, transcriptAssetId: stored.assetId, frame: null, receivedAt: chunk.startedAt },
          new Date().toISOString(),
        );
        if (c) {
          await this.o.pipeline.addCandidate(c);
          this.stats.lines += 1;
        }
        if (sounds.length) {
          await this.o.pipeline.addCandidate({
            type: "reaction",
            description: `Heard on stream: ${sounds.join(", ")}`,
            origin: "audio",
            interpretation: "inferred",
            mediaStartMs,
            mediaEndMs: mediaStartMs + chunk.durationMs,
            evidence: [{ assetId: stored.assetId, kind: "transcript", mediaPtsMs: mediaStartMs }],
            rawText: sounds.join(", "),
            model: { provider: result.provider ?? this.o.provider.provider, version: result.model },
            modelConfidence: null,
            relatedEntities: [],
            receivedAt: chunk.startedAt.toISOString(),
            analyzedAt: new Date().toISOString(),
            capturedAt: null,
            minReadings: 1,
            fusable: false,
          });
        }
      } catch (err) {
        this.stats.errors += 1;
        // One line a minute at most: a service outage shouldn't flood the creator's problems list.
        if (Date.now() - reportedAt > 60_000) {
          reportedAt = Date.now();
          await this.o.sink.problem("speech", `Speech-to-text failed on a chunk: ${sanitizeErrorMessage((err as Error).message)}`).catch(() => undefined);
        }
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
      }
    }
    if (this.reader.error && !this.stopped) {
      await this.o.sink.problem("speech", this.reader.error).catch(() => undefined);
    }
  }
}
