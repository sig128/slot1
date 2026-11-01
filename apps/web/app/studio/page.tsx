import type { Metadata } from "next";
import { StudioApp } from "@/components/studio/StudioApp";

export const metadata: Metadata = { title: "Studio" };
export const dynamic = "force-dynamic";

export default function StudioPage() {
  return <StudioApp />;
}
