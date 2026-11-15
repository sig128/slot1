import { spawn, type ChildProcess } from "node:child_process";
import type { EvidenceRef } from "@slot1/contracts";
import type { FrameRef } from "./candidates";
import type { Candidate } from "./fusion";
import type { MediaTools } from "./media";
import type { TranscriptionResult } from "./providers/transcription";

/**
 * Live speech: what's said on stream, in whatever language it's said. A second, audio-only reader
 * pulls the creator's stream as 16 kHz mono PCM and cuts it into chunks; each chunk with sound in
 * it goes to the speech-to-text service, which detects the language itself. Only text comes back
 * into SLOT1: the audio is never stored.
 */

export const SPEECH_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2;

export interface AudioChunk {
  /** Wall-clock time of the chunk's first sample. */
  startedAt: Date;
  durationMs: number;
  /** 16-bit little-endian mono PCM at 16 kHz. */
  pcm: Buffer;
  /** Loudness of the chunk, in dB relative to full scale (silence is about -90). */
  dbfs: number;
}

/** Loudness of 16-bit PCM in dBFS (root mean square). */
export function pcmDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** A WAV file around 16-bit mono PCM: what every speech-to-text service accepts. */
export function wavFromPcm(pcm: Buffer, sampleRate = SPEECH_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Cuts a PCM byte stream into fixed-length chunks, keeping each chunk's start time. */
export class PcmChunker {
  private parts: Buffer[] = [];
  private have = 0;
  private startedAt: Date | null = null;
  constructor(private readonly chunkMs: number) {}

  /** Feeds bytes received at `now`; returns the chunks that are complete. */
  push(bytes: Buffer, now = new Date()): AudioChunk[] {
    const out: AudioChunk[] = [];
    const size = Math.round((this.chunkMs / 1000) * BYTES_PER_SECOND);
    let rest = bytes;
    while (rest.length > 0) {
      if (this.startedAt === null) {
        // These bytes ended at `now`: the chunk began their playing time earlier.
        this.startedAt = new Date(now.getTime() - Math.round((rest.length / BYTES_PER_SECOND) * 1000));
      }
      const take = Math.min(size - this.have, rest.length);
      this.parts.push(rest.subarray(0, take));
      this.have += take;
      rest = rest.subarray(take);
      if (this.have === size) {
        const pcm = Buffer.concat(this.parts);
        out.push({ startedAt: this.startedAt, durationMs: this.chunkMs, pcm, dbfs: pcmDbfs(pcm) });
        this.parts = [];
        this.have = 0;
        this.startedAt = rest.length > 0 ? new Date(now.getTime() - Math.round((rest.length / BYTES_PER_SECOND) * 1000)) : null;
      }
    }
    return out;
  }
}

export interface LiveSpeechOptions {
  readUrl: string;
  ioTimeoutSec: number;
  /** Length of each chunk sent for transcription. */
  chunkMs: number;
}

/**
 * The audio-only reader. It runs apart from the video reader, so a stream without sound, or a
 * problem with the audio, never touches the video analysis.
 */
export class LiveSpeechReader {
  private child: ChildProcess | null = null;
  private queue: AudioChunk[] = [];
  private waiters: ((v: IteratorResult<AudioChunk>) => void)[] = [];
  private ended = false;
  error: string | null = null;
  /** Chunks dropped because transcription fell behind (kept live rather than late). */
  dropped = 0;

  constructor(
    private readonly tools: MediaTools,
    private readonly opts: LiveSpeechOptions,
  ) {}

  buildArgs(): string[] {
    return [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-rw_timeout",
      String(this.opts.ioTimeoutSec * 1_000_000),
      "-i",
      this.opts.readUrl,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SPEECH_SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ];
  }

  connect(): void {
    const child = spawn(this.tools.ffmpeg, this.buildArgs(), { stdio: ["ignore", "pipe", "pipe"], shell: false });
    this.child = child;
    const chunker = new PcmChunker(this.opts.chunkMs);
    let stderr = "";
    child.stdout!.on("data", (b: Buffer) => {
      for (const c of chunker.push(b)) this.enqueue(c);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => {
      stderr = (stderr + s).slice(-2000);
    });
    child.on("close", (code) => {
      if (code !== 0 && code !== null && !this.ended) {
        const last = stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "";
        this.error = /matches no streams|does not contain any stream/i.test(stderr) ? "This stream has no sound" : `Audio reader exited (${code}): ${last.slice(0, 160)}`;
      }
      this.finish();
    });
    child.on("error", (err) => {
      this.error = `Audio reader failed to start: ${err.message}`;
      this.finish();
    });
  }

  private enqueue(c: AudioChunk) {
    const w = this.waiters.shift();
    if (w) return w({ value: c, done: false });
    this.queue.push(c);
    // Stay live: when more than two chunks wait, the oldest goes.
    while (this.queue.length > 2) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  private finish() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  async *chunks(): AsyncGenerator<AudioChunk> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const r = await new Promise<IteratorResult<AudioChunk>>((resolve) => this.waiters.push(resolve));
      if (r.done) return;
      yield r.value;
    }
  }

  close(): void {
    this.ended = true;
    this.child?.kill("SIGTERM");
    this.finish();
  }
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/**
 * A language as people say it in English, from whatever the service returned: Whisper names
 * ("norwegian"), ISO 639-1 ("no") or ISO 639-3 ("nor", "tur") codes. Null when there's none.
 */
export function languageName(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(v)) {
    try {
      const name = languageNames.of(v.toLowerCase());
      if (name && name.toLowerCase() !== v.toLowerCase()) return name;
    } catch {
      // Not a code Intl knows: fall through and show it as given.
    }
  }
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

/** Text worth logging: something said, not only noise markers like "(music)" or "...". */
export function spokenText(text: string): string {
  return text
    .replace(/[([][^)\]]{1,40}[)\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What was said in one chunk, for the live log. The original words are kept exactly (any
 * language); the description names the language the service detected.
 */
export function speechCandidate(
  input: { result: TranscriptionResult; mediaStartMs: number; durationMs: number; transcriptAssetId: string; frame: FrameRef | null; receivedAt: Date },
  nowIso: string,
): Candidate | null {
  const said = spokenText(input.result.text);
  if (said.length < 2 || !/[\p{L}\p{N}]/u.test(said)) return null;
  const lang = languageName(input.result.language);
  const quoted = said.length > 280 ? `${said.slice(0, 277).trimEnd()}…` : said;
  const evidence: EvidenceRef[] = [{ assetId: input.transcriptAssetId, kind: "transcript", mediaPtsMs: input.mediaStartMs }];
  return {
    type: "dialogue",
    description: lang ? `Said (${lang}): “${quoted}”` : `Said: “${quoted}”`,
    origin: "audio",
    interpretation: "inferred",
    mediaStartMs: input.mediaStartMs,
    mediaEndMs: input.mediaStartMs + input.durationMs,
    evidence,
    rawText: said,
    model: { provider: input.result.provider ?? "transcription", version: input.result.model },
    modelConfidence: typeof input.result.languageProbability === "number" ? Math.max(0, Math.min(1, input.result.languageProbability)) : null,
    relatedEntities: [],
    receivedAt: input.receivedAt.toISOString(),
    analyzedAt: nowIso,
    capturedAt: null,
    minReadings: 1,
    fusable: false,
  };
}

/** Sounds the service tagged ("(laughter)", "(applause)"), for reactions in the log. */
export function soundTags(result: TranscriptionResult): string[] {
  const tags = new Set<string>();
  for (const e of result.events ?? []) {
    const t = e.text.replace(/[()[\]]/g, "").trim().toLowerCase();
    if (t && t.length <= 40) tags.add(t);
  }
  return [...tags];
}
