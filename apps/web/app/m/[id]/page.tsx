import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { MomentLinkTarget } from "@slot1/contracts";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { isUuid, replayHref } from "@/lib/moments";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Moment", robots: { index: false, follow: false } };

/**
 * Short link to one moment (what chat replies carry). It resolves when it's opened: an instant
 * replay on the watch page while the stream is live, the recording at that second once it has
 * finished. Moments the viewer may not see are "not found", exactly like missing ones.
 */
export default async function MomentLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const r = await serverApi<MomentLinkTarget>(`/api/moment-links/${id.toLowerCase()}`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 400) notFound();
    return <ServiceDown message={r.message} requirement={r.requirement} />;
  }
  const t = r.data;
  redirect(t.kind === "live" ? `/watch/${encodeURIComponent(t.login)}?moment=${t.observationId}` : replayHref(t.sessionId, t.tMs, t.observationId));
}
