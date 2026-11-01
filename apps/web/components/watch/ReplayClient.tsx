"use client";

import Link from "next/link";
import type { ClipView, ObservationPage, SessionSummary } from "@slot1/contracts";
import { SessionWorkspace } from "./SessionWorkspace";

export function ReplayClient({
  session,
  page,
  clips,
  viewer,
  jump = { tMs: null, momentId: null },
}: {
  session: SessionSummary;
  page: ObservationPage | null;
  clips: ClipView[];
  viewer: { isCreator: boolean; canAsk: boolean; askPolicy: "off" | "signed_in" | "anyone" };
  /** From `?t=` and `?moment=`. */
  jump?: { tMs: number | null; momentId: string | null };
}) {
  const processing = session.processing && (session.processing.state === "queued" || session.processing.state === "running");
  const empty = processing ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">Processing the recording</p>
      <p>{session.processing?.step ?? "Queued"}. Observations appear here as each frame is analyzed.</p>
    </div>
  ) : session.analysis.state === "error" ? (
    <div className="space-y-2 text-sm text-ivory-2">
      <p className="font-display text-xl font-bold text-ivory">Processing failed</p>
      <p>{session.analysis.reason}</p>
    </div>
  ) : (
    <p className="text-sm text-ivory-2">No observations were produced for this recording.</p>
  );
  return (
    <SessionWorkspace
      mode="replay"
      session={session}
      initialPage={page}
      initialClips={clips}
      identity={{
        displayName: session.title ?? "Untitled replay",
        avatarUrl: null,
        title: null,
        category: null,
        twitchUrl: null,
        subtitle: `${session.channelDisplayName}, uploaded ${new Date(session.startedAt).toLocaleDateString()}`,
      }}
      broadcast="unknown"
      fallbackStatus={session.analysis}
      isCreator={viewer.isCreator}
      canAsk={viewer.canAsk}
      askPolicy={viewer.askPolicy}
      emptyState={empty}
      initialSeekMs={jump.tMs}
      initialMomentId={jump.momentId}
      notice={
        !session.analysis.visionConfigured ? (
          <p className="mt-5 max-w-[80ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
            AI vision isn’t configured on this deployment, so SLOT1 only reports on-screen text it could read and measurements of the video itself.
            Nothing here is invented to fill the gap.{" "}
            <Link href="/setup#ai" className="underline hover:text-ivory">
              Configure a vision provider
            </Link>
          </p>
        ) : null
      }
    />
  );
}
