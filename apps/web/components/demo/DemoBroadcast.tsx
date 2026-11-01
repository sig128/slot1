import Link from "next/link";
import type { ClipView, DemoInfo, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { WatchClient } from "@/components/watch/WatchClient";

/** One station on the signal path. The order is the real order a frame travels in. */
interface Station {
  name: string;
  detail: string;
  /** What this station is in the demo, when it differs from a real stream. */
  here?: string;
}

function stations(info: DemoInfo): Station[] {
  const sample = Math.round(info.sampleIntervalMs / 100) / 10;
  return [
    { name: "The streamer’s PC", detail: "OBS sends the stream to SLOT1 over RTMP or WHIP, with a key from Studio.", here: "Here: SLOT1’s demo generator on this server, drawing a synthetic scene live." },
    { name: "SLOT1 ingest", detail: "The gateway asks SLOT1’s API whether that key may publish, then takes the stream in.", here: info.gateway ? `Gateway: ${info.gateway === "mediamtx" ? "MediaMTX" : "nginx-rtmp"}.` : undefined },
    { name: "Frame sampling", detail: `The worker takes one frame every ${sample} s from the stream it’s reading.` },
    {
      name: "The AI looks",
      detail: "OCR reads the screen regions where a game shows text. AI vision and SLOT1’s GTA model look at the whole frame when they’re switched on.",
      here: info.vision ? "AI vision is on for the demo (rate-limited)." : "For the demo: OCR only. Paid AI vision stays off.",
    },
    { name: "Live log", detail: "What was read becomes evidence-backed entries. Result screens become banners, instant replays and clips." },
    {
      name: "Viewers",
      detail: "Watch SLOT1’s copy over WebRTC, usually under a second behind, next to the log. Twitch keeps its own broadcast.",
      here: info.liveVideo ? undefined : "This server has no WebRTC gateway, so the demo shows the analyzed frames instead of video.",
    },
  ];
}

function SignalPath({ info }: { info: DemoInfo }) {
  const list = stations(info);
  return (
    <ol className="grid gap-px border hairline bg-[var(--color-line)] md:grid-cols-3 xl:grid-cols-6" aria-label="How a frame travels through SLOT1">
      {list.map((s, i) => (
        <li key={s.name} className="relative bg-graphite-900 p-4 pr-6">
          <span className="poster-title block text-[2rem] leading-none text-gold" aria-hidden>
            {i + 1}
          </span>
          <h3 className="mt-2 font-display text-[1.08rem] font-bold tracking-[0.01em] text-ivory">{s.name}</h3>
          <p className="mt-1 text-[0.86rem] leading-snug text-ivory-2">{s.detail}</p>
          {s.here && <p className="mt-2 border-l-2 border-apricot pl-2 text-[0.8rem] leading-snug text-apricot">{s.here}</p>}
          {i < list.length - 1 && (
            <span className="absolute right-1.5 top-4 hidden text-ivory-3 xl:block" aria-hidden>
              ›
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function TryList({ info, live }: { info: DemoInfo; live: boolean }) {
  const items: { title: string; body: React.ReactNode }[] = [
    {
      title: "Instant replay",
      body: live ? (
        <>When MISSION PASSED, WASTED or BUSTED appears, press Replay on its banner or on the entry in the log. The replay starts a few seconds before the moment.</>
      ) : (
        <>Appears on result screens while the demo is live.</>
      ),
    },
    {
      title: "Los Santos right now",
      body: (
        <>
          The demo shows up among the live streams. Flip stations with the{" "}
          <Link href={`/los-santos${info.login ? `?stream=${encodeURIComponent(info.login)}` : ""}`} className="underline underline-offset-4 hover:text-ivory">
            radio wheel
          </Link>
          .
        </>
      ),
    },
    {
      title: "Clips",
      body: info.profilePath ? (
        <>
          About every ten minutes SLOT1 cuts a short clip around a result screen. They’re on the{" "}
          <Link href={info.profilePath} className="underline underline-offset-4 hover:text-ivory">
            demo’s profile
          </Link>{" "}
          (the newest 20 are kept).
        </>
      ) : (
        <>Clips of result screens appear on the demo’s profile.</>
      ),
    },
    {
      title: "The clip editor",
      body: (
        <>
          Creators who turn on Recording in Studio can trim any moment, add text and render vertical clips in Studio’s library. The demo doesn’t record
          the whole stream, so its clips are cut from the short rolling buffer instead.
        </>
      ),
    },
    {
      title: "What the AI sees",
      body: <>Open under the timeline. Blue boxes are the screen regions OCR reads; gold boxes are the exact lines it read in this frame.</>,
    },
  ];
  return (
    <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-5">
      {items.map((t) => (
        <li key={t.title}>
          <h3 className="font-display text-[1.05rem] font-bold text-ivory">{t.title}</h3>
          <p className="mt-1 text-[0.88rem] leading-snug text-ivory-2">{t.body}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The demo page: how a broadcast flows through SLOT1, then the live demo channel with "What the
 * AI sees" open. Everything below the explainer is the real pipeline reading a synthetic video.
 */
export function DemoBroadcast({
  info,
  watch,
  page,
  clips,
  embedParents,
}: {
  info: DemoInfo;
  watch: WatchChannelResponse | null;
  page: ObservationPage | null;
  clips: ClipView[];
  embedParents: string[];
}) {
  const live = Boolean(watch?.session && info.onAir);
  return (
    <div>
      <section className="mx-auto max-w-[1600px] px-4 pt-8 sm:px-6 lg:px-10" aria-labelledby="demo-title">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip chip-replay">Demo</span>
          <span className="chip chip-muted">Synthetic test video</span>
          {info.enabled && <span className={`chip ${live ? "chip-live" : "chip-stale"}`}>{live ? "On air" : "Off air"}</span>}
        </div>
        <h1 id="demo-title" className="poster-title mt-3 max-w-[18ch] text-[length:var(--text-display-md)] font-black leading-[0.92]">
          Watch SLOT1 watch a stream
        </h1>
        <p className="mt-3 max-w-[68ch] text-[1.02rem] text-ivory-2">
          This channel plays a test video that SLOT1 draws on this server: a night drive with HUD text where a game would show it. It isn’t gameplay. Every
          entry in the log, every banner and every box in “What the AI sees” is real output of SLOT1’s pipeline reading that video.
        </p>
        <div className="mt-6">
          <SignalPath info={info} />
        </div>
      </section>

      {info.enabled && watch ? (
        <WatchClient watch={watch} page={page} clips={clips} embedParents={embedParents} clipSlug={null} aiViewOpen />
      ) : (
        <section className="mx-auto max-w-[1600px] px-4 py-10 sm:px-6 lg:px-10" aria-label="Demo status">
          <div className="max-w-[70ch] border-l-2 border-apricot pl-4">
            <p className="font-display text-xl font-bold text-ivory">{info.enabled ? "The demo channel isn’t ready yet" : "The demo is off right now"}</p>
            <p className="mt-1 text-sm text-ivory-2">
              {info.reason ?? (info.enabled ? "Reload in a moment." : "Nothing is being generated or analyzed for the demo right now.")}
            </p>
          </div>
        </section>
      )}

      {info.enabled && (
        <section className="mx-auto max-w-[1600px] border-t hairline px-4 pb-16 pt-8 sm:px-6 lg:px-10" aria-labelledby="demo-try">
          <h2 id="demo-try" className="font-display text-[1.5rem] font-bold text-ivory">
            Things to try
          </h2>
          <div className="mt-4">
            <TryList info={info} live={live} />
          </div>
        </section>
      )}
    </div>
  );
}
