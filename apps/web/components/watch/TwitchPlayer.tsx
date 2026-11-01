"use client";

import { useEffect, useRef, useState } from "react";
import { EMBED_MIN_HEIGHT, EMBED_MIN_WIDTH, liveEmbedUrl } from "@slot1/twitch/url";

/**
 * The official Twitch player, unmodified: nothing of ours covers its controls, branding, ads or
 * video. If the available width can't fit Twitch's minimum embed size (400×300 at 16:9), an
 * intentional "Watch on Twitch" alternative is shown instead of squeezing the iframe.
 */
export function TwitchPlayer({
  login,
  displayName,
  parents,
  thumbnailUrl,
  twitchUrl,
}: {
  login: string;
  displayName: string;
  parents: string[];
  thumbnailUrl: string | null;
  twitchUrl: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    // The page's own hostname decides whether Twitch will accept the embed; it only exists in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(window.location.hostname.toLowerCase());
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? null));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = width === null ? null : (width * 9) / 16;
  const fits = width !== null && height !== null && width >= EMBED_MIN_WIDTH && height >= EMBED_MIN_HEIGHT;
  const parentOk = host === null || parents.includes(host);

  return (
    <div ref={ref} className="w-full">
      {width === null ? (
        <div className="aspect-video w-full bg-graphite-800" />
      ) : !parentOk ? (
        <div className="flex aspect-video w-full flex-col items-start justify-end gap-3 border hairline bg-graphite-800 p-6">
          <p className="font-display text-2xl font-bold">The Twitch player can’t load on this address.</p>
          <p className="max-w-[60ch] text-sm text-ivory-2">
            Twitch only plays embeds on hostnames listed as <code className="text-ivory">parent</code>. Add “{host}” to TWITCH_EMBED_PARENTS.
          </p>
          <a href={twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-primary">
            Watch on Twitch
          </a>
        </div>
      ) : fits ? (
        <iframe
          title={`${displayName} live on Twitch`}
          src={liveEmbedUrl(login, parents, { autoplay: true, muted: true })}
          className="block aspect-video w-full bg-black"
          allowFullScreen
          allow="autoplay; fullscreen; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <a href={twitchUrl} target="_blank" rel="noreferrer noopener" className="group relative block aspect-video w-full overflow-hidden bg-graphite-800">
          {thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover opacity-70" />
          )}
          <span className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-graphite to-transparent p-4">
            <span className="font-display text-xl font-bold group-hover:text-apricot">Watch on Twitch</span>
            <span className="text-xs text-ivory-2">This screen is narrower than Twitch’s minimum player size.</span>
          </span>
        </a>
      )}
    </div>
  );
}
