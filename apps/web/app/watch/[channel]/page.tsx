import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ClipView, MomentLinkTarget, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { WatchClient } from "@/components/watch/WatchClient";
import { readJumpParams, replayHref } from "@/lib/moments";
import { embedParents, serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  return { title: `Watch ${channel}` };
}

export default async function WatchPage({ params, searchParams }: { params: Promise<{ channel: string }>; searchParams: Promise<{ clip?: string; moment?: string }> }) {
  const { channel } = await params;
  const sp = await searchParams;
  const { clip } = sp;
  if (!/^[a-zA-Z0-9_]{2,25}$/.test(channel)) notFound();
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
  return <WatchClient watch={watch.data} page={page} clips={clips} embedParents={embedParents()} clipSlug={slug} momentId={liveMoment} />;
}
