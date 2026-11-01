import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ClipView, MomentLinkTarget, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { JsonLd } from "@/components/seo/JsonLd";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { WatchClient } from "@/components/watch/WatchClient";
import { liveBroadcast } from "@/lib/jsonld";
import { watchMetadata } from "@/lib/meta";
import { readJumpParams, replayHref } from "@/lib/moments";
import { publicOrigin } from "@/lib/origin";
import { embedParents, serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  const watch = /^[a-zA-Z0-9_-]{2,40}$/.test(channel) ? await serverApi<WatchChannelResponse>(`/api/channels/${encodeURIComponent(channel)}/watch`) : null;
  if (!watch?.ok) return { title: `Watch ${channel}`, robots: { index: false, follow: false } };
  return watchMetadata(watch.data);
}

export default async function WatchPage({ params, searchParams }: { params: Promise<{ channel: string }>; searchParams: Promise<{ clip?: string; moment?: string }> }) {
  const { channel } = await params;
  const sp = await searchParams;
  const { clip } = sp;
  // "-" only occurs in SLOT1's own demo login (Twitch logins never contain it).
  if (!/^[a-zA-Z0-9_-]{2,25}$/.test(channel)) notFound();
  const watch = await serverApi<WatchChannelResponse>(`/api/channels/${encodeURIComponent(channel)}/watch`);
  if (!watch.ok) {
    if (watch.status === 400 || watch.status === 404) notFound();
    return <ServiceDown message={watch.message} requirement={watch.requirement} />;
  }
  // `?moment=`: an instant replay while this session is live; once it has finished, the recording.
  const { momentId } = readJumpParams(sp);
  let liveMoment: string | null = null;
  if (momentId) {
    const target = await serverApi<MomentLinkTarget>(`/api/moment-links/${momentId}`);
    if (target.ok) {
      const t = target.data;
      if (t.kind === "live" && t.sessionId === watch.data.session?.id) liveMoment = t.observationId;
      else redirect(replayHref(t.sessionId, t.kind === "replay" ? t.tMs : null, t.observationId));
    }
  }
  let page: ObservationPage | null = null;
  let clips: ClipView[] = [];
  if (watch.data.session) {
    const id = watch.data.session.id;
    const [p, c] = await Promise.all([serverApi<ObservationPage>(`/api/sessions/${id}/observations`), serverApi<{ clips: ClipView[] }>(`/api/sessions/${id}/clips`)]);
    if (p.ok) page = p.data;
    if (c.ok) clips = c.data.clips;
  }
  const slug = clip && /^[A-Za-z0-9_-]{3,100}$/.test(clip) ? clip : null;
  // Live on a SLOT1-connected public channel: tell search engines it's a live broadcast.
  const c = watch.data.channel;
  const parents = embedParents();
  const live = watch.data.authorized && /^[a-z0-9_]+$/i.test(c.login) && c.broadcast.state === "live" && c.broadcast.startedAt && parents[0];
  const structured = live
    ? liveBroadcast({
        origin: await publicOrigin(),
        login: c.login,
        displayName: c.displayName,
        title: c.broadcast.title,
        category: c.broadcast.category,
        startedAt: c.broadcast.startedAt!,
        thumbnailUrl: c.broadcast.thumbnailUrl,
        embedParent: parents[0]!,
      })
    : null;
  return (
    <>
      <WatchClient watch={watch.data} page={page} clips={clips} embedParents={parents} clipSlug={slug} momentId={liveMoment} />
      {structured && <JsonLd data={structured} />}
    </>
  );
}
