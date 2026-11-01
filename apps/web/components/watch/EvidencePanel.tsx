"use client";

import { useEffect, useState } from "react";
import {
  confidenceWords,
  EVIDENCE_CLASS_LABEL,
  evidenceClass,
  formatMediaTime,
  OBSERVATION_TYPE_LABEL,
  ObservationType,
  type ObservationDetail,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { clockTimeSeconds } from "@/lib/format";
import { EvidenceGlyph } from "./EvidenceGlyph";

/**
 * FOLLOW THE MOMENT: the actual evidence frame(s), the source timestamp, the observation type,
 * how it was derived, and creator actions. Opens below the player — never on top of it.
 */
export function EvidencePanel({
  observationId,
  mode,
  onClose,
  onPlayFrom,
  onSaveMoment,
  fixture,
}: {
  observationId: string;
  mode: "live" | "replay";
  onClose: () => void;
  onPlayFrom?: (ms: number) => void;
  onSaveMoment?: (title: string, observationId: string) => void;
  fixture?: ObservationDetail;
}) {
  const [detail, setDetail] = useState<ObservationDetail | null>(fixture ?? null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [editing, setEditing] = useState(false);

  // The parent keys this panel by observation, so every selection starts from fresh state.
  useEffect(() => {
    if (fixture) return;
    let alive = true;
    api<ObservationDetail>(`/api/observations/${observationId}`)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Couldn't load the evidence"));
    return () => {
      alive = false;
    };
  }, [observationId, fixture]);

  const o = detail?.observation;
  const cls = o ? evidenceClass(o) : null;
  const frames = detail?.evidence.filter((e) => e.contentType.startsWith("image/")) ?? [];
  const audio = detail?.evidence.filter((e) => e.contentType.startsWith("audio/")) ?? [];
  const current = frames[frame];

  return (
    <section aria-label="Evidence" className="border hairline bg-graphite-800">
      <header className="flex items-center justify-between gap-3 border-b hairline px-4 py-3 sm:px-5">
        <h2 className="font-display text-xl font-bold">Evidence</h2>
        <div className="flex gap-2">
          {mode === "live" ? (
            <button type="button" className="btn btn-coral btn-sm" onClick={onClose}>
              Return to live
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close evidence
            </button>
          )}
        </div>
      </header>
      {error && <p className="px-5 py-6 text-coral">{error}</p>}
      {!detail && !error && <p className="px-5 py-6 text-ivory-3">Loading evidence</p>}
      {o && cls && (
        <div className="grid gap-6 p-4 sm:p-5 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
          <div className="min-w-0">
            {current ? (
              <figure>
                <div className="bg-black">
                  {/* The actual analyzed frame, unfiltered. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={current.url} alt={`Evidence frame at ${formatMediaTime(current.mediaPtsMs)}`} className="mx-auto block max-h-[52vh] w-auto max-w-full" />
                </div>
                <figcaption className="tnum mt-2 flex flex-wrap justify-between gap-2 text-[0.78rem] text-ivory-3">
                  <span>
                    Frame at source time {formatMediaTime(current.mediaPtsMs)}
                    {current.width && current.height ? `, ${current.width}×${current.height} as analyzed` : ""}
                  </span>
                  {frames.length > 1 && (
                    <span>
                      {frame + 1} of {frames.length}
                    </span>
                  )}
                </figcaption>
                {frames.length > 1 && (
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                    {frames.map((f, i) => (
                      <button
                        key={f.assetId}
                        type="button"
                        onClick={() => setFrame(i)}
                        aria-label={`Show frame at ${formatMediaTime(f.mediaPtsMs)}`}
                        aria-pressed={i === frame}
                        className={`shrink-0 border-2 ${i === frame ? "border-ivory" : "border-transparent opacity-70 hover:opacity-100"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f.url} alt="" className="block h-14 w-auto" />
                      </button>
                    ))}
                  </div>
                )}
              </figure>
            ) : audio.length > 0 ? (
              <div className="border hairline p-4">
                <p className="mb-3 text-sm text-ivory-2">Audio evidence</p>
                {audio.map((a) => (
                  <audio key={a.assetId} controls preload="none" src={a.url} className="w-full" />
                ))}
              </div>
            ) : (
              <div className="grid aspect-video place-items-center border border-dashed border-line-strong p-6 text-center text-sm text-ivory-2">
                {o.origin === "twitch" ? "Twitch platform fact. There is no video frame behind it." : "No frame is stored for this observation (it may have expired)."}
              </div>
            )}
          </div>

          <div className="min-w-0 space-y-5">
            <div>
              <p className="flex items-center gap-2 text-[0.8rem] text-ivory-3">
                <EvidenceGlyph cls={cls} />
                {EVIDENCE_CLASS_LABEL[cls]}
                <span aria-hidden className="h-3 w-px bg-line-strong" />
                {OBSERVATION_TYPE_LABEL[o.type]}
              </p>
              <p className="mt-2 font-display text-[1.7rem] font-bold leading-[1.02]">{o.description}</p>
              {o.rawText && (
                <blockquote className="mt-3 border-l-2 border-apricot pl-3 text-[0.95rem] text-ivory">
                  {o.origin === "audio" ? "Heard" : "Read on screen"}: “{o.rawText}”
                </blockquote>
              )}
            </div>
            <p className="text-sm text-ivory-2">{explain(o, detail!.sessionLabel)}</p>
            <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.82rem]">
              <dt className="text-ivory-3">Source time</dt>
              <dd>
                {o.mediaStartMs === null ? "Not on the media timeline" : `${formatMediaTime(o.mediaStartMs)}${o.mediaEndMs && o.mediaEndMs !== o.mediaStartMs ? ` to ${formatMediaTime(o.mediaEndMs)}` : ""}`}
              </dd>
              <dt className="text-ivory-3">Captured</dt>
              <dd>{o.capturedAt ? clockTimeSeconds(o.capturedAt) : "Not provided by the source"}</dd>
              <dt className="text-ivory-3">Received</dt>
              <dd>{clockTimeSeconds(o.receivedAt)}</dd>
              <dt className="text-ivory-3">Analyzed</dt>
              <dd>{o.analyzedAt ? clockTimeSeconds(o.analyzedAt) : "—"}</dd>
              <dt className="text-ivory-3">Published</dt>
              <dd>{o.publishedAt ? clockTimeSeconds(o.publishedAt) : "—"}</dd>
              <dt className="text-ivory-3">Derived by</dt>
              <dd>{o.model ? `${o.model.provider} ${o.model.version}` : o.origin === "twitch" ? "Twitch EventSub" : "Local measurement"}</dd>
              <dt className="text-ivory-3">Certainty</dt>
              <dd>
                {o.origin === "twitch" ? "Platform fact, no model involved" : confidenceWords(o.modelConfidence)}
                {o.modelConfidence !== null && <span className="text-ivory-3"> (self-reported, not measured accuracy)</span>}
              </dd>
              <dt className="text-ivory-3">Review</dt>
              <dd className="capitalize">{o.reviewStatus}</dd>
            </dl>
            {o.relatedEntities.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-[0.78rem]">
                {o.relatedEntities.map((e) => (
                  <li key={e.id} className="border hairline px-2 py-0.5 text-ivory-2">
                    {e.label} <span className="text-ivory-3">({e.certainty})</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {mode === "replay" && o.mediaStartMs !== null && onPlayFrom && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onPlayFrom(o.mediaStartMs!)}>
                  Play from here
                </button>
              )}
              {detail!.nearbyClip?.clipUrl && (
                <a href={detail!.nearbyClip.clipUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm">
                  Open Twitch clip
                </a>
              )}
              {detail!.canEdit && onSaveMoment && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSaveMoment(o.description.slice(0, 120), o.id)}>
                  Save moment
                </button>
              )}
              {detail!.canEdit && !editing && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)}>
                  Correct this
                </button>
              )}
              {detail!.canEdit && current && !fixture && <SaveFrameButton observationId={o.id} assetId={current.assetId} />}
            </div>
            {editing && detail && <CorrectionForm detail={detail} onDone={(d) => (setDetail(d), setEditing(false))} onCancel={() => setEditing(false)} />}
            {detail!.corrections.length > 0 && (
              <div>
                <p className="text-[0.8rem] text-ivory-3">Correction history</p>
                <ol className="mt-1 space-y-1 text-[0.8rem] text-ivory-2">
                  {detail!.corrections.map((c) => (
                    <li key={c.id}>
                      {clockTimeSeconds(c.createdAt)}: marked {c.reviewStatus}
                      {c.reason ? `, “${c.reason}”` : ""}. Previously “{c.previousDescription}”.
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function explain(o: NonNullable<ObservationDetail["observation"]>, label: string | null): string {
  const cls = evidenceClass(o);
  const where = label === "replay" ? "this replay" : label === "test" ? "this test recording" : label === "clip" ? "a downloaded Twitch clip" : "the authorized video source";
  switch (cls) {
    case "visible_text":
      return `Text read directly from ${where} at the time shown.`;
    case "visible":
      return `Directly visible in ${where}.`;
    case "inferred":
      return `An interpretation of a sequence of frames from ${where}. It may be wrong; check the frames.`;
    case "heard":
      return `Transcribed from the audio of ${where}.`;
    case "measured":
      return `A measurement of ${where} itself (cuts, black frames, coverage), not a claim about gameplay.`;
    case "platform":
      return "Reported by Twitch. Categories and titles are set by the creator and don't prove what the video shows.";
    case "correction":
      return "Corrected by the creator.";
  }
}

function CorrectionForm({ detail, onDone, onCancel }: { detail: ObservationDetail; onDone: (d: ObservationDetail) => void; onCancel: () => void }) {
  const o = detail.observation;
  const [description, setDescription] = useState(o.description);
  const [type, setType] = useState(o.type);
  const [reviewStatus, setReviewStatus] = useState<"confirmed" | "corrected" | "rejected">("corrected");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api<typeof o>(`/api/observations/${o.id}/corrections`, {
        method: "POST",
        json: { reviewStatus, ...(reviewStatus === "corrected" ? { description, type } : {}), ...(reason ? { reason } : {}) },
      });
      onDone({ ...detail, observation: updated, corrections: [...detail.corrections, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), reviewStatus, reason: reason || null, previousDescription: o.description }] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the correction");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 border-t hairline pt-4">
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="label">Your review</legend>
        {(["corrected", "confirmed", "rejected"] as const).map((s) => (
          <label key={s} className="flex items-center gap-2 capitalize">
            <input type="radio" name="review" checked={reviewStatus === s} onChange={() => setReviewStatus(s)} className="accent-[#ffad72]" />
            {s === "corrected" ? "Correct it" : s === "confirmed" ? "It's right" : "It's wrong"}
          </label>
        ))}
      </fieldset>
      {reviewStatus === "corrected" && (
        <>
          <div>
            <label className="label" htmlFor="corr-desc">
              Description
            </label>
            <input id="corr-desc" className="field" value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="corr-type">
              Type
            </label>
            <select id="corr-type" className="field" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {ObservationType.options
                .filter((t) => !["stream_online", "stream_offline", "channel_update"].includes(t))
                .map((t) => (
                  <option key={t} value={t}>
                    {OBSERVATION_TYPE_LABEL[t]}
                  </option>
                ))}
            </select>
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="corr-reason">
          Note (optional)
        </label>
        <input id="corr-reason" className="field" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p className="text-sm text-coral">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? "Saving" : "Save review"}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Keep an evidence frame as a screenshot in the creator's library. */
function SaveFrameButton({ observationId, assetId }: { observationId: string; assetId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm"
      disabled={state === "busy" || state === "saved"}
      onClick={async () => {
        setState("busy");
        try {
          await api("/api/library/screenshots", { method: "POST", json: { from: "evidence", observationId, assetId } });
          setState("saved");
        } catch {
          setState("error");
        }
      }}
    >
      {state === "saved" ? "Saved to library" : state === "busy" ? "Saving" : state === "error" ? "Couldn't save, retry" : "Save frame to library"}
    </button>
  );
}
