import { permanentRedirect } from "next/navigation";

/**
 * The demo page was removed: SLOT1 shows real streams only. Old links (shared posts, bookmarks)
 * land on the home page instead of a 404.
 */
export default function DemoPage() {
  permanentRedirect("/");
}
