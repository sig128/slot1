/**
 * Original artwork (drawn for SLOT1, no third-party or game assets): a coastline city after
 * dark — a thin sunset band on the horizon, palms, a low skyline with a few lit windows and
 * the light breaking up on the water.
 */
export function SkylineArt({ className = "" }: { className?: string }) {
  const windows: [number, number][] = [
    [212, 214], [236, 230], [252, 206], [404, 198], [420, 222], [436, 186], [611, 230], [626, 206],
    [779, 214], [795, 190], [961, 226], [1006, 202], [1022, 238], [1150, 220], [1166, 196],
  ];
  return (
    <div className={`grain relative overflow-hidden ${className}`} aria-hidden>
      <svg viewBox="0 0 1440 420" preserveAspectRatio="xMidYMax slice" className="block h-full w-full">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#101014" />
            <stop offset="0.55" stopColor="#1b1520" />
            <stop offset="0.8" stopColor="#3a1a2c" />
            <stop offset="0.93" stopColor="#7a2c45" />
            <stop offset="1" stopColor="#ff4f87" stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id="horizon" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff4f87" stopOpacity="0" />
            <stop offset="0.35" stopColor="#ff4f87" />
            <stop offset="0.7" stopColor="#ffad72" />
            <stop offset="1" stopColor="#ffad72" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#24121c" />
            <stop offset="1" stopColor="#0b0b0e" />
          </linearGradient>
        </defs>
        <rect width="1440" height="300" fill="url(#sky)" />
        {/* sun, mostly below the horizon */}
        <circle cx="1040" cy="300" r="120" fill="#ffad72" opacity="0.18" />
        <circle cx="1040" cy="300" r="74" fill="#ffad72" opacity="0.32" />
        {/* skyline */}
        <g fill="#0d0c11">
          <rect x="190" y="180" width="80" height="120" />
          <rect x="276" y="230" width="46" height="70" />
          <rect x="390" y="160" width="62" height="140" />
          <rect x="456" y="210" width="40" height="90" />
          <rect x="600" y="190" width="44" height="110" />
          <rect x="648" y="235" width="70" height="65" />
          <rect x="770" y="170" width="44" height="130" />
          <rect x="818" y="226" width="58" height="74" />
          <rect x="950" y="186" width="90" height="114" />
          <rect x="1140" y="176" width="52" height="124" />
          <rect x="1196" y="236" width="80" height="64" />
        </g>
        <g fill="#ffad72" opacity="0.85">
          {windows.map(([x, y], i) => (
            <rect key={i} x={x} y={y} width="5" height="7" />
          ))}
        </g>
        {/* palms */}
        <g fill="#0a090d">
          <path d="M96 300 C 101 250, 108 214, 112 176 L 117 176 C 114 214, 110 252, 106 300 Z" />
          <path d="M114 178 C 90 162, 62 166, 40 182 C 66 170, 92 172, 112 184 Z" />
          <path d="M115 176 C 132 152, 162 146, 188 156 C 160 154, 136 162, 118 182 Z" />
          <path d="M114 176 C 104 150, 82 138, 58 140 C 82 146, 100 158, 111 182 Z" />
          <path d="M116 176 C 140 168, 166 176, 182 196 C 160 182, 138 178, 117 182 Z" />
          <path d="M1318 300 C 1312 256, 1306 226, 1300 196 L 1305 196 C 1311 226, 1318 256, 1326 300 Z" />
          <path d="M1302 198 C 1280 184, 1254 186, 1232 200 C 1256 190, 1280 192, 1300 204 Z" />
          <path d="M1304 196 C 1322 176, 1350 172, 1374 184 C 1348 180, 1326 186, 1306 202 Z" />
          <path d="M1303 196 C 1294 174, 1274 164, 1252 166 C 1274 172, 1290 182, 1300 202 Z" />
        </g>
        <rect x="0" y="298" width="1440" height="3" fill="url(#horizon)" />
        <rect x="0" y="301" width="1440" height="119" fill="url(#water)" />
        {/* light on the water */}
        <g fill="#ff4f87" opacity="0.55">
          <rect x="980" y="314" width="120" height="2" />
          <rect x="1004" y="330" width="78" height="2" opacity="0.7" />
          <rect x="1020" y="348" width="44" height="2" opacity="0.5" />
        </g>
        <g fill="#ffad72" opacity="0.35">
          <rect x="226" y="320" width="26" height="1.5" />
          <rect x="412" y="338" width="20" height="1.5" />
          <rect x="786" y="326" width="22" height="1.5" />
        </g>
      </svg>
    </div>
  );
}
