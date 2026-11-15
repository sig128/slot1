"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { skillLevel, type LearningResponse, type LearningSkill, type NowResponse } from "@slot1/contracts";

type V3 = [number, number, number];

/** What each live catch feeds: the skill node it flies into on the globe. */
const ACTIVITY_SKILL: Record<string, string> = {
  mission_passed: "event:mission_passed",
  mission_failed: "event:mission_failed",
  wasted: "event:wasted",
  busted: "event:busted",
  police_chase: "event:police_chase",
  crash: "event:vehicle_crash",
  shootout: "scene:shootout",
  driving: "scene:driving",
  on_foot: "scene:on_foot",
  cutscene: "scene:cutscene",
  menu: "scene:menu_or_map",
  phone: "scene:phone",
  loading: "scene:loading_or_black",
  mission: "box:mission_text",
};
const BAD = new Set(["wasted", "busted", "mission_failed", "crash"]);

/** Bright dots: one for every 5 frames people labeled, 2 moments caught and 50 frames kept. */
export function knowledgeDots(d: LearningResponse | null): number {
  if (!d) return 0;
  return Math.round(d.learning.labeledFrames / 5 + d.watched.caught / 2 + d.learning.frames / 50);
}

function fibonacci(n: number, offset = 0): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = ga * i + offset;
    out.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return out;
}

/** Seeded random (mulberry32): the network keeps its shape between renders and visits. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each point joined to its k nearest neighbours: the network's threads. */
function threads(points: V3[], k: number): [number, number][] {
  const edges: [number, number][] = [];
  const seen = new Set<number>();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const best: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = points[j]!;
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (best.length < k || d < best[best.length - 1]!.d) {
        best.push({ j, d });
        best.sort((a, b) => a.d - b.d);
        if (best.length > k) best.pop();
      }
    }
    for (const b of best) {
      const key = i < b.j ? i * n + b.j : b.j * n + i;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([i, b.j]);
      }
    }
  }
  return edges;
}

interface Geometry {
  lattice: V3[];
  knowledge: V3[];
  latticeEdges: [number, number][];
  knowledgeEdges: [number, number][];
  nodes: V3[];
  nodeEdges: [number, number][];
}

