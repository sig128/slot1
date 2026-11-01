import "./skyline.css";
import {
  CITY,
  FREEWAY,
  FREEWAY_ANGLE,
  INK,
  SIGN_LETTERS,
  SIGN_STEP,
  SIGN_X0,
  SUN,
  TONES,
  VB,
  buildingPath,
  cloudPath,
  freewayY,
  px,
  py,
  signBase,
  windowsPath,
} from "./skyline-geometry";

/**
 * SLOT1's original artwork, drawn in the language of a game loading screen: a golden-hour bay
 * city with heavy outlines, flat cel shading and halftone, the SLOT1 letters on the hill, palms,
 * an elevated freeway and a helicopter. Original shapes only: no third-party or game assets,
 * logos or likenesses.
 *
 * Static by default (Setup, Studio, thumbnail fallbacks). `animated` adds slow ambient life
 * (transform/opacity only); `intro` adds the loading-screen push-in; `evidence` draws SLOT1's
 * "what I saw" bracket. Reduced motion always gets the composed still frame.
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
        <div className="sk-zoom">
          <SkyLayer id={idPrefix} />
          <SkyFx />
          <MidLayer id={idPrefix} />
          <FrontLayer id={idPrefix} />
          <FrontFx evidence={evidence} />
        </div>
      </div>
    </div>
  );
}

const G = VB.ground;

function SkyLayer({ id }: { id: string }) {
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2={G + 10} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2a0d37" />
          <stop offset="0.22" stopColor="#481451" />
          <stop offset="0.42" stopColor="#8a2a66" />
          <stop offset="0.6" stopColor="#de4a6b" />
          <stop offset="0.74" stopColor="#ff8547" />
          <stop offset="0.87" stopColor="#ffbe4f" />
          <stop offset="1" stopColor="#ffe5a0" />
        </linearGradient>
        <radialGradient id={`${id}-sun`} cx="0.42" cy="0.4" r="0.62">
          <stop offset="0" stopColor="#fff6d2" />
          <stop offset="0.55" stopColor="#ffd56e" />
          <stop offset="1" stopColor="#ffab45" />
        </radialGradient>
      </defs>
      <rect width={VB.w} height={G + 10} fill={`url(#${id}-sky)`} />
      <circle cx={SUN.cx} cy={SUN.cy} r={SUN.r} fill={`url(#${id}-sun)`} stroke={INK} strokeWidth="4" />
    </svg>
  );
}

/** Clouds drift and the sun's halftone corona breathes (HTML layers between sky and city). */
function SkyFx() {
  const clouds: { x: number; y: number; w: number; chords: number[]; cls: string }[] = [
    { x: 1170, y: 238, w: 360, chords: [1, 1.5, 1.2, 1.9, 1.1, 0.8], cls: "sk-cloud sk-cloud-a" },
    { x: 1010, y: 132, w: 230, chords: [1, 1.6, 1.3, 0.9], cls: "sk-cloud sk-cloud-b" },
    { x: 40, y: 396, w: 330, chords: [0.8, 1.3, 1.7, 1.1, 0.9], cls: "sk-cloud sk-cloud-c" },
  ];
  return (
    <div className="sk-fx">
      <span className="sk-dots-sky" />
      <span className="sk-dots-sun" style={{ left: px(SUN.cx - SUN.r * 2.1), top: py(SUN.cy - SUN.r * 2.1), width: px(SUN.r * 4.2), height: py(SUN.r * 4.2) }} />
      {clouds.map((c, i) => {
        const pad = 8;
        const h = c.w * 0.36;
        return (
          <span key={i} className={c.cls} style={{ left: px(c.x - pad), top: py(c.y - h), width: px(c.w + pad * 2), height: py(h + pad) }}>
            <svg viewBox={`${c.x - pad} ${c.y - h} ${c.w + pad * 2} ${h + pad}`} className="block h-full w-full" preserveAspectRatio="none">
              <path d={cloudPath(c.x, c.y, c.w, c.chords)} fill="#7d2d6c" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />
              <path d={`M${c.x + 10} ${c.y - 2}Q${c.x + c.w / 2} ${c.y - c.w * 0.08} ${c.x + c.w - 10} ${c.y - 2}Z`} fill="#ffad6b" />
              <path d={`M${c.x + c.w * 0.18} ${c.y - c.w * 0.14}q${c.w * 0.1} -${c.w * 0.06} ${c.w * 0.2} 0`} stroke="#b0457f" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
          </span>
        );
      })}
    </div>
  );
}

