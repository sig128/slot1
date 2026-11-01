"use client";

import { Tabs } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatAge,
  jumpTarget,
  type Observation,
  type AnalysisStatus,
  type AskResponse,
  type BroadcastSnapshot,
  type ClipView,
  type ObservationDetail,
  type ObservationPage,
  type SessionSummary,
} from "@slot1/contracts";
import { chatEmbedUrl } from "@slot1/twitch/url";
import { ClipperActions } from "@/components/clipper/ClipperActions";
import { BroadcastChip, SourceLabelChip, StatusPair } from "@/components/ui/StatusChips";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { pct } from "@/lib/format";
import { AskPanel } from "./AskPanel";
import { EventRail, railItems } from "./EventRail";
import { EvidencePanel } from "./EvidencePanel";
import { InstantReplayPlayer, PlayerKindContext, useInstantReplay, useInstantReplayStatus, useWideEnough, type PlayerKind } from "./InstantReplay";
import { ActionStars, actionLevel, MomentBanner } from "./Moments";
import { SessionPanel } from "./SessionPanel";
import { Timeline } from "./Timeline";
import { useNow, useSessionStream } from "./useSessionStream";

export interface WorkspaceIdentity {
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
  category: string | null;
  twitchUrl: string | null;
  subtitle?: string;
}

interface Props {
  mode: "live" | "replay";
  session: SessionSummary | null;
  initialPage: ObservationPage | null;
  initialClips: ClipView[];
  identity: WorkspaceIdentity;
  broadcast: BroadcastSnapshot["state"];
  fallbackStatus: AnalysisStatus;
  livePlayer?: React.ReactNode;
  isCreator: boolean;
  canAsk: boolean;
  askPolicy: "off" | "signed_in" | "anyone";
  chatLogin?: string | null;
  embedParents?: string[];
  emptyState: React.ReactNode;
  notice?: React.ReactNode;
  /** Public channel that hasn't connected SLOT1: Twitch player only, no analysis UI. */
  watchOnly?: boolean;
  /** Design demo only: fixtures, no network. */
  fixture?: { details: Record<string, ObservationDetail>; answer: (q: string) => AskResponse };
  /** `?t=`: the moment to land on in a replay (playback starts 3 s before it). */
  initialSeekMs?: number | null;
  /** `?moment=`: select this observation; live, open its instant replay. */
  initialMomentId?: string | null;
}

