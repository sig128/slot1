"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LibraryItemView, SessionSummary } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";

/**
 * Creator tools on a session: a full-resolution screenshot at the playhead (or the latest live
 * frame) and a clip draft around the playhead that opens in the editor.
 */
export function ClipperActions({ mode, session, getPositionMs }: { mode: "live" | "replay"; session: SessionSummary; getPositionMs: () => number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "shot" | "edit">(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stored = mode === "replay" && Boolean(session.playback);
  const liveIngest = mode === "live" && session.kind === "ingest" && !session.endedAt;
  if (!stored && !liveIngest) return null;

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}.` : ""}` : fallback);

  const screenshot = async () => {
    setBusy("shot");
    setError(null);
    setDone(null);
    try {
      const at = getPositionMs();
      const body = stored ? { from: "media", sessionId: session.id, atMs: Math.max(0, at ?? 0) } : { from: "live", sessionId: session.id };
      await api<LibraryItemView>("/api/library/screenshots", { method: "POST", json: body });
      setDone(stored ? `Screenshot at ${editTime(at ?? 0)} saved to your library` : "Live screenshot saved to your library");
    } catch (err) {
      fail(err, "Couldn't take the screenshot");
    } finally {
      setBusy(null);
    }
  };

  const editClip = async () => {
    setBusy("edit");
    setError(null);
    try {
      const at = getPositionMs() ?? 0;
      const r = await api<{ id: string }>("/api/projects", {
        method: "POST",
        json: { sessionId: session.id, inMs: Math.max(0, at - 8000), outMs: at + 6000, title: session.title ? `Clip: ${session.title}`.slice(0, 120) : undefined },
      });
      router.push(`/studio/edit/${r.id}`);
    } catch (err) {
      fail(err, "Couldn't start an edit");
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void screenshot()}>
        {busy === "shot" ? "Saving" : "Screenshot"}
      </button>
      {stored && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void editClip()}>
          {busy === "edit" ? "Opening editor" : "Edit clip"}
        </button>
      )}
      {(done || error) && (
        <span role="status" className={`basis-full text-sm ${error ? "text-coral" : "text-ivory-2"}`}>
          {error ?? done}{" "}
          {done && (
            <Link href="/studio#library" className="underline hover:text-ivory">
              Open library
            </Link>
          )}
        </span>
      )}
    </>
  );
}
