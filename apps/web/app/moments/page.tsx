import type { Metadata } from "next";
import { MomentsApp } from "@/components/moments/MomentsApp";
import { pageMetadata } from "@/lib/site";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Moments",
    description: "Search the moments SLOT1 saw in public GTA streams: missions passed and failed, crashes, chases and more, each linked to its evidence.",
    path: "/moments",
  });
}
export const dynamic = "force-dynamic";

export default function MomentsPage() {
  return <MomentsApp />;
}
