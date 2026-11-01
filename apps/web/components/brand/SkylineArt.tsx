import type { CSSProperties } from "react";
import {
  CAUSEWAY_Y,
  CITY,
  MAST,
  SIGN,
  VB,
  WHEEL,
  WINDOW_COLORS,
  buildingPath,
  crownTrace,
  farTowers,
  lightsDelay,
  px,
  py,
  rng,
  stars,
  windows,
} from "./skyline-geometry";

/**
 * SLOT1's original artwork: a bay city after dark seen from the water, with the station's
 * transmitter on the hill, an art-deco downtown, a moderne beachfront, a pier with a Ferris
 * wheel and a causeway. Drawn for SLOT1; no third-party or game assets.
 *
 * Static by default (Setup, Studio, thumbnail fallbacks). `animated` adds very slow ambient life
 * (transform/opacity only, so the compositor does the work); `intro` adds the one load sequence
 * (the city's lights come on outward from the mast); `evidence` draws SLOT1's "what I saw"
 * brackets. Reduced motion always gets the composed still frame.
 */
export function SkylineArt({
  className = "",
  animated = false,
  intro = false,
  evidence = false,
  idPrefix = "sk",
}: {
  className?: string;
  animated?: boolean;
  intro?: boolean;
  evidence?: boolean;
  /** Unique per page when the artwork appears more than once (SVG ids). */
  idPrefix?: string;
}) {
  const cls = ["sk-scene", animated ? "sk-animated" : "", intro ? "sk-intro" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} aria-hidden>
      <div className="sk-stage">
        <BackLayer id={idPrefix} />
        <SkyFx evidence={evidence} />
        <FrontLayer id={idPrefix} intro={intro} />
        <FrontFx evidence={evidence} />
      </div>
    </div>
  );
}

const H = VB.horizon;
const FAR = farTowers(7);
const STARS = stars(11, 52);
const WINDOWS = CITY.map((b, i) => windows(b, 101 + i * 7));

function BackLayer({ id }: { id: string }) {
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#101014" />
          <stop offset="0.4" stopColor="#15111b" />
          <stop offset="0.64" stopColor="#231226" />
          <stop offset="0.8" stopColor="#441733" />
          <stop offset="0.92" stopColor="#87284d" />
          <stop offset="1" stopColor="#df4d79" />
        </linearGradient>
        <radialGradient
          id={`${id}-glow`}
          cx="1040"
          cy={H}
          r="780"
          gradientUnits="userSpaceOnUse"
          gradientTransform={`translate(0 ${H}) scale(1 0.34) translate(0 ${-H})`}
        >
          <stop offset="0" stopColor="#ffad72" stopOpacity="0.66" />
          <stop offset="0.32" stopColor="#ff4f87" stopOpacity="0.3" />
          <stop offset="1" stopColor="#ff4f87" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-moon`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f4ede2" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f4ede2" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-crescent`}>
          <rect width={VB.w} height={VB.h} fill="#fff" />
          <circle cx="1371" cy="111" r="14" fill="#000" />
        </mask>
      </defs>
      <rect width={VB.w} height={H} fill={`url(#${id}-sky)`} />
      <ellipse cx="1040" cy={H} rx="820" ry="265" fill={`url(#${id}-glow)`} />

      {/* stars, in three brightnesses */}
      {[0.2, 0.34, 0.5].map((o, i) => (
        <path
          key={o}
          fill="#f4ede2"
          opacity={o}
          d={STARS.filter((_, k) => k % 3 === i)
            .map((s) => `M${s.x} ${s.y}h${s.r}v${s.r}h-${s.r}z`)
            .join("")}
        />
      ))}

      {/* crescent moon */}
      <circle cx="1362" cy="116" r="64" fill={`url(#${id}-moon)`} />
      <circle cx="1362" cy="116" r="15" fill="#f4ede2" opacity="0.9" mask={`url(#${id}-crescent)`} />

      {/* hills behind the city; the station's transmitter stands on the highest one */}
      <path d={`M0 ${H}V436C140 424 260 410 400 416C540 422 620 440 720 446V${H}Z`} fill="#1a0f20" />
      <path
        d={`M700 ${H}C820 450 930 424 1050 398C1140 378 1200 356 ${MAST.x} ${MAST.base}C1320 354 1390 382 1480 404C1540 418 1580 426 1600 430V${H}Z`}
        fill="#211229"
      />
      <Mast />

      {/* far skyline, softened by haze */}
      <g fill="#2b1632">
        {FAR.map((t, i) => (
          <path key={i} d={t.d} />
        ))}
      </g>
      <path fill="#ffad72" opacity="0.2" d={FAR.map((t) => t.win).join("")} />
    </svg>
  );
}

