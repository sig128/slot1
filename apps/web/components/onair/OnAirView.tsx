import "@/components/home/intro.css";
import Link from "next/link";
import type { Capabilities, ChannelCard, DirectoryResponse } from "@slot1/contracts";
import { ScenePlayback } from "@/components/brand/ScenePlayback";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { IntroHudCounter, IntroRadar } from "@/components/home/IntroHud";
import { IntroSteps } from "@/components/home/IntroSteps";
import { IntroTips } from "@/components/home/IntroTips";
import { compactNumber } from "@/lib/format";
import { SetupFix } from "@/components/ui/SetupFix";
import { CreatorRewardsSoon } from "@/components/home/CreatorRewardsSoon";
import { LinkOpener } from "./LinkOpener";
import { ChannelAvatar, LiveDirectory } from "./LiveDirectory";

/**
 * The top of the home page: a game-style loading screen that resolves into SLOT1's title card
 * ("Your AI sidekick for GTA."), with a HUD that shows real numbers, then "How it works" in three
 * steps (after the live directory when channels are listed). Server-rendered (the artwork costs no
 * JavaScript); only the directory search, the link opener and the playback control are client
 * code. The sequence is in components/home/intro.css.
 */
export function OnAirView({ directory, capabilities }: { directory: DirectoryResponse; capabilities: Capabilities | null }) {
  const listed = directory.channels;
  const live = listed.filter((c) => c.broadcast.state === "live");
  const mode = listed.length === 0 ? "empty" : "live";
  const twitchReady = capabilities?.twitch.available ?? false;

  return (
    <>
      <section data-scene data-mode={mode} aria-labelledby="intro-title" className="gx-hero">
        <div className="gx-copy">
          <h1 id="intro-title" className="max-w-[48rem]">
            <span className="gx-mark" aria-hidden>
              <span className="gx-mark-slot">SLOT</span>
              <span className="gx-mark-one">
                <span>1</span>
              </span>
            </span>
            <span className="sr-only">SLOT1: </span>
            <span className="gx-tagline">
              <span>Your AI sidekick for GTA.</span>
            </span>
          </h1>
          <p className="gx-help gx-reveal mt-5" style={{ animationDelay: "2.7s" }}>
            <strong className="block font-display text-[1.3rem] font-bold tracking-[0.01em] text-ivory">
              <span>Stream GTA. Get clips. Train the AI.</span> <CreatorRewardsSoon />
            </strong>
            SLOT1 watches your stream live, clips your big moments for you, and learns the game from every stream you choose to share.
          </p>
          <div className="gx-reveal mt-5 flex flex-wrap gap-3" style={{ animationDelay: "2.85s" }}>
            <Link href="/demo" className="btn btn-coral h-12 px-5 text-[1.12rem]">
              Watch the live demo
            </Link>
            {twitchReady ? (
              <Link href="/studio" className="btn btn-ghost h-12 bg-[rgb(10_5_14/0.78)] px-5 text-[1.12rem]">
                Connect my Twitch
              </Link>
            ) : (
              <Link href="/setup" className="btn btn-ghost h-12 bg-[rgb(10_5_14/0.78)] px-5 text-[1.12rem]">
                How creators connect
              </Link>
            )}
          </div>
          <p className="gx-train gx-reveal mt-5" style={{ animationDelay: "2.95s" }}>
            Building the GTA AI, one stream at a time. Next stop: <span className="gx-vi">GTA VI</span>.{" "}
            <a href="#gta-ai" className="whitespace-nowrap underline decoration-line-strong underline-offset-4 hover:text-ivory">
              How it learns
            </a>
          </p>
          <div className="gx-reveal mt-4" style={{ animationDelay: "3.05s" }}>
            {mode === "empty" ? <EmptyStatus /> : <LiveStatus live={live} listed={listed.length} />}
          </div>
        </div>
        <IntroTips />
        <div className="gx-art">
          <SkylineArt animated intro evidence idPrefix="skh" className="h-full w-full" />
          <IntroHudCounter live={live.length} />
          <IntroRadar live={live.length} />
        </div>
        <ScenePlayback />
      </section>

      {mode === "empty" ? (
        <>
          <IntroSteps />
          <EmptyBand twitchReady={twitchReady} capabilities={capabilities} />
        </>
      ) : (
        <>
          {/* People are live: the channels come first, then how it works. */}
          <LiveDirectory directory={directory} fallbackArt={<SkylineArt idPrefix="skf" className="h-full w-full" />} />
          <IntroSteps />
        </>
      )}
    </>
  );
}

function EmptyStatus() {
  return (
    <p className="gx-sub">
      <span className="stale-dot shrink-0 self-center text-ivory-3" aria-hidden />
      <span>
        <span className="font-display text-[1.06rem] font-semibold text-ivory">Nothing on air yet.</span> Channels appear here the moment their creator goes live.
      </span>
    </p>
  );
}

function LiveStatus({ live, listed }: { live: ChannelCard[]; listed: number }) {
  const n = live.length;
  return (
    <div>
      <p className="gx-sub">
        {n > 0 ? (
          <span className="flex items-center gap-2 font-display text-[1.1rem] font-semibold text-coral">
            <span className="live-dot live-dot-pulse" aria-hidden />
            {n === 1 ? "1 channel live now" : `${n} channels live now`}
          </span>
        ) : (
          <span className="flex items-center gap-2 font-display text-[1.1rem] font-semibold text-ivory">
            <span className="stale-dot text-ivory-3" aria-hidden />
            No one is live right now
          </span>
        )}
        <a href="#on-air" className="underline decoration-line-strong underline-offset-4 hover:text-ivory">
          {listed === 1 ? "See the channel" : `See all ${listed} channels`}
        </a>
      </p>
      {n > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Live now">
          {live.slice(0, 3).map((c) => (
            <li key={c.broadcasterId}>
              <Link
                href={`/watch/${c.login}`}
                className="flex h-11 items-center gap-2.5 rounded-[2px] border border-line-strong bg-[rgb(10_5_14/0.8)] pl-1.5 pr-3.5 transition-colors hover:border-ivory-2"
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
          <p className="mt-1 max-w-[52ch] text-sm text-ivory-3">Upload a GTA recording and see what SLOT1 spots in it, with the frames to prove it.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/studio#sources" className="btn btn-ghost">
              Upload a replay
            </Link>
          </div>
          {capabilities && !twitchReady && (
            <p className="mt-6 max-w-[60ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2" data-testid="twitch-closed-note">
              Twitch sign-in isn’t open yet, so creators can’t connect their channels.{" "}
              <Link href="/setup#twitch" className="underline hover:text-ivory">
                How connecting works
              </Link>
              <SetupFix cap={capabilities.twitch} />
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
