import { rng } from "@/components/brand/skyline-geometry";

/**
 * The home intro's HUD, in the conventions of an open-world game: wanted-style stars and a
 * money-style counter top right, a round radar bottom left. Every number is real: the stars and
 * the counter both show channels live on SLOT1 right now (stars capped at five); the radar's red
 * blips are those channels. Nothing here is money or a score.
 */
export function IntroHudCounter({ live }: { live: number }) {
  const stars = Math.min(5, live);
  return (
    <div className="gx-hud-tr gx-in">
      <div className="gx-stars" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <svg key={i} viewBox="0 0 24 24" className={i < stars ? "gx-star gx-star-on" : "gx-star"}>
            <path d="M12 2.4l2.9 6.4 7 .7-5.3 4.6 1.6 6.9L12 17.4 5.8 21l1.6-6.9L2.1 9.5l7-.7z" />
          </svg>
        ))}
      </div>
      <p className="gx-money">
        <span className="gx-money-num tnum">{live}</span>
        <span className="gx-money-cap">{live === 1 ? "channel live" : "channels live"}</span>
      </p>
    </div>
  );
}

const ROADS =
  // An original little city: a grid that bends along the coast, one freeway, a pier.
  "M-120 -40H120M-120 10H120M-120 58H120M-60 -120V120M-6 -120V120M48 -120V120M98 -120V40" +
  "M-120 -88C-60 -84 0 -96 120 -92";
const FREEWAY = "M-120 32C-40 20 40 30 120 -6";

export function IntroRadar({ live }: { live: number }) {
  const rand = rng(97);
  const blips = Array.from({ length: Math.min(6, live) }, () => [Math.round(-70 + rand() * 140), Math.round(-70 + rand() * 120)] as const);
  return (
    <div className="gx-radar gx-in" aria-hidden>
      <svg viewBox="-110 -110 220 220" className="block h-full w-full">
        <defs>
          <clipPath id="gx-radar-clip">
            <circle r="100" />
          </clipPath>
        </defs>
        <circle r="104" fill="#140715" />
        <g clipPath="url(#gx-radar-clip)">
          <rect x="-110" y="-110" width="220" height="220" fill="#24212b" />
          {/* the bay */}
          <path d="M-110 110V40C-80 46 -56 70 -40 110Z" fill="#26476c" />
          <path d="M-110 40C-80 46 -56 70 -40 110" fill="none" stroke="#7fb2ff" strokeWidth="2" opacity="0.6" />
          {/* blocks of the city */}
          <path d={ROADS} stroke="#6f6a72" strokeWidth="5" fill="none" />
          <path d={ROADS} stroke="#9a948f" strokeWidth="1.4" fill="none" />
          <path d={FREEWAY} stroke="#ffad72" strokeWidth="6" fill="none" opacity="0.85" />
          <path d="M60 -110L110 -60V-110Z" fill="#3a2a3f" />
          {/* channels live right now */}
          {blips.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="6" fill="#ff4f87" stroke="#140715" strokeWidth="2" />
          ))}
        </g>
        {/* SLOT1 HQ */}
        <g transform="translate(34 -30)">
          <circle className="gx-radar-ping" r="16" fill="none" stroke="#ffc94d" strokeWidth="2.5" />
          <rect x="-9" y="-10" width="18" height="20" rx="3" fill="#ff7a7c" stroke="#140715" strokeWidth="2.5" />
          <text y="6" textAnchor="middle" fill="#140715" style={{ font: "900 15px 'Passion One', 'Barlow Condensed', sans-serif" }}>
            1
          </text>
        </g>
        {/* you */}
        <path d="M0 -12L9 10L0 5L-9 10Z" fill="#f4ede2" stroke="#140715" strokeWidth="2.5" strokeLinejoin="round" />
        <circle r="101" fill="none" stroke="#f4ede2" strokeOpacity="0.28" strokeWidth="2" />
        <circle r="104" fill="none" stroke="#140715" strokeWidth="6" />
        <g transform="translate(0 -96)">
          <circle r="10" fill="#140715" />
          <text y="5" textAnchor="middle" fill="#f4ede2" style={{ font: "700 14px 'Barlow Condensed', sans-serif" }}>
            N
          </text>
        </g>
      </svg>
    </div>
  );
}
