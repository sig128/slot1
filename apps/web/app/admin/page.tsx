import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { AdminMessagesResponse, AdminOverview } from "@slot1/contracts";
import { AdminApp } from "@/components/admin/AdminApp";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

/** Operator dashboard. The API decides who may see it; everyone else gets the normal 404 page. */
export default async function AdminPage() {
  const [overview, messages] = await Promise.all([serverApi<AdminOverview>("/api/admin/overview"), serverApi<AdminMessagesResponse>("/api/admin/messages?status=open")]);
  if (!overview.ok && overview.status === 404) notFound();
  if (!overview.ok) return <ServiceDown message={overview.message} requirement={overview.requirement} />;
  return <AdminApp initial={overview.data} initialMessages={messages.ok ? messages.data : null} />;
}