function MidLayer({ id }: { id: string }) {
  const hillRidge = "M900 600C946 520 1000 414 1096 352C1166 310 1236 292 1306 302C1396 316 1474 362 1610 404";
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <pattern id={`${id}-dots`} width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="4.5" r="1.7" fill="#000" opacity="0.32" />
        </pattern>
        <linearGradient id={`${id}-one`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff4f87" />
          <stop offset="0.5" stopColor="#ff7a7c" />
          <stop offset="1" stopColor="#ffad72" />
        </linearGradient>
      </defs>

      {/* far ridge behind the city */}
      <path d="M-10 600V520C120 500 220 488 340 494C460 500 540 482 660 470C760 462 840 476 930 506C990 526 1020 560 1040 600Z" fill="#5c1f5e" />
      <path d="M-10 520C120 500 220 488 340 494C460 500 540 482 660 470C760 462 840 476 930 506" fill="none" stroke="#ff9a52" strokeWidth="3" opacity="0.7" />
      <path d="M-10 600V520C120 500 220 488 340 494C460 500 540 482 660 470C760 462 840 476 930 506C990 526 1020 560 1040 600Z" fill="none" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />

      {/* the hill with the letters */}
      <path d={`${hillRidge}V600Z`} fill="#43174d" />
      <path d="M1306 302C1396 316 1474 362 1610 404V600H1330C1356 500 1342 384 1306 302Z" fill="#2c0f36" />
      <path d="M1306 302C1396 316 1474 362 1610 404V600H1330C1356 500 1342 384 1306 302Z" fill={`url(#${id}-dots)`} />
      <path d="M900 600C946 520 1000 414 1096 352C1166 310 1236 292 1306 302" fill="none" stroke="#ffb067" strokeWidth="5" />
      <path d={`${hillRidge}V600Z`} fill="none" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
      {/* scrub on the slope */}
      <path
        d="M972 520q8-10 16 0M1040 470q9-11 18 0M1130 486q7-9 14 0M1236 478q8-10 16 0M1330 440q7-9 14 0M1420 424q8-10 16 0M1480 466q9-11 18 0M1546 476q7-9 14 0M1190 546q8-10 16 0M1080 560q9-11 18 0"
        stroke={INK}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />

      {/* the SLOT1 letters on the hill */}
      {SIGN_LETTERS.map((ch, i) => {
        const x = SIGN_X0 + i * SIGN_STEP;
        const base = signBase(x + 18);
        const one = ch === "1";
        return (
          <g key={ch + i}>
            <path d={`M${x + 8} ${base}v16M${x + 30} ${base}v16`} stroke={INK} strokeWidth="3" />
            {one && <rect x={x - 3} y={base - 62} width="44" height="66" rx="3" fill={`url(#${id}-one)`} stroke={INK} strokeWidth="3.5" />}
            <text
              x={x + 19 + 4}
              y={base + 3}
              textAnchor="middle"
              fill="#a0918a"
              stroke={INK}
              strokeWidth="5"
              paintOrder="stroke"
              style={{ font: "800 74px 'Barlow Condensed', 'Arial Narrow', sans-serif" }}
            >
              {ch}
            </text>
            <text
              x={x + 19}
              y={base}
              textAnchor="middle"
              fill={one ? "#140715" : "#fbf4ea"}
              stroke={one ? "none" : INK}
              strokeWidth="3"
              paintOrder="stroke"
              style={{ font: "800 74px 'Barlow Condensed', 'Arial Narrow', sans-serif" }}
            >
              {ch}
            </text>
          </g>
        );
      })}

      {/* the city: cel-shaded faces (shadow, sunlit side, rim light), halftone, sunset windows */}
      {CITY.map((b, i) => {
        const t = TONES[b.tone];
        const litX = b.x + b.w * 0.64;
        return (
          <g key={i}>
            <path d={buildingPath(b)} fill={t.face} />
            <rect x={litX} y={b.top} width={b.x + b.w - litX} height={G - b.top} fill={t.lit} />
            <path d={buildingPath(b)} fill={`url(#${id}-dots)`} opacity="0.55" />
            <rect x={b.x + b.w - 7} y={b.top} width="6" height={G - b.top} fill={t.rim} opacity="0.85" />
            <path d={windowsPath(b, 31 + i * 5)} fill={i % 2 ? "#ffd36b" : "#ffc04d"} />
            <path d={buildingPath(b)} fill="none" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />
          </g>
        );
      })}
      {/* rooftops: a billboard for the station, a water tower, antennas */}
      <g stroke={INK} strokeWidth="3" strokeLinejoin="round">
        <path d="M790 506V490M842 506V490" fill="none" />
        <rect x="772" y="452" width="88" height="40" fill="#1c0b22" />
        <rect x="778" y="458" width="76" height="28" fill="none" stroke="#ff4f87" strokeWidth="2" />
        <path d="M420 478L424 452M450 478L446 452M422 466H448" fill="none" strokeWidth="2.4" />
        <path d="M414 452V436Q435 424 456 436V452Z" fill="#3a1846" />
        <path d="M140 408V392M150 408V398M166 408V386" fill="none" strokeWidth="2.4" />
      </g>
      <text x="816" y="478" textAnchor="middle" fill="#ffd2df" stroke="#ff4f87" strokeWidth="0.8" style={{ font: "800 17px 'Barlow Condensed', 'Arial Narrow', sans-serif", letterSpacing: "0.1em" }}>
        ON AIR
      </text>
      <rect x="-10" y={G - 2} width={VB.w + 20} height={VB.h - G + 2} fill="#1d0a22" />
      <rect x="-10" y={G - 2} width={VB.w + 20} height={VB.h - G + 2} fill={`url(#${id}-dots)`} />
      <path d={`M-10 ${G}H${VB.w + 10}`} stroke={INK} strokeWidth="4" />
    </svg>
  );
}

