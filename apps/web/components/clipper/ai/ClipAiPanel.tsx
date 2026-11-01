"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  clipTime,
  cutRangesFromEdl,
  edlDurationMs,
  edlOutputTime,
  estimateEditTokens,
  POST_PLATFORM_LABEL,
  tokenCostUsd,
  type AiUsage,
  type BoringKind,
  type BoringPart,
  type BoringResponse,
  type ClipAiStatusResponse,
  type Edl,
  type EditForMeResponse,
  type PlacedAsset,
  type PolishResponse,
  type PostPlatform,
  type PostTone,
  type ProjectView,
  type WritePostResponse,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import "./clip-ai.css";

export interface ClipAiPanelProps {
  /** The project open in the editor (its source, markers and current saved state). */
  project: ProjectView;
  /** The editor's current, possibly unsaved, edit. */
  edl: Edl;
  /** Replace the editor's edit with a proposal the creator accepted (undoable in the editor). */
  onApplyEdl: (next: Edl) => void;
}

type TabId = "edit" | "polish" | "boring" | "post";
const TABS: [TabId, string][] = [
  ["edit", "Edit it for me"],
  ["polish", "Sounds & effects"],
  ["boring", "Cut the boring parts"],
  ["post", "Write my post"],
];

const TONES: [PostTone, string][] = [
  ["hype", "Hype"],
  ["clean", "Clean"],
  ["funny", "Funny"],
];

interface Failure {
  message: string;
  requirement: string | null;
}

function failure(err: unknown, fallback: string): Failure {
  if (err instanceof ApiError) return { message: err.message, requirement: err.requirement };
  return { message: fallback, requirement: null };
}

const sameEdl = (a: Edl, b: Edl) => JSON.stringify(a) === JSON.stringify(b);

function dollars(usd: number): string {
  if (usd < 0.01) return "under $0.01";
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function usageLine(u: AiUsage): string {
  const tokens = `${u.inputTokens.toLocaleString()} tokens in and ${u.outputTokens.toLocaleString()} out`;
  return u.estimatedCostUsd === null ? `Used ${tokens}. Set AI prices on the server to see the cost.` : `Used ${tokens}, about ${dollars(u.estimatedCostUsd)}.`;
}

/** Counts seconds while a request runs, so a long answer doesn't look stuck. */
function useElapsed(running: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setS(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(t);
      setS(0);
    };
  }, [running]);
  return s;
}

/**
 * AI tools inside the clip editor: edit on request, sounds and effects at real moments, cutting
 * the boring parts, and social posts. Nothing changes the edit until the creator applies it.
 */