function Mast() {
  const { x, base, top } = MAST;
  const h = base - top;
  const w0 = 16;
  let lattice = "";
  for (let i = 0; i < 7; i++) {
    const y1 = base - (h * i) / 7;
    const y2 = base - (h * (i + 1)) / 7;
    const a = w0 * (1 - i / 7);
    const b = w0 * (1 - (i + 1) / 7);
    lattice += `M${x - a / 2} ${y1}L${x + b / 2} ${y2}M${x + a / 2} ${y1}L${x - b / 2} ${y2}M${x - b / 2} ${y2}H${x + b / 2}`;
  }
  return (
    <g stroke="#140b18" strokeWidth="1.4" fill="none">
      <path d={`M${x - w0 / 2} ${base}L${x} ${top}L${x + w0 / 2} ${base}`} strokeWidth="2" />
      <path d={lattice} />
      <path d={`M${x} ${top}V${top - 16}`} strokeWidth="1.6" />
      <path d={`M${x + 4} ${top + 34}a7 7 0 0 0 10 -8`} strokeWidth="2.4" />
    </g>
  );
}

const NEON = { coral: "#ff4f87", apricot: "#ffad72", gold: "#ffc94d" } as const;

/** Light on the water: a soft column under each bright thing in the city, broken by ripples. */
const REFLECT: [number, string, number, number][] = [
  // x, colour, width, strength
  [762, "#ff4f87", 46, 0.75],
  [952, "#ff4f87", 18, 0.7],
  [1048, "#ffc94d", 40, 0.6],
  [1129, "#ffad72", 26, 0.5],
  [1466, "#ffc94d", 120, 0.45],
  [1362, "#f4ede2", 18, 0.35],
  [92, "#ffad72", 24, 0.55],
  [538, "#ffc94d", 22, 0.5],
  [1352, "#ffc94d", 20, 0.5],
  [330, "#ffc94d", 60, 0.28],
  [1210, "#ffad72", 60, 0.25],
];