function FrontLayer({ id }: { id: string }) {
  const { x0, x1 } = FREEWAY;
  const y0 = FREEWAY.y0;
  const y1 = FREEWAY.y1;
  const pillars = Array.from({ length: 10 }, (_, i) => 60 + i * 172);
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none" className="sk-layer">
      <defs>
        <pattern id={`${id}-dots2`} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="1.5" fill="#000" opacity="0.35" />
        </pattern>
      </defs>
      {/* freeway pillars */}
      {pillars.map((x) => {
        const top = freewayY(x) + 22;
        return (
          <g key={x}>
            <rect x={x - 13} y={top} width="26" height={VB.h - top + 4} fill="#25102b" stroke={INK} strokeWidth="3.5" />
            <rect x={x + 6} y={top + 3} width="5" height={VB.h - top} fill="#ff9a52" opacity="0.45" />
            <rect x={x - 22} y={top - 2} width="44" height="10" fill="#30163a" stroke={INK} strokeWidth="3" />
          </g>
        );
      })}
      {/* deck: lit top face, dark side, railing */}
      <path d={`M${x0} ${y0}L${x1} ${y1}L${x1} ${y1 + 22}L${x0} ${y0 + 22}Z`} fill="#2a1231" />
      <path d={`M${x0} ${y0}L${x1} ${y1}L${x1} ${y1 + 7}L${x0} ${y0 + 7}Z`} fill="#8a4462" />
      <path d={`M${x0} ${y0 + 22}L${x1} ${y1 + 22}`} stroke="#ff9a52" strokeWidth="2" opacity="0.5" />
      <path d={`M${x0} ${y0}L${x1} ${y1}L${x1} ${y1 + 22}L${x0} ${y0 + 22}Z`} fill="none" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
      <path d={`M${x0} ${y0 - 9}L${x1} ${y1 - 9}`} stroke={INK} strokeWidth="3" />
      <path
        d={Array.from({ length: 56 }, (_, i) => {
          const x = x0 + 10 + i * 30;
          const y = freewayY(x);
          return `M${x} ${(y - 9).toFixed(1)}V${y.toFixed(1)}`;
        }).join("")}
        stroke={INK}
        strokeWidth="2.2"
      />
      {/* foreground lot */}
      <path d="M-10 810V724C300 704 700 734 1000 716C1300 700 1500 720 1610 708V810Z" fill="#13061a" />
      <path d="M-10 810V724C300 704 700 734 1000 716C1300 700 1500 720 1610 708V810Z" fill={`url(#${id}-dots2)`} />
      <path d="M-10 724C300 704 700 734 1000 716C1300 700 1500 720 1610 708" fill="none" stroke={INK} strokeWidth="4" />
      <Coupe x={560} y={672} />
    </svg>
  );
}

