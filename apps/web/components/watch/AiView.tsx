"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatAge, formatMediaTime, OBSERVATION_TYPE_LABEL, type AiViewResponse, type AiViewSnapshot, type ObservationType } from "@slot1/contracts";
import { api } from "@/lib/api";

/* ------------------------------------------------------------------------------------------ */
/* One poller per session, shared by every component that shows the AI view.                   */
/* ------------------------------------------------------------------------------------------ */

interface FeedState {
  response: AiViewResponse | null;
  /** The snapshot whose frame image has loaded (what's on screen). */
  shown: AiViewSnapshot | null;
  error: string | null;
}

const EMPTY: FeedState = { response: null, shown: null, error: null };

class Feed {
  state: FeedState = EMPTY;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;

  constructor(private readonly sessionId: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private set(patch: Partial<FeedState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private start() {
    this.alive = true;
    void this.tick();
  }

  private stop() {
    this.alive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (!this.alive) return;
    let wait = 2000;
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      try {
        const r = await api<AiViewResponse>(`/api/sessions/${this.sessionId}/ai-view`);
        wait = r.refreshMs;
        this.set({ response: r, error: null });
        const snap = r.snapshot;
        if (snap && snap.id !== this.state.shown?.id) {
          // Swap only once the new frame has loaded, so boxes and image always match.
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = snap.frame.url;
          });
          if (this.alive) this.set({ shown: snap });
        }
        if (!snap) this.set({ shown: null });
      } catch {
        wait = 5000;
        this.set({ error: "Couldn't reach SLOT1. Retrying." });
      }
    }
    if (this.alive) this.timer = setTimeout(() => void this.tick(), wait);
  }
}

const feeds = new Map<string, Feed>();
function feedFor(sessionId: string): Feed {
  let f = feeds.get(sessionId);
  if (!f) feeds.set(sessionId, (f = new Feed(sessionId)));
  return f;
}

const noop = () => () => undefined;

