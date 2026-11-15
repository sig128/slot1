import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ElevenLabsTranscription,
  languageName,
  OpenAICompatibleTranscription,
  PcmChunker,
  pcmDbfs,
  soundTags,
  speechCandidate,
  spokenText,
  wavFromPcm,
  wordSegments,
} from "@slot1/analysis";
import { settingsEntries, SettingsPatch, speechServiceOf } from "@slot1/contracts";

const tone = (seconds: number, amplitude: number) => {
  const n = Math.round(seconds * 16_000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / 16_000) * 2 * Math.PI * 440) * amplitude * 32767), i * 2);
  return b;
};

describe("live speech audio", () => {
  it("measures loudness: silence, a full tone, a quiet one", () => {
    expect(pcmDbfs(Buffer.alloc(3200))).toBe(-Infinity);
    expect(pcmDbfs(tone(0.5, 1))).toBeCloseTo(-3, 0);
    expect(pcmDbfs(tone(0.5, 0.01))).toBeLessThan(-40);
  });

  it("wraps PCM in a WAV header every speech service accepts", () => {
    const pcm = tone(0.25, 0.5);
    const wav = wavFromPcm(pcm);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(44 + pcm.length);
  });

  it("cuts the stream into whole chunks and keeps when each began", () => {
    const c = new PcmChunker(1000); // 32,000 bytes a chunk
    const t0 = new Date("2026-11-15T18:00:01.500Z");
    // 1.5 s of audio arriving at once: one full chunk, half of the next one waiting.
    const out = c.push(Buffer.alloc(48_000, 1), t0);
    expect(out).toHaveLength(1);
    expect(out[0]!.pcm.length).toBe(32_000);
    expect(out[0]!.startedAt.toISOString()).toBe("2026-11-15T18:00:00.000Z");
    expect(out[0]!.durationMs).toBe(1000);
    const next = c.push(Buffer.alloc(16_000, 1), new Date("2026-11-15T18:00:02.000Z"));
    expect(next).toHaveLength(1);
    expect(next[0]!.startedAt.toISOString()).toBe("2026-11-15T18:00:01.000Z");
    expect(c.push(Buffer.alloc(10), new Date())).toHaveLength(0);
  });
});

describe("any language", () => {
  it("names the detected language in English, from names or ISO codes", () => {
    expect(languageName("norwegian")).toBe("Norwegian");
    expect(languageName("tur")).toBe("Turkish");
    expect(languageName("no")).toBe("Norwegian");
    expect(languageName("eng")).toBe("English");
    expect(languageName("ar")).toBe("Arabic");
    expect(languageName("th")).toBe("Thai");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("")).toBeNull();
    expect(languageName(null)).toBeNull();
  });

  it("logs what was said with the original words, and nothing for noise alone", () => {
    const base = { mediaStartMs: 30_000, durationMs: 12_000, transcriptAssetId: "t1", frame: null, receivedAt: new Date("2026-11-15T18:00:00Z") };
    const tr = speechCandidate({ ...base, result: { text: " Polis geliyor, kaçın! ", language: "turkish", segments: [], model: "whisper-large-v3-turbo", provider: "openai_compatible" } }, "2026-11-15T18:00:13Z");
    expect(tr).toMatchObject({
      type: "dialogue",
      origin: "audio",
      interpretation: "inferred",
      description: "Said (Turkish): “Polis geliyor, kaçın!”",
      rawText: "Polis geliyor, kaçın!",
      mediaStartMs: 30_000,
      mediaEndMs: 42_000,
      evidence: [{ assetId: "t1", kind: "transcript", mediaPtsMs: 30_000 }],
      model: { provider: "openai_compatible", version: "whisper-large-v3-turbo" },
      fusable: false,
    });
    const ar = speechCandidate({ ...base, result: { text: "يلا بسرعة", language: "ar", segments: [], model: "scribe_v2", languageProbability: 0.97 } }, "x");
    expect(ar?.description).toBe("Said (Arabic): “يلا بسرعة”");
    expect(ar?.modelConfidence).toBe(0.97);
    expect(speechCandidate({ ...base, result: { text: "(music) [applause]", language: "en", segments: [], model: "m" } }, "x")).toBeNull();
    expect(speechCandidate({ ...base, result: { text: "…", language: null, segments: [], model: "m" } }, "x")).toBeNull();
    const long = speechCandidate({ ...base, result: { text: "word ".repeat(100), language: null, segments: [], model: "m" } }, "x");
    expect(long!.description.length).toBeLessThan(300);
    expect(long!.description.startsWith("Said: “")).toBe(true);
    expect(spokenText("[laughs] hello there (music)")).toBe("hello there");
  });

  it("keeps tagged sounds for reactions", () => {
    expect(soundTags({ text: "", language: null, segments: [], model: "m", events: [{ text: "(laughter)", startMs: 0, endMs: 1 }, { text: "(Laughter)", startMs: 2, endMs: 3 }] })).toEqual(["laughter"]);
  });
});

