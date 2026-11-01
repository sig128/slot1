import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Edl } from "@slot1/contracts";
import { buildEdlRender, findRenderFonts, findRenderFontsDir, refKey } from "./edl-render";
const S = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
const dir = process.argv[2]!;
const sample = "/home/claude/slot1/tests/fixtures/generated/sample-replay.mp4";
const M = { path: sample, offsetMs: 0, width: 1280, height: 720, hasAudio: true };
const V = process.env.VARIANT ?? "";
const raw: Record<string, any> = ({
  version: 1, aspect: "9:16", layout: "split", split: { cam: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, camShare: 0.35, camOnTop: true },
  segments: [
    { id: "a", sessionId: S, inMs: 2000, outMs: 5000, keys: [{ atMs: 2000, x: 0.3, y: 0.5, zoom: 1 }, { atMs: 5000, x: 0.7, y: 0.5, zoom: 1.6 }] },
    { id: "b", sessionId: S, inMs: 9000, outMs: 12000, rampTo: 0.5, transitionIn: { kind: "flash", durationMs: 400 } },
    { id: "c", sessionId: S, inMs: 20000, outMs: 22000, volume: 0.6, transitionIn: { kind: "glitch", durationMs: 300 } },
  ],
  overlays: [{ id: "ov", items: [
    { type: "text", id: "t1", startMs: 0, endMs: 2500, text: "THE DOCKS JOB", subtext: "Mission 4", style: "title-card", animation: "pop", y: 0.3 },
    { type: "image", id: "s1", startMs: 1000, endMs: 4000, source: { kind: "library", assetId: "sticker/test" }, widthPct: 0.4, keys: [{ atMs: 1000, x: 0.2, y: 0.75, scale: 0.6, rotation: -10, opacity: 0.4 }, { atMs: 3000, x: 0.75, y: 0.7, scale: 1.1, rotation: 8, opacity: 1 }] },
    { type: "pip", id: "p1", startMs: 4500, endMs: 7000, sessionId: S, sourceInMs: 30000, widthPct: 0.4, x: 0.75, y: 0.8 },
    { type: "text", id: "t2", startMs: 5000, endMs: 8000, text: "streamer_name", subtext: "GTA V live", style: "lower-third", animation: "slide", x: 0.08, y: 0.86 },
  ] }],
  audioTracks: [
    { id: "m", kind: "music", duck: true, volume: 0.8, clips: [{ id: "c1", source: { kind: "upload", assetId: "11111111-2222-4333-8444-555555555555" }, startMs: 0, durationMs: 9000, loop: true, fadeOutMs: 800 }] },
    { id: "fx", kind: "sfx", clips: [{ id: "w1", source: { kind: "library", assetId: "sfx/whoosh" }, startMs: 2700, durationMs: 800, envelope: [{ atMs: 2700, volume: 0.2 }, { atMs: 3000, volume: 1 }] }] },
  ],
  effects: [{ id: "e1", kind: "punch", startMs: 1500, endMs: 2100, amount: 0.4 }, { id: "e2", kind: "wasted", startMs: 7200, endMs: 8400 }, { id: "e3", kind: "shake", startMs: 3300, endMs: 3900 }],
  grade: { preset: "vice-night", vignette: 0.4, grain: 0.2 },
  captionTrack: { style: "karaoke", cues: [{ id: "k1", startMs: 3000, endMs: 5500, text: "no way we made it out" }] },
  sourceAudio: { voiceBoost: true, denoise: true },
  normalize: true, fadeOutMs: 300,
});
if (V.includes("nowasted")) raw.effects = raw.effects.filter((e: { kind: string }) => e.kind !== "wasted");
if (V.includes("nofx")) raw.effects = [];
if (V.includes("nopip")) raw.overlays[0].items = raw.overlays[0].items.filter((i: { type: string }) => i.type !== "pip");
if (V.includes("noov")) raw.overlays = [];
if (V.includes("noaudio")) raw.audioTracks = [];
if (V.includes("noxfade")) raw.segments = raw.segments.map((s: Record<string, unknown>) => ({ ...s, transitionIn: undefined }));
const edl = Edl.parse(raw);
const media = edl.segments.map(() => M);
const opts = process.argv[3] === "small" ? { height: 720 as const, quality: "small" as const } : process.argv[3] === "gif" ? { format: "gif" as const } : process.argv[3] === "audio" ? { format: "audio" as const } : process.argv[3] === "yt" ? { aspect: "16:9" as const, height: 720 as const, fps: 24 as const, quality: "small" as const, maxrateKbps: 4000 } : undefined;
const out = `${dir}/multi${V ? `-${V}` : ""}.${opts?.format === "gif" ? "gif" : opts?.format === "audio" ? "m4a" : "mp4"}`;
const plan = buildEdlRender({ edl, media, output: out, workDir: dir, fonts: findRenderFonts(), fontsDir: findRenderFontsDir(), options: opts,
  refs: { [refKey({ kind: "library", assetId: "sticker/test" })]: { path: `${dir}/sticker.png`, kind: "image" }, [refKey({ kind: "upload", assetId: "11111111-2222-4333-8444-555555555555" })]: { path: `${dir}/bed.m4a`, kind: "audio" }, [refKey({ kind: "library", assetId: "sfx/whoosh" })]: { path: `${dir}/whoosh.m4a`, kind: "audio" } },
  pips: { p1: M } });
for (const f of plan.textFiles) writeFileSync(f.path, f.content);
console.log("duration", plan.durationMs, plan.width, plan.height, plan.container);
writeFileSync(`${out}.args.json`, JSON.stringify(plan.args, null, 1));
if (process.env.DRY) process.exit(0);
const t0 = Date.now();
const log = `${out}.log`;
const r = spawnSync("bash", ["-c", 'ffmpeg -loglevel warning "$@" 2>"$LOG"; rc=$?; times; exit $rc', "_", ...plan.args.filter((a) => a !== "-progress" && a !== "pipe:1")], { env: { ...process.env, LOG: log }, encoding: "utf8" });
console.log("exit", r.status, "wall ms", Date.now() - t0, "times(shell/children user sys):", r.stdout.trim().replace(/\n/g, " | "));
if (r.status !== 0) { console.log(readFileSync(log, "utf8").split("\n").filter((l) => !/OFL\.txt|libass|Loading font|Shaper|Added subtitle|font provider|swscaler/.test(l)).slice(-25).join("\n")); process.exit(1); }