export function useAiView(sessionId: string | null, enabled = true): FeedState {
  const feed = sessionId && enabled ? feedFor(sessionId) : null;
  return useSyncExternalStore(
    feed ? feed.subscribe : noop,
    () => (feed ? feed.state : EMPTY),
    () => EMPTY,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The frame with what was read where                                                          */
/* ------------------------------------------------------------------------------------------ */

const pctBox = (b: readonly [number, number, number, number]) => ({ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%` });

function typeLabel(t: string): string {
  return OBSERVATION_TYPE_LABEL[t as ObservationType] ?? t.replace(/_/g, " ");
}

/**
 * The analyzed frame. With `annotate`, the OCR regions are outlined with numbered keys (the list
 * beside it uses the same numbers) and every line OCR read is boxed in gold.
 */
export function AnalyzedFrame({ snapshot, annotate = true, className = "" }: { snapshot: AiViewSnapshot; annotate?: boolean; className?: string }) {
  const read = annotate ? snapshot.ocr.regions.flatMap((r) => r.readings) : [];
  return (
    <figure className={`relative m-0 overflow-hidden bg-black ${className}`} style={{ aspectRatio: `${snapshot.frame.width} / ${snapshot.frame.height}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={snapshot.frame.url} alt="The video frame SLOT1 analyzed" className="absolute inset-0 h-full w-full object-contain" />
      {annotate &&
        snapshot.ocr.regions.map((r, i) => (
          <div
            key={r.id}
            className={`absolute border ${r.readings.length ? "border-signal" : "border-dashed border-ivory/45"}`}
            style={pctBox(r.box)}
            aria-hidden
          >
            <span
              className={`absolute left-0 top-0 grid h-4 min-w-4 place-items-center px-0.5 font-display text-[0.7rem] font-bold leading-none ${r.readings.length ? "bg-signal text-graphite" : "bg-graphite-900/85 text-ivory-2"}`}
            >
              {i + 1}
            </span>
          </div>
        ))}
      {read
        .filter((x) => x.box)
        .map((x, i) => (
          <div key={`${x.text}-${i}`} className="absolute outline outline-2 outline-gold" style={pctBox(x.box!)} aria-hidden />
        ))}
    </figure>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t hairline pt-3">
      <h3 className="font-display text-[1rem] font-semibold tracking-[0.02em] text-ivory">{title}</h3>
      <div className="mt-1.5 space-y-1.5 text-[0.86rem] text-ivory-2">{children}</div>
    </section>
  );
}

/**
 * "What the AI sees": the last frame SLOT1 analyzed, the regions OCR looked at and what it read
 * there, what AI vision and the GTA model made of it, and what landed in the log.
 */
export function AiViewPanel({ sessionId, onSelect }: { sessionId: string; onSelect?: (observationId: string) => void }) {
  const { response, shown, error } = useAiView(sessionId);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!response && !error) return <div className="border hairline bg-graphite-900 p-4 text-sm text-ivory-2">Loading what the AI sees</div>;
  if (!shown) {
    return (
      <div className="border hairline bg-graphite-900 p-4 text-sm text-ivory-2" role="status">
        {error ?? response?.reason ?? "Waiting for the first analyzed frame"}
      </div>
    );
  }
  const s = shown;
  const age = now > 0 ? Math.max(0, now - Date.parse(s.frame.analyzedAt)) : null;
  return (
    <div className="border hairline bg-graphite-900" data-testid="ai-view">
      <div className="grid gap-4 p-3 sm:p-4 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
        <div className="min-w-0">
          <AnalyzedFrame snapshot={s} />
          <p className="mt-2 text-[0.78rem] text-ivory-3" suppressHydrationWarning>
            {age === null ? "Analyzed frame" : `Analyzed ${formatAge(age)} ago`}
            {s.frame.mediaMs !== null ? `, at ${formatMediaTime(s.frame.mediaMs)} into the stream` : ""}. Sampled every {formatAge(s.sampling.intervalMs)}; this frame took{" "}
            {(s.latencyMs / 1000).toFixed(1)} s to analyze. Shown at {s.frame.width}×{s.frame.height}; analyzed at {s.frame.analyzedWidth}×{s.frame.analyzedHeight}.
          </p>
          {error && <p className="mt-1 text-[0.78rem] text-coral">{error}</p>}
        </div>
        <div className="min-w-0 space-y-3">
          <Section title="Read on screen (OCR)">
            {s.ocr.status !== "read" ? (
              <p>{s.ocr.note}</p>
            ) : (
              <ul className="space-y-1.5">
                {s.ocr.regions.map((r, i) => (
                  <li key={r.id}>
                    <span
                      className={`mr-1.5 inline-grid h-4 min-w-4 place-items-center px-0.5 align-[1px] font-display text-[0.7rem] font-bold leading-none ${r.readings.length ? "bg-signal text-graphite" : "border border-ivory/40 text-ivory-2"}`}
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                    <span className="text-ivory-3">{r.label}: </span>
                    {r.readings.length === 0 ? (
                      <span>nothing legible</span>
                    ) : (
                      r.readings.map((x, i) => (
                        <span key={i} className="block text-ivory">
                          “{x.text}” <span className="text-ivory-3">{typeLabel(x.type).toLowerCase()}, OCR confidence {Math.round(x.confidence)}</span>
                        </span>
                      ))
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[0.76rem] text-ivory-3">
              {s.ocr.profile.name}
              {s.ocr.profile.validation === "unvalidated_draft" ? ": region layout not yet validated on real footage" : ""}.
            </p>
          </Section>
          <Section title="AI vision">
            {s.vision.status === "analyzed" ? (
              <>
                {s.vision.summary && <p className="text-ivory">“{s.vision.summary}”</p>}
                {s.vision.findings.length ? (
                  <ul className="list-disc pl-4">
                    {s.vision.findings.map((f, i) => (
                      <li key={i}>
                        {f.description}
                        {f.confidence !== null ? <span className="text-ivory-3"> (model reports {Math.round(f.confidence * 100)}%)</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No findings for this batch.</p>
                )}
                <p className="text-[0.76rem] text-ivory-3">{s.vision.model ? `${s.vision.provider} ${s.vision.model}` : s.vision.provider}</p>
              </>
            ) : (
              <p>{s.vision.note}</p>
            )}
          </Section>
          <Section title="GTA model">
            {s.gtaModel.status === "predicted" ? (
              <ul>
                {s.gtaModel.top.map((t) => (
                  <li key={t.label}>
                    {t.label} <span className="text-ivory-3">{Math.round(t.p * 100)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{s.gtaModel.note}</p>
            )}
          </Section>
          <Section title="Added to the log from this frame">
            {s.produced.length === 0 ? (
              <p>Nothing new. Repeats of text already in the log extend that entry instead of adding one.</p>
            ) : (
              <ul className="space-y-1">
                {s.produced.map((p) => (
                  <li key={p.id}>
                    {onSelect ? (
                      <button type="button" className="text-left text-ivory underline-offset-4 hover:underline" onClick={() => onSelect(p.id)}>
                        {p.description}
                      </button>
                    ) : (
                      <span className="text-ivory">{p.description}</span>
                    )}{" "}
                    <span className="text-ivory-3">{p.action === "new" ? "new" : "more evidence"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * For channels without Twitch when SLOT1's WebRTC video isn't available here: the frames the
 * AI analyzed, refreshed as they come in. Honest about being a frame feed, not video.
 */
export function AiFramePlayer({ sessionId, reason }: { sessionId: string; reason?: string }) {
  const { response, shown } = useAiView(sessionId);
  return (
    <div className="min-w-0">
      {shown ? (
        <AnalyzedFrame snapshot={shown} annotate={false} className="w-full" />
      ) : (
        <div className="grid aspect-video w-full place-items-center bg-graphite-800 p-6 text-center text-sm text-ivory-2">
          {response?.reason ?? "Waiting for the first analyzed frame"}
        </div>
      )}
      <p className="mt-2 text-[0.8rem] text-ivory-3">
        Frames the AI analyzed, one every {shown ? formatAge(shown.sampling.intervalMs) : "few seconds"}. {reason ?? "Smooth live video needs SLOT1's WebRTC gateway (MediaMTX)."}
      </p>
    </div>
  );
}