function FrontLayer({ id, intro }: { id: string; intro: boolean }) {
  const R = rng(23);
  // Ripple mask: thin broken horizontal lines, wider apart further down.
  let ripples = "";
  for (let y = H + 3, gap = 3; y < CAUSEWAY_Y + 50; y += gap, gap = Math.min(9, gap + 0.35)) {
    for (let x = 0; x < VB.w; ) {
      const len = 14 + R() * 90;
      if (R() < 0.72) ripples += `M${x.toFixed(1)} ${y.toFixed(1)}h${len.toFixed(1)}v${(1 + R() * 0.9).toFixed(2)}h-${len.toFixed(1)}z`;
      x += len + 4 + R() * 30;
    }
  }
  const lamps = Array.from({ length: 21 }, (_, i) => 20 + i * 80);
  const focal = CITY.find((b) => b.outline);
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <linearGradient id={`${id}-bld`} x1="0" y1="150" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1e1623" />
          <stop offset="1" stopColor="#0d0b11" />
        </linearGradient>
        <linearGradient id={`${id}-water`} x1="0" y1={H} x2="0" y2={VB.h} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2c1223" />
          <stop offset="0.3" stopColor="#150c16" />
          <stop offset="1" stopColor="#09080c" />
        </linearGradient>
        <linearGradient id={`${id}-horizon`} x1="0" y1="0" x2={VB.w} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff4f87" stopOpacity="0.2" />
          <stop offset="0.45" stopColor="#ff4f87" stopOpacity="0.9" />
          <stop offset="0.66" stopColor="#ffad72" />
          <stop offset="1" stopColor="#ff4f87" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id={`${id}-fade`} x1="0" y1={H} x2="0" y2={CAUSEWAY_Y + 40} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-ripple`} maskUnits="userSpaceOnUse" x="0" y={H} width={VB.w} height={VB.h - H}>
          <path d={ripples} fill={`url(#${id}-fade)`} />
        </mask>
        <filter id={`${id}-neon`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* city */}
      <g fill={`url(#${id}-bld)`}>
        {CITY.map((b, i) => (
          <path key={i} d={buildingPath(b)} />
        ))}
      </g>
      {/* moderne ledges catch the glow */}
      <g stroke="#3d2335" strokeWidth="1.1" opacity="0.75">
        {CITY.filter((b) => b.ledges).map((b, i) => {
          let d = "";
          for (let y = b.top + 7; y < H - 8; y += 16) d += `M${b.x + 2} ${y}H${b.x + b.w - 2}`;
          return <path key={i} d={d} />;
        })}
      </g>
      {/* unlit panes, then the lit ones (one group per building; the intro lights a building as a
          unit, outward from the mast) */}
      <path fill="#f4ede2" opacity="0.055" d={WINDOWS.map((w) => w.dark).join("")} />
      {CITY.map((b, i) => (
        <g
          key={i}
          className={intro ? "sk-lit" : undefined}
          style={intro ? ({ "--d": `${lightsDelay(b)}ms` } as CSSProperties) : undefined}
          opacity="0.92"
        >
          {WINDOWS[i]!.lit.map((d, c) => (d ? <path key={c} d={d} fill={WINDOW_COLORS[c]} /> : null))}
        </g>
      ))}
      {/* neon: fins, the dome's strip and the focal tower's crown */}
      <g filter={`url(#${id}-neon)`}>
        {CITY.filter((b) => b.neon).map((b, i) => (
          <rect key={i} x={b.neon!.x - 1.5} y={b.neon!.y1} width="3" height={b.neon!.y2 - b.neon!.y1} fill={NEON[b.neon!.color]} />
        ))}
        {focal &&
          crownTrace(focal).map((d, i) => (
            <path
              key={i}
              d={d}
              className={intro ? "sk-trace" : undefined}
              pathLength={100}
              strokeDasharray="100"
              fill="none"
              stroke="#ff4f87"
              strokeWidth="1.5"
              strokeLinejoin="miter"
              opacity="0.95"
            />
          ))}
      </g>

      {/* the station's rooftop sign */}
      <g>
        <path d={`M${SIGN.x + 14} ${SIGN.y + SIGN.h}V330M${SIGN.x + SIGN.w - 14} ${SIGN.y + SIGN.h}V330`} stroke="#0d0b11" strokeWidth="3" />
        <rect x={SIGN.x} y={SIGN.y} width={SIGN.w} height={SIGN.h} rx="2" fill="#1a0d16" stroke="#3a1a2b" strokeWidth="1.5" />
        <g className={intro ? "sk-neon" : undefined} filter={`url(#${id}-neon)`}>
          <rect x={SIGN.x + 3} y={SIGN.y + 3} width={SIGN.w - 6} height={SIGN.h - 6} rx="1.5" fill="none" stroke="#ff4f87" strokeWidth="1.3" />
          <text
            x={SIGN.x + SIGN.w / 2}
            y={SIGN.y + SIGN.h / 2 + 5.6}
            textAnchor="middle"
            fill="#ffd2df"
            stroke="#ff4f87"
            strokeWidth="0.6"
            style={{ font: "800 15.5px 'Barlow Condensed', 'Arial Narrow', sans-serif", letterSpacing: "0.12em" }}
          >
            ON AIR
          </text>
        </g>
      </g>

      {/* pier and the wheel's frame (the wheel itself turns in the effects layer) */}
      <g fill="#0c0a10" stroke="#0c0a10">
        <path d={`M${WHEEL.cx - 40} ${H - 2}L${WHEEL.cx} ${WHEEL.cy}L${WHEEL.cx + 40} ${H - 2}`} fill="none" strokeWidth="3.4" />
        <path d={`M${WHEEL.cx - 26} ${H - 30}H${WHEEL.cx + 26}`} fill="none" strokeWidth="1.6" />
        <rect x="1340" y={H - 6} width="260" height="6" stroke="none" />
        <path d={`M1340 ${H - 13}H1600`} fill="none" strokeWidth="1.2" />
        {Array.from({ length: 11 }, (_, i) => (
          <path key={i} d={`M${1346 + i * 24} ${H - 13}V${H}M${1346 + i * 24} ${H}V${H + 18}`} fill="none" strokeWidth={i % 2 ? 1 : 2.4} />
        ))}
      </g>

      {/* the bay */}
      <rect x="0" y={H} width={VB.w} height={VB.h - H} fill={`url(#${id}-water)`} />
      <g mask={`url(#${id}-ripple)`}>
        {REFLECT.map(([x, color, w, o], i) => (
          <rect key={i} x={x - w / 2} y={H} width={w} height={CAUSEWAY_Y + 40 - H} fill={color} opacity={o} />
        ))}
        <rect x="0" y={H} width={VB.w} height="34" fill="#ff4f87" opacity="0.22" />
      </g>
      <rect x="0" y={H - 1} width={VB.w} height="2.2" fill={`url(#${id}-horizon)`} />

      {/* causeway with its lamps */}
      <g>
        <rect x="-10" y={CAUSEWAY_Y} width={VB.w + 20} height="5" fill="#0b090e" />
        <rect x="-10" y={CAUSEWAY_Y - 0.6} width={VB.w + 20} height="0.9" fill="#ffad72" opacity="0.3" />
        {lamps.map((x) => (
          <g key={x}>
            <path d={`M${x} ${CAUSEWAY_Y}V${CAUSEWAY_Y - 11}h4`} stroke="#0b090e" strokeWidth="1.2" fill="none" />
            <circle cx={x + 4} cy={CAUSEWAY_Y - 10.5} r="5" fill="#ffad72" opacity="0.14" />
            <circle cx={x + 4} cy={CAUSEWAY_Y - 10.5} r="1.3" fill="#ffe6bf" />
            <rect x={x + 1} y={CAUSEWAY_Y + 9} width="6" height="1.2" fill="#ffad72" opacity="0.3" />
            <rect x={x + 2} y={CAUSEWAY_Y + 15} width="4" height="1" fill="#ffad72" opacity="0.18" />
          </g>
        ))}
        {Array.from({ length: 11 }, (_, i) => (
          <rect key={i} x={60 + i * 160} y={CAUSEWAY_Y + 5} width="3.4" height="48" fill="#0b090e" />
        ))}
      </g>

      {/* beach */}
      <path d={`M0 ${VB.h}V612C260 604 520 618 800 614C1080 610 1340 606 1600 618V${VB.h}Z`} fill="#09080b" />
      <path d="M0 612C260 604 520 618 800 614C1080 610 1340 606 1600 618" stroke="#3a1a2b" strokeWidth="1" fill="none" opacity="0.7" />
    </svg>
  );
}

