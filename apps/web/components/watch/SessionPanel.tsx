"use client";

import Link from "next/link";
import { formatAge, formatMediaTime, SOURCE_LABEL_TEXT, type ClipView, type SessionSummary, type SourceRef } from "@slot1/contracts";
import { clockTime, pct } from "@/lib/format";

const CLIP_STATE: Record<ClipView["state"], string> = {
  requested: "Requested",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

const MEDIA_STATE: Record<ClipView["mediaState"], string | null> = {
  not_requested: null,
  missing_scope: "Analysis needs extra permission",
  queued: "Analysis queued",
  downloading: "Downloading clip",
  analyzing: "Analyzing clip",
  ready: "Clip analyzed",
  failed: "Analysis failed",
  expired: "Download link expired",
};

export function ClipList({ clips }: { clips: ClipView[] }) {
  if (clips.length === 0) return <p className="text-sm text-ivory-3">No clips requested yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {[...clips]
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .map((c) => (
          <li key={c.id} className="py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-display text-base font-semibold">
                {c.kind === "owned_render" ? "Rendered clip" : c.kind === "twitch_vod" ? "VOD clip" : "Twitch clip"}
              </span>
              <span className={c.state === "failed" ? "text-coral" : c.state === "ready" ? "text-ivory" : "text-ivory-2"}>{CLIP_STATE[c.state]}</span>
            </div>
            <p className="tnum text-[0.78rem] text-ivory-3">
              Requested {clockTime(c.requestedAt)}
              {c.durationMs ? `, ${formatMediaTime(c.durationMs)} long` : ""}
              {c.sourceResolution ? `, source ${c.sourceResolution}` : ""}
            </p>
            {c.errorMessage && <p className="mt-1 text-[0.82rem] text-ivory-2">{c.errorMessage}</p>}
            {MEDIA_STATE[c.mediaState] && c.kind !== "owned_render" && <p className="mt-1 text-[0.78rem] text-ivory-3">{MEDIA_STATE[c.mediaState]}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {c.state === "ready" && c.clipUrl && (
                <a href={c.clipUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm">
                  Open on Twitch
                </a>
              )}
              {c.exports.map((x) => (
                <a key={x.kind} href={x.url} download className="btn btn-ghost btn-sm">
                  Download {x.kind}
                  {x.width && x.height ? ` ${x.width}×${x.height}` : ""}
                </a>
              ))}
            </div>
          </li>
        ))}
    </ul>
  );
}

export function SessionPanel({ session, sources, clips, now }: { session: SessionSummary | null; sources: SourceRef[]; clips: ClipView[]; now: number }) {
  if (!session) return <p className="p-5 text-sm text-ivory-2">No session yet.</p>;
  const a = session.analysis;
  const lastFrameAge = a.lastReceivedFrameAt && now > 0 ? now - new Date(a.lastReceivedFrameAt).getTime() : null;
  return (
    <div className="space-y-6 overflow-y-auto p-4">
      <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.84rem]">
        <dt className="text-ivory-3">Session</dt>
        <dd>{session.kind === "replay" ? "Replay of an uploaded recording" : session.kind === "ingest" ? "Continuous ingest" : "Twitch broadcast"}</dd>
        <dt className="text-ivory-3">Started</dt>
        <dd suppressHydrationWarning>{new Date(session.startedAt).toLocaleString()}</dd>
        <dt className="text-ivory-3">Coverage</dt>
        <dd>
          {pct(session.coverage.ratio)} analyzed
          {session.coverage.durationMs ? ` of ${formatMediaTime(session.coverage.durationMs)}` : ""}
        </dd>
        <dt className="text-ivory-3">Frames</dt>
        <dd>
          {session.coverage.framesAnalyzed} analyzed{session.coverage.framesDropped ? `, ${session.coverage.framesDropped} dropped under load` : ""}
        </dd>
        <dt className="text-ivory-3">Last frame</dt>
        <dd>{lastFrameAge === null ? "None received" : `${formatAge(lastFrameAge)} ago`}</dd>
        <dt className="text-ivory-3">Cadence</dt>
        <dd>{a.measuredCadenceMs ? `One frame every ${formatAge(a.measuredCadenceMs)}` : "—"}</dd>
        <dt className="text-ivory-3">Stale after</dt>
        <dd>{a.staleAfterMs ? `${formatAge(a.staleAfterMs)} without frames` : "Not applicable"}</dd>
        <dt className="text-ivory-3">Vision AI</dt>
        <dd>{a.visionConfigured ? "On" : "Not switched on yet"}</dd>
      </dl>
      {a.reason && <p className="text-sm text-ivory-2">{a.reason}</p>}
      {sources.length > 0 && (
        <div>
          <h3 className="font-display text-lg font-bold">Sources in this log</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {sources.map((s) => (
              <li key={s.id} className="flex justify-between gap-3">
                <span className="truncate text-ivory-2">{s.name}</span>
                <span className="shrink-0 font-display text-[0.8rem] font-semibold tracking-wider text-ivory-3">{SOURCE_LABEL_TEXT[s.label]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="font-display text-lg font-bold">Clips</h3>
        <div className="mt-1">
          <ClipList clips={clips} />
        </div>
      </div>
      <p className="text-[0.78rem] text-ivory-3">
        The Twitch player and SLOT1’s analysis travel separately and can be several seconds apart. SLOT1 never claims frame-perfect sync.{" "}
        <Link href="/setup#modes" className="underline hover:text-ivory">
          Why
        </Link>
      </p>
    </div>
  );
}