/** A low two-door coupe parked in the lot, side on, nose to the right (original design). */
function Coupe({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(1.3)`} strokeLinejoin="round">
      <ellipse cx="112" cy="70" rx="122" ry="7" fill="#000" opacity="0.4" />
      <path
        d="M4 52L8 38Q22 31 46 29L76 14Q92 7 116 8L150 23Q182 25 208 32L220 42Q224 52 216 58H8Q2 58 4 52Z"
        fill="#9a2f62"
        stroke={INK}
        strokeWidth="4"
      />
      <path d="M8 46H216V54Q216 58 210 58H10Q4 58 6 52Z" fill="#5e1b47" />
      <path d="M48 31L77 17Q92 11 112 12L140 26Z" fill="#3a1d4a" stroke={INK} strokeWidth="3" />
      <path d="M84 16L92 13L104 25H92Z" fill="#ffb067" opacity="0.55" />
      <path d="M96 12V27" stroke={INK} strokeWidth="3" />
      <path d="M10 37Q24 31 46 29M150 23Q182 25 208 32" fill="none" stroke="#ffb067" strokeWidth="3" />
      <path d="M8 45H216" stroke="#ff9a52" strokeWidth="2" opacity="0.6" />
      <rect x="208" y="36" width="12" height="7" rx="2" fill="#fff1c9" stroke={INK} strokeWidth="2" />
      <rect x="2" y="38" width="9" height="7" rx="2" fill="#ff4f87" stroke={INK} strokeWidth="2" />
      {[48, 172].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="58" r="17" fill="#140715" stroke={INK} strokeWidth="3" />
          <circle cx={cx} cy="58" r="9" fill="#ffc94d" stroke={INK} strokeWidth="2.5" />
          <circle cx={cx} cy="58" r="3" fill={INK} />
        </g>
      ))}
    </g>
  );
}

const CARS: { lane: 0 | 1; dur: number; delay: number; x: string }[] = [
  { lane: 0, dur: 14, delay: -2, x: "70%" },
  { lane: 0, dur: 17, delay: -9, x: "28%" },
  { lane: 0, dur: 15, delay: -13, x: "48%" },
  { lane: 1, dur: 16, delay: -5, x: "16%" },
  { lane: 1, dur: 13, delay: -10, x: "60%" },
  { lane: 1, dur: 19, delay: -15, x: "84%" },
];

function FrontFx({ evidence }: { evidence: boolean }) {
  return (
    <div className="sk-fx">
      {/* traffic: headlights head west in the far lane, tail lights east in the near lane */}
      {CARS.map((c, i) => (
        <span
          key={i}
          className={`sk-car ${c.lane === 0 ? "sk-car-l" : "sk-car-r"}`}
          style={{
            left: px(FREEWAY.x0),
            top: py(FREEWAY.y0 + (c.lane === 0 ? 1.6 : 4.6)),
            width: px(FREEWAY.x1 - FREEWAY.x0),
            rotate: `${FREEWAY_ANGLE}deg`,
            ["--x" as string]: c.x,
            animationDuration: `${c.dur}s`,
            animationDelay: `${c.delay}s`,
          }}
        />
      ))}

      {/* a helicopter crosses the sky; SLOT1 notices it */}
      <div className="sk-heli" style={{ top: py(186) }}>
        <div className="sk-heli-craft" style={{ width: px(70) }}>
          <span className="sk-heli-cone" />
          <svg viewBox="0 0 70 30" className="relative block h-auto w-full">
            <path d="M6 5h58" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
            <path d="M35 5v5" stroke={INK} strokeWidth="2.6" />
            <path d="M24 14c0-3 4-4.5 10-4.5h6c6 0 11 3 11 7.5s-4 6-10 6h-9c-5 0-8-3-8-9z" fill="#2c1533" stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
            <path d="M43 11.5c4 0 7 2.5 7.5 5.5h-8z" fill="#ffb067" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M24 16H7l-2-5" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M28 23.5l-3 4.5h24l-3-4.5" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>
          <span className="sk-heli-light" />
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

      {/* palms in front */}
      <Palm x={32} h={252} tilt={-6} />
      <Palm x={138} h={196} tilt={7} flip />
      <Palm x={1484} h={474} tilt={3} flip />
      <Palm x={1580} h={372} tilt={-5} />
    </div>
  );
}

/** A palm in the loading-screen style: inked outline, dark fronds, a warm rim on top. */
function Palm({ x, h, tilt, flip = false }: { x: number; h: number; tilt: number; flip?: boolean }) {
  const w = h * 0.74;
  return (
    <span
      className="sk-palm"
      style={{
        left: px(x - w / 2),
        top: py(VB.h - h + 6),
        width: px(w),
        height: py(h),
        rotate: `${tilt}deg`,
        animationDuration: `${7 + (x % 5)}s`,
        animationDelay: `${-(x % 7)}s`,
      }}
    >
      <svg viewBox="0 0 220 320" preserveAspectRatio="none" className="block h-full w-full" style={flip ? { transform: "scaleX(-1)" } : undefined}>
        <g fill="#1a0a1e" stroke={INK} strokeWidth="4" strokeLinejoin="round">
          <path d="M101 322C104 250 113 160 122 76L134 76C128 164 122 252 120 322Z" />
          <path d="M128 70C100 52 62 60 26 120C66 86 100 82 128 82Z" />
          <path d="M128 70C108 40 80 26 46 30C80 38 104 56 126 80Z" />
          <path d="M128 70C124 40 116 14 100 0C122 18 134 42 134 74Z" />
          <path d="M128 70C146 38 164 20 184 10C170 34 152 56 134 79Z" />
          <path d="M128 70C162 50 196 50 220 66C190 64 160 72 134 82Z" />
          <path d="M130 74C168 80 190 108 200 148C178 116 156 98 130 87Z" />
          <path d="M126 76C98 90 78 120 62 166C88 126 106 106 128 87Z" />
        </g>
        <path d="M60 36C84 36 104 52 122 72M150 30C164 24 176 16 184 11M140 62C162 54 192 54 214 64" stroke="#ff9a52" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.8" />
        <path d="M108 300h12M110 268h12M112 236h12M114 204h12M116 172h12M118 140h11M120 108h11" stroke={INK} strokeWidth="3" />
        <circle cx="128" cy="78" r="8" fill="#1a0a1e" stroke={INK} strokeWidth="3" />
      </svg>
    </span>
  );
}