describe("speech-to-text services", () => {
  let dir = "";
  let wav = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "slot1-stt-"));
    wav = path.join(dir, "chunk.wav");
    await writeFile(wav, wavFromPcm(tone(0.2, 0.3)));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("ElevenLabs Scribe: detects the language itself and returns words and sounds", async () => {
    let seen: { url: string; headers: Record<string, string>; form: FormData } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, form: init.body as FormData };
      return new Response(
        JSON.stringify({
          language_code: "nor",
          language_probability: 0.94,
          text: "Hei alle sammen! (laughter)",
          words: [
            { text: "Hei", start: 0.1, end: 0.3, type: "word" },
            { text: " ", start: 0.3, end: 0.35, type: "spacing" },
            { text: "alle", start: 0.35, end: 0.6, type: "word" },
            { text: " ", start: 0.6, end: 0.62, type: "spacing" },
            { text: "sammen!", start: 0.62, end: 1.0, type: "word" },
            { text: "(laughter)", start: 1.2, end: 2.0, type: "audio_event" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await new ElevenLabsTranscription("https://api.elevenlabs.io", "sk_test_key_123", "scribe_v2", fetchImpl).transcribe(wav);
    expect(seen!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen!.headers["xi-api-key"]).toBe("sk_test_key_123");
    expect(seen!.form.get("model_id")).toBe("scribe_v2");
    expect(seen!.form.get("tag_audio_events")).toBe("true");
    expect(seen!.form.get("language_code")).toBeNull(); // the service detects it
    expect((seen!.form.get("file") as File).type).toBe("audio/wav");
    expect(r).toMatchObject({ language: "nor", languageProbability: 0.94, provider: "elevenlabs", model: "scribe_v2" });
    expect(r.segments).toEqual([{ startMs: 100, endMs: 1000, text: "Hei alle sammen!" }]);
    expect(r.events).toEqual([{ text: "(laughter)", startMs: 1200, endMs: 2000 }]);
    expect(languageName(r.language)).toBe("Norwegian");
  });

  it("Whisper (Groq, OpenAI or self-hosted): sends WAV and reads the detected language", async () => {
    let form: FormData | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: "vamos, rápido", language: "spanish", segments: [{ start: 0, end: 1.5, text: " vamos, rápido" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new OpenAICompatibleTranscription("https://api.groq.com/openai/v1", "gsk_test", "whisper-large-v3-turbo", fetchImpl).transcribe(wav);
    expect((form!.get("file") as File).type).toBe("audio/wav");
    expect(form!.get("response_format")).toBe("verbose_json");
    expect(r).toMatchObject({ text: "vamos, rápido", language: "spanish", provider: "openai_compatible" });
    expect(languageName(r.language)).toBe("Spanish");
  });

  it("splits words into sentences at pauses", () => {
    expect(
      wordSegments([
        { text: "go", startMs: 0, endMs: 200 },
        { text: " ", startMs: 200, endMs: 210, spacing: true },
        { text: "now", startMs: 210, endMs: 400 },
        { text: "wait", startMs: 1500, endMs: 1700 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 400, text: "go now" },
      { startMs: 1500, endMs: 1700, text: "wait" },
    ]);
  });
});

describe("Admin → Speech to text", () => {
  it("one choice sets the service, its address and its model", () => {
    const groq = settingsEntries(SettingsPatch.parse({ speechService: "groq", speechApiKey: "gsk_abcdefghijklmnop" }));
    expect(groq).toEqual({
      ok: true,
      entries: [
        { key: "TRANSCRIPTION_PROVIDER", value: "openai_compatible" },
        { key: "TRANSCRIPTION_BASE_URL", value: "https://api.groq.com/openai/v1" },
        { key: "TRANSCRIPTION_MODEL", value: "whisper-large-v3-turbo" },
        { key: "TRANSCRIPTION_API_KEY", value: "gsk_abcdefghijklmnop" },
      ],
    });
    const eleven = settingsEntries(SettingsPatch.parse({ speechService: "elevenlabs" }));
    expect(eleven.ok && eleven.entries.map((e) => e.value)).toEqual(["elevenlabs", "https://api.elevenlabs.io", "scribe_v2"]);
    expect(settingsEntries(SettingsPatch.parse({ speechService: "off" }))).toEqual({ ok: true, entries: [{ key: "TRANSCRIPTION_PROVIDER", value: "none" }] });
    const own = settingsEntries(SettingsPatch.parse({ speechService: "custom", speechBaseUrl: "http://whisper:8000/v1", speechModel: "whisper-large-v3" }));
    expect(own.ok && own.entries).toEqual([
      { key: "TRANSCRIPTION_PROVIDER", value: "openai_compatible" },
      { key: "TRANSCRIPTION_BASE_URL", value: "http://whisper:8000/v1" },
      { key: "TRANSCRIPTION_MODEL", value: "whisper-large-v3" },
    ]);
    expect(settingsEntries(SettingsPatch.parse({ speechBaseUrl: "ftp://x" })).ok).toBe(false);
    expect(settingsEntries(SettingsPatch.parse({ speechApiKey: "has space in it" })).ok).toBe(false);
    expect(settingsEntries(SettingsPatch.parse({ speechApiKey: "" }))).toEqual({ ok: true, entries: [{ key: "TRANSCRIPTION_API_KEY", value: null }] });
  });

  it("reads back which service the server uses", () => {
    expect(speechServiceOf("none", "https://api.openai.com/v1")).toBe("off");
    expect(speechServiceOf("openai_compatible", "https://api.groq.com/openai/v1")).toBe("groq");
    expect(speechServiceOf("openai_compatible", "https://api.openai.com/v1")).toBe("openai");
    expect(speechServiceOf("openai_compatible", "http://whisper:8000/v1")).toBe("custom");
    expect(speechServiceOf("elevenlabs", "https://api.elevenlabs.io")).toBe("elevenlabs");
  });
});
