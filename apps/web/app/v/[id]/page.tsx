import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { jumpTarget, type LibraryItemView } from "@slot1/contracts";
import { clipEmbedUrl, parseTwitchUrl } from "@slot1/twitch/url";
import { MediaPlayer } from "@/components/clipper/PublicMedia";
import { ShareFilePanel, ShareLinkButton } from "@/components/clipper/ShareClip";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { editTime, itemKindLabel, VISIBILITY_TEXT } from "@/lib/clipper";
import { publicOrigin } from "@/lib/origin";
import { readJumpParams } from "@/lib/moments";
import { canShareAsFile } from "@/lib/share";
import { embedParents, serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";

type ItemResponse = { item: LibraryItemView; channel: { login: string; displayName: string } };

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return serverApi<ItemResponse>(`/api/library/${id}`);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await load(id);
  if (!r?.ok) return { title: "Not found", robots: { index: false } };
  const { item, channel } = r.data;
  const origin = await publicOrigin();
  const url = `${origin}/v/${item.id}`;
  const kind = itemKindLabel(item).toLowerCase();
  const description = `A ${kind} by ${channel.displayName} on SLOT1${item.durationMs ? `, ${editTime(item.durationMs).replace(/\.\d$/, "")} long` : ""}.`;
  const hasPoster = Boolean(item.posterUrl) && item.visibility !== "private";
  const images = hasPoster ? [{ url: `${origin}/api/library/${item.id}/poster`, width: item.width ?? undefined, height: item.height ?? undefined, alt: item.title }] : [];
  const video = item.kind !== "screenshot" && item.kind !== "twitch_clip";
  return {
    title: `${item.title} by ${channel.displayName}`,
    description,
    // Unlisted items open for anyone with the link but stay out of search results.
    robots: item.visibility === "public" ? { index: true, follow: true } : { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: { type: video ? "video.other" : "website", title: item.title, description, url, siteName: "SLOT1", images },
    twitter: { card: images.length ? "summary_large_image" : "summary", title: item.title, description, images: images.map((i) => i.url) },
  };
}

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  // `?t=` (83, 1m23s or 01:23) starts the video 3 s before that second.
  const { tMs } = readJumpParams(await searchParams);
  const r = await load(id);
  if (!r) notFound();
  if (!r.ok) {
    if (r.status === 404 || r.status === 400) notFound();
    return <ServiceDown message={r.message} requirement={r.requirement} />;
  }
  const { item, channel } = r.data;
  // The AI log is linked only when this viewer may already open the session.
  const session = item.sessionId ? await serverApi<{ id: string }>(`/api/sessions/${item.sessionId}`) : null;
  const canOpenSession = Boolean(session?.ok);
  const clip = item.kind === "twitch_clip" && item.externalUrl ? parseTwitchUrl(item.externalUrl) : null;
  const twitchEmbed = clip?.kind === "clip" ? clipEmbedUrl(clip.slug, embedParents()) : null;
  return (
    <div className="mx-auto max-w-[1280px] px-4 pb-24 pt-8 sm:px-6 lg:px-10">
      <Link href={`/c/${channel.login}`} className="text-sm text-ivory-2 hover:text-ivory">
        ← {channel.displayName}
      </Link>
      <h1 className="poster-title mt-2 break-words text-[length:var(--text-display-md)] font-black leading-[0.92]">{item.title}</h1>
      <p className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ivory-2">
        <span className="chip chip-replay">{itemKindLabel(item)}</span>
        {item.durationMs ? <span>{editTime(item.durationMs)}</span> : null}
        {item.width && item.height ? <span>{`${item.width}×${item.height}`}</span> : null}
        <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</time>
        {item.canEdit && <span className="text-ivory-3">{VISIBILITY_TEXT[item.visibility].label}: {VISIBILITY_TEXT[item.visibility].detail.toLowerCase()}</span>}
      </p>

      <div className="mt-6">
        {item.status === "ready" ? (
          <MediaPlayer item={item} twitchEmbed={twitchEmbed} startAtMs={tMs === null ? null : jumpTarget(tMs)} />
        ) : (
          <p className="bg-graphite-800 p-6 text-sm text-ivory-2">{item.status === "failed" ? (item.error ?? "This item failed to process.") : "Still processing. Reload in a moment."}</p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {canOpenSession && item.sessionId && (
          <Link href={`/replay/${item.sessionId}`} className="btn btn-primary btn-sm">
            Open with the AI log
          </Link>
        )}
        {item.canEdit && item.projectId && (
          <Link href={`/studio/edit/${item.projectId}`} className="btn btn-ghost btn-sm">
            Edit
          </Link>
        )}
        {item.canEdit && (
          <Link href="/studio#library" className="btn btn-ghost btn-sm">
            Manage in Studio
          </Link>
        )}
        {item.canEdit && item.url && item.kind !== "twitch_clip" && (
          <a href={item.url} download className="btn btn-quiet btn-sm">
            Download
          </a>
        )}
        {item.visibility !== "private" && item.status === "ready" && <ShareLinkButton path={`/v/${item.id}`} title={item.title} />}
        <Link href={`/c/${channel.login}`} className="btn btn-quiet btn-sm">
          More from {channel.displayName}
        </Link>
      </div>
      {/* Owner only: the video file itself goes to the share sheet. */}
      {canShareAsFile(item) && <ShareFilePanel item={item} />}
    </div>
  );
}
