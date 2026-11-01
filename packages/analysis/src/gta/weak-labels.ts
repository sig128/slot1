import type { GtaBox, GtaEvent, GtaScene } from "@slot1/contracts";
import type { OcrLine } from "../ocr";

/**
 * Automatic, unconfirmed labels for the training queue. They are PROPOSALS: nothing enters a
 * dataset until a person accepts it. They exist to put interesting frames first and to save
 * clicks, never to stand in for human review.
 */
export interface WeakLabel {
  kind: "scene" | "event" | "box";
  class: GtaScene | GtaEvent | GtaBox;
  box: { x: number; y: number; w: number; h: number } | null;
  source: "auto_ocr" | "auto_measure";
  /** OCR line confidence (0..1) or 1 for measurements. Reported, not a measured accuracy. */
  confidence: number;
  evidenceText: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Pad a tight text box a little (OCR boxes hug the glyphs) and keep it inside the frame. */
function padBox(b: [number, number, number, number], padX = 0.15, padY = 0.35) {
  const [x, y, w, h] = b;
  const x1 = clamp01(x - w * padX);
  const y1 = clamp01(y - h * padY);
  const x2 = clamp01(x + w + w * padX);
  const y2 = clamp01(y + h + h * padY);
  return { x: x1, y: y1, w: Math.max(0.001, x2 - x1), h: Math.max(0.001, y2 - y1) };
}

const BIG: { re: RegExp; event: GtaEvent }[] = [
  { re: /\bMISSION\s+PASSED\b/, event: "mission_passed" },
  { re: /\bMISSION\s+FAILED\b/, event: "mission_failed" },
  { re: /^WASTED\b/, event: "wasted" },
  { re: /^BUSTED\b/, event: "busted" },
];
const MONEY = /^\$\s?\d{1,3}(,\d{3})*$/;
const SPEAKER = /^[A-Z][A-Za-z.' -]{1,24}:\s+\S/;
const CHASE = /\b(LOSE THE COPS|LOSE YOUR WANTED LEVEL|EVADE THE (COPS|POLICE))\b/;

export function weakLabelsFromOcr(lines: OcrLine[]): WeakLabel[] {
  const out: WeakLabel[] = [];
  const seen = new Set<string>();
  const push = (l: WeakLabel) => {
    const key = `${l.kind}:${l.class}:${l.box ? l.box.x.toFixed(2) + l.box.y.toFixed(2) : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  for (const line of lines) {
    const text = line.text.trim();
    const upper = text.toUpperCase().replace(/\s+/g, " ");
    const confidence = Math.round(Math.min(100, Math.max(0, line.confidence))) / 100;
    const evidenceText = text.slice(0, 300);
    const box = line.bbox ? padBox(line.bbox) : null;

    const big = BIG.find((b) => b.re.test(upper));
    if (big) {
      push({ kind: "event", class: big.event, box: null, source: "auto_ocr", confidence, evidenceText });
      if (box) push({ kind: "box", class: "big_message", box, source: "auto_ocr", confidence, evidenceText });
      continue;
    }
    if (MONEY.test(text)) {
      if (box) push({ kind: "box", class: "money_hud", box, source: "auto_ocr", confidence, evidenceText });
      continue;
    }
    if (CHASE.test(upper)) push({ kind: "event", class: "police_chase", box: null, source: "auto_ocr", confidence: confidence * 0.8, evidenceText });
    if (line.type === "subtitle" || line.type === "dialogue" || SPEAKER.test(text)) {
      if (box) push({ kind: "box", class: "subtitle", box, source: "auto_ocr", confidence, evidenceText });
      continue;
    }
    if (line.type === "objective_text" || line.type === "mission_title") {
      if (box) push({ kind: "box", class: "mission_text", box, source: "auto_ocr", confidence, evidenceText });
    }
  }
  return out;
}

/** Labels from deterministic measurements (e.g. a frame inside a detected black segment). */
export function weakLabelsFromMeasurements(m: { black: boolean }): WeakLabel[] {
  return m.black ? [{ kind: "scene", class: "loading_or_black", box: null, source: "auto_measure", confidence: 1, evidenceText: "Black frame (measured)" }] : [];
}
