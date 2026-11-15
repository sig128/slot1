import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProviderError, type FetchLike } from "./http";

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  /** The language the service detected (a name like "norwegian" or a code like "nor"), or null. */
  language: string | null;
  /** How sure the service is of that language, 0 to 1, when it says. */
  languageProbability?: number | null;
  /** Segment times are relative to the chunk start. Empty if the provider gave none. */
  segments: TranscriptSegment[];
  /** Non-speech sounds the service tagged, like "(laughter)". */
  events?: TranscriptSegment[];
  model: string;
  provider?: string;
}

const AUDIO_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};
const audioType = (file: string) => AUDIO_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export interface TranscriptionProvider {
  readonly provider: string;
  readonly model: string;
  transcribe(audioFile: string): Promise<TranscriptionResult>;
}

/**
 * OpenAI-compatible `/audio/transcriptions` (works with OpenAI and with local servers that expose
 * the same API, e.g. faster-whisper based servers). Requests verbose_json for segment times and
 * falls back to json when the model does not support it.
 */
export class OpenAICompatibleTranscription implements TranscriptionProvider {
  readonly provider = "openai_compatible";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 120_000,
  ) {}

  async transcribe(audioFile: string): Promise<TranscriptionResult> {
    try {
      return await this.request(audioFile, "verbose_json");
    } catch (err) {
      if (err instanceof ProviderError && err.status === 400 && /response_format|verbose_json/i.test(err.message)) {
        return this.request(audioFile, "json");
      }
      throw err;
    }
  }

  private async request(audioFile: string, format: "verbose_json" | "json"): Promise<TranscriptionResult> {
    const bytes = await readFile(audioFile);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: audioType(audioFile) }), path.basename(audioFile));
    form.append("model", this.model);
    form.append("response_format", format);
    if (format === "verbose_json") form.append("timestamp_granularities[]", "segment");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ProviderError(`transcription request failed: ${(err as Error).message}`, null, true, this.provider);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`transcription returned ${res.status}: ${text.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429, this.provider);
    const json = JSON.parse(text) as { text?: string; language?: string; segments?: { start: number; end: number; text: string }[] };
    return {
      text: (json.text ?? "").trim(),
      language: json.language ?? null,
      segments: (json.segments ?? []).map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text.trim() })),
      model: this.model,
      provider: this.provider,
    };
  }
}

/**
 * ElevenLabs Scribe (`POST /v1/speech-to-text`). The language is detected by the service unless one
 * is given; sounds like laughter come back tagged as audio events.
 */
export class ElevenLabsTranscription implements TranscriptionProvider {
  readonly provider = "elevenlabs";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 120_000,
  ) {}

  async transcribe(audioFile: string): Promise<TranscriptionResult> {
    const bytes = await readFile(audioFile);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: audioType(audioFile) }), path.basename(audioFile));
    form.append("model_id", this.model);
    form.append("tag_audio_events", "true");
    form.append("timestamps_granularity", "word");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ProviderError(`transcription request failed: ${(err as Error).message}`, null, true, this.provider);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`transcription returned ${res.status}: ${text.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429, this.provider);
    const json = JSON.parse(text) as {
      text?: string;
      language_code?: string;
      language_probability?: number;
      words?: { text: string; start?: number; end?: number; type?: string }[];
    };
    const words = json.words ?? [];
    const ms = (s: number | undefined) => Math.round((s ?? 0) * 1000);
    return {
      text: (json.text ?? "").trim(),
      language: json.language_code ?? null,
      languageProbability: typeof json.language_probability === "number" ? json.language_probability : null,
      segments: wordSegments(words.filter((w) => w.type !== "audio_event").map((w) => ({ text: w.text, startMs: ms(w.start), endMs: ms(w.end), spacing: w.type === "spacing" }))),
      events: words.filter((w) => w.type === "audio_event").map((w) => ({ text: w.text.trim(), startMs: ms(w.start), endMs: ms(w.end) })),
      model: this.model,
      provider: this.provider,
    };
  }
}

/** Words → sentence-like segments, split at a pause of 0.8 s or at the end of a sentence. */
export function wordSegments(words: { text: string; startMs: number; endMs: number; spacing?: boolean }[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  for (const w of words) {
    if (w.spacing) {
      if (cur) cur.text += w.text;
      continue;
    }
    if (cur && (w.startMs - cur.endMs > 800 || /[.!?]\s*$/.test(cur.text))) {
      out.push({ ...cur, text: cur.text.trim() });
      cur = null;
    }
    if (!cur) cur = { startMs: w.startMs, endMs: w.endMs, text: w.text };
    else {
      cur.text += w.text;
      cur.endMs = w.endMs;
    }
  }
  if (cur && cur.text.trim()) out.push({ ...cur, text: cur.text.trim() });
  return out;
}

/** Plan overlapping audio chunks so words at chunk borders are not lost. */
export function planAudioChunks(durationMs: number, chunkMs = 30_000, overlapMs = 4_000): { startMs: number; durationMs: number }[] {
  const out: { startMs: number; durationMs: number }[] = [];
  const step = Math.max(1000, chunkMs - overlapMs);
  for (let s = 0; s < durationMs; s += step) {
    out.push({ startMs: s, durationMs: Math.min(chunkMs, durationMs - s) });
    if (s + chunkMs >= durationMs) break;
  }
  return out;
}

/** Remove the overlapped duplicate words at the start of a chunk's transcript. */
export function dedupeOverlap(previousText: string, nextText: string): string {
  const prev = previousText.trim().split(/\s+/).slice(-12);
  const next = nextText.trim().split(/\s+/);
  for (let k = Math.min(prev.length, next.length); k >= 3; k--) {
    const tail = prev.slice(-k).join(" ").toLowerCase();
    const head = next.slice(0, k).join(" ").toLowerCase();
    if (tail === head) return next.slice(k).join(" ");
  }
  return nextText.trim();
}