function SkyFx({ evidence }: { evidence: boolean }) {
  return (
    <div className="sk-fx">
      {/* thin cloud lit from below by the city, drifting */}
      <span className="sk-wisp" style={{ left: px(180), top: py(262), width: px(760), height: py(26) }} />
      <span className="sk-wisp sk-wisp-2" style={{ left: px(860), top: py(214), width: px(620), height: py(20) }} />

      {/* searchlights from behind downtown */}
      <span className="sk-beam sk-beam-a" style={{ left: px(985 - 60), bottom: py(VB.h - H), width: px(120), height: py(H) }} />
      <span className="sk-beam sk-beam-b" style={{ left: px(1150 - 60), bottom: py(VB.h - H), width: px(120), height: py(H) }} />

      {/* the station transmits */}
      <span className="sk-ring" style={{ left: px(MAST.x), top: py(MAST.top - 8), width: px(280) }} />
      <span className="sk-ring sk-ring-2" style={{ left: px(MAST.x), top: py(MAST.top - 8), width: px(280) }} />
      <span className="sk-beacon" style={{ left: px(MAST.x), top: py(MAST.top - 16) }} />
      <span className="sk-beacon sk-beacon-slow" style={{ left: px(MAST.x), top: py(MAST.top + 44) }} />

      {/* a few stars breathe */}
      {(
        [
          [212, 64],
          [538, 128],
          [1180, 40],
          [1490, 178],
          [760, 30],
        ] as const
      ).map(([x, y], i) => (
        <span key={i} className="sk-star" style={{ left: px(x), top: py(y), animationDelay: `${-i * 1.7}s`, animationDuration: `${6 + i}s` }} />
      ))}

      {/* a helicopter crosses the bay; SLOT1 notices it */}
      <div className="sk-heli" style={{ top: py(104) }}>
        <div className="sk-heli-craft" style={{ width: px(48) }}>
          <span className="sk-heli-cone" />
          <svg viewBox="0 0 46 20" className="relative block h-auto w-full">
            <path d="M2 4h42" stroke="#3a2a36" strokeWidth="1.1" />
            <path d="M23 4v3" stroke="#3a2a36" strokeWidth="1.4" />
            <path d="M16 9c0-2 3-3 7-3h4c4 0 7 2 7 5s-3 4-7 4h-6c-3 0-5-2-5-6z" fill="#2c2230" />
            <path d="M18 13.5c3 1 9 1 13 0" stroke="#7a4a5c" strokeWidth="0.9" fill="none" />
            <path d="M16 10H4l-1-3" stroke="#2c2230" strokeWidth="1.6" fill="none" />
            <path d="M20 15l-2 3h16l-2-3" stroke="#2c2230" strokeWidth="1" fill="none" />
          </svg>
          <span className="sk-heli-light" />
          <span className="sk-heli-strobe" />
          {evidence && (
            <span className="sk-bracket sk-bracket-heli">
              <span className="sk-bracket-label">
                <i className="sk-glyph sk-glyph-visible" />
                Visible
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const CARS: { dir: "l" | "r"; dur: number; delay: number; x: string }[] = [
  { dir: "l", dur: 26, delay: -3, x: "72%" },
  { dir: "l", dur: 34, delay: -19, x: "31%" },
  { dir: "l", dur: 29, delay: -12, x: "54%" },
  { dir: "r", dur: 31, delay: -7, x: "18%" },
  { dir: "r", dur: 24, delay: -16, x: "63%" },
  { dir: "r", dur: 38, delay: -27, x: "86%" },
];

const FLICKER: [number, number, number][] = [
  // x, y, seconds
  [748, 370, 23],
  [930, 300, 31],
  [1062, 250, 27],
  [318, 436, 37],
  [1186, 330, 29],
];

const TOWER_LIGHTS: [number, number, number][] = [
  [952, 168, 0],
  [1048, 48, -0.9],
  [1129, 179, -1.6],
  [1291, 256, -0.4],
];

function FrontFx({ evidence }: { evidence: boolean }) {
  return (
    <div className="sk-fx">
      {/* the ON AIR sign's glow (screen-blended over the sign) */}
      <span className="sk-halo" style={{ left: px(SIGN.x - 44), top: py(SIGN.y - 36), width: px(SIGN.w + 88), height: py(SIGN.h + 72) }} />

      {/* the water's light breathes */}
      <span className="sk-shimmer" style={{ left: px(700), top: py(H + 4), width: px(520), height: py(CAUSEWAY_Y - H - 8) }} />
      <span className="sk-shimmer sk-shimmer-2" style={{ left: px(1400), top: py(H + 4), width: px(140), height: py(CAUSEWAY_Y - H - 8) }} />

      {/* traffic on the causeway: headlights head west, tail lights east */}
      {CARS.map((c, i) => (
        <span
          key={i}
          className={`sk-car sk-car-${c.dir}`}
          style={{ top: py(CAUSEWAY_Y - 3.4), ["--x" as string]: c.x, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }}
        />
      ))}

      {/* a few windows switch on and off over time */}
      {FLICKER.map(([x, y, s], i) => (
        <span key={i} className="sk-window" style={{ left: px(x), top: py(y), width: px(3), height: py(4.4), animationDuration: `${s}s`, animationDelay: `${-i * 5}s` }} />
      ))}

      {/* aviation lights on the towers */}
      {TOWER_LIGHTS.map(([x, y, d], i) => (
        <span key={i} className="sk-beacon sk-beacon-tower" style={{ left: px(x), top: py(y), animationDelay: `${d}s` }} />
      ))}

      {/* the Ferris wheel turns, very slowly */}
      <Wheel />

      {/* palms */}
      <Palm x={26} h={226} tilt={-5} />
      <Palm x={112} h={176} tilt={6} flip />
      <Palm x={1548} h={268} tilt={4} flip />
      <Palm x={1604} h={206} tilt={-6} />

      {evidence && (
        <span
          className="sk-bracket sk-bracket-sign"
          style={{ left: px(SIGN.x - 9), top: py(SIGN.y - 9), width: px(SIGN.w + 18), height: py(SIGN.h + 18) }}
        >
          <span className="sk-bracket-label">
            <i className="sk-glyph sk-glyph-text" />
            Visible text
          </span>
        </span>
      )}
    </div>
  );
}

function Wheel() {
  const { cx, cy, r } = WHEEL;
  const size = r * 2 + 12;
  const c = size / 2;
  const spokes = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return `M${c} ${c}L${(c + Math.cos(a) * r).toFixed(1)} ${(c + Math.sin(a) * r).toFixed(1)}`;
  }).join("");
  const lights = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r] as const;
  });
  const cabins = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2 + Math.PI / 16;
    return [c + Math.cos(a) * (r + 1), c + Math.sin(a) * (r + 1)] as const;
  });
  return (
    <span className="sk-wheel" style={{ left: px(cx - c), top: py(cy - c), width: px(size), height: py(size) }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="block h-full w-full">
        <g stroke="#140f18" fill="none">
          <circle cx={c} cy={c} r={r} strokeWidth="2.6" />
          <circle cx={c} cy={c} r={r * 0.84} strokeWidth="1.2" />
          <path d={spokes} strokeWidth="1" />
        </g>
        {cabins.map(([x, y], i) => (
          <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r="3.4" fill="#140f18" />
        ))}
        {lights.map(([x, y], i) => (
          <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r="1.5" fill={i % 4 === 0 ? "#ff4f87" : i % 2 ? "#ffc94d" : "#ffad72"} />
        ))}
        <circle cx={c} cy={c} r="5" fill="#140f18" />
        <circle cx={c} cy={c} r="1.6" fill="#ffc94d" />
      </svg>
    </span>
  );
}