function buildGeometry(skills: LearningSkill[], dots: number, small: boolean): Geometry {
  const lattice = fibonacci(small ? 150 : 240, 0.3);
  const rand = seeded(1729);
  const knowledge: V3[] = [];
  for (let i = 0; i < dots; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const lift = 0.94 + rand() * 0.12;
    knowledge.push([Math.cos(t) * r * lift, u * lift, Math.sin(t) * r * lift]);
  }
  const nodes = fibonacci(skills.length, 1.1).map(([x, y, z]) => [x * 1.08, y * 1.08, z * 1.08] as V3);
  // Constellations: each skill joined to its two nearest skills of the same kind.
  const nodeEdges: [number, number][] = [];
  skills.forEach((s, i) => {
    const same = skills.map((o, j) => ({ o, j })).filter(({ o, j }) => j !== i && o.group === s.group);
    same
      .map(({ j }) => ({ j, d: (nodes[i]![0] - nodes[j]![0]) ** 2 + (nodes[i]![1] - nodes[j]![1]) ** 2 + (nodes[i]![2] - nodes[j]![2]) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach(({ j }) => {
        if (!nodeEdges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) nodeEdges.push([i, j]);
      });
  });
  return { lattice, knowledge, latticeEdges: threads(lattice, 3), knowledgeEdges: threads(knowledge, 2), nodes, nodeEdges };
}

interface Projected {
  x: number;
  y: number;
  z: number;
  s: number;
}

function project(p: V3, a: number, tilt: number, out: Projected): Projected {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const x1 = p[0] * ca + p[2] * sa;
  const z1 = -p[0] * sa + p[2] * ca;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const y2 = p[1] * ct - z1 * st;
  const z2 = p[1] * st + z1 * ct;
  const s = 3.4 / (3.4 - z2);
  out.x = x1 * s;
  out.y = y2 * s;
  out.z = z2;
  out.s = s;
  return out;
}

interface Pulse {
  from: string; // stream id
  node: number;
  start: number;
  color: string;
  label: string;
}

interface Hover {
  skill: LearningSkill;
  x: number;
  y: number;
}

/** "#ffad72" + alpha → "rgba(255,173,114,a)": canvas gradients don't take color-mix(). */
function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,173,114,${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function skillStatus(s: LearningSkill): string {
  if (s.score !== null) return `${Math.round(s.score * 100)}% right on its test`;
  if (s.examples > 0) return `${s.examples.toLocaleString("en-US")} labeled examples`;
  return "Not learned yet";
}

/**
 * SLOT1's learning network: a slowly turning globe of threads that grows with everything SLOT1
 * learns. Dim lattice = room still to learn; bright dots = labeled frames, caught moments and kept
 * frames; the 29 big nodes are its GTA skills, sized by how far each has come. Streams SLOT1 is
 * watching orbit it, and each live catch flies into its skill.
 */
export function LearningGlobe({ data, now, thinking = false }: { data: LearningResponse | null; now: NowResponse | null; thinking?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [small, setSmall] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const skills = useMemo(() => data?.skills ?? [], [data]);
  const dots = Math.min(small ? 900 : 1800, knowledgeDots(data));
  const geo = useMemo(() => buildGeometry(skills, dots, small), [skills, dots, small]);

  // Live state the animation reads without re-rendering.
  const live = useRef({
    geo,
    skills,
    now,
    pulses: [] as Pulse[],
    lastSeen: new Map<string, string>(),
    lastKey: new Map<string, string>(),
    hoverIdx: -1,
    thinking: false,
    /** When an answer last landed: one ring goes out from the globe. */
    answeredAt: -Infinity,
  });
  useEffect(() => {
    live.current.geo = geo;
    live.current.skills = skills;
  }, [geo, skills]);

  // Asking: the network searches (spins up, threads light up); answered: a ring goes out.
  useEffect(() => {
    const l = live.current;
    if (l.thinking && !thinking) l.answeredAt = performance.now();
    l.thinking = thinking;
  }, [thinking]);

  // A new catch on a stream: send it flying into its skill.
  useEffect(() => {
    const l = live.current;
    l.now = now;
    const t = performance.now();
    for (const s of now?.streams ?? []) {
      const a = s.activity;
      if (s.kind !== "slot1" || !a?.observationId) continue;
      const prev = l.lastSeen.get(s.broadcasterId);
      const prevKey = l.lastKey.get(s.broadcasterId);
      l.lastSeen.set(s.broadcasterId, a.observationId);
      l.lastKey.set(s.broadcasterId, a.key);
      // Every new event flies in; a scene or mission only when it changes, not on every frame.
      if (prev === a.observationId || (a.tier !== "event" && prevKey === a.key)) continue;
      const node = l.skills.findIndex((k) => `${k.group}:${k.key}` === ACTIVITY_SKILL[a.key]);
      if (node < 0) continue;
      l.pulses.push({
        from: s.broadcasterId,
        node,
        start: t,
        color: BAD.has(a.key) ? "--color-coral" : a.key === "mission_passed" ? "--color-gold" : "--color-ivory",
        label: `${a.tier === "event" ? a.label.toUpperCase() : a.label} · ${s.displayName}`,
      });
    }
  }, [now]);

  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const color = (v: string) => css.getPropertyValue(v).trim() || "#f4ede2";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let angle = 0.6;
    let spin = reduced ? 0 : 0.07;
    // How fast it turns right now, and how much it's "thinking" (0..1), eased toward their targets.
    let spinNow = spin;
    let think = 0;
    let lastScan = 0;
    const scans: { a: V3; b: V3; start: number }[] = [];
    const rnd = seeded(4242);
    // A faint field of stars around the network, fixed to the frame.
    const stars = Array.from({ length: 110 }, () => ({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 0.9, phase: rnd() * Math.PI * 2, speed: 0.4 + rnd() * 1.2 }));
    let drag: { x: number; a: number } | null = null;
    let visible = true;
    let raf = 0;
    let last = performance.now();
    const tilt = -0.32;
    const tmp: Projected = { x: 0, y: 0, z: 0, s: 1 };
    const nodeScreen: { x: number; y: number; z: number; r: number }[] = [];

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = box.clientWidth;
      h = box.clientHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    };
    resize();
    // Phones, and the globe when it's docked small above a conversation, get a lighter network.
    let compact = w < 640 || h < 300;
    const ro = new ResizeObserver(() => {
      resize();
      compact = w < 640 || h < 300;
      setSmall(compact);
    });
    ro.observe(box);
    const io = new IntersectionObserver(([e]) => (visible = Boolean(e?.isIntersecting)));
    io.observe(box);

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (!visible) return;
      const { geo: g, skills: sk, now: nw, pulses, thinking, answeredAt } = live.current;
      think += ((thinking ? 1 : 0) - think) * Math.min(1, dt * 3);
      const spinTarget = reduced ? 0 : thinking ? 0.9 : spin;
      spinNow += (spinTarget - spinNow) * Math.min(1, dt * 2.5);
      if (!drag) angle += spinNow * dt;
      const learned = g.knowledge.length;
      const grow = 0.8 + 0.2 * Math.min(1, Math.log10(1 + learned) / 3.2);
      const R = Math.min(w, h) * 0.4 * grow;
      const cx = w / 2;
      const cy = h / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const apricotTone = color("--color-apricot");
      const ivoryTone = color("--color-ivory");
      const night = color("--color-graphite-900");

      // Stars, twinkling slowly (still with reduced motion).
      ctx.fillStyle = ivoryTone;
      for (const s of stars) {
        const x = s.x * w;
        const y = s.y * h;
        if ((x - cx) ** 2 + (y - cy) ** 2 < (R * 1.05) ** 2) continue;
        ctx.globalAlpha = reduced ? 0.18 : 0.08 + 0.22 * (0.5 + 0.5 * Math.sin((t / 1000) * s.speed + s.phase));
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // The glow brightens as it learns, and while it's searching for an answer.
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.7);
      glow.addColorStop(0, rgba(apricotTone, (0.08 + 0.18 * Math.min(1, learned / 600)) * (1 + 0.9 * think)));
      glow.addColorStop(1, rgba(apricotTone, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // The body: a dark sphere lit from the upper left, so the network reads as a world.
      const body = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.04, cx, cy, R * 1.02);
      body.addColorStop(0, rgba(apricotTone, 0.16 + 0.1 * think));
      body.addColorStop(0.45, rgba(night, 0.55));
      body.addColorStop(1, rgba(night, 0.92));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      // Its atmosphere and rim light.
      const air = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.22);
      air.addColorStop(0, rgba(apricotTone, 0.16 + 0.14 * think));
      air.addColorStop(1, rgba(apricotTone, 0));
      ctx.fillStyle = air;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.22, 0, Math.PI * 2);
      ctx.arc(cx, cy, R * 0.96, 0, Math.PI * 2, true);
      ctx.fill();
      const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      rim.addColorStop(0, rgba(apricotTone, 0.7));
      rim.addColorStop(0.5, rgba(ivoryTone, 0.1));
      rim.addColorStop(1, rgba(color("--color-signal"), 0.35));
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.004, 0, Math.PI * 2);
      ctx.stroke();

      // Two slow orbit rings around the network.
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      for (const [k, tiltK] of [
        [1.32, 0.42],
        [1.5, -0.28],
      ] as const) {
        ctx.strokeStyle = color("--color-ivory");
        ctx.globalAlpha = 0.1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * k, R * k * Math.abs(Math.sin(tiltK + angle * 0.05)) * 0.55 + R * 0.08, tiltK, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const P = (p: V3) => {
        project(p, angle, tilt, tmp);
        return { x: cx + tmp.x * R, y: cy + tmp.y * R, z: tmp.z, s: tmp.s };
      };
      const ivory = color("--color-ivory");
      const apricot = color("--color-apricot");

      // Threads, back ones fainter. Bucketed by depth so each bucket is one stroke.
      const strokeEdges = (pts: V3[], edges: [number, number][], tone: string, base: number, span: number, width: number) => {
        const proj = pts.map(P);
        for (let b = 0; b < 4; b++) {
          ctx.beginPath();
          for (const [i, j] of edges) {
            const z = (proj[i]!.z + proj[j]!.z) / 2;
            if (Math.min(3, Math.floor(((z + 1) / 2) * 4)) !== b) continue;
            ctx.moveTo(proj[i]!.x, proj[i]!.y);
            ctx.lineTo(proj[j]!.x, proj[j]!.y);
          }
          ctx.strokeStyle = tone;
          ctx.globalAlpha = base + span * (b / 3);
          ctx.lineWidth = width;
          ctx.stroke();
        }
        return proj;
      };
      const lat = strokeEdges(g.lattice, g.latticeEdges, ivory, 0.03, 0.09, 0.6);
      const kno = strokeEdges(g.knowledge, g.knowledgeEdges, apricot, 0.08, 0.32, 0.8);

      // Dots.
      const dotsOf = (proj: { x: number; y: number; z: number }[], tone: string, alpha: number, size: number) => {
        for (let b = 0; b < 4; b++) {
          ctx.beginPath();
          for (const p of proj) {
            if (Math.min(3, Math.floor(((p.z + 1) / 2) * 4)) !== b) continue;
            const r = size * (0.55 + 0.25 * b);
            ctx.moveTo(p.x + r, p.y);
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          }
          ctx.fillStyle = tone;
          ctx.globalAlpha = alpha * (0.35 + 0.22 * b);
          ctx.fill();
        }
      };
      dotsOf(lat, ivory, 0.55, 1.5);
      dotsOf(kno, apricot, 1, 2.1);

      // Skill constellations and nodes.
      const nodes = g.nodes.map(P);
      ctx.lineWidth = 1;
      for (const [i, j] of g.nodeEdges) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        ctx.strokeStyle = color(sk[i]?.group === "event" ? "--color-coral" : sk[i]?.group === "scene" ? "--color-signal" : "--color-apricot");
        ctx.globalAlpha = 0.12 + 0.25 * ((a.z + b.z + 2) / 4);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const order = nodes.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z);
      nodeScreen.length = 0;
      for (const { p, i } of order) {
        const s = sk[i];
        if (!s) continue;
        const level = skillLevel(s);
        const flash = pulses.some((q) => q.node === i && t - q.start > 1100 && t - q.start < 2600);
        const tone = color(s.group === "event" ? "--color-coral" : s.group === "scene" ? "--color-signal" : "--color-apricot");
        const r = (3 + 7 * level + (flash ? 6 : 0)) * p.s;
        const front = (p.z + 1) / 2;
        nodeScreen[i] = { x: p.x, y: p.y, z: p.z, r };
        if (level > 0 || flash) {
          ctx.globalAlpha = 0.25 + 0.5 * front;
          const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
          halo.addColorStop(0, rgba(tone, 0.85));
          halo.addColorStop(1, rgba(tone, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.5 + 0.5 * front;
          ctx.fillStyle = s.score !== null ? color("--color-gold") : tone;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalAlpha = 0.25 + 0.45 * front;
          ctx.strokeStyle = tone;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(2.5, r), 0, Math.PI * 2);
          ctx.stroke();
        }
        if (live.current.hoverIdx === i) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = ivory;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(6, r + 4), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Searching for an answer: threads light up from what it knows to its skills.
      if (thinking && !reduced && t - lastScan > 70 && nodes.length) {
        lastScan = t;
        const pool = g.knowledge.length > 20 ? g.knowledge : g.lattice;
        scans.push({ a: pool[Math.floor(rnd() * pool.length)]!, b: g.nodes[Math.floor(rnd() * g.nodes.length)]!, start: t });
      }
      for (let k = scans.length - 1; k >= 0; k--) {
        const sc = scans[k]!;
        const age = (t - sc.start) / 900;
        if (age >= 1) {
          scans.splice(k, 1);
          continue;
        }
        const a = P(sc.a);
        const b = P(sc.b);
        if (a.z < -0.2 && b.z < -0.2) continue;
        // Bowed outward from the center, like a signal over the surface.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = mx - cx;
        const dy = my - cy;
        const dl = Math.hypot(dx, dy) || 1;
        const qx = mx + (dx / dl) * R * 0.28;
        const qy = my + (dy / dl) * R * 0.28;
        const fade = age < 0.2 ? age / 0.2 : 1 - (age - 0.2) / 0.8;
        ctx.globalAlpha = 0.5 * fade;
        ctx.strokeStyle = apricotTone;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(qx, qy, b.x, b.y);
        ctx.stroke();
        const u = Math.min(1, age * 1.4);
        const hx = (1 - u) ** 2 * a.x + 2 * (1 - u) * u * qx + u ** 2 * b.x;
        const hy = (1 - u) ** 2 * a.y + 2 * (1 - u) * u * qy + u ** 2 * b.y;
        ctx.globalAlpha = fade;
        ctx.fillStyle = ivoryTone;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      // An answer landed: one ring goes out.
      const since = t - answeredAt;
      if (since >= 0 && since < 1400) {
        const e = 1 - (1 - since / 1400) ** 3;
        ctx.globalAlpha = 0.55 * (1 - e);
        ctx.strokeStyle = apricotTone;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R * (1.02 + 0.55 * e), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Streams SLOT1 is watching, orbiting the globe.
      const streams = (nw?.streams ?? []).filter((s) => s.kind === "slot1" && s.activity);
      const sat = new Map<string, { x: number; y: number }>();
      streams.forEach((s, k) => {
        const a = (k / Math.max(1, streams.length)) * Math.PI * 2 + angle * 0.35 - Math.PI / 2;
        const x = cx + Math.cos(a) * R * 1.45;
        const y = cy + Math.sin(a) * R * 1.12;
        sat.set(s.broadcasterId, { x, y });
        ctx.globalAlpha = 1;
        ctx.fillStyle = color("--color-coral");
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = ivory;
        ctx.font = `600 ${compact ? 11 : 13}px "Barlow Condensed", system-ui, sans-serif`;
        ctx.textAlign = x < cx ? "right" : "left";
        ctx.fillText(s.displayName, x + (x < cx ? -10 : 10), y + 4);
      });

      // Catches in flight, then a callout where they land.
      for (let k = pulses.length - 1; k >= 0; k--) {
        const q = pulses[k]!;
        const age = t - q.start;
        if (age > 3200) {
          pulses.splice(k, 1);
          continue;
        }
        const from = sat.get(q.from);
        const to = nodeScreen[q.node];
        if (!to) continue;
        const tone = color(q.color);
        if (from && age < 1100) {
          const e = reduced ? 1 : 1 - (1 - age / 1100) ** 3;
          const x = from.x + (to.x - from.x) * e;
          const y = from.y + (to.y - from.y) * e;
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = tone;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = tone;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
        } else if (age >= 1100) {
          // Full strength for a second, then fade, on a dark plate so it reads over the network.
          const fade = Math.max(0, Math.min(1, 1 - (age - 2100) / 1100));
          ctx.font = `800 ${compact ? 16 : 22}px "Passion One", "Barlow Condensed", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tw = ctx.measureText(q.label).width;
          const ty = to.y - to.r - (compact ? 18 : 22);
          ctx.globalAlpha = 0.88 * fade;
          ctx.fillStyle = color("--color-graphite-900");
          ctx.beginPath();
          ctx.roundRect(to.x - tw / 2 - 10, ty - (compact ? 13 : 16), tw + 20, compact ? 26 : 32, 3);
          ctx.fill();
          ctx.globalAlpha = fade;
          ctx.fillStyle = tone;
          ctx.fillText(q.label, to.x, ty + 1);
          ctx.textBaseline = "alphabetic";
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    const pick = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (drag) {
        angle = drag.a + (x - drag.x) * 0.006;
        return;
      }
      let best = -1;
      let bestD = 24 * 24;
      nodeScreen.forEach((n, i) => {
        if (!n || n.z < -0.25) return;
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      live.current.hoverIdx = best;
      const s = live.current.skills[best];
      const n = nodeScreen[best];
      setHover(s && n ? { skill: s, x: n.x, y: n.y } : null);
    };
    const down = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      drag = { x: ev.clientX - rect.left, a: angle };
      el.setPointerCapture(ev.pointerId);
    };
    const up = () => {
      drag = null;
    };
    const leave = () => {
      live.current.hoverIdx = -1;
      setHover(null);
    };
    el.addEventListener("pointermove", pick);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("pointermove", pick);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      spin = 0;
    };
    // The geometry and data are read live through `live`; the loop only restarts with the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const started = skills.filter((s) => skillLevel(s) > 0).length;
  const summary = data
    ? `SLOT1's learning network: ${started} of ${skills.length} GTA skills started, ${data.watched.caught} moments caught, ${data.learning.labeledFrames} frames labeled.`
    : "SLOT1's learning network.";

  return (
    <div ref={wrap} className="learn-globe relative h-full w-full touch-pan-y select-none">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing" role="img" aria-label={summary} />
      {hover && (
        <div className="learn-tip pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full" style={{ left: hover.x, top: hover.y - 18 }}>
          <p className="font-display text-lg font-bold leading-tight text-ivory">{hover.skill.label}</p>
          <p className="text-[0.82rem] text-ivory-2">{skillStatus(hover.skill)}</p>
          {hover.skill.seen !== null && <p className="text-[0.82rem] text-ivory-3">Caught {hover.skill.seen.toLocaleString("en-US")}× live</p>}
        </div>
      )}
      <ul className="sr-only">
        {skills.map((s) => (
          <li key={`${s.group}:${s.key}`}>
            {s.label}: {skillStatus(s)}
          </li>
        ))}
      </ul>
    </div>
  );
}
