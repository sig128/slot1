import { CLIP_GUIDES } from "@/lib/clip-guides";
import { OG_SIZE } from "@/lib/og";

// The same card for X/Twitter's summary_large_image.
export { default } from "./opengraph-image";
export const alt = CLIP_GUIDES.xbox.card.title;
export const size = OG_SIZE;
export const contentType = "image/png";
export const dynamic = "force-dynamic";