export function ClipAiPanel({ project, edl, onApplyEdl }: ClipAiPanelProps) {
  const base = useId();
  const [tab, setTab] = useState<TabId | null>(null);
  const [status, setStatus] = useState<ClipAiStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    let live = true;
    api<ClipAiStatusResponse>("/api/clip-ai/status")
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setTab((cur) => cur ?? (s.textModel.available ? "edit" : "polish"));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setStatusError(failure(err, "Couldn't reach the AI tools").message);
        setTab((cur) => cur ?? "polish");
      });
    return () => {
      live = false;
    };
  }, []);

  const current = tab ?? "edit";
  const ai = status?.textModel ?? null;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex(([id]) => id === current);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]![0];
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <section className="ca-panel" aria-labelledby={`${base}-title`}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 id={`${base}-title`} className="font-display text-xl font-bold">
          AI assistant
        </h2>
        {ai && (
          <span className={ai.available ? "chip chip-vision" : "chip chip-muted"} title={ai.available ? `${ai.provider ?? ""} ${ai.model ?? ""}`.trim() : (ai.reason ?? undefined)}>
            {ai.available ? "AI writing on" : "AI writing off"}
          </span>
        )}
      </header>
      <div className="ca-tabs" role="tablist" aria-label="AI tools">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${id}`}
            aria-selected={current === id}
            aria-controls={`${base}-panel-${id}`}
            tabIndex={current === id ? 0 : -1}
            className="ca-tab"
            onClick={() => setTab(id)}
            onKeyDown={onTabKey}
          >
            {label}
          </button>
        ))}
      </div>
      {statusError && (
        <p role="alert" className="mx-4 mt-3 border-l-2 border-coral pl-3 text-sm">
          {statusError}
        </p>
      )}
      {TABS.map(([id]) => (
        <div key={id} role="tabpanel" id={`${base}-panel-${id}`} aria-labelledby={`${base}-tab-${id}`} hidden={current !== id} className="p-4">
          {id === "edit" && <EditForMe edl={edl} status={status} onApplyEdl={onApplyEdl} />}
          {id === "polish" && <Polish edl={edl} status={status} onApplyEdl={onApplyEdl} />}
          {id === "boring" && <Boring edl={edl} onApplyEdl={onApplyEdl} />}
          {id === "post" && <WritePost edl={edl} status={status} projectTitle={project.title} />}
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Shared pieces                                                                              */
/* ------------------------------------------------------------------------------------------ */

function Problem({ f }: { f: Failure | null }) {
  if (!f) return null;
  return (
    <div role="alert" className="mt-3 border-l-2 border-coral pl-3 text-sm">
      <p>{f.message}</p>
      {f.requirement && <p className="mt-1 text-ivory-2">{f.requirement}</p>}
    </div>
  );
}

function NeedsAi({ what, reason }: { what: string; reason: string | null }) {
  return (
    <div className="border-l-2 border-apricot pl-3 text-sm">
      <p>{what} needs an AI model on this server.</p>
      <p className="mt-1 text-ivory-2">{reason ?? "No AI key is set on this server. On the server, run: slot1 ai"}</p>
      <p className="mt-2 text-ivory-3">Sounds & effects and Cut the boring parts work without one.</p>
    </div>
  );
}

function ToneField({ value, onChange, label }: { value: PostTone; onChange: (t: PostTone) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex border hairline">
      {TONES.map(([t, name]) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          onClick={() => onChange(t)}
          className={`h-9 px-3 font-display text-[0.95rem] font-semibold ${value === t ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function Changes({ items, title = "What changes" }: { items: string[]; title?: string }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <h4 className="mb-1 font-display text-[1.02rem] font-semibold">{title}</h4>
      <ul className="ca-changes text-ivory-2">
        {items.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

const AUDIO_FILE = /\.(ogg|oga|opus|mp3|wav|m4a|aac|flac)(\?|$)/i;
const VIDEO_FILE = /\.(webm|mp4|mov)(\?|$)/i;
let playing: HTMLAudioElement | null = null;

function AssetPreview({ a }: { a: PlacedAsset }) {
  const [on, setOn] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  const url = a.previewUrl;
  const isAudio = url ? AUDIO_FILE.test(url) || a.kind === "sfx" || a.kind === "music" || a.kind === "ambience" : false;
  const toggle = () => {
    if (!url) return;
    if (!audio.current) {
      audio.current = new Audio(url);
      audio.current.addEventListener("ended", () => setOn(false));
      audio.current.addEventListener("pause", () => setOn(false));
      audio.current.addEventListener("play", () => setOn(true));
    }
    const el = audio.current;
    if (!el.paused) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    el.currentTime = 0;
    void el.play().catch(() => setOn(false));
  };
  return (
    <li className="ca-asset">
      {url && isAudio ? (
        <button type="button" className="btn btn-ghost btn-sm w-[4.6rem] flex-none" onClick={toggle} aria-label={`${on ? "Stop" : "Play"} ${a.name}`}>
          {on ? "Stop" : "Play"}
        </button>
      ) : url && VIDEO_FILE.test(url) ? (
        <video src={url} muted loop playsInline preload="metadata" className="h-10 w-10 flex-none object-contain" onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : (
        <span className="w-[4.6rem] flex-none text-[0.8rem] text-ivory-3">No preview</span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-semibold">{a.name}</span>
        <span className="block text-[0.82rem] text-ivory-3">
          {a.atMs !== null ? <span className="tnum">at {clipTime(a.atMs)}</span> : null}
          {a.atMs !== null && a.reason ? ", " : null}
          {a.reason}
        </span>
      </span>
    </li>
  );
}

function Placed({ items }: { items: PlacedAsset[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <h4 className="mb-1 font-display text-[1.02rem] font-semibold">From the Studio library</h4>
      <ul className="grid gap-2">
        {items.slice(0, 24).map((a, i) => (
          <AssetPreview key={`${a.assetId}-${a.atMs}-${i}`} a={a} />
        ))}
      </ul>
      {items.length > 24 && <p className="mt-1 text-sm text-ivory-3">and {items.length - 24} more</p>}
    </div>
  );
}

/** Apply / discard for a proposed edit, with a one-step undo after applying. */
function ProposalActions({
  proposal,
  basedOn,
  edl,
  onApplyEdl,
  onDone,
  applyLabel = "Apply this edit",
}: {
  proposal: Edl;
  basedOn: Edl;
  edl: Edl;
  onApplyEdl: (next: Edl) => void;
  onDone: () => void;
  applyLabel?: string;
}) {
  const stale = !sameEdl(basedOn, edl);
  return (
    <div className="mt-4">
      {stale && <p className="mb-2 text-sm text-apricot">You changed the edit after asking. Applying this replaces those changes.</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            onApplyEdl(proposal);
            onDone();
          }}
        >
          {applyLabel}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Discard
        </button>
      </div>
    </div>
  );
}

/** After applying: say so, and offer to put the previous edit back. */
function Applied({ previous, onApplyEdl, onClear, text }: { previous: Edl; onApplyEdl: (next: Edl) => void; onClear: () => void; text: string }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm" role="status">
      <span>{text}</span>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => {
          onApplyEdl(previous);
          onClear();
        }}
      >
        Undo
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Edit it for me                                                                             */
/* ------------------------------------------------------------------------------------------ */

const EXAMPLES = ["Make it faster and punchier", "Slow motion on the best moment", "Add sounds and a WASTED screen at the crash", "Cut it down to 20 seconds", "Make it widescreen with a fade out"];

function EditForMe({ edl, status, onApplyEdl }: { edl: Edl; status: ClipAiStatusResponse | null; onApplyEdl: (next: Edl) => void }) {
  const id = useId();
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [result, setResult] = useState<{ r: EditForMeResponse; basedOn: Edl } | null>(null);
  const [applied, setApplied] = useState<Edl | null>(null);
  const elapsed = useElapsed(busy);
  const ai = status?.textModel;
  const prices = ai?.pricePerMTok ?? null;
  const libraryItems = status?.libraryAssets ?? 0;
  const estimate = useMemo(() => (prices ? tokenCostUsd(estimateEditTokens(edl, request, libraryItems), prices) : null), [prices, edl, request, libraryItems]);

  if (status && !ai?.available) return <NeedsAi what="Editing on request" reason={ai?.reason ?? null} />;

  const ask = async () => {
    const text = request.trim();
    if (text.length < 3) {
      setError({ message: "Say what should change, for example “make it faster”", requirement: null });
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setApplied(null);
    const basedOn = edl;
    try {
      const r = await api<EditForMeResponse>("/api/clip-ai/edit", { method: "POST", json: { request: text, edl: basedOn } });
      setResult({ r, basedOn });
    } catch (err) {
      setError(failure(err, "The AI couldn't propose an edit. Try again"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label htmlFor={`${id}-req`} className="label">
        What should change?
      </label>
      <textarea
        id={`${id}-req`}
        className="field min-h-[5.5rem] resize-y"
        maxLength={500}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) void ask();
        }}
        placeholder="Make it faster, put a slow-mo on the crash and end on the WASTED screen"
      />
      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="chip hover:border-ivory-2" onClick={() => setRequest(ex)}>
            {ex}
          </button>
        ))}
      </div>
      <p className="mt-3 text-sm text-ivory-3">
        The AI gets this edit, the moments SLOT1 detected and the Studio library, and proposes a new version. SLOT1 checks it and shows every change; nothing
        changes until you apply it.
        {estimate !== null ? ` Rough cost: about ${dollars(estimate)} a request.` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !status} onClick={() => void ask()}>
          {busy ? "Working on it…" : "Propose an edit"}
        </button>
        {busy && (
          <span className="tnum text-sm text-ivory-3" aria-live="polite">
            {elapsed > 3 ? `${elapsed} s, this can take up to a minute` : ""}
          </span>
        )}
      </div>
      <Problem f={error} />

      {applied && <Applied previous={applied} onApplyEdl={onApplyEdl} onClear={() => setApplied(null)} text="Applied to your edit." />}

      {result && (
        <div className="mt-5 border-t hairline pt-4" aria-live="polite">
          <div className="border-l-2 border-gold pl-3">
            <span className="ca-ai-label">AI-written</span>
            <p className="mt-1 text-ivory">{result.r.summary || "The AI didn't add a summary."}</p>
          </div>
          {result.r.unchanged ? (
            <p className="mt-3 text-sm text-ivory-2">The proposal is the same as your edit, so there&apos;s nothing to apply. Try saying it another way.</p>
          ) : (
            <Changes items={result.r.changes} title="What changes (checked by SLOT1)" />
          )}
          {result.r.stripped.length > 0 && (
            <p className="mt-3 text-sm text-apricot">SLOT1 removed {result.r.stripped.join(", ")} from the proposal because it doesn&apos;t exist.</p>
          )}
          <Placed items={result.r.placed} />
          <p className="mt-3 text-[0.82rem] text-ivory-3">{usageLine(result.r.usage)}</p>
          {!result.r.unchanged && (
            <ProposalActions
              proposal={result.r.edl}
              basedOn={result.basedOn}
              edl={edl}
              onApplyEdl={(next) => {
                setApplied(edl);
                onApplyEdl(next);
              }}
              onDone={() => setResult(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Sounds & effects                                                                           */
/* ------------------------------------------------------------------------------------------ */

function Polish({ edl, status, onApplyEdl }: { edl: Edl; status: ClipAiStatusResponse | null; onApplyEdl: (next: Edl) => void }) {
  const id = useId();
  const [sounds, setSounds] = useState(true);
  const [music, setMusic] = useState(false);
  const [effects, setEffects] = useState(true);
  const [refine, setRefine] = useState(false);
  const [tone, setTone] = useState<PostTone>("hype");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [result, setResult] = useState<{ r: PolishResponse; basedOn: Edl } | null>(null);
  const [applied, setApplied] = useState<Edl | null>(null);
  const aiOn = status?.textModel.available ?? false;

  const run = async () => {
    if (!sounds && !music && !effects) {
      setError({ message: "Pick at least one thing to add", requirement: null });
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setApplied(null);
    const basedOn = edl;
    try {
      const r = await api<PolishResponse>("/api/clip-ai/polish", { method: "POST", json: { edl: basedOn, sounds, music, effects, refine: refine && aiOn, tone } });
      setResult({ r, basedOn });
    } catch (err) {
      setError(failure(err, "Couldn't add sounds and effects. Try again"));
    } finally {
      setBusy(false);
    }
  };

  const opts: [string, boolean, (v: boolean) => void, string, boolean][] = [
    ["sounds", sounds, setSounds, "Sound effects at the big moments, and a whoosh on each cut", false],
    ["effects", effects, setEffects, "GTA effects: MISSION PASSED or WASTED at result screens, punch-ins on crashes, flashes between parts", false],
    ["music", music, setMusic, "A music bed under the clip, ducked under your voice", false],
    ["refine", refine && aiOn, setRefine, aiOn ? "Let the AI choose and time the sounds" : "Let the AI choose and time the sounds (needs an AI key)", !aiOn],
  ];

  return (
    <div>
      <p className="text-sm text-ivory-2">
        Places sounds from the Studio library and GTA effects at the moments SLOT1 detected in this edit. Works without an AI key.
        {status ? ` The library has ${status.libraryAssets} item${status.libraryAssets === 1 ? "" : "s"}.` : ""}
      </p>
      <fieldset className="mt-2">
        <legend className="sr-only">What to add</legend>
        {opts.map(([key, value, set, label, disabled]) => (
          <label key={key} htmlFor={`${id}-${key}`} className="ca-toggle w-full" data-disabled={disabled || undefined}>
            <input id={`${id}-${key}`} type="checkbox" checked={value} disabled={disabled} onChange={(e) => set(e.target.checked)} />
            <span className={disabled ? "text-ivory-3" : undefined}>{label}</span>
          </label>
        ))}
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-sm text-ivory-2">Mood</span>
        <ToneField value={tone} onChange={setTone} label="Mood of the music and sounds" />
      </div>
      <div className="mt-4">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run()}>
          {busy ? "Placing…" : "Preview the changes"}
        </button>
      </div>
      <Problem f={error} />
      {applied && <Applied previous={applied} onApplyEdl={onApplyEdl} onClear={() => setApplied(null)} text="Added to your edit." />}
      {result && (
        <div className="mt-5 border-t hairline pt-4" aria-live="polite">
          {result.r.usedAi && <span className="ca-ai-label">Sounds chosen by AI</span>}
          {result.r.note && <p className="mt-2 text-sm text-apricot">{result.r.note}</p>}
          {result.r.changes.length === 0 ? (
            <p className="mt-2 text-sm text-ivory-2">Nothing to add to this edit.</p>
          ) : (
            <Changes items={result.r.changes} />
          )}
          <Placed items={result.r.placed} />
          {result.r.usage && <p className="mt-3 text-[0.82rem] text-ivory-3">{usageLine(result.r.usage)}</p>}
          {result.r.changes.length > 0 && (
            <ProposalActions
              proposal={result.r.edl}
              basedOn={result.basedOn}
              edl={edl}
              applyLabel="Add to my edit"
              onApplyEdl={(next) => {
                setApplied(edl);
                onApplyEdl(next);
              }}
              onDone={() => setResult(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Cut the boring parts                                                                       */
/* ------------------------------------------------------------------------------------------ */

const KIND_LABEL: Record<BoringKind, string> = { black: "Black screen", loading: "Loading screen", silence: "Silence", quiet: "Nothing happens" };

function Boring({ edl, onApplyEdl }: { edl: Edl; onApplyEdl: (next: Edl) => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [result, setResult] = useState<{ r: BoringResponse; basedOn: Edl } | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Edl | null>(null);
  const [measuring, setMeasuring] = useState(false);

  const find = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setBusy(true);
        setError(null);
        setApplied(null);
      }
      const basedOn = edl;
      try {
        const r = await api<BoringResponse>("/api/clip-ai/boring", { method: "POST", json: { edl: basedOn } });
        setResult({ r, basedOn });
        if (!quiet) setSkip(new Set());
      } catch (err) {
        if (!quiet) setError(failure(err, "Couldn't check this edit. Try again"));
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [edl],
  );

  // While the audio is being measured, check again every few seconds so silence shows up.
  const waiting = result?.r.audio.some((a) => a.status.state === "queued" || a.status.state === "running") ?? false;
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 45) clearInterval(t); // about three minutes; "Check again" picks it up later
      else void find(true);
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, find]);

  // SLOT1 starts the audio check itself; a failed one can be started again.
  const failed = result?.r.audio.filter((a) => a.status.state === "failed" || a.status.state === "not_started") ?? [];
  const measure = async () => {
    setMeasuring(true);
    try {
      for (const a of failed) await api(`/api/clip-ai/sessions/${a.sessionId}/audio`, { method: "POST" });
      await find(true);
    } catch (err) {
      setError(failure(err, "Couldn't start the audio check"));
    } finally {
      setMeasuring(false);
    }
  };

  const basedOn = result?.basedOn ?? edl;
  const parts = useMemo(() => result?.r.parts ?? [], [result]);
  const chosen = useMemo(() => parts.filter((p) => !skip.has(p.id)), [parts, skip]);
  const cut = useMemo(() => (chosen.length ? cutRangesFromEdl(basedOn, chosen) : null), [basedOn, chosen]);
  const before = edlDurationMs(basedOn);
  const stale = result ? !sameEdl(result.basedOn, edl) : false;

  const outRange = (p: BoringPart): [number, number] | null => {
    const i = basedOn.segments.findIndex((s) => s.id === p.segmentId);
    if (i < 0) return null;
    return [edlOutputTime(basedOn, i, p.startMs), edlOutputTime(basedOn, i, p.endMs)];
  };

  return (
    <div>
      <p className="text-sm text-ivory-2">
        Finds black and loading screens, silence and long stretches where nothing happens inside your edit. You choose what goes. Works without an AI key.
      </p>
      <div className="mt-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void find()}>
          {busy ? "Checking…" : result ? "Check again" : "Find the boring parts"}
        </button>
      </div>
      <Problem f={error} />
      {applied && <Applied previous={applied} onApplyEdl={onApplyEdl} onClear={() => setApplied(null)} text="Cut from your edit." />}

      {result && (
        <div className="mt-5 border-t hairline pt-4" aria-live="polite">
          {result.r.note && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-ivory-2">
              {waiting && <span className="live-dot live-dot-pulse text-signal" aria-hidden />}
              <span>{result.r.note}.</span>
              {failed.length > 0 && (
                <button type="button" className="btn btn-quiet btn-sm" disabled={measuring} onClick={() => void measure()}>
                  {measuring ? "Starting…" : "Check the audio again"}
                </button>
              )}
            </p>
          )}
          {parts.length === 0 ? (
            <p className="mt-2 text-sm text-ivory-2">Nothing boring found in this edit.</p>
          ) : (
            <>
              <h4 className="mt-3 mb-1 font-display text-[1.02rem] font-semibold">
                {parts.length} part{parts.length === 1 ? "" : "s"} to cut
              </h4>
              <ul className="grid gap-1">
                {parts.map((p) => {
                  const r = outRange(p);
                  return (
                    <li key={p.id}>
                      <label htmlFor={`${id}-${p.id}`} className="ca-toggle w-full items-start py-1">
                        <input
                          id={`${id}-${p.id}`}
                          type="checkbox"
                          className="mt-1"
                          checked={!skip.has(p.id)}
                          onChange={(e) =>
                            setSkip((cur) => {
                              const next = new Set(cur);
                              if (e.target.checked) next.delete(p.id);
                              else next.add(p.id);
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0">
                          <span className="block">
                            <span className="font-semibold">{KIND_LABEL[p.kind]}</span>
                            {r && (
                              <span className="tnum text-ivory-2">
                                {" "}
                                {clipTime(r[0])}–{clipTime(r[1])}
                              </span>
                            )}
                          </span>
                          <span className="block text-[0.85rem] text-ivory-3">{p.label}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {cut?.error && <p className="mt-2 text-sm text-apricot">{cut.error}</p>}
              {cut?.edl && (
                <p className="tnum mt-2 text-sm text-ivory-2">
                  Removes {clipTime(cut.removedMs)}: {clipTime(before)} becomes {clipTime(edlDurationMs(cut.edl))}. Texts, sounds and effects move with the cut.
                </p>
              )}
              {stale && <p className="mt-2 text-sm text-apricot">You changed the edit after checking. Check again before cutting.</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!cut?.edl || stale}
                  onClick={() => {
                    if (!cut?.edl) return;
                    setApplied(edl);
                    onApplyEdl(cut.edl);
                    setResult(null);
                  }}
                >
                  {chosen.length ? `Cut ${chosen.length} part${chosen.length === 1 ? "" : "s"}` : "Pick parts to cut"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Write my post                                                                              */
/* ------------------------------------------------------------------------------------------ */

const PLATFORMS: PostPlatform[] = ["tiktok", "youtube", "instagram", "x"];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => setDone(false));
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function WritePost({ edl, status, projectTitle }: { edl: Edl; status: ClipAiStatusResponse | null; projectTitle: string }) {
  const id = useId();
  const [platforms, setPlatforms] = useState<Set<PostPlatform>>(new Set(["tiktok", "youtube"]));
  const [tone, setTone] = useState<PostTone>("hype");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [result, setResult] = useState<WritePostResponse | null>(null);
  const elapsed = useElapsed(busy);
  const ai = status?.textModel;

  if (status && !ai?.available) return <NeedsAi what="Writing posts" reason={ai?.reason ?? null} />;

  const run = async () => {
    if (!platforms.size) {
      setError({ message: "Pick at least one platform", requirement: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<WritePostResponse>("/api/clip-ai/post", { method: "POST", json: { edl, platforms: PLATFORMS.filter((p) => platforms.has(p)), tone } });
      setResult(r);
    } catch (err) {
      setError(failure(err, "The AI couldn't write the posts. Try again"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-sm text-ivory-2">
        Titles, captions and hashtags for “{projectTitle}”, written from what SLOT1 detected and what was said in this edit.
      </p>
      <fieldset className="mt-2 flex flex-wrap gap-x-4">
        <legend className="sr-only">Platforms</legend>
        {PLATFORMS.map((p) => (
          <label key={p} htmlFor={`${id}-${p}`} className="ca-toggle">
            <input
              id={`${id}-${p}`}
              type="checkbox"
              checked={platforms.has(p)}
              onChange={(e) =>
                setPlatforms((cur) => {
                  const next = new Set(cur);
                  if (e.target.checked) next.add(p);
                  else next.delete(p);
                  return next;
                })
              }
            />
            {POST_PLATFORM_LABEL[p]}
          </label>
        ))}
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-sm text-ivory-2">Tone</span>
        <ToneField value={tone} onChange={setTone} label="Tone of the posts" />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !status} onClick={() => void run()}>
          {busy ? "Writing…" : "Write the posts"}
        </button>
        {busy && elapsed > 3 && <span className="tnum text-sm text-ivory-3">{elapsed} s</span>}
      </div>
      <Problem f={error} />
      {result && (
        <div className="mt-5 border-t hairline pt-4" aria-live="polite">
          <p className="text-sm text-ivory-2">
            <span className="ca-ai-label mr-2">AI-written</span>
            Check it before you post. Based on {result.basedOn.moments} detected moment{result.basedOn.moments === 1 ? "" : "s"} and {result.basedOn.transcriptLines}{" "}
            transcript line{result.basedOn.transcriptLines === 1 ? "" : "s"}.
          </p>
          <div className="mt-3 grid gap-4">
            {result.posts.map((p) => {
              const tags = p.hashtags.join(" ");
              const body = [p.caption, tags].filter(Boolean).join("\n\n");
              return (
                <article key={p.platform} className="border-l-2 border-line-strong pl-3" aria-label={POST_PLATFORM_LABEL[p.platform]}>
                  <h4 className="font-display text-[1.05rem] font-bold">{POST_PLATFORM_LABEL[p.platform]}</h4>
                  {p.title && (
                    <div className="mt-1 flex items-start justify-between gap-2">
                      <p className="min-w-0 font-semibold">{p.title}</p>
                      <CopyButton text={p.title} label={`Copy the ${POST_PLATFORM_LABEL[p.platform]} title`} />
                    </div>
                  )}
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <p className="min-w-0 whitespace-pre-line text-ivory-2">
                      {p.caption}
                      {tags && <span className="mt-1 block text-signal">{tags}</span>}
                    </p>
                    <CopyButton text={body} label={`Copy the ${POST_PLATFORM_LABEL[p.platform]} caption and hashtags`} />
                  </div>
                  <p className="tnum mt-1 text-[0.78rem] text-ivory-3">{body.length} characters</p>
                </article>
              );
            })}
          </div>
          <p className="mt-3 text-[0.82rem] text-ivory-3">{usageLine(result.usage)}</p>
        </div>
      )}
    </div>
  );
}

