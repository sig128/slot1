import type { Metadata } from "next";
import { StudioApp } from "@/components/studio/StudioApp";

// A private tool: kept out of search results (robots.txt also asks crawlers to skip it).
export const metadata: Metadata = { title: "Studio", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function StudioPage() {
  return <StudioApp />;
}
