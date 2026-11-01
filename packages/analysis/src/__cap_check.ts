import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Edl } from "@slot1/contracts";
import { buildEdlRender, findRenderFonts, findRenderFontsDir, refKey } from "./edl-render";
const dir = process.argv[2]!;
const S = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
const UP = "11111111-2222-4333-8444-555555555555";
const IMG = "21111111-2222-4333-8444-555555555555";
const M = { path: "/home/claude/slot1/tests/fixtures/generated/sample-replay.mp4", offsetMs: 0, width: 1280, height: 720, hasAudio: true };
const edl = Edl.parse({
  version: 1, aspect: "9:16", layout: "split", split: { cam: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, camShare: 0.38, camOnTop: true },
  segments: [{ id: "a", sessionId: S, inMs: 1000, outMs: 4000 }, { id: "b", sessionId: S, inMs: 14_000, outMs: 17_000, transitionIn: { kind: "crossfade", durationMs: 500 } }, { id: "c", sessionId: S, inMs: 27_000, outMs: 32_000, transitionIn: { kind: "flash", durationMs: 300 } }],
  overlays: [{ id: "o", items: [{ type: "text", id: "t", startMs: 0, endMs: 2000, text: "THE DOCKS", subtext: "Mission 4", style: "title-card", animation: "pop", y: 0.5 }, { type: "image", id: "l", startMs: 2000, endMs: 4000, source: { kind: "upload", assetId: IMG }, widthPct: 0.2, x: 0.85, y: 0.45 }] }],
  effects: [{ id: "w", kind: "wasted", startMs: 7700, endMs: 10_200 }],
  captionTrack: { style: "line", position: "bottom", cues: [{ id: "k", startMs: 8800, endMs: 9800, text: "THAT DID NOT GO TO PLAN" }] },
  audioTracks: [{ id: "m", name: "Music", kind: "music", duck: true, volume: 0.7, clips: [{ id: "c1", source: { kind: "upload", assetId: UP }, startMs: 0, durationMs: 10_200, loop: true, fadeOutMs: 600 }] }],
  normalize: true,
});
const out = `${dir}/cap.mp4`;
const plan = buildEdlRender({ edl, media: edl.segments.map(() => M), output: out, workDir: dir, fonts: findRenderFonts(), fontsDir: findRenderFontsDir(), refs: { [refKey({ kind: "upload", assetId: UP })]: { path: `${dir}/bed.m4a`, kind: "audio" }, [refKey({ kind: "upload", assetId: IMG })]: { path: `${dir}/sticker.png`, kind: "image" } } });
for (const f of plan.textFiles) writeFileSync(f.path, f.content);
writeFileSync(`${dir}/cap.args.json`, JSON.stringify(plan.args, null, 1));
const r = spawnSync("ffmpeg", plan.args.filter((a) => a !== "-progress" && a !== "pipe:1"), { encoding: "utf8" });
console.log("exit", r.status, r.stderr.split("\n").filter((l) => /rror|nvalid/.test(l)).slice(-5).join("\n"));
