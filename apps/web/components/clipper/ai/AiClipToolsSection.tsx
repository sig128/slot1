"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatMediaTime,
  type ClipAiSession,
  type ClipAiSessionsResponse,
  type CreateMomentClipsResponse,
  type EdlAspect,
  type MomentCandidate,
  type MomentsResponse,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import type { StudioCtx } from "@/components/studio/StudioApp";
import "./clip-ai.css";

const ASPECTS: [EdlAspect, string][] = [
  ["9:16", "Vertical"],
  ["16:9", "Widescreen"],
  ["1:1", "Square"],
];

const STAR = "M12 2.4l2.9 6.4 7 .7-5.3 4.6 1.6 6.9L12 17.4 5.8 21l1.6-6.9L2.1 9.5l7-.7z";

export function MomentStars({ stars, label }: { stars: number; label: string }) {
  return (
    <span className="ca-stars" role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" className="ca-star" data-on={i < stars} aria-hidden>
          <path d={STAR} />
        </svg>
      ))}
    </span>
  );
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function length(ms: number): string {
  return formatMediaTime(ms).replace(/^0(\d:)/, "$1");
}

/** Studio → AI clip tools: the best moments of a session, ranked from what SLOT1 detected. */
export function AiClipToolsSection({ ctx }: { ctx: StudioCtx }) {
  const router = useRouter();
  const [data, setData] = useState<ClipAiSessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [moments, setMoments] = useState<MomentsResponse | null>(null);
  const [loadingMoments, setLoadingMoments] = useState(false);
  const [aspect, setAspect] = useState<EdlAspect>("9:16");
  const [reel, setReel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const requested = useRef(new Set<string>());

  const loadSessions = useCallback(async () => {
    try {
      const d = await api<ClipAiSessionsResponse>("/api/clip-ai/sessions");
      setData(d);
      setError(null);
      setSelected((cur) => cur ?? d.sessions.find((s) => s.media.available)?.id ?? d.sessions[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your sessions");
    }
  }, []);

  useEffect(() => {
    // Initial load of this tab's data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSessions();
  }, [loadSessions]);

  const loadMoments = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoadingMoments(true);
    try {
      const m = await api<MomentsResponse>(`/api/clip-ai/sessions/${id}/moments`);
      setMoments(m);
      setError(null);
      // Start the one-time audio analysis the first time a session with stored video is opened.
      if (m.session.audio.state === "not_started" && m.session.media.available && !requested.current.has(id)) {
        requested.current.add(id);
        await api(`/api/clip-ai/sessions/${id}/audio`, { method: "POST" });
        const again = await api<MomentsResponse>(`/api/clip-ai/sessions/${id}/moments`);
        setMoments(again);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rank this session");
    } finally {
      setLoadingMoments(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    // A new session: clear the old ranking and the reel picks, then rank it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMoments(null);
    setReel(new Set());
    void loadMoments(selected);
  }, [selected, loadMoments]);

  // While the audio is being measured, refresh the ranking so loud moments join in.
  const listening = moments?.session.audio.state === "queued" || moments?.session.audio.state === "running";
  useEffect(() => {
    if (!listening || !selected) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 60) clearInterval(t); // about three minutes; reopening the session refreshes it
      else void loadMoments(selected, true);
    }, 3000);
    return () => clearInterval(t);
  }, [listening, selected, loadMoments]);

  const session = useMemo(() => data?.sessions.find((s) => s.id === selected) ?? null, [data, selected]);
  const canClip = moments?.session.media.available ?? session?.media.available ?? false;

  const create = async (mode: "single" | "reel", picks: MomentCandidate[], key: string) => {
    if (!selected) return;
    setBusy(key);
    setError(null);
    try {
      const r = await api<CreateMomentClipsResponse>(`/api/clip-ai/sessions/${selected}/clips`, {
        method: "POST",
        json: { mode, aspect, moments: picks.map((p) => ({ startMs: p.startMs, endMs: p.endMs, title: p.title.slice(0, 60), peakMs: p.peakMs, tone: p.tone, big: p.big })) },
      });
      const id = r.projectIds[0];
      if (id) router.push(`/studio/edit/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the edit");
    } finally {
      setBusy(null);
    }
  };

  const toggleReel = (id: string) =>
    setReel((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else if (next.size < 10) next.add(id);
      return next;
    });

  const reelPicks = (moments?.candidates ?? []).filter((c) => reel.has(c.id));

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">AI clip tools</h2>
        <p className="mt-2 max-w-[68ch] text-ivory-2">
          SLOT1 ranks the moments in your sessions from what it actually read on screen, heard and measured. Pick one to open it as an edit, or put several
          together into a best-of reel. In the editor, the AI panel cuts the boring parts, adds sounds and effects, writes your posts and edits on request.
        </p>
        {data && (
          <p className="mt-3 flex flex-wrap gap-2 text-sm">
            <span className={data.textModel.available ? "chip chip-vision" : "chip chip-muted"} title={data.textModel.reason ?? undefined}>
              {data.textModel.available ? "AI writing on" : "AI writing off"}
            </span>
            <span className="chip chip-muted">{data.libraryAssets} library items</span>
          </p>
        )}
        {data && !data.textModel.available && (
          <p className="mt-2 max-w-[68ch] text-sm text-ivory-3">
            Ranking, cutting, sounds and effects work without an AI key. Writing posts and editing on request need one: {data.textModel.reason}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 border-l-2 border-coral pl-3 text-sm text-ivory">
          {error}
        </p>
      )}

      {!data && !error && <p className="text-ivory-3">Loading your sessions…</p>}
      {data && data.sessions.length === 0 && (
        <div className="st-block border-t hairline py-6">
          <h3 className="font-display text-xl font-bold">No sessions yet</h3>
          <p className="mt-1 max-w-[60ch] text-ivory-2">Upload a replay under Video sources, or stream to SLOT1 with Recording on. Your sessions show up here to rank.</p>
          <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => void ctx.runAction("add_source")}>
            Add a video source
          </button>
        </div>
      )}

      {data && data.sessions.length > 0 && (
        <>
          <h3 className="mb-2 font-display text-lg font-bold">Pick a session</h3>
          <div className="ca-tapes" role="group" aria-label="Sessions">
            {data.sessions.map((s) => (
              <SessionTape key={s.id} s={s} active={s.id === selected} onPick={() => setSelected(s.id)} />
            ))}
          </div>

          <section className="mt-8" aria-labelledby="ca-best">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b hairline pb-3">
              <div>
                <h3 id="ca-best" className="font-display text-2xl font-bold">
                  Best moments
                </h3>
                {session && <p className="text-sm text-ivory-3">{session.title}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div role="radiogroup" aria-label="Clip shape" className="flex border hairline">
                  {ASPECTS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={aspect === value}
                      onClick={() => setAspect(value)}
                      className={`h-9 px-3 font-display text-[0.95rem] font-semibold ${aspect === value ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-coral btn-sm"
                  disabled={reelPicks.length < 2 || !canClip || busy !== null}
                  onClick={() => void create("reel", reelPicks, "reel")}
                  title={reelPicks.length < 2 ? "Tick at least two moments" : undefined}
                >
                  {busy === "reel" ? "Making the reel…" : `Make a best-of reel${reelPicks.length ? ` (${reelPicks.length})` : ""}`}
                </button>
              </div>
            </div>

            {moments?.note && (
              <p className="mt-3 flex items-center gap-2 text-sm text-ivory-2" aria-live="polite">
                {listening && <span className="live-dot live-dot-pulse text-signal" aria-hidden />}
                {moments.note}
              </p>
            )}
            {moments && !moments.session.media.available && (
              <p className="mt-3 max-w-[68ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">{moments.session.media.reason}. You can still see what SLOT1 ranked.</p>
            )}
            {loadingMoments && !moments && <p className="mt-4 text-ivory-3">Ranking this session…</p>}
            {moments && moments.candidates.length === 0 && (
              <p className="mt-4 max-w-[60ch] text-ivory-2">
                Nothing stood out yet. SLOT1 ranks result screens, mission titles, action, loud moments and fast cuts; this session has {moments.signals.observations}{" "}
                observations to work with.
              </p>
            )}
            {moments && moments.candidates.length > 0 && (
              <ol className="ca-moments mt-2" aria-label="Moments, best first">
                {moments.candidates.map((c, i) => (
                  <MomentRow
                    key={c.id}
                    c={c}
                    rank={i + 1}
                    inReel={reel.has(c.id)}
                    onReel={() => toggleReel(c.id)}
                    canClip={canClip}
                    busy={busy}
                    onClip={() => void create("single", [c], c.id)}
                  />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SessionTape({ s, active, onPick }: { s: ClipAiSession; active: boolean; onPick: () => void }) {
  return (
    <button type="button" className="ca-tape" aria-pressed={active} onClick={onPick}>
      <span className="block truncate font-display text-[1.05rem] font-bold">{s.title}</span>
      <span className="ca-tape-meta mt-1 flex flex-wrap gap-x-3">
        <span>{dateLabel(s.startedAt)}</span>
        {s.durationMs !== null && <span className="tnum">{length(s.durationMs)}</span>}
        <span>{s.kind === "replay" ? "Replay" : s.label === "test" ? "Test stream" : "Stream"}</span>
        {!s.media.available && <span>No stored video</span>}
      </span>
    </button>
  );
}

function MomentRow({
  c,
  rank,
  inReel,
  onReel,
  canClip,
  busy,
  onClip,
}: {
  c: MomentCandidate;
  rank: number;
  inReel: boolean;
  onReel: () => void;
  canClip: boolean;
  busy: string | null;
  onClip: () => void;
}) {
  const reelId = `ca-reel-${c.id}`;
  return (
    <li className="ca-moment" data-first={rank === 1}>
      <span className="ca-rank" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <div className="ca-thumb">
        {c.frameUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.frameUrl} alt={`Frame SLOT1 stored at ${formatMediaTime(c.peakMs)}`} loading="lazy" />
        ) : null}
        <time className="tnum">{formatMediaTime(c.peakMs)}</time>
      </div>
      <div className="ca-moment-body min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {c.big ? (
            <span className="ca-big" data-tone={c.tone}>
              {c.big}
            </span>
          ) : (
            <span className="ca-plain-title">{c.title}</span>
          )}
          <MomentStars stars={c.stars} label={`${c.stars} of 5 stars (score ${c.score})`} />
        </div>
        <p className="mt-1 text-sm text-ivory-3">
          <span className="tnum">
            {formatMediaTime(c.startMs)}–{formatMediaTime(c.endMs)}
          </span>{" "}
          ({length(c.endMs - c.startMs)})
        </p>
        <ul className="ca-reasons" aria-label="Why it ranks here">
          {c.reasons.map((r, i) => (
            <li key={i}>
              <span className="ca-glyph" data-signal={r.signal} aria-hidden />
              <span>{r.label}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary btn-sm" disabled={!canClip || busy !== null} onClick={onClip}>
            {busy === c.id ? "Opening…" : "Clip it"}
          </button>
          <label htmlFor={reelId} className="ca-toggle text-ivory-2">
            <input id={reelId} type="checkbox" checked={inReel} onChange={onReel} disabled={!canClip} />
            Add to reel
          </label>
        </div>
      </div>
    </li>
  );
}
