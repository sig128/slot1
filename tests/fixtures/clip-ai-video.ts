import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FONTS = [
  "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];

/**
 * A synthetic 40 s test video for the AI clip tools (no gameplay, no third-party footage):
 *
 *   picture  0–8 s test pattern with "Go to the docks", 8–10 s black, 10–28 s test pattern,
 *            28–40 s bars with a large "MISSION PASSED" card
 *   sound    a quiet pink-noise bed, a loud 880 Hz tone at 16–18 s, true silence at 22–26 s
 *
 * Every signal the tools rank or cut on is really in the file, so tests can check the exact
 * times SLOT1 reports. Returns the path of the MP4 (written into `out`, or a new temp folder).
 */
export function makeClipAiVideo(out?: string): string {
  const font = FONTS.find((f) => existsSync(f));
  if (!font) throw new Error("No font for ffmpeg drawtext (install fonts-dejavu or Inter)");
  const dir = mkdtempSync(path.join(tmpdir(), "slot1-clipai-video-"));
  const file = out ?? path.join(dir, "clip-ai-test.mp4");
  try {
    writeFileSync(path.join(dir, "a.txt"), "Go to the docks");
    writeFileSync(path.join(dir, "b.txt"), "MISSION PASSED");
    const dt = (name: string, size: number, x: string, y: string) =>
      `drawtext=fontfile='${font}':textfile='${path.join(dir, name)}':fontsize=${size}:fontcolor=white:x=${x}:y=${y}:box=1:boxcolor=black@0.55:boxborderw=14`;
    const mono = "aformat=sample_rates=48000:channel_layouts=mono";
    // prettier-ignore
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=8",
      "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=2",
      "-f", "lavfi", "-i", "testsrc=s=1280x720:r=30:d=18",
      "-f", "lavfi", "-i", "smptehdbars=s=1280x720:r=30:d=12",
      "-f", "lavfi", "-i", "anoisesrc=d=16:c=pink:r=48000:a=0.03:seed=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2",
      "-f", "lavfi", "-i", "anoisesrc=d=4:c=pink:r=48000:a=0.03:seed=2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=4",
      "-f", "lavfi", "-i", "anoisesrc=d=14:c=pink:r=48000:a=0.03:seed=3",
      "-filter_complex", [
        `[0:v]${dt("a.txt", 44, "(w-text_w)/2", "h*0.82")}[v0]`,
        `[3:v]${dt("b.txt", 84, "(w-text_w)/2", "(h-text_h)/2")}[v3]`,
        "[v0][1:v][2:v][v3]concat=n=4:v=1:a=0,format=yuv420p[v]",
        `[4:a]${mono}[a0]`, `[5:a]volume=6,${mono}[a1]`, `[6:a]${mono}[a2]`, `[7:a]${mono}[a3]`, `[8:a]${mono}[a4]`,
        "[a0][a1][a2][a3][a4]concat=n=5:v=0:a=1[a]",
      ].join(";"),
      "-map", "[v]", "-map", "[a]", "-t", "40", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "60",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", file,
    ]);
  } finally {
    for (const f of ["a.txt", "b.txt"]) rmSync(path.join(dir, f), { force: true });
  }
  return file;
}
