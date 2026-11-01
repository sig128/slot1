import Link from "next/link";
import { formatMediaTime, type LibraryItemView } from "@slot1/contracts";
import { itemKindLabel } from "@/lib/clipper";

/** A shared item on a public page: poster, kind, duration and title, linking to its own page. */
export function MediaTile({ item, size = "md" }: { item: LibraryItemView; size?: "md" | "lg" }) {
  const portrait = Boolean(item.width && item.height && item.height > item.width);
  const href = item.viewPath;
  return (
    <Link href={href} className="group block min-w-0 focus-visible:outline-offset-4">
      <div className={`relative overflow-hidden bg-graphite-900 ${portrait ? "aspect-[9/16]" : "aspect-video"}`}>
        {item.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.posterUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
          />
        ) : (
          <div className="grid h-full place-items-center px-3 text-center text-sm text-ivory-3">{item.kind === "twitch_clip" ? "Twitch clip" : "No preview"}</div>
        )}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-graphite-900/90 to-transparent" />
        <span className="chip absolute left-2 top-2 bg-graphite-900/80">{itemKindLabel(item)}</span>
        {item.durationMs ? <span className="tnum absolute bottom-2 right-2 text-[0.8rem] text-ivory">{formatMediaTime(item.durationMs)}</span> : null}
      </div>
      <p className={`mt-2 font-display font-bold leading-tight group-hover:text-apricot ${size === "lg" ? "text-[1.6rem]" : "text-[1.15rem]"}`}>{item.title}</p>
      <p className="text-[0.8rem] text-ivory-3">
        <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</time>
      </p>
    </Link>
  );
}

/** The item itself: a player for video, the full image for screenshots, Twitch's player for clips. */
export function MediaPlayer({ item, twitchEmbed, startAtMs = null }: { item: LibraryItemView; twitchEmbed: string | null; startAtMs?: number | null }) {
  const portrait = Boolean(item.width && item.height && item.height > item.width);
  if (item.format === "audio" && item.url) {
    return (
      <div className="bg-graphite-800 p-6">
        <audio controls preload="metadata" src={item.url} aria-label={item.title} className="w-full" />
      </div>
    );
  }
  if ((item.kind === "screenshot" || item.kind === "thumbnail" || item.format === "gif") && item.url) {
    return (
      <a href={item.url} className="block bg-black" aria-label={`Open ${item.title} at full size`}>
        {/* The screenshot at full resolution, unfiltered. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt={item.title} width={item.width ?? undefined} height={item.height ?? undefined} className="mx-auto block h-auto max-h-[80vh] w-auto max-w-full" />
      </a>
    );
  }
  if (item.kind === "twitch_clip") {
    return twitchEmbed ? (
      <iframe title={item.title} src={twitchEmbed} allowFullScreen className="block aspect-video w-full bg-black" />
    ) : (
      <p className="bg-graphite-800 p-6 text-sm text-ivory-2">This clip lives on Twitch.</p>
    );
  }
  if (!item.url) return <p className="bg-graphite-800 p-6 text-sm text-ivory-2">This video is no longer stored.</p>;
  return (
    <div className="flex justify-center bg-black">
      <video
        controls
        playsInline
        preload="metadata"
        poster={item.posterUrl ?? undefined}
        // `?t=` on the page: a media fragment starts playback there, with no script needed.
        src={startAtMs !== null && startAtMs > 0 ? `${item.url}#t=${(startAtMs / 1000).toFixed(1)}` : item.url}
        aria-label={item.title}
        className={portrait ? "block h-[min(80vh,860px)] max-w-full" : "block aspect-video w-full"}
      />
    </div>
  );
}
