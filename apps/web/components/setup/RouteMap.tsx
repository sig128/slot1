/**
 * "How the video travels", drawn like an in-game map with GPS routes. Two lanes: a console
 * broadcasting straight to Twitch (SLOT1 shows Twitch's player and sees nothing), and a capture
 * card + OBS sending SLOT1 its own copy (analyzed, played live, forwarded). Large screens get the
 * map; smaller ones the same routes as a list. Original drawing: generic glyphs, no platform logos.
 */

const INK = "#140715";

function Label({
  x,
  y,
  children,
  size = 17,
  anchor = "middle",
  tone = "#f4ede2",
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  size?: number;
  anchor?: "start" | "middle" | "end";
  tone?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} className="su-map-label" fontSize={size} fill={tone}>
      {children}
    </text>
  );
}

function Blip({ x, y, fill, children }: { x: number; y: number; fill: string; children: React.ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="25" fill={fill} stroke={INK} strokeWidth="5" />
      {children}
    </g>
  );
}

const Console = (
  <g fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M-12 -6h24a6 6 0 0 1 5.6 4l2.6 8a4 4 0 0 1-6.8 3.8L9 6H-9l-4.4 3.8A4 4 0 0 1-20.2 6l2.6-8A6 6 0 0 1-12-6Z" />
    <path d="M-9 0v-0.1M-12 0h6M9 -1v0.1M12 2v0.1" />
  </g>
);
const Screen = (
  <g fill="none" stroke={INK} strokeWidth="3.4" strokeLinejoin="round">
    <rect x="-13" y="-11" width="26" height="17" rx="2" />
    <path d="M-5 12h10M0 6v6" strokeLinecap="round" />
  </g>
);
const Play = <path d="M-6 -9L10 0L-6 9Z" fill={INK} />;
const Eye = (
  <g fill="none" stroke={INK} strokeWidth="3.4">
    <path d="M-15 0C-9 -9 9 -9 15 0C9 9 -9 9 -15 0Z" strokeLinejoin="round" />
    <circle r="4.2" fill={INK} />
  </g>
);
const EyeOff = (
  <g fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round">
    <path d="M-15 0C-9 -9 9 -9 15 0C9 9 -9 9 -15 0Z" strokeLinejoin="round" />
    <path d="M-12 11L12 -11" />
  </g>
);

/** A GPS route: an ink casing under a coloured line, drawn in when the page loads. */
function Route({ d, color, delay }: { d: string; color: string; delay: number }) {
  return (
    <g style={{ ["--su-delay" as string]: `${delay}ms` }}>
      <path d={d} fill="none" stroke={INK} strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" className="su-route" pathLength={1} />
      <path d={d} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" className="su-route" pathLength={1} />
    </g>
  );
}

function Chip({ x, y, w, children, tone }: { x: number; y: number; w: number; children: React.ReactNode; tone: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height="26" rx="3" fill="rgb(10 5 14 / 0.86)" stroke={tone} strokeWidth="1.5" />
      <text x={w / 2} y="18" textAnchor="middle" className="su-map-chip" fill={tone}>
        {children}
      </text>
    </g>
  );
}

