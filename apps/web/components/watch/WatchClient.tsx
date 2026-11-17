"use client";

import Link from "next/link";
import type { ClipView, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { clipEmbedUrl, EMBED_MIN_WIDTH } from "@slot1/twitch/url";
import { compactNumber } from "@/lib/format";
import { AiFramePlayer } from "./AiView";
import { LivePlayerSwitch } from "./LivePlayerSwitch";
import { SessionWorkspace } from "./SessionWorkspace";
import { KickPlayer } from "./KickPlayer";
import { TwitchPlayer } from "./TwitchPlayer";

/**
 * The channel's audience, from its platform: followers (Twitch), or subscribers where the platform
 * gives no follower total (Kick's API doesn't), and how many are watching while it's live.
 */
function audience(c: WatchChannelResponse["channel"]): string[] {
  const out: string[] = [];
  const plural = (n: number, one: string) => `${compactNumber(n)} ${n === 1 ? one : `${one}s`}`;
  if (typeof c.followers === "number") out.push(plural(c.followers, "follower"));
  else if (typeof c.subscribers === "number") out.push(plural(c.subscribers, "subscriber"));
  if (c.broadcast.state === "live" && typeof c.broadcast.viewerCount === "number") out.push(`${compactNumber(c.broadcast.viewerCount)} watching`);
  return out;
}

export function WatchClient({
  watch,
  page,
  clips,
  embedParents,
  clipSlug,
  momentId = null,
  aiViewOpen = false,
  nameAs = "h1",
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
  /** The channel name's heading level (h2 on the home page). */
  nameAs?: "h1" | "h2";
}) {
  const c = watch.channel;
  const session = watch.session;
  // SLOT1-only channels (the demo) have no Twitch channel, player or chat.
  const onTwitch = Boolean(c.twitchUrl);
  // Kick channels ("kick-<slug>"), featured or signed in with Kick: Kick's player and Kick chat.
  const onKick = c.platform === "kick";
  const platformName = onKick ? "Kick" : "Twitch";
  const kickSlug = c.login.replace(/^kick-/, "");
  // Admin → Featured channels: shown like any channel, without the watch-only notes.
  const featured = !watch.authorized && Boolean(c.preview);
  // SLOT1 chat: on SLOT1 channels this visitor can watch, and on featured channels.
  const chatRoom = (watch.authorized || featured) && /^[a-z0-9_-]{2,32}$/i.test(c.login) ? c.login.toLowerCase() : null;
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
  ) : watch.authorized && session && session.kind !== "replay" && onKick ? (
    // A Kick creator sending to SLOT1: SLOT1's own video (full quality), or Kick's player.
    <LivePlayerSwitch sessionId={session.id} title={`Live video from ${c.displayName}`} platform="kick" twitch={<KickPlayer slug={kickSlug} displayName={c.displayName} />} />
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
  ) : onKick ? (
    <KickPlayer slug={kickSlug} displayName={c.displayName} />
  ) : !onTwitch ? (
    <div className="grid aspect-video w-full place-items-center bg-graphite-800 p-6 text-center text-sm text-ivory-2">
      {c.displayName} isn’t sending video to SLOT1 right now.
    </div>
  ) : (
    <TwitchPlayer login={c.login} displayName={c.displayName} parents={embedParents} thumbnailUrl={c.broadcast.thumbnailUrl} twitchUrl={c.twitchUrl} />
  );

  const streamOffline = c.broadcast.state === "offline";
  // Admin → Learning is off: a featured channel is shown, but SLOT1 isn't watching it.
  const learningPaused = c.analysis.state === "stopped" && Boolean(c.analysis.reason?.includes("Learning is paused"));
  const empty = featured || !watch.authorized ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">{learningPaused ? "Learning paused" : streamOffline ? "Offline" : "Learning on"}</p>
      <p>
        {learningPaused
          ? c.analysis.reason
          : streamOffline
            ? "This stream is offline. Learning stays on for when it goes live."
            : c.analysis.lastReceivedFrameAt
              ? (c.analysis.reason ?? "Watching this stream and learning from it.")
              : "Learning is on for this stream. Nothing has been logged yet."}
      </p>
    </div>
  ) : !session ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">No session yet</p>
      <p>
        {streamOffline
          ? "This stream is offline. Learning stays on for when it goes live."
          : "Learning is on for this stream. The log fills when there is something to cite."}
      </p>
    </div>
  ) : session.analysis.state === "no_source" ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">{streamOffline ? "Offline" : "Learning on"}</p>
      <p>
        {streamOffline
          ? "This stream is offline. Learning stays on for when it goes live."
          : `Learning is on for this stream. The ${platformName} player is up${onKick ? "" : ", and chat commands and clips still work"}. The log fills when there is something to cite.`}
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
        stats: audience(c),
        twitchUrl: onTwitch ? c.twitchUrl : null,
        kickUrl: onKick ? `https://kick.com/${kickSlug}` : null,
      }}
      nameAs={nameAs}
      broadcast={c.broadcast.state}
      fallbackStatus={c.analysis}
      livePlayer={player}
      isCreator={watch.viewer.isCreator}
      canAsk={watch.viewer.canAsk}
      askPolicy={watch.viewer.askPolicy}
      chatLogin={onTwitch ? c.login : null}
      kickChat={onKick ? kickSlug : null}
      chatRoom={chatRoom}
      embedParents={embedParents}
      emptyState={empty}
      watchOnly={!watch.authorized}
      featured={featured}
      initialMomentId={momentId}
      aiViewOpen={aiViewOpen}
      notice={
        featured ? null : !watch.authorized ? (
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
