import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ProjectView } from "@slot1/contracts";
import { ClipEditor } from "@/components/clipper/ClipEditor";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit clip", robots: { index: false, follow: false } };

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const p = await serverApi<ProjectView>(`/api/projects/${id}`);
  if (!p.ok) {
    if (p.status === 401 || p.status === 403) {
      return (
        <section className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 lg:px-10">
          <h1 className="poster-title text-[length:var(--text-display-md)] font-black">Sign in to edit.</h1>
          <p className="mt-4 max-w-[60ch] text-ivory-2">Only the creator who owns a clip can edit it.</p>
          <Link href="/studio" className="btn btn-primary mt-8">
            Open Studio
          </Link>
        </section>
      );
    }
    if (p.status === 404 || p.status === 400) notFound();
    return <ServiceDown message={p.message} requirement={p.requirement} />;
  }
  return <ClipEditor initial={p.data} />;
}
