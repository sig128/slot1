import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cutRangesFromEdl,
  Edl,
  edlDurationMs,
  type BoringResponse,
  type ClipAiSessionsResponse,
  type ClipAiStatusResponse,
  type EditForMeResponse,
  type MomentsResponse,
  type PolishResponse,
  type ProjectView,
  type WritePostResponse,
} from "@slot1/contracts";
import { analyzeClipAudio } from "../../apps/worker/src/jobs/clip-ai";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { makeClipAiVideo } from "../fixtures/clip-ai-video";
import { Browser, multipart, startHarness, type Harness } from "./harness";

/** A small Studio library for the test: real (tiny) files and a manifest. */
function makeLibrary(dir: string): string {
  const root = path.join(dir, "library");
  for (const d of ["sfx", "music", "stickers"]) mkdirSync(path.join(root, d), { recursive: true });
  const tone = (file: string, secs: number) =>
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=660:duration=${secs}`, path.join(root, file)]);
  tone("sfx/whoosh-test.wav", 0.6);
  tone("sfx/fanfare-test.wav", 1.8);
  tone("sfx/pop-test.wav", 0.2);
  tone("music/drive-test.wav", 4);
  writeFileSync(path.join(root, "stickers/star-test.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const lic = "Original (SLOT1)";
  writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      assets: [
        { id: "sfx/whoosh-test", kind: "sfx", category: "whooshes", name: "Test whoosh", tags: ["whoosh", "transition"], durationMs: 600, file: "sfx/whoosh-test.wav", license: lic },
        { id: "sfx/fanfare-test", kind: "sfx", category: "stingers", name: "Test fanfare", tags: ["success", "mission", "passed", "stinger"], durationMs: 1800, file: "sfx/fanfare-test.wav", license: lic },
        { id: "sfx/pop-test", kind: "sfx", category: "ui", name: "Test pop", tags: ["pop", "ui"], durationMs: 200, file: "sfx/pop-test.wav", license: lic },
        { id: "music/drive-test", kind: "music", category: "beds", name: "Test drive", tags: ["hype", "synth", "drive"], durationMs: 4000, loop: true, file: "music/drive-test.wav", license: lic },
        { id: "stickers/star-test", kind: "sticker", category: "badges", name: "Test star", tags: ["star"], width: 256, height: 256, file: "stickers/star-test.png", license: lic },
      ],
    }),
  );
  return root;
}

interface StubReply {
  status?: number;
  /** Text content returned by the "model" (JSON as a string, or anything to test parsing). */
  text?: string;
  json?: unknown;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * A stand-in for the Anthropic Messages API on 127.0.0.1. Each test sets `reply`; every request
 * is recorded so the test can check what SLOT1 actually sent. No real model is involved.
 */
class StubModel {
  server: Server;
  base = "";
  calls: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  reply: (body: any) => StubReply = () => ({ status: 500, json: { error: { message: "no stub reply set" } } });

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : null;
        this.calls.push({ path: req.url ?? "", headers: req.headers, body });
        if (req.method !== "POST" || req.url !== "/v1/messages") {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
          return;
        }
        const r = this.reply(body);
        if (r.status && r.status !== 200) {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? { error: { type: "overloaded_error", message: "stub error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "msg_stub",
            type: "message",
            role: "assistant",
            model: body?.model,
            content: [{ type: "text", text: r.text ?? JSON.stringify(r.json) }],
            usage: r.usage ?? { input_tokens: 1200, output_tokens: 300 },
          }),
        );
      });
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  /** The user message of the last call. */
  lastUser(): string {
    return String(this.calls.at(-1)?.body?.messages?.[0]?.content ?? "");
  }
}

function takeJob(h: Harness, name: string) {
  const i = h.jobs.findIndex((j) => j.name === name);
  if (i < 0) throw new Error(`no ${name} job queued (have: ${h.jobs.map((j) => j.name).join(", ")})`);
  return h.jobs.splice(i, 1)[0]!.data as any;
}

/* ================================================================================================ */

/**
 * AI clip tools end to end against the real API, Postgres, Redis, ffmpeg and tesseract. The text
 * model is a local stub of the Anthropic API (labeled as such): it checks the requests SLOT1
 * sends and returns canned answers, including broken ones, so validation is exercised for real.
 */
describe("AI clip tools", () => {
  let tmp = "";
  let h: Harness;
  let plain: Harness;
  let stub: StubModel;
  let creator: Browser;
  let stranger: Browser;
  let anon: Browser;
  let sessionId = "";
  let broadcasterId = "";
  let edl: Edl;
  const previousAssets = process.env.SLOT1_STUDIO_ASSETS_DIR;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "slot1-clipai-"));
    const video = makeClipAiVideo(path.join(tmp, "clip-ai-test.mp4"));
    process.env.SLOT1_STUDIO_ASSETS_DIR = makeLibrary(tmp);
    stub = await new StubModel().start();
    h = await startHarness({
      VISION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "stub-key",
      ANTHROPIC_TEXT_MODEL: "stub-text-model",
      ANTHROPIC_BASE_URL: stub.base,
      VISION_PRICE_INPUT_PER_MTOK: "3",
      VISION_PRICE_OUTPUT_PER_MTOK: "15",
    });
    creator = new Browser(h);
    stranger = new Browser(h);
    anon = new Browser(h);
    await creator.signInLocal("Clip AI Crew");
    await stranger.signInLocal("Not The Owner");
    await anon.refreshCsrf();

    const form = await multipart({ title: "Docks run", rightsConfirmed: "true" }, { field: "file", filename: "docks.mp4", path: video, type: "video/mp4" });
    const up = await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(up.status).toBe(200);
    sessionId = up.json<{ sessionId: string }>().sessionId;
    await analyzeUpload(h.ctx, takeJob(h, "analyze-upload"));
    broadcasterId = (await h.ctx.db.query<{ broadcaster_id: string }>(`SELECT broadcaster_id FROM stream_sessions WHERE id = $1`, [sessionId])).rows[0]!.broadcaster_id;
    edl = Edl.parse({ version: 1, aspect: "9:16", segments: [{ id: "all", sessionId, inMs: 0, outMs: 40_000 }] });
  });

  afterAll(async () => {
    await h?.close();
    await plain?.close();
    await stub?.stop();
    if (previousAssets === undefined) delete process.env.SLOT1_STUDIO_ASSETS_DIR;
    else process.env.SLOT1_STUDIO_ASSETS_DIR = previousAssets;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the creator's sessions with stored video and the tools' status", async () => {
    const r = (await creator.get("/api/clip-ai/sessions")).json<ClipAiSessionsResponse>();
    const s = r.sessions.find((x) => x.id === sessionId)!;
    expect(s).toMatchObject({ title: "Docks run", kind: "replay", media: { available: true, reason: null }, audio: { state: "not_started" } });
    expect(s.durationMs).toBeGreaterThan(39_000);
    expect(s.observations).toBeGreaterThan(0);
    expect(r.textModel).toMatchObject({ available: true, provider: "anthropic", model: "stub-text-model", pricesConfigured: true, pricePerMTok: { input: 3, output: 15 } });
    expect(r.libraryAssets).toBe(5);
    const status = (await creator.get("/api/clip-ai/status")).json<ClipAiStatusResponse>();
    expect(status.libraryAssets).toBe(5);
  });

  it("ranks MISSION PASSED read on screen, then adds the loud moment once the audio is measured", async () => {
    const before = (await creator.get(`/api/clip-ai/sessions/${sessionId}/moments`)).json<MomentsResponse>();
    const passed = before.candidates.find((c) => c.big === "MISSION PASSED");
    expect(passed, JSON.stringify(before.candidates.map((c) => c.title))).toBeTruthy();
    expect(passed!).toMatchObject({ tone: "good", title: "MISSION PASSED" });
    expect(passed!.peakMs).toBeGreaterThanOrEqual(27_000);
    expect(passed!.peakMs).toBeLessThanOrEqual(40_000);
    expect(passed!.reasons[0]!.label).toMatch(/^MISSION PASSED read on screen at 00:(2[7-9]|3\d)$/);
    expect(passed!.reasons[0]!.observationId).toBeTruthy();
    expect(passed!.frameUrl).toMatch(/^\/api\/media\//); // the stored evidence frame, signed
    expect(before.note).toContain("audio hasn't been analyzed yet");
    expect(before.candidates.some((c) => c.reasons.some((r) => r.signal === "audio_peak"))).toBe(false);

    // Start the loudness pass and run the worker job it queued.
    const queued = (await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/audio`)).json<{ state: string }>();
    expect(queued.state).toBe("queued");
    const running = (await creator.get(`/api/clip-ai/sessions/${sessionId}/moments`)).json<MomentsResponse>();
    expect(running.session.audio.state).toBe("queued");
    expect(running.note).toContain("Listening to the audio now");
    // Asking again doesn't queue a second pass.
    expect((await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/audio`)).json<{ state: string }>().state).toBe("queued");
    await analyzeClipAudio(h.ctx, takeJob(h, "clip-ai-audio"));
    expect(h.jobs.filter((j) => j.name === "clip-ai-audio")).toHaveLength(0);

    const { rows } = await h.ctx.db.query<{ status: string; rms_db: number[] }>(`SELECT status, rms_db FROM clip_ai_audio WHERE session_id = $1`, [sessionId]);
    expect(rows[0]!.status).toBe("ready");
    const rms = rows[0]!.rms_db.map(Number);
    expect(rms.length).toBeGreaterThanOrEqual(39);
    expect(Math.max(...rms.slice(16, 18))).toBeGreaterThan(-12); // the loud tone
    expect(Math.max(...rms.slice(23, 26))).toBeLessThan(-60); // true silence
    expect(rms[5]!).toBeLessThan(-25); // the quiet bed

    const after = (await creator.get(`/api/clip-ai/sessions/${sessionId}/moments`)).json<MomentsResponse>();
    expect(after.session.audio.state).toBe("ready");
    expect(after.signals.audioPeaks).toBeGreaterThanOrEqual(1);
    const loud = after.candidates.flatMap((c) => c.reasons).find((r) => r.signal === "audio_peak")!;
    expect(loud.label).toMatch(/^Audio spike \+\d+ dB at 00:1[67]$/);
    expect(loud.atMs).toBeGreaterThanOrEqual(16_000);
    expect(loud.atMs).toBeLessThan(18_000);
    expect(after.note).toBeNull();
    const top = after.candidates[0]!;
    expect(top.score).toBeGreaterThan(0);
    expect(top.stars).toBeGreaterThanOrEqual(1);
  });

  it("turns moments into editable projects: one clip, or one best-of reel", async () => {
    const m = (await creator.get(`/api/clip-ai/sessions/${sessionId}/moments`)).json<MomentsResponse>();
    const passed = m.candidates.find((c) => c.big === "MISSION PASSED")!;
    const pick = (c: typeof passed) => ({ startMs: c.startMs, endMs: c.endMs, title: c.title, peakMs: c.peakMs, tone: c.tone, big: c.big });

    const single = await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/clips`, { json: { mode: "single", aspect: "9:16", moments: [pick(passed)] } });
    expect(single.status).toBe(200);
    const [id] = single.json<{ projectIds: string[] }>().projectIds;
    const p = (await creator.get(`/api/projects/${id}`)).json<ProjectView>();
    expect(p.title).toBe("MISSION PASSED · Docks run");
    expect(p.edl.segments[0]).toMatchObject({ sessionId, inMs: passed.startMs, outMs: passed.endMs });
    expect(p.edl.effects.some((f) => f.kind === "passed")).toBe(true);
    expect(p.edl.layout).toBe("fit");

    const reelPicks = [
      { startMs: 1_000, endMs: 9_000, title: "Opening", peakMs: null, tone: "neutral", big: null },
      pick(passed),
    ];
    const reel = await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/clips`, { json: { mode: "reel", aspect: "16:9", moments: reelPicks.reverse() } });
    const [reelId] = reel.json<{ projectIds: string[] }>().projectIds;
    const rp = (await creator.get(`/api/projects/${reelId}`)).json<ProjectView>();
    expect(rp.title).toBe("Best of Docks run");
    expect(rp.edl.segments.map((s) => s.inMs)).toEqual([1_000, passed.startMs]);
    expect(rp.edl.segments[1]!.transitionIn.kind).toBe("whip");

    // Moments past the end of the stored video are clamped, not trusted.
    const clamped = await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/clips`, { json: { mode: "single", moments: [{ startMs: 35_000, endMs: 90_000, title: "Late" }] } });
    const cp = (await creator.get(`/api/projects/${clamped.json<{ projectIds: string[] }>().projectIds[0]}`)).json<ProjectView>();
    expect(cp.edl.segments[0]!.outMs).toBeLessThanOrEqual(40_100);
    const outside = await creator.request("POST", `/api/clip-ai/sessions/${sessionId}/clips`, { json: { mode: "single", moments: [{ startMs: 80_000, endMs: 90_000, title: "Nope" }] } });
    expect(outside.status).toBe(400);
  });

  it("finds the black screen and the silence, and the cut moves everything with it", async () => {
    const r = await creator.request("POST", "/api/clip-ai/boring", { json: { edl } });
    expect(r.status).toBe(200);
    const b = r.json<BoringResponse>();
    const black = b.parts.find((p) => p.kind === "black");
    const silence = b.parts.find((p) => p.kind === "silence");
    expect(black, JSON.stringify(b.parts)).toBeTruthy();
    expect(black!.startMs).toBeGreaterThanOrEqual(7_500);
    expect(black!.endMs).toBeLessThanOrEqual(10_500);
    expect(black!.observationId).toBeTruthy();
    expect(silence, JSON.stringify(b.parts)).toBeTruthy();
    expect(silence!.startMs).toBeGreaterThanOrEqual(21_000);
    expect(silence!.endMs).toBeLessThanOrEqual(27_000);
    expect(b.audio[0]!.status.state).toBe("ready");
    expect(b.note).toBeNull();

    const cut = cutRangesFromEdl(edl, [black!, silence!]);
    expect(cut.error).toBeNull();
    expect(edlDurationMs(cut.edl!)).toBe(40_000 - cut.removedMs);
    expect(cut.edl!.segments.length).toBe(3);
  });

  it("adds sounds, music and GTA effects at real moments without an AI key", async () => {
    const r = await creator.request("POST", "/api/clip-ai/polish", { json: { edl, sounds: true, music: true, effects: true } });
    expect(r.status).toBe(200);
    const p = r.json<PolishResponse>();
    expect(p.usedAi).toBe(false);
    expect(p.usage).toBeNull();
    const fanfare = p.placed.find((a) => a.assetId === "sfx/fanfare-test")!;
    expect(fanfare).toMatchObject({ kind: "sfx", name: "Test fanfare", reason: "MISSION PASSED on screen", previewUrl: "/api/studio/assets/file/sfx/fanfare-test.wav" });
    expect(fanfare.atMs).toBeGreaterThanOrEqual(27_000);
    expect(p.placed.some((a) => a.assetId === "music/drive-test" && a.atMs === 0)).toBe(true);
    expect(p.edl.audioTracks.map((t) => t.name)).toEqual(["AI sounds", "Music"]);
    expect(p.edl.audioTracks[1]).toMatchObject({ kind: "music", duck: true });
    expect(p.edl.effects.some((f) => f.kind === "passed" && f.text === "MISSION PASSED")).toBe(true);
    expect(p.changes).toEqual(expect.arrayContaining(["Adds the audio track “AI sounds”", expect.stringMatching(/^Adds sound “Test fanfare” at 0:/)]));
    expect(Edl.safeParse(p.edl).success).toBe(true);
  });

  it("lets the AI choose sounds only from the library and only at real cues", async () => {
    stub.reply = (body) => {
      const cues = [...String(body.messages[0].content).matchAll(/^- (\d+) ms: (.+)$/gm)].map((m) => Number(m[1]));
      return {
        json: {
          sounds: [
            { assetId: "sfx/pop-test", atMs: cues[0]! + 100, volume: 0.8, reason: "title pop" },
            { assetId: "sfx/not-in-library", atMs: cues[0]!, volume: 1, reason: "made up" },
            { assetId: "sfx/whoosh-test", atMs: 39_000, volume: 1, reason: "not at a cue" },
          ],
        },
        usage: { input_tokens: 2000, output_tokens: 150 },
      };
    };
    const r = await creator.request("POST", "/api/clip-ai/polish", { json: { edl, sounds: true, refine: true } });
    expect(r.status).toBe(200);
    const p = r.json<PolishResponse>();
    expect(p.usedAi).toBe(true);
    expect(p.placed.map((a) => a.assetId)).toEqual(["sfx/pop-test"]);
    expect(p.usage).toEqual({ inputTokens: 2000, outputTokens: 150, estimatedCostUsd: (2000 * 3 + 150 * 15) / 1e6 });
    const sent = stub.calls.at(-1)!;
    expect(sent.headers["x-api-key"]).toBe("stub-key");
    expect(sent.body.output_config.format.type).toBe("json_schema");
    expect(stub.lastUser()).toContain("sfx/fanfare-test");
  });

  it("proposes an edit from a request, strips unknown library items and shows every change", async () => {
    stub.reply = (body) => {
      const user = String(body.messages[0].content);
      const current = JSON.parse(user.split("CURRENT EDIT (JSON):\n")[1]!.split("\n")[0]!);
      current.segments[0].speed = 2;
      current.audioTracks = [
        {
          id: "ai-sfx-1",
          name: "AI sounds",
          kind: "sfx",
          clips: [
            { id: "s1", source: { kind: "library", assetId: "sfx/fanfare-test" }, startMs: 14_000, durationMs: 1_800 },
            { id: "s2", source: { kind: "library", assetId: "sfx/invented-sound" }, startMs: 2_000, durationMs: 500 },
          ],
        },
      ];
      return { json: { summary: "Doubled the speed and added a fanfare on MISSION PASSED.", edl: current }, usage: { input_tokens: 9000, output_tokens: 1400 } };
    };
    const r = await creator.request("POST", "/api/clip-ai/edit", { json: { request: "make it faster and add a fanfare at mission passed", edl } });
    expect(r.status).toBe(200);
    const e = r.json<EditForMeResponse>();
    expect(e.summary).toBe("Doubled the speed and added a fanfare on MISSION PASSED.");
    expect(e.unchanged).toBe(false);
    expect(e.stripped).toEqual(["library item “sfx/invented-sound”"]);
    expect(e.changes).toEqual(expect.arrayContaining(["Length 0:40.0 → 0:20.0", "Part 1 plays at 2×", "Adds the audio track “AI sounds”", "Adds sound “Test fanfare” at 0:14.0"]));
    expect(e.placed).toEqual([expect.objectContaining({ assetId: "sfx/fanfare-test", atMs: 14_000, previewUrl: "/api/studio/assets/file/sfx/fanfare-test.wav" })]);
    expect(e.edl.audioTracks[0]!.clips.map((c) => c.id)).toEqual(["s1"]);
    expect(e.model).toBe("stub-text-model");
    expect(e.usage.estimatedCostUsd).toBeCloseTo((9000 * 3 + 1400 * 15) / 1e6, 8);

    // What SLOT1 sent: the request as data, the edit, detected moments, the library and a strict schema.
    const sent = stub.calls.at(-1)!.body;
    expect(sent.model).toBe("stub-text-model");
    expect(sent.system).toContain("use only ids from LIBRARY");
    const user = stub.lastUser();
    expect(user).toContain("<request>\nmake it faster and add a fanfare at mission passed\n</request>");
    expect(user).toMatch(/MISSION PASSED/);
    expect(user).toContain("sfx/whoosh-test | sfx | whooshes | Test whoosh");
    expect(JSON.stringify(sent.output_config.format.schema)).not.toMatch(/"default":|"oneOf":/);

    // Usage is logged per call, with the cost from the server's prices.
    const usage = await h.ctx.db.query<{ n: number; cost: string }>(`SELECT count(*)::int AS n, sum(estimated_cost_usd)::text AS cost FROM usage_events WHERE broadcaster_id = $1 AND kind = 'clip_ai'`, [broadcasterId]);
    expect(usage.rows[0]!.n).toBe(2);
  });

  it("rejects proposals that aren't valid edits or reach outside this edit", async () => {
    const ask = () => creator.request("POST", "/api/clip-ai/edit", { json: { request: "make it better", edl } });

    stub.reply = () => ({ json: { summary: "Removed everything.", edl: { version: 1, aspect: "9:16", segments: [] } } });
    let r = await ask();
    expect(r.status).toBe(422);
    expect(r.json().error.message).toMatch(/^The AI's edit didn't pass SLOT1's checks \(segments: /);

    stub.reply = () => ({ json: { summary: "Used another video.", edl: { version: 1, aspect: "9:16", segments: [{ id: "x", sessionId: "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f", inMs: 0, outMs: 5_000 }] } } });
    r = await ask();
    expect(r.status).toBe(422);
    expect(r.json().error.message).toBe("The AI used a session that isn't part of this edit. Try rephrasing");

    stub.reply = () => ({ json: { summary: "Longer.", edl: { version: 1, aspect: "9:16", segments: [{ id: "all", sessionId, inMs: 0, outMs: 90_000 }] } } });
    r = await ask();
    expect(r.status).toBe(422);
    expect(r.json().error.message).toMatch(/went past the end of the video/);

    stub.reply = () => ({ text: "Sure! Here is your edit:" });
    r = await ask();
    expect(r.status).toBe(502);
    expect(r.json().error.message).toBe("The AI's reply wasn't valid JSON. Try again");

    stub.reply = () => ({ status: 529 });
    r = await ask();
    expect(r.status).toBe(502);
    expect(r.json().error.message).toBe("The AI provider is busy right now. Try again in a minute");

    // Nothing was changed anywhere: proposals are only returned, never saved.
    stub.reply = () => ({ json: { summary: "Same edit.", edl } });
    const same = (await ask()).json<EditForMeResponse>();
    expect(same.unchanged).toBe(true);
    expect(same.changes).toEqual([]);
  });

  it("writes posts per platform from what was detected, within each platform's limits", async () => {
    stub.reply = () => ({
      json: {
        posts: [
          { platform: "tiktok", title: "Docks run", caption: "Mission passed at the docks", hashtags: ["gta5", "#slot1", "gta"] },
          { platform: "x", title: "", caption: `${"Mission passed. ".repeat(30)}`, hashtags: ["#gta5", "#slot1", "#extra"] },
          { platform: "youtube", title: "Not asked for", caption: "x", hashtags: [] },
        ],
      },
    });
    const r = await creator.request("POST", "/api/clip-ai/post", { json: { edl, platforms: ["tiktok", "x"], tone: "hype" } });
    expect(r.status).toBe(200);
    const w = r.json<WritePostResponse>();
    expect(w.posts.map((p) => p.platform)).toEqual(["tiktok", "x"]);
    expect(w.posts[0]!.hashtags).toEqual(["#gta5", "#slot1", "#gta"]);
    const x = w.posts[1]!;
    expect(`${x.caption}\n\n${x.hashtags.join(" ")}`.length).toBeLessThanOrEqual(280);
    expect(x.hashtags).toHaveLength(2);
    expect(w.basedOn.moments).toBeGreaterThanOrEqual(1);
    const user = stub.lastUser();
    expect(user).toContain("PLATFORMS: tiktok, x");
    expect(user).toMatch(/DETECTED IN THE CLIP[\s\S]*MISSION PASSED on screen/);
  });

  it("limits AI requests per channel per hour", async () => {
    const key = `clipai:rl:${broadcasterId}:${Math.floor(Date.now() / 3_600_000)}`;
    const before = await h.ctx.redis.get(key);
    await h.ctx.redis.set(key, "30");
    const r = await creator.request("POST", "/api/clip-ai/edit", { json: { request: "faster", edl } });
    expect(r.status).toBe(429);
    expect(r.json().error.message).toMatch(/limited to 30 requests an hour per channel/);
    await h.ctx.redis.set(key, before ?? "0");
  });

  it("is creator-only: strangers get not found, signed-out visitors are refused", async () => {
    expect((await anon.get("/api/clip-ai/sessions")).status).toBe(401);
    expect((await anon.get("/api/clip-ai/status")).status).toBe(401);
    expect((await anon.request("POST", "/api/clip-ai/boring", { json: { edl } })).status).toBe(401);
    expect((await stranger.get(`/api/clip-ai/sessions/${sessionId}/moments`)).status).toBe(404);
    expect((await stranger.request("POST", `/api/clip-ai/sessions/${sessionId}/audio`)).status).toBe(404);
    expect((await stranger.request("POST", `/api/clip-ai/sessions/${sessionId}/clips`, { json: { mode: "single", moments: [{ startMs: 0, endMs: 5_000, title: "Mine now" }] } })).status).toBe(404);
    expect((await stranger.request("POST", "/api/clip-ai/boring", { json: { edl } })).status).toBe(404);
    expect((await stranger.request("POST", "/api/clip-ai/polish", { json: { edl } })).status).toBe(404);
    const calls = stub.calls.length;
    expect((await stranger.request("POST", "/api/clip-ai/edit", { json: { request: "steal it", edl } })).status).toBe(404);
    expect((await stranger.request("POST", "/api/clip-ai/post", { json: { edl, platforms: ["x"] } })).status).toBe(404);
    expect(stub.calls.length).toBe(calls); // the model was never asked
    expect((await stranger.get("/api/clip-ai/sessions")).json<ClipAiSessionsResponse>().sessions.some((s) => s.id === sessionId)).toBe(false);
    // Mutations need the CSRF token.
    expect((await creator.request("POST", "/api/clip-ai/boring", { json: { edl }, csrf: false })).status).toBe(403);
  });

  it("says exactly what's missing when the server has no AI key", async () => {
    plain = await startHarness();
    const someone = new Browser(plain);
    await someone.signInLocal("No Key Creator");
    const status = (await someone.get("/api/clip-ai/status")).json<ClipAiStatusResponse>();
    expect(status.textModel).toMatchObject({ available: false, reason: "No AI key is set on this server. On the server, run: slot1 ai" });
    const r = await someone.request("POST", "/api/clip-ai/edit", { json: { request: "faster", edl } });
    expect(r.status).toBe(503);
    expect(r.json().error).toMatchObject({ code: "unavailable", message: "AI writing isn't set up on this server", requirement: "No AI key is set on this server. On the server, run: slot1 ai" });
    expect((await someone.request("POST", "/api/clip-ai/post", { json: { edl, platforms: ["x"] } })).status).toBe(503);
  });
});
