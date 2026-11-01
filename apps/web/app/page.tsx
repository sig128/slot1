import type { Capabilities, DirectoryResponse } from "@slot1/contracts";
import { OnAirView } from "@/components/onair/OnAirView";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { serverApi } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function OnAirPage() {
  const [dir, caps] = await Promise.all([serverApi<DirectoryResponse>("/api/channels"), serverApi<Capabilities>("/api/capabilities")]);
  if (!dir.ok) return <ServiceDown message={dir.message} requirement={dir.requirement} />;
  return <OnAirView directory={dir.data} capabilities={caps.ok ? caps.data : null} />;
}
