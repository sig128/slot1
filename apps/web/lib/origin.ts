import "server-only";
import { headers } from "next/headers";

/**
 * The public origin for absolute links in link previews. The configured origin wins, so a
 * forged Host header can't put another site into SLOT1's share cards.
 */
export async function publicOrigin(): Promise<string> {
  const configured = process.env.SLOT1_PUBLIC_ORIGIN;
  if (configured && /^https?:\/\/[a-z0-9.:-]+\/?$/i.test(configured)) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = (h.get("host") ?? "localhost:3000").replace(/[^a-z0-9.:-]/gi, "");
  return `http://${host}`;
}
