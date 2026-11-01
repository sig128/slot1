import "server-only";
import { cookies, headers } from "next/headers";

const API = process.env.SLOT1_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

export type ServerResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string; requirement: string | null };

/** Server-side fetch to the API, forwarding the viewer's cookies so authorization stays server-side. */
export async function serverApi<T>(path: string): Promise<ServerResult<T>> {
  const cookieHeader = (await cookies()).toString();
  try {
    const res = await fetch(`${API}${path}`, { headers: cookieHeader ? { cookie: cookieHeader } : {}, cache: "no-store" });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let requirement: string | null = null;
      try {
        const j = (await res.json()) as { error?: { message?: string; requirement?: string | null } };
        message = j.error?.message ?? message;
        requirement = j.error?.requirement ?? null;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, message, requirement };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    // Visitors read "SLOT1 isn't answering"; only a developer's own machine gets the command.
    return { ok: false, status: 503, message: "SLOT1 isn’t answering right now", requirement: process.env.NODE_ENV === "production" ? "Try again in a minute." : "Start the API (pnpm dev:api)" };
  }
}

export async function nonce(): Promise<string | undefined> {
  return (await headers()).get("x-nonce") ?? undefined;
}

/** Hostnames allowed to embed the Twitch player (must match Twitch's `parent` parameter rules). */
export function embedParents(): string[] {
  return (process.env.TWITCH_EMBED_PARENTS ?? "localhost")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9.-]+$/.test(s));
}
