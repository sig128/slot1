import { describe, expect, it } from "vitest";
import { decodeYolox, DEFAULT_DECODE, yoloxRows } from "@slot1/gta-runtime";

/**
 * The AI overlay's object finder: YOLOX's raw grid output becomes normalized boxes in the original
 * frame, only for the classes the overlay shows, with overlapping duplicates removed.
 */

const INPUT = 416;
const ROW = 85;
const FRAME = { w: 1280, h: 720 };
const SCALE = Math.min(INPUT / FRAME.w, INPUT / FRAME.h); // letterboxed at the top left

interface Cell {
  /** Grid cell at stride 8 (52 × 52 cells on a 416 input). */
  gx: number;
  gy: number;
  /** Box size in cells of 8 px. */
  w: number;
  h: number;
  objectness: number;
  cls: number;
  score: number;
}

function rawOutput(cells: Cell[]): Float32Array {
  const out = new Float32Array(yoloxRows(INPUT) * ROW);
  for (const c of cells) {
    const at = (c.gy * (INPUT / 8) + c.gx) * ROW;
    out[at] = 0.5;
    out[at + 1] = 0.5;
    out[at + 2] = Math.log(c.w);
    out[at + 3] = Math.log(c.h);
    out[at + 4] = c.objectness;
    out[at + 5 + c.cls] = c.score;
  }
  return out;
}

describe("YOLOX object decoding", () => {
  it("has one row per grid cell of each stride", () => {
    expect(yoloxRows(416)).toBe(52 * 52 + 26 * 26 + 13 * 13);
  });

  it("puts a person where the model saw it, in the original frame, scored objectness × class", () => {
    const objects = decodeYolox(rawOutput([{ gx: 10, gy: 20, w: 5, h: 10, objectness: 0.9, cls: 0, score: 0.8 }]), INPUT, SCALE, FRAME.w, FRAME.h);
    expect(objects).toHaveLength(1);
    const [o] = objects;
    expect(o!.label).toBe("person");
    expect(o!.score).toBeCloseTo(0.72, 3);
    // Centre (10.5, 20.5) cells × 8 px, 40 × 80 px on the input, back to the 1280 × 720 frame.
    const [x, y, w, h] = o!.box;
    expect(x).toBeCloseTo((84 - 20) / SCALE / FRAME.w, 3);
    expect(y).toBeCloseTo((164 - 40) / SCALE / FRAME.h, 3);
    expect(w).toBeCloseTo(40 / SCALE / FRAME.w, 3);
    expect(h).toBeCloseTo(80 / SCALE / FRAME.h, 3);
  });

  it("names vehicles and animals in plain words, and leaves out what the overlay doesn't show", () => {
    const objects = decodeYolox(
      rawOutput([
        { gx: 5, gy: 5, w: 6, h: 4, objectness: 0.9, cls: 2, score: 0.9 }, // car
        { gx: 30, gy: 5, w: 4, h: 4, objectness: 0.9, cls: 3, score: 0.9 }, // motorcycle
        { gx: 40, gy: 30, w: 4, h: 4, objectness: 0.9, cls: 16, score: 0.9 }, // dog
        { gx: 20, gy: 40, w: 6, h: 4, objectness: 0.9, cls: 62, score: 0.95 }, // tv: not shown
      ]),
      INPUT,
      SCALE,
      FRAME.w,
      FRAME.h,
    );
    expect(objects.map((o) => o.label).sort()).toEqual(["car", "dog", "motorbike"]);
  });

  it("keeps one box per object: the same class overlapping, or another class almost on top of it", () => {
    const objects = decodeYolox(
      rawOutput([
        { gx: 10, gy: 20, w: 5, h: 10, objectness: 0.9, cls: 0, score: 0.8 },
        { gx: 11, gy: 20, w: 5, h: 10, objectness: 0.8, cls: 0, score: 0.8 },
        // The same figure read as a dog, a little less sure: one object seen two ways.
        { gx: 10, gy: 21, w: 5, h: 10, objectness: 0.7, cls: 16, score: 0.8 },
        // A second person further away stays.
        { gx: 40, gy: 20, w: 5, h: 10, objectness: 0.9, cls: 0, score: 0.6 },
      ]),
      INPUT,
      SCALE,
      FRAME.w,
      FRAME.h,
    );
    expect(objects.map((o) => o.label)).toEqual(["person", "person"]);
    expect(objects[0]!.score).toBeGreaterThan(objects[1]!.score);
  });

  it("drops boxes below the score floor, and asks more of animals", () => {
    const weak = rawOutput([{ gx: 10, gy: 20, w: 5, h: 10, objectness: 0.5, cls: 0, score: 0.5 }]);
    expect(decodeYolox(weak, INPUT, SCALE, FRAME.w, FRAME.h)).toEqual([]);
    expect(decodeYolox(weak, INPUT, SCALE, FRAME.w, FRAME.h, { ...DEFAULT_DECODE, minScore: 0.2 })).toHaveLength(1);
    // 0.4 is enough for a person, not for a dog: games' crouching people often read as dogs.
    const person = rawOutput([{ gx: 10, gy: 20, w: 5, h: 10, objectness: 0.8, cls: 0, score: 0.5 }]);
    const dog = rawOutput([{ gx: 10, gy: 20, w: 5, h: 10, objectness: 0.8, cls: 16, score: 0.5 }]);
    expect(decodeYolox(person, INPUT, SCALE, FRAME.w, FRAME.h).map((o) => o.label)).toEqual(["person"]);
    expect(decodeYolox(dog, INPUT, SCALE, FRAME.w, FRAME.h)).toEqual([]);
  });

  it("refuses an output that doesn't fit the input size", () => {
    expect(() => decodeYolox(new Float32Array(10), INPUT, SCALE, FRAME.w, FRAME.h)).toThrow(/too short/);
  });
});
