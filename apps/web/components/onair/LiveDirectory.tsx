"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ChannelCard, DirectoryResponse } from "@slot1/contracts";
import { SkylineArt } from "@/components/brand/SkylineArt";
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

function Viewers({ c }: { c: ChannelCard }) {
  if (c.broadcast.viewerCount === null) return null;
  return <span className="tnum">{compactNumber(c.broadcast.viewerCount)} watching</span>;
}

function Featured({ c }: { c: ChannelCard }) {
  return (
    <article className="min-w-0">
      <Link href={`/watch/${c.login}`} className="group block" aria-label={`Watch ${c.displayName}`}>
        <div className="relative aspect-video overflow-hidden bg-graphite-800">
          {c.broadcast.thumbnailUrl ? (
            // Twitch's own thumbnail — listing never autoplays embeds.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.broadcast.thumbnailUrl} alt={`${c.displayName} stream thumbnail`} className="h-full w-full object-cover" />
          ) : (
            <SkylineArt className="h-full w-full" idPrefix={`skf-${c.broadcasterId}`} />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-graphite/85 to-transparent" />
          <div className="absolute bottom-4 left-4 flex flex-wrap gap-2">
            <BroadcastChip state={c.broadcast.state} />
            {c.publicAnalysis && <AnalysisChip status={c.analysis} />}
          </div>
        </div>
      </Link>
      <div className="mt-5 flex items-start gap-4">
        <ChannelAvatar c={c} size={52} />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[length:var(--text-display-md)] font-extrabold leading-[0.95]">
            <Link href={`/watch/${c.login}`} className="hover:text-apricot">
              {c.displayName}
            </Link>
          </h3>
          {c.broadcast.title && <p className="mt-2 max-w-[62ch] text-[1.05rem] text-ivory-2">{c.broadcast.title}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ivory-3">
            {c.broadcast.category && <span>{c.broadcast.category}</span>}
            <Viewers c={c} />
            {c.broadcast.lastRefreshedAt && <span>Twitch data {relativeAge(c.broadcast.lastRefreshedAt)}</span>}
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={`/watch/${c.login}`} className="btn btn-primary">
              Watch
            </Link>
            <a href={c.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost">
              Open on Twitch
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

function Row({ c }: { c: ChannelCard }) {
  return (
    <li className="border-b hairline">
      <div className="flex items-center gap-4 py-4">
        <Link href={`/watch/${c.login}`} className="relative hidden aspect-video w-32 shrink-0 overflow-hidden bg-graphite-800 sm:block" tabIndex={-1} aria-hidden>
          {c.broadcast.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.broadcast.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <ChannelAvatar c={c} size={34} />
            </span>
          )}
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Link href={`/watch/${c.login}`} className="truncate font-display text-[1.35rem] font-bold leading-tight hover:text-apricot">
              {c.displayName}
            </Link>
            {c.broadcast.state === "live" ? (
              <span className="flex items-center gap-1.5 text-[0.8rem] text-coral">
                <span className="live-dot" aria-hidden />
                Live
              </span>
            ) : (
              <span className="text-[0.8rem] text-ivory-3">{c.broadcast.state === "offline" ? "Offline" : "Status unknown"}</span>
            )}
          </div>
          {c.broadcast.title && <p className="truncate text-sm text-ivory-2">{c.broadcast.title}</p>}
          <div className="mt-0.5 flex gap-4 text-[0.8rem] text-ivory-3">
            {c.broadcast.category && <span className="truncate">{c.broadcast.category}</span>}
            <Viewers c={c} />
          </div>
        </div>
        <a href={c.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-quiet btn-sm shrink-0" aria-label={`Open ${c.displayName} on Twitch`}>
          Twitch
        </a>
      </div>
    </li>
  );
}

/** The channel directory under the intro: searchable, the first channel featured. */
export function LiveDirectory({ directory }: { directory: DirectoryResponse }) {
  const [query, setQuery] = useState("");
  const channels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return directory.channels;
    return directory.channels.filter((c) => [c.login, c.displayName, c.broadcast.title ?? "", c.broadcast.category ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [query, directory.channels]);
  const featured = channels[0];
  const rest = channels.slice(1);

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
        <div className="mt-10 grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-8">{featured && <Featured c={featured} />}</div>
          <aside className="lg:col-span-4" aria-label="More channels">
            {rest.length > 0 && (
              <>
                <h3 className="border-b hairline pb-3 font-display text-xl font-bold text-ivory-2">Also connected</h3>
                <ul>
                  {rest.map((c) => (
                    <Row key={c.broadcasterId} c={c} />
                  ))}
                </ul>
              </>
            )}
            <div className="mt-10">
              <h3 className="font-display text-xl font-bold">Open a Twitch link</h3>
              <p className="mb-3 mt-1 text-sm text-ivory-3">Watch-only unless the creator uses SLOT1.</p>
              <LinkOpener />
            </div>
          </aside>
        </div>
      )}
      {directory.refreshedAt && (
        <p className="mt-12 text-[0.8rem] text-ivory-3">Live status and viewer counts come from Twitch, refreshed {relativeAge(directory.refreshedAt)}.</p>
      )}
    </section>
  );
}
