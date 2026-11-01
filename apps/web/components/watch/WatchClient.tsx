"use client";

import Link from "next/link";
import type { ClipView, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { clipEmbedUrl, EMBED_MIN_WIDTH } from "@slot1/twitch/url";
import { AiFramePlayer } from "./AiView";
import { LivePlayerSwitch } from "./LivePlayerSwitch";
import { SessionWorkspace } from "./SessionWorkspace";
import { TwitchPlayer } from "./TwitchPlayer";

export function WatchClient({
  watch,
  page,
  clips,
  embedParents,
  clipSlug,
  momentId = null,
  aiViewOpen = false,
}: {
  watch: WatchChannelResponse;
  page: ObservationPage | null;
  clips: ClipView[];
  embedParents: string[];
  clipSlug: string | null;
  /** `?moment=`: a moment of this live session to select and replay. */
  momentId?: string | null;
  /** Open "What the AI sees" on load (the demo page). */
  aiViewOpen?: boolean;
}) {
  const c = watch.channel;
  const session = watch.session;
  // SLOT1-only channels (the demo) have no Twitch channel, player or chat.
  const onTwitch = Boolean(c.twitchUrl);
  const player = clipSlug ? (
    <div className="w-full" style={{ minWidth: 0 }}>
      <iframe
        title={`Twitch clip from ${c.displayName}`}
        src={clipEmbedUrl(clipSlug, embedParents)}
        className="block aspect-video w-full bg-black"
        style={{ minWidth: Math.min(EMBED_MIN_WIDTH, 400) }}
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  ) : watch.authorized && session && session.kind !== "replay" && !onTwitch ? (
    // No Twitch behind this channel: SLOT1's own video, or else the frames the AI analyzed.
    <LivePlayerSwitch
      sessionId={session.id}
      title={`Live video from ${c.displayName}`}
      twitch={<AiFramePlayer sessionId={session.id} />}
      fallback={{ name: "Analyzed frames", note: "The frames the AI analyzed, refreshed as they arrive." }}
    />
  ) : watch.authorized && session && session.kind !== "replay" ? (
    // SLOT1's own sub-second video when the creator sends it; otherwise Twitch's player.
    <LivePlayerSwitch
      sessionId={session.id}
      title={`Live video from ${c.displayName}`}
      twitch={<TwitchPlayer login={c.login} displayName={c.displayName} parents={embedParents} thumbnailUrl={c.broadcast.thumbnailUrl} twitchUrl={c.twitchUrl} />}
    />
  ) : !onTwitch ? (
    <div className="grid aspect-video w-full place-items-center bg-graphite-800 p-6 text-center text-sm text-ivory-2">
      {c.displayName} isn’t sending video to SLOT1 right now.
    </div>
  ) : (
    <TwitchPlayer login={c.login} displayName={c.displayName} parents={embedParents} thumbnailUrl={c.broadcast.thumbnailUrl} twitchUrl={c.twitchUrl} />
  );

  const empty = !watch.authorized ? (
    <div className="space-y-3 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">Watch-only</p>
      <p>{c.displayName} hasn’t connected SLOT1, so nothing on this page is analyzed or recorded. You’re watching Twitch’s own player.</p>
      <Link href="/setup#modes" className="underline hover:text-ivory">
        What SLOT1 needs to analyze a channel
      </Link>
    </div>
  ) : !session ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">No session yet</p>
      <p>
        {c.broadcast.state === "live"
          ? "The broadcast is live, but this channel's analysis isn't public or hasn't started."
          : "When this channel goes live, its session log will appear here."}
      </p>
    </div>
  ) : session.analysis.state === "no_source" ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">SLOT1 can’t see this broadcast</p>
      <p>
        The Twitch player and chat are platform data, not gameplay video. Nothing is analyzed until the creator connects an authorized video source or
        analyzes a clip. Chat commands and clips still work.
      </p>
    </div>
  ) : session.analysis.state === "stale" ? (
    <p className="text-sm text-ivory-2">The video source went quiet before anything notable was observed.</p>
  ) : (
    <p className="text-sm text-ivory-2">Watching. Observations appear here as soon as there’s evidence for them.</p>
  );

  return (
    <SessionWorkspace
      mode="live"
      session={session}
      initialPage={page}
      initialClips={clips}
      identity={{
        displayName: c.displayName,
        avatarUrl: c.avatarUrl,
        title: c.broadcast.title,
        category: c.broadcast.category,
        twitchUrl: onTwitch ? c.twitchUrl : null,
      }}
      broadcast={c.broadcast.state}
      fallbackStatus={c.analysis}
      livePlayer={player}
      isCreator={watch.viewer.isCreator}
      canAsk={watch.viewer.canAsk}
      askPolicy={watch.viewer.askPolicy}
      chatLogin={onTwitch ? c.login : null}
      embedParents={embedParents}
      emptyState={empty}
      watchOnly={!watch.authorized}
      initialMomentId={momentId}
      aiViewOpen={aiViewOpen}
      notice={
        !watch.authorized ? (
          <p className="mt-5 border-l-2 border-apricot pl-3 text-sm text-ivory-2">
            Watch-only. Pasting a link doesn’t connect a channel or allow recording. Only the creator can do that from their own Twitch account.
          </p>
        ) : watch.recentReplays.length > 0 ? (
          <nav aria-label="Replays" className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="text-ivory-3">Replays</span>
            {watch.recentReplays.map((r) => (
              <Link key={r.id} href={`/replay/${r.id}`} className="text-ivory-2 underline-offset-4 hover:text-ivory hover:underline">
                {r.title ?? "Untitled replay"}
              </Link>
            ))}
          </nav>
        ) : null
      }
    />
  );
}