export function SessionWorkspace(p: Props) {
  const now = useNow(1000);
  const stream = useSessionStream(
    p.session?.id ?? null,
    {
      observations: p.initialPage?.observations ?? [],
      sources: p.initialPage?.sources ?? [],
      lastEventId: p.initialPage?.lastEventId ?? null,
      status: p.session?.analysis ?? null,
    },
    { disabled: Boolean(p.fixture) },
  );
  const status = stream.status ?? p.fallbackStatus;
  const broadcastState = stream.broadcast?.state ?? p.broadcast;
  const items = useMemo(() => railItems(stream.observations, p.mode), [stream.observations, p.mode]);
  const clips = useMemo(() => {
    const m = new Map(p.initialClips.map((c) => [c.id, c]));
    for (const c of stream.clips) m.set(c.id, c);
    return [...m.values()];
  }, [p.initialClips, stream.clips]);

  const [selected, setSelected] = useState<string | null>(p.initialMomentId ?? null);
  const [tab, setTab] = useState("log");
  const [theater, setTheater] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [position, setPosition] = useState<number | null>(null);
  const [panel, setPanel] = useState<null | "moment" | "clip">(null);
  const video = useRef<HTMLVideoElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);

  const select = (id: string) => {
    setSelected(id);
    setTab("log");
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1023px)").matches) evidenceRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  const seek = (ms: number) => {
    const v = video.current;
    if (!v) return;
    // Move the playhead immediately; the video catches up when it has buffered.
    setPosition(ms);
    v.currentTime = ms / 1000;
    void v.play().catch(() => undefined);
  };

  /** Clickable timestamps land a little before the moment, and bring the video into view on phones. */
  const jumpTo = (momentMs: number) => {
    seek(jumpTarget(momentMs));
    if (window.matchMedia("(max-width: 1023px)").matches) {
      video.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  };

  // Instant replay (live only): where it may appear depends on which player is the main one.
  const [playerKind, setPlayerKind] = useState<PlayerKind>("twitch");
  const wide = useWideEnough();
  const replayEnabled = p.mode === "live" && !p.watchOnly && !p.fixture && Boolean(p.session);
  const replayStatus = useInstantReplayStatus(p.session?.id ?? null, replayEnabled);
  const { state: replayState, open: openReplay, close: closeReplay } = useInstantReplay(p.session?.id ?? null);
  const canInstant = replayEnabled && replayStatus?.available === true;
  const overlayReplay = playerKind === "slot1" && wide;
  const instantReplay = (o: Pick<Observation, "id" | "description">, trigger: HTMLElement | null) => {
    setSelected(o.id);
    openReplay({ observationId: o.id, label: o.description, returnFocus: trigger });
  };

  // `?moment=` while live: open that moment's instant replay once SLOT1 says it can.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !canInstant || !p.initialMomentId) return;
    autoOpened.current = true;
    const o = items.find((x) => x.id === p.initialMomentId);
    openReplay({ observationId: p.initialMomentId, label: o?.description ?? "Shared moment", returnFocus: null });
  }, [canInstant, p.initialMomentId, items, openReplay]);

  // `?t=` / `?moment=` in a replay: land on the moment once the video knows its duration.
  const landed = useRef(false);
  const land = () => {
    if (landed.current) return;
    landed.current = true;
    const momentMs = p.initialSeekMs ?? items.find((x) => x.id === p.initialMomentId)?.mediaStartMs ?? null;
    const v = video.current;
    if (momentMs === null || !v) return;
    const at = jumpTarget(momentMs);
    v.currentTime = at / 1000;
    setPosition(at);
  };

  const onCite = (id: string, mediaStartMs: number | null) => {
    select(id);
    if (mediaStartMs === null) return;
    if (p.mode === "replay" && p.session?.playback) jumpTo(mediaStartMs);
    else if (canInstant) instantReplay({ id, description: items.find((x) => x.id === id)?.description ?? "Cited moment" }, document.activeElement as HTMLElement | null);
  };

  const selectedObs = items.find((o) => o.id === selected) ?? null;
  const durationMs = p.session?.playback?.durationMs ?? p.session?.coverage.durationMs ?? null;

  return (
    <PlayerKindContext.Provider value={setPlayerKind}>
    <div className={`mx-auto px-4 pb-16 pt-6 sm:px-6 lg:px-10 ${theater ? "max-w-none" : "max-w-[1600px]"}`}>
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 items-start gap-4">
          {p.identity.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.identity.avatarUrl} alt="" className="mt-1 h-12 w-12 shrink-0 rounded-full" />
          ) : (
            <span className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-full bg-graphite-600 font-display text-xl font-bold">
              {p.identity.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="poster-title text-[length:var(--text-display-md)] font-black leading-[0.92]">{p.identity.displayName}</h1>
            {p.identity.title && <p className="mt-1.5 max-w-[70ch] text-[1.02rem] text-ivory-2">{p.identity.title}</p>}
            <div className="mt-1 flex flex-wrap gap-x-5 text-sm text-ivory-3">
              {p.identity.category && <span title="Category set by the creator on Twitch">{p.identity.category}</span>}
              {p.identity.subtitle && <span suppressHydrationWarning>{p.identity.subtitle}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.identity.twitchUrl && (
            <a href={p.identity.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm">
              Open on Twitch
            </a>
          )}
          <button type="button" className="btn btn-quiet btn-sm hidden lg:inline-flex" aria-pressed={theater} onClick={() => setTheater((t) => !t)}>
            {theater ? "Exit theater" : "Theater mode"}
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3">
          {p.mode === "replay" ? (
            <div className="flex flex-wrap items-center gap-3">
              {p.session && p.session.kind !== "replay" ? (
                <>
                  <span className="chip chip-replay">Recording</span>
                  <SourceLabelChip label={p.session.label} />
                  <span className="text-sm text-ivory-2">A recording of a live broadcast, with what SLOT1 saw while it was live.</span>
                </>
              ) : (
                <>
                  <SourceLabelChip label={p.session?.label ?? "replay"} />
                  <span className="text-sm text-ivory-2">An uploaded recording, not a live broadcast.</span>
                </>
              )}
            </div>
          ) : p.watchOnly ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[0.78rem] text-ivory-3">Broadcast</span>
                <BroadcastChip state={broadcastState} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[0.78rem] text-ivory-3">Analysis</span>
                <span className="chip chip-muted">Not analyzed</span>
              </div>
            </div>
          ) : (
            <StatusPair broadcast={broadcastState} analysis={status} />
          )}
          {p.mode === "live" && p.session?.label === "test" && <SourceLabelChip label="test" />}
          {!p.watchOnly && p.session && <ActionStars level={actionLevel(items, p.mode, position, now)} />}
        </div>
      </header>
      {p.notice}

      <div
        className={`mt-6 grid gap-6 lg:grid-rows-[auto_auto_1fr] ${
          theater ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)]"
        }`}
      >
        <div className="relative min-w-0 lg:col-start-1 lg:row-start-1" data-main-player>
          {p.mode === "replay" && (
            // Over SLOT1's own replay video only; never over Twitch's player.
            <MomentBanner className="absolute inset-x-0 top-[7%] z-10" items={items} mode="replay" positionMs={position} freshIds={stream.freshIds} now={now} />
          )}
          {p.mode === "replay" ? (
            p.session?.playback ? (
              <video
                ref={video}
                controls
                preload="metadata"
                playsInline
                poster={p.session.playback.posterUrl ?? undefined}
                src={p.session.playback.url}
                className="block aspect-video w-full bg-black"
                onLoadedMetadata={land}
                onTimeUpdate={(e) => setPosition(Math.round(e.currentTarget.currentTime * 1000))}
              />
            ) : (
              <div className="grid aspect-video w-full place-items-center bg-graphite-800 text-sm text-ivory-2">
                {p.session?.processing?.state === "failed" ? "Processing failed. See the session panel." : "Preparing playback"}
              </div>
            )
          ) : (
            p.livePlayer
          )}
          {/* Only over SLOT1's own live video; with Twitch's player it docks in the rail instead. */}
          {replayState.kind !== "idle" && overlayReplay && <InstantReplayPlayer state={replayState} variant="overlay" onClose={closeReplay} />}
        </div>

        <div className={`relative min-w-0 space-y-4 lg:col-start-1 lg:row-start-2 ${p.session ? "" : "hidden"}`}>
          {p.mode === "live" && !p.watchOnly && (
            <MomentBanner
              className="absolute inset-x-0 top-0 z-10"
              items={items}
              mode="live"
              positionMs={null}
              freshIds={stream.freshIds}
              now={now}
              onReplay={canInstant ? instantReplay : undefined}
            />
          )}
          <Timeline
            mode={p.mode}
            items={items}
            selectedId={selected}
            onSelect={select}
            durationMs={durationMs}
            positionMs={position}
            onSeek={p.mode === "replay" ? seek : undefined}
            coverage={p.session?.coverage ?? null}
            now={now}
          />
          <div className="flex flex-wrap items-center gap-2">
            {p.isCreator && p.session && (
              <>
                <button type="button" className="btn btn-primary btn-sm" aria-expanded={panel === "moment"} onClick={() => setPanel(panel === "moment" ? null : "moment")}>
                  Save moment
                </button>
                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={panel === "clip"} onClick={() => setPanel(panel === "clip" ? null : "clip")}>
                  Request clip
                </button>
                {!p.fixture && (
                  <ClipperActions mode={p.mode} session={p.session} getPositionMs={() => (video.current ? Math.round(video.current.currentTime * 1000) : position)} />
                )}
              </>
            )}
            <details className="group ml-auto text-sm">
              <summary className="btn btn-quiet btn-sm cursor-pointer list-none">Metrics</summary>
              <Metrics session={p.session} status={status} now={now} />
            </details>
          </div>
          {panel === "moment" && p.session && (
            <MomentForm
              key={selectedObs?.id ?? "none"}
              sessionId={p.session.id}
              observationId={selectedObs?.id ?? null}
              defaultTitle={selectedObs?.description.slice(0, 120) ?? ""}
              mediaMs={p.mode === "replay" ? (selectedObs?.mediaStartMs ?? position) : (selectedObs?.mediaStartMs ?? null)}
              onDone={() => setPanel(null)}
              fixture={Boolean(p.fixture)}
            />
          )}
          {panel === "clip" && p.session && (
            <ClipForm
              session={p.session}
              mode={p.mode}
              centerMs={selectedObs?.mediaStartMs ?? position}
              onDone={() => setPanel(null)}
              fixture={Boolean(p.fixture)}
            />
          )}
        </div>

        <aside
          className="flex min-h-[420px] min-w-0 flex-col border hairline bg-graphite-900 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:h-[calc(100dvh-7rem)]"
          aria-label="SLOT1 rail"
        >
          {replayState.kind !== "idle" && !overlayReplay && (
            <div className="border-b hairline p-3">
              <InstantReplayPlayer state={replayState} variant="dock" onClose={closeReplay} />
            </div>
          )}
          <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <Tabs.List className="flex border-b hairline" aria-label="Rail views">
              {[
                ["log", "Live log"],
                ["ask", "Ask SLOT1"],
                ["session", "Session"],
              ].map(([v, label]) => (
                <Tabs.Trigger
                  key={v}
                  value={v!}
                  className="h-11 flex-1 font-display text-[1rem] font-semibold tracking-[0.02em] text-ivory-2 transition-colors hover:text-ivory data-[state=active]:select-bar"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="log" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount>
              <EventRail
                mode={p.mode}
                items={items}
                sources={stream.sources}
                status={p.mode === "live" ? status : null}
                showHeader={p.mode === "live" && Boolean(p.session)}
                connection={stream.connection}
                selectedId={selected}
                onSelect={select}
                freshIds={stream.freshIds}
                now={now}
                emptyState={p.emptyState}
                onReplay={
                  p.mode === "live"
                    ? canInstant
                      ? instantReplay
                      : undefined
                    : p.session?.playback
                      ? (o) => {
                          setSelected(o.id);
                          if (o.mediaStartMs !== null) jumpTo(o.mediaStartMs);
                        }
                      : undefined
                }
                replayAction={p.mode === "live" ? "Replay" : "Play"}
                replayNote={replayEnabled && replayStatus && !replayStatus.available ? replayStatus.reason : null}
              />
            </Tabs.Content>
            <Tabs.Content value="ask" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <AskPanel sessionId={p.session?.id ?? null} canAsk={p.canAsk} policy={p.askPolicy} onCite={onCite} fixtureAnswer={p.fixture?.answer} />
            </Tabs.Content>
            <Tabs.Content value="session" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <SessionPanel session={p.session ? { ...p.session, analysis: status } : null} sources={stream.sources} clips={clips} now={now} />
            </Tabs.Content>
          </Tabs.Root>
          {p.mode === "live" && p.chatLogin && p.embedParents && (
            <div className="border-t hairline">
              <button type="button" className="flex h-10 w-full items-center justify-between px-4 text-sm text-ivory-2 hover:text-ivory" aria-expanded={chatOpen} onClick={() => setChatOpen((o) => !o)}>
                <span>Twitch chat</span>
                <span aria-hidden>{chatOpen ? "Hide" : "Show"}</span>
              </button>
              {chatOpen && <iframe title="Twitch chat" src={chatEmbedUrl(p.chatLogin, p.embedParents)} className="block h-[38vh] w-full border-t hairline bg-graphite" />}
            </div>
          )}
        </aside>

        {selected && (
          <div ref={evidenceRef} className="min-w-0 scroll-mt-20 lg:col-start-1 lg:row-start-3">
            <EvidencePanel
              key={selected}
              observationId={selected}
              mode={p.mode}
              onClose={() => setSelected(null)}
              onPlayFrom={p.mode === "replay" && p.session?.playback ? seek : undefined}
              onSaveMoment={() => setPanel("moment")}
              fixture={p.fixture?.details[selected]}
            />
          </div>
        )}
      </div>
    </div>
    </PlayerKindContext.Provider>
  );
}

function Metrics({ session, status, now }: { session: SessionSummary | null; status: AnalysisStatus; now: number }) {
  if (!session) return <div className="mt-3 text-ivory-3">No session.</div>;
  const c = session.coverage;
  const lastFrame = status.lastReceivedFrameAt && now > 0 ? now - new Date(status.lastReceivedFrameAt).getTime() : null;
  const rows: [string, string][] = [
    ["Analyzed coverage", `${pct(c.ratio)}${c.durationMs ? ` of ${formatAge(c.durationMs)}` : ""}`],
    ["Frames analyzed", String(c.framesAnalyzed)],
    ["Dropped under load", String(c.framesDropped)],
    ["Last frame", lastFrame === null ? "—" : `${formatAge(lastFrame)} ago`],
    ["Frame cadence", status.measuredCadenceMs ? formatAge(status.measuredCadenceMs) : "—"],
    ["Processing delay", status.measuredDelayMs ? formatAge(status.measuredDelayMs) : "—"],
    ["Source", session.playback?.width ? `${session.playback.width}×${session.playback.height}${session.playback.fps ? `, ${session.playback.fps} fps delivery` : ""}` : "—"],
  ];
  return (
    <dl className="tnum absolute right-0 z-20 mt-2 grid w-[min(92vw,340px)] grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 border hairline bg-graphite-800 p-4 text-[0.82rem] shadow-xl shadow-black/40">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ivory-3">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
      <p className="col-span-2 mt-2 text-[0.74rem] text-ivory-3">Totals cover analyzed footage only; nothing is extrapolated.</p>
    </dl>
  );
}

function MomentForm({
  sessionId,
  observationId,
  defaultTitle,
  mediaMs,
  onDone,
  fixture,
}: {
  sessionId: string;
  observationId: string | null;
  defaultTitle: string;
  mediaMs: number | null;
  onDone: () => void;
  fixture: boolean;
}) {
  const [title, setTitle] = useState(defaultTitle || "Saved moment");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fixture) return setState("saved");
    setState("busy");
    try {
      await api("/api/moments", {
        method: "POST",
        json: { sessionId, ...(observationId ? { observationId } : {}), title, ...(note ? { note } : {}), ...(mediaMs !== null && !observationId ? { mediaStartMs: mediaMs } : {}) },
      });
      setState("saved");
      setTimeout(onDone, 1200);
    } catch (err) {
      setState("error");
      setError(err instanceof ApiError ? err.message : "Couldn't save the moment");
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-3 border hairline bg-graphite-800 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div>
        <label className="label" htmlFor="m-title">
          Moment title
        </label>
        <input id="m-title" className="field" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor="m-note">
          Note (optional)
        </label>
        <input id="m-note" className="field" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={state === "busy" || state === "saved"}>
        {state === "saved" ? "Saved to Moments" : state === "busy" ? "Saving" : "Save moment"}
      </button>
      <p className="text-[0.78rem] text-ivory-3 sm:col-span-3">
        {observationId ? "Linked to the selected observation and its evidence." : "Not linked to an observation. Select one in the log to attach its evidence."}
        {error ? <span className="ml-2 text-coral">{error}</span> : null}
      </p>
    </form>
  );
}

function ClipForm({ session, mode, centerMs, onDone, fixture }: { session: SessionSummary; mode: "live" | "replay"; centerMs: number | null; onDone: () => void; fixture: boolean }) {
  const [vertical, setVertical] = useState(false);
  const [caption, setCaption] = useState("");
  const [result, setResult] = useState<ClipView | null>(null);
  const [error, setError] = useState<{ message: string; requirement: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = mode === "live";
  const canLive = session.kind === "twitch_broadcast" && session.broadcastState === "live";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fixture) return;
    setBusy(true);
    setError(null);
    try {
      const body = live
        ? { sessionId: session.id, kind: "twitch_live", idempotencyKey: newIdempotencyKey() }
        : { sessionId: session.id, kind: "owned_render", centerMs: centerMs ?? 0, vertical, ...(caption ? { caption } : {}), idempotencyKey: newIdempotencyKey() };
      setResult(await api<ClipView>("/api/clips", { method: "POST", json: body }));
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, requirement: err.requirement } : { message: "Couldn't request a clip", requirement: null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 border hairline bg-graphite-800 p-4">
      {live ? (
        <p className="text-sm text-ivory-2">
          {canLive
            ? "Asks Twitch to clip the last moments of the live broadcast. Twitch creates clips asynchronously; the link appears only once Twitch confirms it."
            : "Live clips are only possible while the channel is live on Twitch."}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} className="accent-[#ffad72]" />
            Also render a vertical 9:16 version
          </label>
          {vertical && (
            <div>
              <label className="label" htmlFor="c-cap">
                Caption for the vertical version
              </label>
              <input id="c-cap" className="field" value={caption} maxLength={90} onChange={(e) => setCaption(e.target.value)} />
            </div>
          )}
          <p className="text-[0.78rem] text-ivory-3 sm:col-span-2">Renders 8 seconds either side of the selected moment from the stored recording, at source resolution.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-coral btn-sm" disabled={busy || (live && !canLive)}>
          {busy ? "Requesting" : live ? "Request Twitch clip" : "Render clip"}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onDone}>
          Close
        </button>
        {result && (
          <span role="status" className="text-sm text-ivory-2">
            {result.state === "ready" ? "Clip ready. See the Session tab." : "Requested. It appears in the Session tab when ready."}
          </span>
        )}
      </div>
      {error && (
        <p className="text-sm text-coral">
          {error.message}
          {error.requirement ? `. ${error.requirement}.` : ""}
        </p>
      )}
    </form>
  );
}
