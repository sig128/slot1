import type { Metadata } from "next";
import type { AdminLoginStatus, AdminMessagesResponse, AdminOverview } from "@slot1/contracts";
import { AdminApp } from "@/components/admin/AdminApp";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

/** Operator dashboard. The API decides who may see it; everyone else gets the admin password form. */
export default async function AdminPage() {
  const [overview, messages] = await Promise.all([serverApi<AdminOverview>("/api/admin/overview"), serverApi<AdminMessagesResponse>("/api/admin/messages?status=open")]);
  if (!overview.ok && overview.status === 404) {
    const login = await serverApi<AdminLoginStatus>("/api/admin/login");
    if (!login.ok) return <ServiceDown message={login.message} requirement={login.requirement} />;
    return <AdminLogin passwordSet={login.data.passwordSet} />;
  }
  if (!overview.ok) return <ServiceDown message={overview.message} requirement={overview.requirement} />;
  return <AdminApp initial={overview.data} initialMessages={messages.ok ? messages.data : null} />;
}
