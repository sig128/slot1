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
  language: string | null;
  /** Segment times are relative to the chunk start. Empty if the provider gave none. */
  segments: TranscriptSegment[];
  model: string;
}

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
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), path.basename(audioFile));
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
    };
  }
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
