import type { CSSProperties } from "react";
import {
  CAUSEWAY_Y,
  CITY,
  MAST,
  SIGN,
  VB,
  WHEEL,
  buildingPath,
  farTowers,
  lightsDelay,
  px,
  py,
  rng,
  stars,
  windowsPath,
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
  /** Unique per page when the artwork appears more than once (SVG gradient ids). */
  idPrefix?: string;
}) {
  const cls = ["sk-scene", animated ? "sk-animated" : "", intro ? "sk-intro" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} aria-hidden>
      <div className="sk-stage">
        <BackLayer id={idPrefix} />
        <SkyFx />
        <FrontLayer id={idPrefix} intro={intro} />
        <FrontFx evidence={evidence} />
      </div>
    </div>
  );
}

const FAR = farTowers(7);
const STARS = stars(11, 46);

function BackLayer({ id }: { id: string }) {
  const H = VB.horizon;
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#101014" />
          <stop offset="0.42" stopColor="#16111c" />
          <stop offset="0.66" stopColor="#261227" />
          <stop offset="0.82" stopColor="#4a1834" />
          <stop offset="0.93" stopColor="#8f2a51" />
          <stop offset="1" stopColor="#e2507a" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="1000" cy={H} r="760" gradientUnits="userSpaceOnUse" gradientTransform={`translate(0 ${H}) scale(1 0.32) translate(0 ${-H})`}>
          <stop offset="0" stopColor="#ffad72" stopOpacity="0.62" />
          <stop offset="0.35" stopColor="#ff4f87" stopOpacity="0.3" />
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
      <ellipse cx="1000" cy={H} rx="800" ry="250" fill={`url(#${id}-glow)`} />

      {/* stars, in three brightnesses */}
      {[0.22, 0.36, 0.52].map((o, i) => (
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
      <circle cx="1362" cy="116" r="62" fill={`url(#${id}-moon)`} />
      <circle cx="1362" cy="116" r="15" fill="#f4ede2" opacity="0.88" mask={`url(#${id}-crescent)`} />

      {/* hills behind the city; the station's transmitter stands on the highest one */}
      <path d={`M0 ${H}V430C120 420 240 404 380 412C520 420 600 440 700 444V${H}Z`} fill="#1c1021" />
      <path
        d={`M640 ${H}C760 446 880 420 1000 394C1090 374 1150 356 ${MAST.x} ${MAST.base}C1270 358 1350 386 1450 408C1520 422 1570 430 1600 434V${H}Z`}
        fill="#22122a"
      />
      <Mast />

      {/* far skyline, softened by haze */}
      <g fill="#2a1631">
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
  const legs = [];
  // Lattice: two legs converging upward, with cross-bracing.
  const w0 = 16;
  for (let i = 0; i < 7; i++) {
    const y1 = base - (h * i) / 7;
    const y2 = base - (h * (i + 1)) / 7;
    const a = w0 * (1 - i / 7);
    const b = w0 * (1 - (i + 1) / 7);
    legs.push(`M${x - a / 2} ${y1}L${x + b / 2} ${y2}M${x + a / 2} ${y1}L${x - b / 2} ${y2}M${x - b / 2} ${y2}H${x + b / 2}`);
  }
  return (
    <g stroke="#140b18" strokeWidth="1.4" fill="none">
      <path d={`M${x - w0 / 2} ${base}L${x} ${top}L${x + w0 / 2} ${base}`} strokeWidth="2" />
      <path d={legs.join("")} />
      <path d={`M${x} ${top}V${top - 16}`} strokeWidth="1.6" />
      {/* the station's dish */}
      <path d={`M${x + 4} ${top + 34}a7 7 0 0 0 10 -8`} strokeWidth="2.4" />
    </g>
  );
}

const NEON = { coral: "#ff4f87", apricot: "#ffad72", gold: "#ffc94d" } as const;

function FrontLayer({ id, intro }: { id: string; intro: boolean }) {
  const H = VB.horizon;
  const R = rng(23);
  // Light on the water: streaks under the brightest things in the city.
  const sources: [number, string, number][] = [
    [704, "#ff4f87", 26],
    [812, "#ffc94d", 16],
    [906, "#ff4f87", 18],
    [996, "#ffad72", 18],
    [1086, "#ffc94d", 22],
    [1248, "#ffc94d", 16],
    [1424, "#ffc94d", 40],
    [1362, "#f4ede2", 10],
    [104, "#ffad72", 22],
    [372, "#ffc94d", 18],
  ];
  const streaks = sources.map(([x, color, w]) => {
    let d = "";
    for (let y = H + 6; y < CAUSEWAY_Y - 4; y += 6 + Math.floor(R() * 4)) {
      const len = w * (0.4 + R() * 0.9) * (1 - (y - H) / 140);
      if (len < 3) continue;
      const jx = (R() - 0.5) * 10;
      d += `M${(x + jx - len / 2).toFixed(1)} ${y}h${len.toFixed(1)}v1.4h-${len.toFixed(1)}z`;
    }
    return { color, d };
  });
  const lamps = Array.from({ length: 21 }, (_, i) => 20 + i * 80);
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <linearGradient id={`${id}-bld`} x1="0" y1="150" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1d1522" />
          <stop offset="1" stopColor="#0d0b11" />
        </linearGradient>
        <linearGradient id={`${id}-water`} x1="0" y1={H} x2="0" y2={VB.h} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2a1222" />
          <stop offset="0.35" stopColor="#140c15" />
          <stop offset="1" stopColor="#09080c" />
        </linearGradient>
        <linearGradient id={`${id}-horizon`} x1="0" y1="0" x2={VB.w} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff4f87" stopOpacity="0.15" />
          <stop offset="0.45" stopColor="#ff4f87" stopOpacity="0.9" />
          <stop offset="0.66" stopColor="#ffad72" />
          <stop offset="1" stopColor="#ff4f87" stopOpacity="0.2" />
        </linearGradient>
        <filter id={`${id}-neon`} x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
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
      <g stroke="#3b2333" strokeWidth="1.2" opacity="0.8">
        {CITY.filter((b) => b.ledges).map((b, i) => {
          let d = "";
          for (let y = b.top + 7; y < H - 8; y += 16) d += `M${b.x + 2} ${y}H${b.x + b.w - 2}`;
          return <path key={i} d={d} />;
        })}
      </g>
      {/* lit windows: one path per building; the intro lights them outward from the mast */}
      {CITY.map((b, i) => (
        <path
          key={i}
          className={intro ? "sk-lit" : undefined}
          style={intro ? ({ "--d": `${lightsDelay(b)}ms` } as CSSProperties) : undefined}
          fill={i % 3 === 1 ? "#ffad72" : "#ffc94d"}
          opacity="0.88"
          d={windowsPath(b, 101 + i)}
        />
      ))}
      {/* neon fins and strips */}
      <g filter={`url(#${id}-neon)`}>
        {CITY.filter((b) => b.neon).map((b, i) => (
          <rect key={i} x={b.neon!.x - 1.5} y={b.neon!.y1} width="3" height={b.neon!.y2 - b.neon!.y1} fill={NEON[b.neon!.color]} />
        ))}
      </g>

      {/* the station's rooftop sign */}
      <g>
        <path d={`M${SIGN.x + 14} ${SIGN.y + SIGN.h}V320M${SIGN.x + SIGN.w - 14} ${SIGN.y + SIGN.h}V320`} stroke="#0d0b11" strokeWidth="3" />
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
        <rect x="1296" y={H - 6} width="304" height="6" stroke="none" />
        <path d={`M1296 ${H - 13}H1600`} fill="none" strokeWidth="1.2" />
        {Array.from({ length: 13 }, (_, i) => (
          <path key={i} d={`M${1302 + i * 24} ${H - 13}V${H}M${1302 + i * 24} ${H}V${H + 18}`} fill="none" strokeWidth={i % 2 ? 1 : 2.4} />
        ))}
      </g>

      {/* the bay */}
      <rect x="0" y={H} width={VB.w} height={VB.h - H} fill={`url(#${id}-water)`} />
      <rect x="0" y={H - 1} width={VB.w} height="2.2" fill={`url(#${id}-horizon)`} />
      {streaks.map((s, i) => (
        <path key={i} d={s.d} fill={s.color} opacity="0.5" />
      ))}

      {/* causeway with its lamps */}
      <g>
        <rect x="-10" y={CAUSEWAY_Y} width={VB.w + 20} height="5" fill="#0b090e" />
        <rect x="-10" y={CAUSEWAY_Y - 0.6} width={VB.w + 20} height="0.9" fill="#ffad72" opacity="0.28" />
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
      <path d={`M0 ${VB.h}V606C260 598 520 612 800 608C1080 604 1340 600 1600 612V${VB.h}Z`} fill="#09080b" />
      <path d="M0 606C260 598 520 612 800 608C1080 604 1340 600 1600 612" stroke="#3a1a2b" strokeWidth="1" fill="none" opacity="0.7" />
    </svg>
  );
}

function SkyFx() {
  return (
    <div className="sk-fx">
      {/* searchlights from behind downtown */}
      <span className="sk-beam sk-beam-a" style={{ left: px(918 - 60), bottom: py(VB.h - VB.horizon), width: px(120), height: py(VB.horizon) }} />
      <span className="sk-beam sk-beam-b" style={{ left: px(1096 - 60), bottom: py(VB.h - VB.horizon), width: px(120), height: py(VB.horizon) }} />

      {/* neon halo behind the ON AIR sign */}
      <span className="sk-halo" style={{ left: px(SIGN.x - 40), top: py(SIGN.y - 34), width: px(SIGN.w + 80), height: py(SIGN.h + 68) }} />

      {/* the station transmits */}
      <span className="sk-ring" style={{ left: px(MAST.x), top: py(MAST.top - 8), width: px(260) }} />
      <span className="sk-ring sk-ring-2" style={{ left: px(MAST.x), top: py(MAST.top - 8), width: px(260) }} />
      <span className="sk-beacon" style={{ left: px(MAST.x), top: py(MAST.top - 16) }} />
      <span className="sk-beacon sk-beacon-slow" style={{ left: px(MAST.x), top: py(MAST.top + 40) }} />

      {/* a few stars breathe */}
      {(
        [
          [212, 64],
          [538, 128],
          [1090, 46],
          [1490, 168],
          [760, 30],
        ] as const
      ).map(([x, y], i) => (
        <span key={i} className="sk-star" style={{ left: px(x), top: py(y), animationDelay: `${-i * 1.7}s`, animationDuration: `${6 + i}s` }} />
      ))}

      {/* a helicopter crosses the bay; SLOT1 notices it */}
      <div className="sk-heli" style={{ top: py(188) }}>
        <div className="sk-heli-craft" style={{ width: px(46) }}>
          <svg viewBox="0 0 46 20" className="block h-auto w-full">
            <path d="M3 4h40" stroke="#08070a" strokeWidth="1.2" />
            <path d="M23 4v3" stroke="#08070a" strokeWidth="1.4" />
            <path d="M16 9c0-2 3-3 7-3h4c4 0 7 2 7 5s-3 4-7 4h-6c-3 0-5-2-5-6z" fill="#08070a" />
            <path d="M16 10H4l-1-3" stroke="#08070a" strokeWidth="1.6" fill="none" />
            <path d="M20 15l-2 3h16l-2-3" stroke="#08070a" strokeWidth="1" fill="none" />
          </svg>
          <span className="sk-heli-light" />
          <span className="sk-heli-cone" />
          <span className="sk-bracket sk-bracket-heli">
            <span className="sk-bracket-label">
              <i className="sk-glyph sk-glyph-visible" />
              Visible
            </span>
          </span>
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
  [652, 344, 23],
  [826, 300, 31],
  [1060, 300, 27],
  [372, 404, 37],
  [1252, 412, 29],
];

function FrontFx({ evidence }: { evidence: boolean }) {
  return (
    <div className="sk-fx">
      {/* the water's light breathes */}
      <span className="sk-shimmer" style={{ left: px(660), top: py(VB.horizon + 4), width: px(470), height: py(CAUSEWAY_Y - VB.horizon - 10) }} />
      <span className="sk-shimmer sk-shimmer-2" style={{ left: px(1360), top: py(VB.horizon + 4), width: px(130), height: py(CAUSEWAY_Y - VB.horizon - 10) }} />

      {/* traffic on the causeway: headlights head west, tail lights east */}
      {CARS.map((c, i) => (
        <span
          key={i}
          className={`sk-car sk-car-${c.dir}`}
          style={{ top: py(CAUSEWAY_Y - 3.2), ["--x" as string]: c.x, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }}
        />
      ))}

      {/* a few windows switch on and off over time */}
      {FLICKER.map(([x, y, s], i) => (
        <span key={i} className="sk-window" style={{ left: px(x), top: py(y), width: px(4), height: py(6), animationDuration: `${s}s`, animationDelay: `${-i * 5}s` }} />
      ))}

      {/* aviation lights on the towers */}
      {(
        [
          [812, 114, 0],
          [906, 150, -0.9],
          [996, 133, -1.6],
          [1165, 174, -0.4],
        ] as const
      ).map(([x, y, d], i) => (
        <span key={i} className="sk-beacon sk-beacon-tower" style={{ left: px(x), top: py(y), animationDelay: `${d}s` }} />
      ))}

      {/* the Ferris wheel turns, very slowly */}
      <Wheel />

      {/* palms */}
      <Palm x={34} h={300} tilt={-4} />
      <Palm x={156} h={232} tilt={5} flip />
      <Palm x={1488} h={286} tilt={3} flip />
      <Palm x={1566} h={220} tilt={-6} />

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
        top: py(624 - h),
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
