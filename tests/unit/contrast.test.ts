import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** WCAG 2.x contrast of the design tokens actually used for text, read from globals.css. */
const css = readFileSync(path.resolve(__dirname, "../../apps/web/app/globals.css"), "utf8");
const token = (name: string) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token ${name} not found`);
  return m[1]!;
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(token(a)), lum(token(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("text contrast (WCAG AA, 4.5:1 for body text)", () => {
  it.each([
    ["ivory", "graphite"],
    ["ivory-2", "graphite"],
    ["ivory-3", "graphite"],
    ["ivory-3", "graphite-800"],
    ["ivory-2", "graphite-700"],
    ["apricot", "graphite"],
    ["coral", "graphite"],
    ["signal", "graphite"],
    ["graphite", "ivory"],
    ["graphite", "coral"],
  ])("%s on %s", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
