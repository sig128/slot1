import type { Metadata } from "next";
import type { LearningResponse, NowResponse } from "@slot1/contracts";
import { LearningView } from "@/components/learning/LearningView";
import { serverApi } from "@/lib/server";
import { pageMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";
export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "What SLOT1 learned",
    description: "What SLOT1's AI is looking at right now, what it has watched and caught across every stream sent to it, and how far each GTA skill has come.",
    path: "/learning",
  });
}

export default async function LearningPage() {
  const [learning, now] = await Promise.all([serverApi<LearningResponse>("/api/learning"), serverApi<NowResponse>("/api/now")]);
  return <LearningView data={learning.ok ? learning.data : null} now={now.ok ? now.data : null} />;
}
