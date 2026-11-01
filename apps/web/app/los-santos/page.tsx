import type { Metadata } from "next";
import type { NowResponse } from "@slot1/contracts";
import { LosSantosNow } from "@/components/now/LosSantosNow";
import { embedParents, serverApi } from "@/lib/server";
import { pageMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";
export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Los Santos right now",
    description: "Every public GTA stream SLOT1 is watching, and what it saw happen on each one in the last minute. Flip between them with the radio wheel.",
    path: "/los-santos",
  });
}

export default async function LosSantosPage({ searchParams }: { searchParams: Promise<{ stream?: string }> }) {
  const { stream } = await searchParams;
  const r = await serverApi<NowResponse>("/api/now");
  const login = stream && /^[a-zA-Z0-9_-]{2,25}$/.test(stream) ? stream : null;
  return <LosSantosNow initial={r.ok ? r.data : null} embedParents={embedParents()} initialStream={login} />;
}
