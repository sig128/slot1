import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ObservationType } from "@slot1/contracts";
import type { MediaTools } from "./media";
import { runChecked, runProcess } from "./process";
import type { GameProfile, OcrRegion } from "./profiles";

export interface OcrLine {
  text: string;
  confidence: number; // tesseract mean word confidence 0..100
  regionId: string;
  type: ObservationType;
  /** Tight box around the line in normalized frame coordinates [x, y, w, h], when known. */
  bbox?: [number, number, number, number];
}

export interface OcrEngine {
  readonly name: string;
  readFrame(framePath: string, profile: GameProfile, workDir: string): Promise<OcrLine[]>;
}

interface TsvWord {
  block: number;
  par: number;
  line: number;
  conf: number;
  text: string;
  /** Word box normalized to the OCR'd image (0..1), when the page size is known. */
  box?: [number, number, number, number];
}

export function parseTesseractTsv(tsv: string): TsvWord[] {
  const out: TsvWord[] = [];
  const lines = tsv.split(/\r?\n/);
  let pageW = 0;
  let pageH = 0;
  for (const row of lines.slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    if (level === 1) {
      // The page row carries the size of the image tesseract read.
      pageW = Number(cols[8]) || 0;
      pageH = Number(cols[9]) || 0;
      continue;
    }
    if (level !== 5) continue;
    const text = (cols[11] ?? "").trim();
    const conf = Number(cols[10]);
    if (!text || !Number.isFinite(conf) || conf < 0) continue;
    const [left, top, width, height] = [6, 7, 8, 9].map((i) => Number(cols[i]));
    const box: [number, number, number, number] | undefined =
      pageW > 0 && pageH > 0 && [left, top, width, height].every((v) => Number.isFinite(v))
        ? [left! / pageW, top! / pageH, width! / pageW, height! / pageH]
        : undefined;
    out.push({ block: Number(cols[2]), par: Number(cols[3]), line: Number(cols[4]), conf, text, ...(box ? { box } : {}) });
  }
  return out;
}

/**
 * Keep only lines that look like real, legible text. Gameplay frames are full of textures that
 * OCR reads as noise; these rules deliberately prefer missing text over inventing it.
 */
export function legibleLines(words: TsvWord[], minLineConfidence: number): { text: string; confidence: number; box?: [number, number, number, number] }[] {
  const groups = new Map<string, TsvWord[]>();
  for (const raw of words) {
    // Strip stray punctuation OCR attaches to word edges (box borders, quotes, pipes).
    const text = raw.text.replace(/^[^\p{L}\p{N}$]+/u, "").replace(/[^\p{L}\p{N}$!?.%]+$/u, "");
    if (!text) continue;
    const w = { ...raw, text };
    const key = `${w.block}:${w.par}:${w.line}`;
    const list = groups.get(key) ?? [];
    list.push(w);
    groups.set(key, list);
  }
  const result: { text: string; confidence: number; box?: [number, number, number, number] }[] = [];
  for (const ws of groups.values()) {
    const kept = ws.filter((w) => w.conf >= 55);
    if (kept.length === 0) continue;
    const text = kept
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const confidence = kept.reduce((s, w) => s + w.conf, 0) / kept.length;
    if (confidence < minLineConfidence) continue;
    if (text.length < 3 || text.length > 200) continue;
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    const alnum = (text.match(/[\p{L}\p{N}$]/gu) ?? []).length;
    if (alnum / text.replace(/\s/g, "").length < 0.7) continue;
    const longWords = kept.filter((w) => (w.text.match(/\p{L}/gu) ?? []).length >= 3);
    const singles = kept.filter((w) => w.text.length === 1).length;
    if (longWords.length === 0 && !/\$\s?[\d,]{2,}/.test(text)) continue;
    if (singles > kept.length / 2) continue;
    if (letters === 0 && !/\$/.test(text)) continue;
    const boxes = kept.map((w) => w.box).filter((b): b is [number, number, number, number] => Boolean(b));
    let box: [number, number, number, number] | undefined;
    if (boxes.length === kept.length && boxes.length > 0) {
      const x1 = Math.min(...boxes.map((b) => b[0]));
      const y1 = Math.min(...boxes.map((b) => b[1]));
      const x2 = Math.max(...boxes.map((b) => b[0] + b[2]));
      const y2 = Math.max(...boxes.map((b) => b[1] + b[3]));
      box = [x1, y1, x2 - x1, y2 - y1];
    }
    result.push({ text, confidence: Math.round(confidence * 10) / 10, ...(box ? { box } : {}) });
  }
  return result;
}

/** Local tesseract engine. Region crops are made with ffmpeg (argument arrays only). */
export class TesseractOcr implements OcrEngine {
  readonly name = "tesseract";
  constructor(
    private readonly tesseractPath: string,
    private readonly tools: MediaTools,
  ) {}

  async readFrame(framePath: string, profile: GameProfile, workDir: string): Promise<OcrLine[]> {
    const out: OcrLine[] = [];
    await mkdir(workDir, { recursive: true });
    for (const region of profile.regions) {
      const input = await this.prepareRegion(framePath, region, workDir);
      try {
        const res = await runProcess(this.tesseractPath, [input, "stdout", "--psm", String(region.psm), "-l", "eng", "tsv"], {
          timeoutMs: 30_000,
          maxStdoutBytes: 2 * 1024 * 1024,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_THREAD_LIMIT: "1", LANG: "C" },
        });
        if (res.code !== 0) continue;
        for (const line of legibleLines(parseTesseractTsv(res.stdout.toString("utf8")), region.minLineConfidence)) {
          if (region.requirePattern && !region.requirePattern.test(line.text)) continue;
          const type = region.classify ? region.classify(line.text) ?? region.type : region.type;
          // Region-local box → frame-normalized box.
          const [rx, ry, rw, rh] = region.box;
          const bbox: [number, number, number, number] | undefined = line.box
            ? [rx + line.box[0] * rw, ry + line.box[1] * rh, line.box[2] * rw, line.box[3] * rh]
            : undefined;
          out.push({ text: line.text, confidence: line.confidence, regionId: region.id, type, ...(bbox ? { bbox } : {}) });
        }
      } finally {
        if (input !== framePath) await rm(input, { force: true });
      }
    }
    return out;
  }

  private async prepareRegion(framePath: string, region: OcrRegion, workDir: string): Promise<string> {
    const [x, y, w, h] = region.box;
    const full = x === 0 && y === 0 && w === 1 && h === 1;
    const out = path.join(workDir, `ocr-${region.id}-${path.basename(framePath, ".jpg")}.png`);
    const crop = full ? "" : `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},`;
    // Upscale and convert to grayscale: small HUD text reads far better at 2x.
    await runChecked(
      this.tools.ffmpeg,
      ["-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-i", framePath, "-vf", `${crop}scale=iw*2:-2:flags=lanczos,format=gray`, "-frames:v", "1", "-y", out],
      { timeoutMs: 30_000 },
    );
    return out;
  }
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$ ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over word sets — tolerant of small OCR differences between frames. */
export function textSimilarity(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(" ").filter(Boolean));
  const B = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}
