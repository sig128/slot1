"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GTA_BOX_LABEL,
  GTA_BOXES,
  GTA_EVENT_LABEL,
  GTA_EVENTS,
  GTA_SCENE_LABEL,
  GTA_SCENES,
  type GtaBox,
  type GtaEvent,
  type GtaScene,
  type ModelView,
  type TrainingFrameView,
  type TrainingOverview,
} from "@slot1/contracts";
import { Toggle } from "@/components/ui/Toggle";
import { api, ApiError } from "@/lib/api";
import type { StudioCtx } from "./StudioApp";

type Box = { class: GtaBox; x: number; y: number; w: number; h: number };

const SOURCE_TEXT: Record<string, string> = {
  auto_ocr: "read on screen",
  auto_measure: "measured",
  model: "model guess",
  creator: "you",
  labeler: "labeler",
};

function pct(v: number) {
  return `${(v * 100).toFixed(2)}%`;
}

export function GtaModelSection({ ctx }: { ctx: StudioCtx }) {
  const [overview, setOverview] = useState<TrainingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setOverview(await api<TrainingOverview>("/api/training"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the GTA model status");
    }
  }, []);
  useEffect(() => {
    // Initial load of this tab's data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const consent = ctx.overview.settings.trainingConsent;
  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">GTA model</h2>
        <p className="mt-2 max-w-[68ch] text-ivory-2">
          SLOT1 is training its own GTA model from what happens in streams creators send here. You decide whether your streams help: frames are only
          kept while this is on, and you label them so the model learns from what really happened.
        </p>
      </div>

      <section className="border-t hairline py-6">
        <h3 className="mb-2 font-display text-xl font-bold">Your consent</h3>
        <Toggle
          label="Use frames from my streams to train SLOT1's GTA model"
          description="SLOT1 keeps one frame every few seconds from your uploads, clips and video sources, plus moments its text reader flags. Frames follow your retention setting and are removed when you delete a session. Turning this off stops collection and removes your frames from future datasets; copies already downloaded for training can't be recalled."
          checked={consent}
          onChange={(v) => void ctx.save({ trainingConsent: v }).then(() => reload())}
        />
        {overview && (
          <dl className="tnum mt-4 grid max-w-xl grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-ivory-3">Frames kept</dt>
              <dd className="font-display text-2xl font-bold">{overview.counts.frames}</dd>
            </div>
            <div>
              <dt className="text-ivory-3">To label</dt>
              <dd className="font-display text-2xl font-bold">{overview.counts.unlabeled}</dd>
            </div>
            <div>
              <dt className="text-ivory-3">Labeled</dt>
              <dd className="font-display text-2xl font-bold">{overview.counts.labeled}</dd>
            </div>
            <div>
              <dt className="text-ivory-3">Skipped</dt>
              <dd className="font-display text-2xl font-bold">{overview.counts.skipped}</dd>
            </div>
          </dl>
        )}
        {overview && overview.counts.frames > 0 && (
          <button
            type="button"
            className="btn btn-quiet btn-sm mt-4 text-coral"
            onClick={async () => {
              if (!window.confirm("Delete every training frame and label from your channel? This can't be undone.")) return;
              await api("/api/training/frames", { method: "DELETE", json: { confirm: "DELETE" } }).catch(() => undefined);
              await reload();
            }}
          >
            Delete my training data
          </button>
        )}
        {error && <p className="mt-3 text-sm text-coral">{error}</p>}
      </section>

      <section className="border-t hairline py-6">
        <h3 className="mb-2 font-display text-xl font-bold">Label frames</h3>
        <Labeler onChange={reload} />
      </section>

      <section className="border-t hairline py-6">
        <h3 className="mb-2 font-display text-xl font-bold">Model in use</h3>
        {overview && overview.activeModels.length === 0 ? (
          <p className="text-sm text-ivory-3">No trained GTA model is active yet. Until one is, analysis uses on-screen text, measurements and, when it’s switched on, the AI that describes gameplay.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {overview?.activeModels.map((m) => (
              <li key={m.id}>
                <ModelLine m={m} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {overview?.operator && <OperatorPanel overview={overview} reload={reload} />}
    </div>
  );
}

function ModelLine({ m }: { m: ModelView }) {
  const best = m.metrics.at(-1);
  return (
    <span>
      <span className="font-display text-base font-semibold">
        {m.name} {m.version}
      </span>{" "}
      <span className="text-ivory-3">
        {m.task === "scene" ? "scene and events" : "HUD and objects"}
        {best ? `, ${best.primaryMetric === "macro_f1" ? "macro F1" : "mAP@0.5"} ${best.value.toFixed(3)} on ${best.testFrames} test frames (dataset v${best.datasetVersion ?? "?"})` : ""}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Labeling                                                                                     */
/* ------------------------------------------------------------------------------------------ */

function Labeler({ onChange }: { onChange: () => Promise<void> }) {
  const [queue, setQueue] = useState<TrainingFrameView[] | null>(null);
  const [scene, setScene] = useState<GtaScene | null>(null);
  const [events, setEvents] = useState<Set<GtaEvent>>(new Set());
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [boxClass, setBoxClass] = useState<GtaBox>("minimap");
  const [draft, setDraft] = useState<Box | null>(null);
  const [status, setStatus] = useState<string>("");
  const start = useRef<{ x: number; y: number } | null>(null);
  const imgBox = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { frames } = await api<{ frames: TrainingFrameView[] }>("/api/training/queue?limit=12");
      setQueue(frames);
    } catch {
      setQueue([]);
    }
  }, []);
  useEffect(() => {
    // Initial queue load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const frame = queue?.[0] ?? null;
  const proposals = frame?.labels.filter((l) => l.status === "proposed") ?? [];
  const suggestedScene = proposals.find((l) => l.kind === "scene");

  const reset = () => {
    setScene(null);
    setEvents(new Set());
    setBoxes([]);
    setDraft(null);
  };

  const submit = async (skip: boolean) => {
    if (!frame) return;
    if (!skip && !scene) {
      setStatus("Pick a scene first (keys 1–8).");
      return;
    }
    setStatus(skip ? "Skipping" : "Saving");
    try {
      await api(`/api/training/frames/${frame.id}/labels`, { method: "POST", json: skip ? { skip: true } : { scene, events: [...events], boxes } });
      setStatus(skip ? "Skipped." : "Saved.");
      reset();
      setQueue((q) => (q ? q.slice(1) : q));
      if ((queue?.length ?? 0) <= 2) void load();
      void onChange();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Couldn't save the labels");
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "SELECT" || t.tagName === "INPUT") return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= GTA_SCENES.length) {
      setScene(GTA_SCENES[n - 1]!);
      e.preventDefault();
    } else if (e.key === "Enter" && t.tagName !== "BUTTON") {
      void submit(false);
      e.preventDefault();
    } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
      void submit(true);
      e.preventDefault();
    } else if (e.key === "Escape") {
      setDraft(null);
      start.current = null;
    }
  };

  const point = (e: React.PointerEvent) => {
    const r = imgBox.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  if (queue === null) return <p className="text-sm text-ivory-3">Loading frames.</p>;
  if (!frame)
    return (
      <p className="max-w-[68ch] text-sm text-ivory-3">
        Nothing to label right now. With consent on, frames arrive as SLOT1 analyzes your uploads, clips and video sources.
      </p>
    );

  return (
    <div role="group" aria-label="Label this frame" tabIndex={0} onKeyDown={onKey} className="grid gap-6 outline-none lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <div
          ref={imgBox}
          className="relative w-full touch-none select-none overflow-hidden border hairline bg-graphite-900"
          style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            start.current = point(e);
            setDraft(null);
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const p = point(e);
            const s = start.current;
            setDraft({ class: boxClass, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
          }}
          onPointerUp={() => {
            start.current = null;
            if (draft && draft.w > 0.01 && draft.h > 0.01) setBoxes((b) => [...b, draft]);
            setDraft(null);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={frame.imageUrl} alt={`Training frame from ${frame.sessionTitle ?? "a session"}`} className="pointer-events-none absolute inset-0 h-full w-full" draggable={false} />
          {proposals
            .filter((l) => l.box)
            .map((l) => (
              <span
                key={l.id}
                className="pointer-events-none absolute border border-dashed border-apricot"
                style={{ left: pct(l.box!.x), top: pct(l.box!.y), width: pct(l.box!.w), height: pct(l.box!.h) }}
                title={`Suggested ${GTA_BOX_LABEL[l.class as GtaBox] ?? l.class}`}
              />
            ))}
          {[...boxes, ...(draft ? [draft] : [])].map((b, i) => (
            <span
              key={i}
              className="pointer-events-none absolute border-2 border-signal"
              style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}
            >
              <span className="absolute -top-5 left-0 bg-signal px-1 text-[0.7rem] text-graphite">{GTA_BOX_LABEL[b.class]}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-[0.8rem] text-ivory-3">
          {frame.sourceLabel.toUpperCase()} from {frame.sessionTitle ?? "an untitled session"}. Drag on the frame to draw a box. Dashed boxes are
          suggestions; accept them on the right.
        </p>
      </div>

      <div className="space-y-5 text-sm">
        <fieldset>
          <legend className="label">Scene (keys 1–8)</legend>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {GTA_SCENES.map((s, i) => (
              <button
                key={s}
                type="button"
                aria-pressed={scene === s}
                onClick={() => setScene(s)}
                className={`btn btn-sm justify-start ${scene === s ? "btn-primary" : "btn-ghost"}`}
              >
                <span className="tnum mr-1.5 text-ivory-3">{i + 1}</span>
                {GTA_SCENE_LABEL[s]}
              </button>
            ))}
          </div>
          {suggestedScene && (
            <p className="mt-1.5 text-[0.8rem] text-ivory-3">
              Suggested: {GTA_SCENE_LABEL[suggestedScene.class as GtaScene] ?? suggestedScene.class} ({SOURCE_TEXT[suggestedScene.source]})
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend className="label">What happens</legend>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {GTA_EVENTS.map((ev) => {
              const on = events.has(ev);
              const suggested = proposals.some((l) => l.kind === "event" && l.class === ev);
              return (
                <button
                  key={ev}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setEvents((cur) => (cur.has(ev) ? new Set([...cur].filter((x) => x !== ev)) : new Set(cur).add(ev)))}
                  className={`btn btn-sm ${on ? "btn-primary" : "btn-ghost"} ${suggested && !on ? "border-apricot" : ""}`}
                >
                  {GTA_EVENT_LABEL[ev]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="gta-box-class">
            Box to draw
          </label>
          <select id="gta-box-class" className="field" value={boxClass} onChange={(e) => setBoxClass(e.target.value as GtaBox)}>
            {GTA_BOXES.map((b) => (
              <option key={b} value={b}>
                {GTA_BOX_LABEL[b]}
              </option>
            ))}
          </select>
          {proposals.some((l) => l.kind === "box") && (
            <ul className="mt-2 space-y-1">
              {proposals
                .filter((l) => l.kind === "box" && l.box)
                .map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-ivory-2">
                      {GTA_BOX_LABEL[l.class as GtaBox] ?? l.class} ({SOURCE_TEXT[l.source]})
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBoxes((b) => [...b, { class: l.class as GtaBox, ...l.box! }])}>
                      Accept
                    </button>
                  </li>
                ))}
            </ul>
          )}
          {boxes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {boxes.map((b, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="text-ivory">{GTA_BOX_LABEL[b.class]}</span>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setBoxes((cur) => cur.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void submit(false)}>
            Save labels
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void submit(true)}>
            Skip frame
          </button>
        </div>
        <p className="text-[0.8rem] text-ivory-3">Enter saves, S skips. {queue.length} frames loaded.</p>
        <p className="text-[0.8rem] text-ivory-2" aria-live="polite">
          {status}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Operators: datasets and the model registry                                                   */
/* ------------------------------------------------------------------------------------------ */

function OperatorPanel({ overview, reload }: { overview: TrainingOverview; reload: () => Promise<void> }) {
  const op = overview.operator!;
  const [msg, setMsg] = useState<string | null>(null);
  const modelFile = useRef<HTMLInputElement>(null);
  const metaFile = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<string>) => {
    try {
      setMsg(await fn());
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Request failed");
    }
  };

  return (
    <section className="border-t hairline py-6">
      <h3 className="mb-1 font-display text-xl font-bold">Datasets and models (operators)</h3>
      <p className="mb-4 max-w-[68ch] text-sm text-ivory-2">
        {op.consentingChannels} channels consent, {op.acceptedFrames} labeled frames available. A dataset version freezes those frames with a fixed
        train/val/test split by session. A new model goes live only if it scores at least as well as the active one on the same test split.
      </p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(async () => `Built dataset v${(await api<{ version: number }>("/api/training/datasets", { method: "POST" })).version}.`)}>
        Build dataset version
      </button>
      <ul className="mt-4 divide-y divide-line text-sm">
        {op.datasets.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span>
              <span className="font-display text-base font-semibold">Dataset v{d.version}</span>{" "}
              <span className="tnum text-ivory-3">
                {d.counts.frames} frames from {d.counts.channels} channels; train {d.counts.splits.train}, val {d.counts.splits.val}, test {d.counts.splits.test}
              </span>
            </span>
            <a className="btn btn-ghost btn-sm" href={`/api/training/datasets/${d.id}/export`} download>
              Export zip
            </a>
          </li>
        ))}
      </ul>

      <form
        className="mt-6 grid max-w-3xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const m = modelFile.current?.files?.[0];
            const meta = metaFile.current?.files?.[0];
            if (!m || !meta) throw new ApiError(400, "bad_request", "Choose the .onnx file and its metadata .json", null);
            const form = new FormData();
            form.append("metadata", await meta.text());
            form.append("model", m);
            const v = await api<ModelView>("/api/training/models", { method: "POST", body: form });
            return `Registered ${v.name} ${v.version} as a candidate.`;
          });
        }}
      >
        <div>
          <label className="label" htmlFor="model-file">
            Model (.onnx)
          </label>
          <input id="model-file" ref={modelFile} type="file" accept=".onnx" className="field" />
        </div>
        <div>
          <label className="label" htmlFor="meta-file">
            Metadata (.json from the training script)
          </label>
          <input id="meta-file" ref={metaFile} type="file" accept=".json,application/json" className="field" />
        </div>
        <button className="btn btn-primary">Upload model</button>
      </form>

      <ul className="mt-6 divide-y divide-line text-sm">
        {op.models.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <ModelLine m={m} /> <span className="chip chip-muted ml-1">{m.status}</span>
            </span>
            <span className="flex gap-2">
              <label className="btn btn-quiet btn-sm cursor-pointer">
                Add evaluation
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      void run(async () => {
                        await api(`/api/training/models/${m.id}/evaluations`, { method: "POST", json: JSON.parse(await f.text()) });
                        return `Added evaluation to ${m.name} ${m.version}.`;
                      });
                  }}
                />
              </label>
              {m.status !== "active" && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ decision: { reason: string } }>(`/api/training/models/${m.id}/activate`, { method: "POST" });
                      return `Activated. ${r.decision.reason}.`;
                    })
                  }
                >
                  Activate
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {msg && (
        <p className="mt-3 text-sm text-ivory-2" aria-live="polite">
          {msg}
        </p>
      )}
    </section>
  );
}
