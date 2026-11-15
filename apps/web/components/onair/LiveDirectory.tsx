"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ChannelCard, DirectoryResponse } from "@slot1/contracts";
import { AnalysisChip, BroadcastChip } from "@/components/ui/StatusChips";
import { compactNumber, relativeAge } from "@/lib/format";
import { LinkOpener } from "./LinkOpener";

export function ChannelAvatar({ c, size = 40 }: { c: ChannelCard; size?: number }) {
  if (c.avatarUrl)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={c.avatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
  return (
    <span className="grid shrink-0 place-items-center rounded-full bg-graphite-600 font-display font-bold" style={{ width: size, height: size }}>
      {c.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

const count = (n: number, one: string, many: string) => `${compactNumber(n)} ${n === 1 ? one : many}`;

/** One channel as a small card: Twitch's thumbnail, live state, name, title, viewers and followers. */
function Tile({ c }: { c: ChannelCard }) {
  const live = c.broadcast.state === "live";
  return (
    <li className="min-w-0" data-testid="channel-tile">
      <Link href={`/watch/${c.login}`} className="group block">
        <div className="relative aspect-video overflow-hidden border hairline bg-graphite-800 transition-colors group-hover:border-ivory-2">
          {c.broadcast.thumbnailUrl ? (
            // The platform's own thumbnail: the list never autoplays embeds when there is one.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.broadcast.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : c.platform === "kick" && c.broadcast.state === "unknown" ? (
            // No data from Kick (no Kick app saved yet): Kick's own player, muted, as the preview.
            // The card stays one link: the player takes no clicks.
            <iframe
              title={`${c.displayName} on Kick`}
              src={`https://player.kick.com/${encodeURIComponent(c.login.replace(/^kick-/, ""))}?autoplay=true&muted=true`}
              loading="lazy"
              tabIndex={-1}
              aria-hidden
              allow="autoplay"
              className="pointer-events-none h-full w-full border-0 bg-black"
            />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <ChannelAvatar c={c} size={64} />
            </span>
          )}
          <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
            <BroadcastChip state={c.broadcast.state} platform={c.platform === "kick" ? "kick" : "twitch"} />
            {c.publicAnalysis && <AnalysisChip status={c.analysis} />}
          </div>
          {live && c.broadcast.viewerCount !== null && (
            <span className="tnum absolute bottom-2.5 left-2.5 bg-[rgb(10_5_14/0.85)] px-2 py-0.5 text-[0.8rem] text-ivory">
              {count(c.broadcast.viewerCount, "viewer", "viewers")}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-start gap-3">
          <ChannelAvatar c={c} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-[1.2rem] font-bold leading-tight group-hover:text-apricot">{c.displayName}</p>
            {c.broadcast.title && <p className="truncate text-sm text-ivory-2">{c.broadcast.title}</p>}
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-[0.8rem] text-ivory-3">
              {c.broadcast.category && <span className="max-w-full truncate">{c.broadcast.category}</span>}
              {typeof c.followers === "number" ? (
                <span className="tnum">{count(c.followers, "follower", "followers")}</span>
              ) : typeof c.subscribers === "number" ? (
                <span className="tnum">{count(c.subscribers, "subscriber", "subscribers")}</span>
              ) : null}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

/**
 * Every channel under Live now, as small cards with Twitch's thumbnails (no autoplaying embeds),
 * searchable by name, title or game.
 */
export function LiveDirectory({ directory }: { directory: DirectoryResponse }) {
  const [query, setQuery] = useState("");
  const channels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return directory.channels;
    return directory.channels.filter((c) => [c.login, c.displayName, c.broadcast.title ?? "", c.broadcast.category ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [query, directory.channels]);

  return (
    <section id="on-air" aria-labelledby="on-air-title" className="mx-auto max-w-[1600px] scroll-mt-20 px-4 pb-20 pt-12 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h2 id="on-air-title" className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">
          On air
        </h2>
        <div className="w-full max-w-md">
          <label htmlFor="dir-search" className="sr-only">
            Search channels
          </label>
          <input
            id="dir-search"
            className="field"
            type="search"
            placeholder="Search channel, title or game"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {channels.length === 0 ? (
        <p className="mt-16 text-lg text-ivory-2">No channel matches “{query}”.</p>
      ) : (
        <ul className="mt-8 grid gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-label="Channels">
          {channels.map((c) => (
            <Tile key={c.broadcasterId} c={c} />
          ))}
        </ul>
      )}
      <div className="mt-14 max-w-xl">
        <h3 className="font-display text-xl font-bold">Open a Twitch link</h3>
        <p className="mb-3 mt-1 text-sm text-ivory-3">Watch-only unless the creator uses SLOT1.</p>
        <LinkOpener />
      </div>
      {directory.refreshedAt && (
        <p className="mt-12 text-[0.8rem] text-ivory-3">Live status, viewers, followers and Kick subscribers come from Twitch and Kick, refreshed {relativeAge(directory.refreshedAt)}.</p>
      )}
    </section>
  );
}
