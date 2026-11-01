import type { Metadata } from "next";
import type { Capabilities, DirectoryResponse } from "@slot1/contracts";
import { HomeLanding } from "@/components/home/HomeLanding";
import { OnAirView } from "@/components/onair/OnAirView";
import { JsonLd } from "@/components/seo/JsonLd";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { FAQ } from "@/lib/home-content";
import { faqPage, graph, organization, webApplication, website } from "@/lib/jsonld";
import { legalConfig } from "@/lib/legal";
import { publicOrigin } from "@/lib/origin";
import { serverApi } from "@/lib/server";
import { pageMetadata, SITE } from "@/lib/site";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({ title: SITE.title, absolute: true, description: SITE.description, path: "/" });
}

export default async function OnAirPage() {
  const [dir, caps, origin] = await Promise.all([serverApi<DirectoryResponse>("/api/channels"), serverApi<Capabilities>("/api/capabilities"), publicOrigin()]);
  const structured = graph(
    organization(origin, legalConfig().name),
    website(origin, SITE.description),
    webApplication(origin, SITE.description),
    faqPage(origin, FAQ),
  );
  return (
    <>
      {dir.ok ? <OnAirView directory={dir.data} capabilities={caps.ok ? caps.data : null} /> : <ServiceDown message={dir.message} requirement={dir.requirement} />}
      <HomeLanding />
      <JsonLd data={structured} />
    </>
  );
}
