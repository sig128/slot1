import Link from "next/link";
import type { Capabilities, ChannelCard, DirectoryResponse } from "@slot1/contracts";
import { ScenePlayback } from "@/components/brand/ScenePlayback";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { compactNumber } from "@/lib/format";
import { requirementText } from "@/lib/requirements";
import { LinkOpener } from "./LinkOpener";
import { ChannelAvatar, LiveDirectory } from "./LiveDirectory";

/**
 * The top of the home page: SLOT1's intro over the animated skyline, then the live directory.
 * Server-rendered (the artwork costs no JavaScript); only the directory search, the link opener
 * and the off-screen pause are client code.
 */
export function OnAirView({ directory, capabilities }: { directory: DirectoryResponse; capabilities: Capabilities | null }) {
  const listed = directory.channels;
  const live = listed.filter((c) => c.broadcast.state === "live");
  const mode = listed.length === 0 ? "empty" : "live";
  const twitchReady = capabilities?.twitch.available ?? false;

  return (
    <>
      <section data-scene data-mode={mode} aria-labelledby="intro-title" className="sk-hero flex flex-col">
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-[clamp(2.75rem,8vh,6.5rem)] sm:px-6 lg:px-10 lg:pb-16">
          <div className="max-w-[46rem]">
            <h1 id="intro-title" className={`poster-title leading-[0.86] ${mode === "empty" ? "text-[clamp(3.1rem,6.9vw,6.9rem)]" : "text-[clamp(2.7rem,5.6vw,5.6rem)]"}`}>
              <span className="sk-line">
                <span className="sk-rise" style={{ animationDelay: "60ms" }}>
                  The AI that watches
                </span>
              </span>{" "}
              <span className="sk-line">
                <span className="sk-rise" style={{ animationDelay: "170ms" }}>
                  GTA streams with you.
                </span>
              </span>
            </h1>
            <p className="sk-reveal mt-6 max-w-[34rem] text-[1.075rem] leading-relaxed text-ivory-2 sm:text-[1.15rem]" style={{ animationDelay: "520ms" }}>
              SLOT1 sits beside a GTA broadcast, logs what it actually sees and links every line to the frames it came from. Streams sent to SLOT1 also get live
              video, instant replays and clips.
            </p>
            <div className="sk-reveal mt-8 flex flex-wrap gap-3" style={{ animationDelay: "680ms" }}>
              <Link href="/demo" className="btn btn-coral h-11 px-5 text-[1.08rem]">
                Watch the live demo
              </Link>
              {twitchReady ? (
                <Link href="/studio" className="btn btn-ghost h-11 bg-graphite/40 px-5 text-[1.08rem]">
                  Connect my Twitch
                </Link>
              ) : (
                <Link href="/setup" className="btn btn-ghost h-11 bg-graphite/40 px-5 text-[1.08rem]">
                  How creators connect
                </Link>
              )}
            </div>
            <div className="sk-reveal mt-8" style={{ animationDelay: "820ms" }}>
              {mode === "empty" ? <EmptyStatus /> : <LiveStatus live={live} listed={listed.length} />}
            </div>
          </div>
        </div>
        <div className="sk-hero-art mt-auto">
          <SkylineArt animated intro evidence idPrefix="skh" className="h-full w-full" />
        </div>
        <ScenePlayback />
      </section>

      {mode === "empty" ? <EmptyBand twitchReady={twitchReady} capabilities={capabilities} /> : <LiveDirectory directory={directory} />}
    </>
  );
}

function EmptyStatus() {
  return (
    <p className="flex max-w-[34rem] items-start gap-2.5 text-[0.98rem] text-ivory-2">
      <span className="stale-dot mt-[0.45rem] text-ivory-3" aria-hidden />
      <span>
        <span className="font-display text-[1.08rem] font-semibold text-ivory">Nothing on air yet.</span> Channels appear here the moment their creator goes live.
      </span>
    </p>
  );
}

function LiveStatus({ live, listed }: { live: ChannelCard[]; listed: number }) {
  const n = live.length;
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.98rem] text-ivory-2">
        {n > 0 ? (
          <span className="flex items-center gap-2 font-display text-[1.12rem] font-semibold text-coral">
            <span className="live-dot live-dot-pulse" aria-hidden />
            {n === 1 ? "1 channel live now" : `${n} channels live now`}
          </span>
        ) : (
          <span className="flex items-center gap-2 font-display text-[1.12rem] font-semibold text-ivory">
            <span className="stale-dot text-ivory-3" aria-hidden />
            No one is live right now
          </span>
        )}
        <a href="#on-air" className="underline decoration-line-strong underline-offset-4 hover:text-ivory">
          {listed === 1 ? "See the channel" : `See all ${listed} channels`}
        </a>
      </p>
      {n > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Live now">
          {live.slice(0, 3).map((c) => (
            <li key={c.broadcasterId}>
              <Link
                href={`/watch/${c.login}`}
                className="flex h-11 items-center gap-2.5 rounded-[2px] border border-line-strong bg-graphite/60 pl-1.5 pr-3.5 backdrop-blur-sm transition-colors hover:border-ivory-2"
              >
                <ChannelAvatar c={c} size={30} />
                <span className="max-w-[11rem] truncate font-display text-[1.05rem] font-semibold">{c.displayName}</span>
                {c.broadcast.viewerCount !== null && <span className="tnum text-[0.82rem] text-ivory-3">{compactNumber(c.broadcast.viewerCount)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyBand({ twitchReady, capabilities }: { twitchReady: boolean; capabilities: Capabilities | null }) {
  return (
    <section aria-label="Get started" className="border-t hairline">
      <div className="mx-auto grid max-w-[1600px] gap-12 px-4 py-14 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-5">
          <h2 className="font-display text-2xl font-bold">Watch any public channel</h2>
          <p className="mb-4 mt-1 text-sm text-ivory-3">Opens the official Twitch player. Without the creator’s opt-in there is no analysis.</p>
          <LinkOpener />
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <h2 className="font-display text-2xl font-bold">Have a replay?</h2>
          <p className="mt-1 max-w-[52ch] text-sm text-ivory-3">Upload a GTA recording and see exactly what SLOT1 logs from it, frame by frame.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/studio#sources" className="btn btn-ghost">
              Upload a replay
            </Link>
          </div>
          {capabilities && !twitchReady && (
            <p className="mt-6 max-w-[60ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
              Channels can’t connect until Twitch is configured on this deployment. {requirementText(capabilities.twitch.reason)}{" "}
              <Link href="/setup#twitch" className="underline hover:text-ivory">
                Setup guide
              </Link>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
