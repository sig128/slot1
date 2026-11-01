import type { Metadata } from "next";
import { DemoClient } from "@/components/watch/DemoClient";

export const metadata: Metadata = { title: "Design demo (fixtures)", robots: { index: false } };

export default function DemoPage() {
  return <DemoClient />;
}
