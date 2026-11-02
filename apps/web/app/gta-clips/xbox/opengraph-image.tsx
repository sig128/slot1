import { CLIP_GUIDES } from "@/lib/clip-guides";
import { guideShareCard } from "@/lib/guide-og";
import { OG_SIZE } from "@/lib/og";

export const alt = CLIP_GUIDES.xbox.card.title;
export const size = OG_SIZE;
export const contentType = "image/png";
// The host name on the card comes from the deployment's configured origin.
export const dynamic = "force-dynamic";

export default function Image() {
  return guideShareCard(CLIP_GUIDES.xbox);
}
