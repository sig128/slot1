import type { Metadata } from "next";
import { ClipGuidePage } from "@/components/seo/ClipGuidePage";
import { CLIP_GUIDES } from "@/lib/clip-guides";
import { guideShareImage } from "@/lib/guide-og";
import { pageMetadata } from "@/lib/site";

const guide = CLIP_GUIDES.xbox;

export function generateMetadata(): Metadata {
  return pageMetadata({ title: guide.title, description: guide.description, path: guide.path, images: [guideShareImage(guide)], type: "article" });
}

export default function Page() {
  return <ClipGuidePage guide={guide} />;
}
