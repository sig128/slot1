import type { Metadata } from "next";
import type { NowResponse } from "@slot1/contracts";
import { LosSantosNow } from "@/components/now/LosSantosNow";
import { embedParents, serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Los Santos right now",
  description: "Every public stream SLOT1 is watching, and what it saw on each one in the last minute.",
};

export default async function LosSantosPage({ searchParams }: { searchParams: Promise<{ stream?: string }> }) {
  const { stream } = await searchParams;
  const r = await serverApi<NowResponse>("/api/now");
  const login = stream && /^[a-zA-Z0-9_]{2,25}$/.test(stream) ? stream : null;
  return <LosSantosNow initial={r.ok ? r.data : null} embedParents={embedParents()} initialStream={login} />;
}