export function RouteMap() {
  return (
    <figure className="su-map">
      <svg viewBox="0 0 1000 480" className="su-map-svg" role="img" aria-labelledby="su-map-title su-map-desc">
        <title id="su-map-title">How the video travels</title>
        <desc id="su-map-desc">
          Console only: the PS5 broadcasts to Twitch, and SLOT1’s watch page shows Twitch’s own player, so SLOT1 sees nothing. With a capture card and OBS: your
          video goes to SLOT1, which analyzes it, plays it live to viewers with the AI log, and can forward the same stream to Twitch, YouTube and Kick.
        </desc>
        {/* the map */}
        <rect width="1000" height="480" fill="#221f2a" />
        <path d="M0 410C110 392 210 430 290 480H0Z" fill="#1d3654" />
        <path d="M1000 0V150C935 132 885 70 868 0Z" fill="#1d3654" />
        <path d="M0 410C110 392 210 430 290 480M1000 150C935 132 885 70 868 0" fill="none" stroke="#7fb2ff" strokeOpacity="0.35" strokeWidth="2" />
        <g stroke="#2f2b39" strokeWidth="12" fill="none">
          <path d="M0 205H1000M0 30H860M300 0V480M640 0V480M800 205V480M120 205V400" />
        </g>
        <g stroke="#3b3747" strokeWidth="2" fill="none">
          <path d="M0 205H1000M0 30H860M300 0V480M640 0V480M800 205V480M120 205V400" />
        </g>
        <path d="M0 470C200 440 420 470 640 440S900 380 1000 360" fill="none" stroke="#3a2c35" strokeWidth="14" />

        {/* lane 1: console only */}
        <Label x={40} y={60} anchor="start" size={20} tone="#f4ede2">
          Console only
        </Label>
        <Chip x={162} y={42} w={196} tone="#b8b0a4">
          SLOT1 SEES: NOTHING
        </Chip>
        <path
          d="M137 120H443M497 120H823"
          stroke="#8a847b"
          strokeWidth="5"
          strokeDasharray="2 12"
          strokeLinecap="round"
          fill="none"
          className="su-route-faint"
        />
        <Label x={290} y={108} size={16} tone="#d9d1c5">
          built-in broadcast
        </Label>
        <Label x={660} y={108} size={16} tone="#d9d1c5">
          Twitch’s player, watch only
        </Label>
        <Blip x={110} y={120} fill="#d9d1c5">
          {Console}
        </Blip>
        <Blip x={470} y={120} fill="#a98be6">
          {Screen}
        </Blip>
        <Blip x={850} y={120} fill="#8a847b">
          {EyeOff}
        </Blip>
        <Label x={110} y={170}>
          PS5
        </Label>
        <Label x={470} y={84}>
          Twitch
        </Label>
        <Label x={850} y={170}>
          SLOT1 watch page
        </Label>

        {/* lane 2: capture card + OBS */}
        <Label x={40} y={255} anchor="start" size={20} tone="#f4ede2">
          Capture card + OBS
        </Label>
        <Chip x={222} y={237} w={262} tone="#ffc94d">
          SLOT1 SEES: THE FRAMES IT GETS
        </Chip>
        <Route d="M137 330H440" color="#ffc94d" delay={150} />
        <Route d="M500 330H822" color="#ff4f87" delay={650} />
        <Route d="M470 300V150" color="#ffad72" delay={1050} />
        <Route d="M470 360V398H380V418M470 398H560V418" color="#ffad72" delay={1150} />
        <Label x={290} y={316} size={16} tone="#ffe2a0">
          your video
        </Label>
        <Label x={660} y={316} size={16} tone="#ffc1d4">
          live video + the AI log
        </Label>
        <Label x={484} y={232} anchor="start" size={16} tone="#ffd3b0">
          forwarded to Twitch
        </Label>
        <Label x={584} y={393} anchor="start" size={16} tone="#ffd3b0">
          forwarded, not re-encoded
        </Label>
        <Blip x={110} y={330} fill="#d9d1c5">
          {Screen}
        </Blip>
        <g transform="translate(470 330)">
          <circle className="su-hq-ping" r="34" fill="none" stroke="#ffc94d" strokeWidth="4" />
          <rect x="-24" y="-27" width="48" height="54" rx="7" fill="url(#su-hq)" stroke={INK} strokeWidth="5" />
          <text y="16" textAnchor="middle" className="su-map-hq">
            1
          </text>
        </g>
        <defs>
          <linearGradient id="su-hq" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff4f87" />
            <stop offset="0.5" stopColor="#ff7a7c" />
            <stop offset="1" stopColor="#ffad72" />
          </linearGradient>
        </defs>
        <Blip x={850} y={330} fill="#ff4f87">
          {Eye}
        </Blip>
        <Blip x={380} y={440} fill="#d9d1c5">
          {Play}
        </Blip>
        <Blip x={560} y={440} fill="#d9d1c5">
          {Play}
        </Blip>
        <Label x={110} y={380}>
          PC + OBS
        </Label>
        <Label x={502} y={296} anchor="start" tone="#ffe2a0">
          SLOT1
        </Label>
        <Label x={850} y={380}>
          Viewers on SLOT1
        </Label>
        <Label x={340} y={447} anchor="end">
          YouTube
        </Label>
        <Label x={600} y={447} anchor="start">
          Kick
        </Label>
      </svg>

      {/* The same routes as a list, for narrower screens. */}
      <div className="su-lanes">
        <section className="su-lane" aria-label="Console only">
          <p className="su-lane-title">
            Console only <span className="su-lane-tag">SLOT1 sees nothing</span>
          </p>
          <ol className="su-stops" data-tone="faint">
            <li>
              <span className="su-stop-name">PS5</span>
              <span className="su-stop-note">broadcasts with its built-in feature</span>
            </li>
            <li>
              <span className="su-stop-name">Twitch</span>
              <span className="su-stop-note">the only place the PS5 sends video</span>
            </li>
            <li>
              <span className="su-stop-name">SLOT1 watch page</span>
              <span className="su-stop-note">shows Twitch’s own player, watch only</span>
            </li>
          </ol>
        </section>
        <section className="su-lane" aria-label="Capture card and OBS">
          <p className="su-lane-title">
            Capture card + OBS <span className="su-lane-tag su-lane-tag-gold">SLOT1 sees the frames it gets</span>
          </p>
          <ol className="su-stops" data-tone="gold">
            <li>
              <span className="su-stop-name">PC + OBS</span>
              <span className="su-stop-note">sends SLOT1 its own copy of your video</span>
            </li>
            <li>
              <span className="su-stop-name">SLOT1</span>
              <span className="su-stop-note">analyzes it, and can forward it to Twitch, YouTube and Kick without re-encoding</span>
            </li>
            <li>
              <span className="su-stop-name">Viewers on SLOT1</span>
              <span className="su-stop-note">live video and the AI log, side by side</span>
            </li>
          </ol>
        </section>
      </div>
    </figure>
  );
}
