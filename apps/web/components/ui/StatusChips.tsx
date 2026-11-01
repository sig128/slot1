import { ANALYSIS_STATE_LABEL, SOURCE_LABEL_TEXT, type AnalysisStatus, type BroadcastSnapshot, type SourceLabel } from "@slot1/contracts";

/**
 * Broadcast status — Twitch platform data only. `platform="slot1"` is for channels without a
 * Twitch channel (SLOT1's demo): there "live" means the source is sending to SLOT1.
 */
export function BroadcastChip({ state, platform = "twitch" }: { state: BroadcastSnapshot["state"]; platform?: "twitch" | "slot1" }) {
  if (platform === "slot1") {
    return state === "live" ? (
      <span className="chip chip-live" title="The source is sending video to SLOT1">
        <span className="live-dot" aria-hidden />
        Live on SLOT1
      </span>
    ) : (
      <span className="chip chip-muted" title="The source isn't sending video to SLOT1">Not sending</span>
    );
  }
  if (state === "live")
    return (
      <span className="chip chip-live" title="Twitch reports this channel is live">
        <span className="live-dot" aria-hidden />
        Live on Twitch
      </span>
    );
  if (state === "offline") return <span className="chip chip-muted" title="Twitch reports this channel is offline">Offline</span>;
  if (state === "error") return <span className="chip chip-error" title="Twitch data is temporarily unavailable">Twitch unavailable</span>;
  return <span className="chip chip-muted" title="Broadcast status unknown — Twitch isn't connected on this deployment">Status unknown</span>;
}

/**
 * Analysis status — only about the gameplay-analysis subsystem. "Live vision" is shown only
 * while frames are arriving and being processed; it pulses only then.
 */
export function AnalysisChip({ status }: { status: AnalysisStatus }) {
  const s = status.state;
  if (s === "live_vision") {
    const textOnly = !status.visionConfigured;
    return (
      <span className="chip chip-vision" title={status.reason ?? undefined}>
        <span className="live-dot live-dot-pulse" aria-hidden />
        {textOnly ? "Live frames, text only" : "Live vision"}
      </span>
    );
  }
  if (s === "stale")
    return (
      <span className="chip chip-stale" title={status.reason ?? undefined}>
        <span className="stale-dot" aria-hidden />
        Stale
      </span>
    );
  if (s === "replay") return <span className="chip chip-replay" title={status.reason ?? undefined}>Replay</span>;
  if (s === "error") return <span className="chip chip-error" title={status.reason ?? undefined}>Analysis error</span>;
  if (s === "no_source") return <span className="chip chip-muted" title={status.reason ?? undefined}>Chat & clips only</span>;
  if (s === "analyzing_clip") return <span className="chip chip-vision" title={status.reason ?? undefined}>Analyzing clip</span>;
  if (s === "delayed") return <span className="chip chip-vision" title={status.reason ?? undefined}>Delayed</span>;
  return <span className="chip chip-muted" title={status.reason ?? undefined}>{ANALYSIS_STATE_LABEL[s]}</span>;
}

export function SourceLabelChip({ label }: { label: SourceLabel | null }) {
  if (!label) return null;
  const cls = label === "live" ? "chip-vision" : label === "clip" ? "chip-muted" : "chip-replay";
  return <span className={`chip ${cls}`}>{SOURCE_LABEL_TEXT[label]}</span>;
}

/** Small labelled pair of the two independent statuses. */
export function StatusPair({ broadcast, analysis, platform = "twitch" }: { broadcast: BroadcastSnapshot["state"]; analysis: AnalysisStatus; platform?: "twitch" | "slot1" }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[0.78rem] text-ivory-3">Broadcast</span>
        <BroadcastChip state={broadcast} platform={platform} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[0.78rem] text-ivory-3">Analysis</span>
        <AnalysisChip status={analysis} />
      </div>
    </div>
  );
}