/** A palm, rooted on the beach. `h` is its height in artwork units. */
function Palm({ x, h, tilt, flip = false }: { x: number; h: number; tilt: number; flip?: boolean }) {
  const w = h * 0.7;
  return (
    <span
      className="sk-palm"
      style={{
        left: px(x - w / 2),
        top: py(628 - h),
        width: px(w),
        height: py(h),
        ["--tilt" as string]: `${tilt}deg`,
        animationDuration: `${7 + (x % 5)}s`,
        animationDelay: `${-(x % 7)}s`,
      }}
    >
      <svg viewBox="0 0 220 320" preserveAspectRatio="none" className="block h-full w-full" style={flip ? { transform: "scaleX(-1)" } : undefined}>
        <g fill="#08070a">
          <path d="M103 320C106 250 114 160 123 74L132 74C127 162 121 252 119 320Z" />
          <path d="M128 70C100 52 62 60 28 118C66 84 100 80 128 80Z" />
          <path d="M128 70C108 40 80 26 50 30C82 38 104 56 126 78Z" />
          <path d="M128 70C124 40 116 16 102 2C122 18 132 42 133 72Z" />
          <path d="M128 70C146 40 162 22 180 12C168 34 150 54 133 77Z" />
          <path d="M128 70C160 52 194 52 216 66C188 64 160 70 133 80Z" />
          <path d="M130 74C166 80 188 106 198 144C178 114 156 96 130 85Z" />
          <path d="M126 76C100 90 80 118 66 162C90 124 106 104 128 85Z" />
          <circle cx="128" cy="78" r="7" />
        </g>
        <path d="M110 300h10M112 268h10M114 236h10M116 204h10M118 172h10M120 140h9M122 108h9" stroke="#1d1520" strokeWidth="2" />
      </svg>
    </span>
  );
}
