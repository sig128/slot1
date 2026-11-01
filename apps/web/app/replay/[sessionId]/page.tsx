import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ClipView, ObservationPage, SessionSummary } from "@slot1/contracts";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { ReplayClient } from "@/components/watch/ReplayClient";
import { readJumpParams } from "@/lib/moments";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Replay" };

export default async function ReplayPage({ params, searchParams }: { params: Promise<{ sessionId: string }>; searchParams: Promise<{ t?: string; moment?: string }> }) {
  const { sessionId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) notFound();
  // `?t=83`, `?t=1m23s` or `?t=01:23` lands 3 s before that second; `?moment=` selects the entry.
  const jump = readJumpParams(await searchParams);
  const s = await serverApi<SessionSummary>(`/api/sessions/${sessionId}`);
  if (!s.ok) {
    if (s.status === 404 || s.status === 400) notFound();
    return <ServiceDown message={s.message} requirement={s.requirement} />;
  }
  const [p, c, v] = await Promise.all([
    serverApi<ObservationPage>(`/api/sessions/${sessionId}/observations`),
    serverApi<{ clips: ClipView[] }>(`/api/sessions/${sessionId}/clips`),
    serverApi<{ isCreator: boolean; canAsk: boolean; askPolicy: "off" | "signed_in" | "anyone" }>(`/api/sessions/${sessionId}/viewer`),
  ]);
  const viewer = v.ok ? v.data : { isCreator: false, canAsk: false, askPolicy: "off" as const };
  return <ReplayClient session={s.data} page={p.ok ? p.data : null} clips={c.ok ? c.data.clips : []} viewer={viewer} jump={jump} />;
}
