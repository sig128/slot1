import type { Metadata } from "next";
import type { ClipView, DemoInfo, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { DemoBroadcast } from "@/components/demo/DemoBroadcast";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { embedParents, serverApi } from "@/lib/server";
import { pageMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Live demo",
    description: "How a broadcast flows through SLOT1, and what its AI reads on screen, shown live on a synthetic test video.",
    path: "/demo",
    // A temporary page: kept out of search results.
    noindex: true,
  });
}

export default async function DemoPage() {
  const info = await serverApi<DemoInfo>("/api/demo");
  if (!info.ok) return <ServiceDown message={info.message} requirement={info.requirement} />;
  let watch: WatchChannelResponse | null = null;
  let page: ObservationPage | null = null;
  let clips: ClipView[] = [];
  if (info.data.enabled && info.data.login) {
    const w = await serverApi<WatchChannelResponse>(`/api/channels/${encodeURIComponent(info.data.login)}/watch`);
    if (w.ok) {
      watch = w.data;
      if (watch.session) {
        const id = watch.session.id;
        const [p, c] = await Promise.all([serverApi<ObservationPage>(`/api/sessions/${id}/observations`), serverApi<{ clips: ClipView[] }>(`/api/sessions/${id}/clips`)]);
        if (p.ok) page = p.data;
        if (c.ok) clips = c.data.clips;
      }
    }
  }
  return <DemoBroadcast info={info.data} watch={watch} page={page} clips={clips} embedParents={embedParents()} />;
}
