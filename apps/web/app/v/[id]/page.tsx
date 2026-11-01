import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { jumpTarget, type LibraryItemView } from "@slot1/contracts";
import { clipEmbedUrl, parseTwitchUrl } from "@slot1/twitch/url";
import { MediaPlayer } from "@/components/clipper/PublicMedia";
import { ShareFilePanel, ShareLinkButton } from "@/components/clipper/ShareClip";
import { JsonLd } from "@/components/seo/JsonLd";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { editTime, itemKindLabel, VISIBILITY_TEXT } from "@/lib/clipper";
import { clipVideo } from "@/lib/jsonld";
import { publicOrigin } from "@/lib/origin";
import { readJumpParams } from "@/lib/moments";
import { canShareAsFile } from "@/lib/share";
import { embedParents, serverApi } from "@/lib/server";
import { pageMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";

type ItemResponse = { item: LibraryItemView; channel: { login: string; displayName: string } };

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return serverApi<ItemResponse>(`/api/library/${id}`);
}

function describe(item: LibraryItemView, channel: { displayName: string }): string {
  const kind = itemKindLabel(item).toLowerCase();
  return `A ${kind} by ${channel.displayName} on SLOT1${item.durationMs ? `, ${editTime(item.durationMs).replace(/\.\d$/, "")} long` : ""}.`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await load(id);
  if (!r?.ok) return { title: "Not found", robots: { index: false } };
  const { item, channel } = r.data;
  const origin = await publicOrigin();
  const hasPoster = Boolean(item.posterUrl) && item.visibility !== "private";
  const images = hasPoster ? [{ url: `${origin}/api/library/${item.id}/poster`, width: item.width ?? undefined, height: item.height ?? undefined, alt: item.title }] : [];
  const video = item.kind !== "screenshot" && item.kind !== "twitch_clip";
  return pageMetadata({
    title: `${item.title} by ${channel.displayName}`,
    description: describe(item, channel),
    path: `/v/${item.id}`,
    images,
    type: video ? "video.other" : "website",
    // Unlisted items open for anyone with the link but stay out of search results.
    noindex: item.visibility !== "public",
  });
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
  // Public videos get VideoObject structured data, pointing at stable addresses only.
  const ownVideo = item.kind === "recording" || item.kind === "render" || item.kind === "clip_export";
  const origin = await publicOrigin();
  const structured =
    item.visibility === "public" && item.status === "ready" && (ownVideo || twitchEmbed)
      ? {
          ...clipVideo({
            origin,
            id: item.id,
            title: item.title,
            description: describe(item, channel),
            createdAt: item.createdAt,
            durationMs: item.durationMs,
            posterUrl: item.posterUrl ? `${origin}/api/library/${item.id}/poster` : null,
            channel,
            contentPath: ownVideo ? `/api/seo/media/${item.id}` : null,
          }),
          ...(twitchEmbed ? { embedUrl: twitchEmbed } : {}),
        }
      : null;
  return (
    <div className="mx-auto max-w-[1280px] px-4 pb-24 pt-8 sm:px-6 lg:px-10">
      {structured && <JsonLd data={structured} />}
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
