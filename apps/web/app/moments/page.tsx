import type { Metadata } from "next";
import { MomentsApp } from "@/components/moments/MomentsApp";

export const metadata: Metadata = { title: "Moments" };
export const dynamic = "force-dynamic";

export default function MomentsPage() {
  return <MomentsApp />;
}
