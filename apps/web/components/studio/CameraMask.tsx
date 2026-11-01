"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CAMERA_MASK_MAX_BOXES,
  CAMERA_MASK_MIN_SIZE,
  CAMERA_MASK_PRESETS,
  normalizeCameraMask,
  type CameraMaskBox,
  type CameraMaskCorner,
  type MediaSourceView,
} from "@slot1/contracts";
import { useAiView } from "@/components/watch/AiView";
import { api, ApiError } from "@/lib/api";
import type { StudioCtx } from "./StudioApp";

const BUSY = "aria-disabled:cursor-progress aria-disabled:opacity-60";
const CORNERS: [CameraMaskCorner, string][] = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
];
const GRID: React.CSSProperties = {
  backgroundImage: "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)",
  backgroundSize: "33.333% 33.333%",
};
const STEP = 0.01;
const BIG_STEP = 0.05;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const same = (a: readonly CameraMaskBox[], b: readonly CameraMaskBox[]) => JSON.stringify(a) === JSON.stringify(b);

function describe(b: CameraMaskBox): string {
  return `from ${pct(b.x)} across and ${pct(b.y)} down, ${pct(b.w)} wide and ${pct(b.h)} tall`;
}

type Drag =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "move"; index: number; dx: number; dy: number }
  | { kind: "resize"; index: number };

/**
 * Studio → Stream setup → "Hide your camera from the AI". The creator draws up to three boxes on
 * their newest analyzed frame (or a neutral 16:9 placeholder) and saves them on their live
 * source; the worker blacks those boxes out of every frame it analyzes from then on.
 */
export function CameraMaskSection({ ctx, mainSourceId }: { ctx: StudioCtx; mainSourceId: string | null }) {
  const sources = useMemo(
    () => ctx.overview.sources.filter((s) => s.kind === "live_ingest" && s.status !== "revoked" && s.status !== "deleted"),
    [ctx.overview.sources],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const source: MediaSourceView | null = sources.find((s) => s.id === (chosen ?? mainSourceId)) ?? sources[0] ?? null;

  return (
    <section className="border-t hairline py-6" aria-labelledby="hide-camera-title" id="hide-camera">
      <h3 id="hide-camera-title" className="mb-2 font-display text-xl font-bold">
        Hide your camera from the AI
      </h3>
      <div className="mb-4 max-w-[70ch] space-y-2 text-sm text-ivory-2">
        <p>
          Draw a box over your webcam, or pick a corner. SLOT1 blacks out these boxes in every frame it analyzes from your stream, before anything looks at it. On-screen text
          reading (OCR), AI vision, SLOT1’s GTA model, the evidence frames it keeps and “What the AI sees” never get what’s inside.
        </p>
        <p>
          <strong className="text-ivory">Your viewers still see your full stream.</strong> Recordings, clips, instant replays and forwarding to Twitch, YouTube or Kick stay exactly as
          OBS sends them.
        </p>
        <p>It only works while your camera stays inside the box. If you move or resize your camera in OBS, move the box too.</p>
      </div>
      {!source ? (
        <p className="max-w-[70ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">Point OBS at SLOT1 first (step 1). Then you can mark where your camera sits.</p>
      ) : (
        <>
          {sources.length > 1 && (
            <label className="mb-3 block max-w-sm text-sm">
              <span className="mb-1 block text-ivory-2">Video source</span>
              <select className="field" value={source.id} onChange={(e) => setChosen(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.label === "test" ? "TEST" : "LIVE"})
                  </option>
                ))}
              </select>
            </label>
          )}
          <MaskEditor key={source.id} ctx={ctx} source={source} />
        </>
      )}
    </section>
  );
}

function MaskEditor({ ctx, source }: { ctx: StudioCtx; source: MediaSourceView }) {
  const saved = useMemo(() => source.cameraMask ?? [], [source.cameraMask]);
  const [boxes, setBoxes] = useState<CameraMaskBox[]>(saved);
  const [draft, setDraft] = useState<CameraMaskBox | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const boxRefs = useRef<(HTMLDivElement | null)[]>([]);

  // The newest analyzed frame of this source while it's live (already masked with the saved
  // boxes); otherwise the last frame Studio has; otherwise a neutral placeholder.
  const live = source.status === "publishing" && source.sessionId ? source.sessionId : null;
  const { shown } = useAiView(live, Boolean(live));
  const lastFrame = ctx.overview.lastFrame && ctx.overview.lastFrame.sessionId === source.sessionId ? ctx.overview.lastFrame.url : null;
  const picture = shown?.frame.url ?? lastFrame;

  const dirty = !same(boxes, saved);
  const full = boxes.length >= CAMERA_MASK_MAX_BOXES;

  useEffect(() => {
    if (selected !== null && selected < boxes.length) boxRefs.current[selected]?.focus();
  }, [selected, boxes.length]);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  const update = (index: number, next: CameraMaskBox) => setBoxes((list) => list.map((b, i) => (i === index ? normalizeCameraMask([next])[0]! : b)));

  const onAreaPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== area.current) return;
    if (full) {
      setStatus({ kind: "error", text: `You can hide up to ${CAMERA_MASK_MAX_BOXES} areas. Remove one to draw another.` });
      return;
    }
    const p = point(e);
    drag.current = { kind: "draw", startX: p.x, startY: p.y };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    area.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onBoxPointerDown = (e: React.PointerEvent<HTMLElement>, index: number, kind: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = point(e);
    const b = boxes[index]!;
    drag.current = kind === "move" ? { kind, index, dx: p.x - b.x, dy: p.y - b.y } : { kind, index };
    setSelected(index);
    area.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.kind === "draw") {
      setDraft({ x: Math.min(d.startX, p.x), y: Math.min(d.startY, p.y), w: Math.abs(p.x - d.startX), h: Math.abs(p.y - d.startY) });
    } else if (d.kind === "move") {
      const b = boxes[d.index]!;
      update(d.index, { ...b, x: clamp(p.x - d.dx, 0, 1 - b.w), y: clamp(p.y - d.dy, 0, 1 - b.h) });
    } else {
      const b = boxes[d.index]!;
      update(d.index, { ...b, w: clamp(p.x - b.x, CAMERA_MASK_MIN_SIZE, 1 - b.x), h: clamp(p.y - b.y, CAMERA_MASK_MIN_SIZE, 1 - b.y) });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (area.current?.hasPointerCapture(e.pointerId)) area.current.releasePointerCapture(e.pointerId);
    if (d?.kind === "draw") {
      const b = draft;
      setDraft(null);
      // A click or a tiny drag isn't a box.
      if (b && b.w >= CAMERA_MASK_MIN_SIZE && b.h >= CAMERA_MASK_MIN_SIZE) {
        setBoxes((list) => [...list, normalizeCameraMask([b])[0]!]);
        setSelected(boxes.length);
        setStatus(null);
      }
    }
  };

  const onBoxKey = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    const b = boxes[index]!;
    const step = e.altKey ? BIG_STEP : STEP;
    const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key in keys) {
      const [dx, dy] = keys[e.key]!;
      e.preventDefault();
      if (e.shiftKey) update(index, { ...b, w: clamp(b.w + dx, CAMERA_MASK_MIN_SIZE, 1 - b.x), h: clamp(b.h + dy, CAMERA_MASK_MIN_SIZE, 1 - b.y) });
      else update(index, { ...b, x: clamp(b.x + dx, 0, 1 - b.w), y: clamp(b.y + dy, 0, 1 - b.h) });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(index);
    }
  };

  const addCorner = (corner: CameraMaskCorner) => {
    if (full) return;
    setBoxes((list) => [...list, CAMERA_MASK_PRESETS[corner]]);
    setSelected(boxes.length);
    setStatus(null);
  };

  const remove = (index: number) => {
    setBoxes((list) => list.filter((_, i) => i !== index));
    setSelected(null);
    setStatus(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await api(`/api/studio/sources/${source.id}/camera-mask`, { method: "PUT", json: { boxes } });
      await ctx.reload();
      setStatus({
        kind: "ok",
        text: boxes.length
          ? `Saved. SLOT1 hides ${boxes.length === 1 ? "this area" : "these areas"} from the AI within a few seconds.`
          : "Saved. Nothing is hidden from the AI now.",
      });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof ApiError ? err.message : "Couldn’t save your boxes. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[880px]">
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Add a box in a corner">
        <span className="mr-1 text-sm text-ivory-2">Add a corner:</span>
        {CORNERS.map(([corner, label]) => (
          <button
            key={corner}
            type="button"
            className={`btn btn-ghost btn-sm ${BUSY}`}
            aria-disabled={full || undefined}
            aria-label={`Add a box in the ${label.toLowerCase()} corner`}
            onClick={() => addCorner(corner)}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        ref={area}
        className="relative aspect-video w-full touch-none select-none overflow-hidden border hairline bg-graphite-800"
        style={picture ? { backgroundImage: `url("${picture}")`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
        onPointerDown={onAreaPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="camera-mask-area"
        aria-label="Your picture. Drag on it to draw a box over your camera."
        role="group"
      >
        {!picture && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center" aria-hidden>
            <div>
              <p className="font-display text-lg font-bold text-ivory-2">No live picture right now</p>
              <p className="mt-1 text-sm text-ivory-3">Place the box where your camera usually sits. Your picture shows here while you stream.</p>
            </div>
          </div>
        )}
        {/* Thirds, to help line a box up with a corner camera. */}
        <div className="pointer-events-none absolute inset-0" style={GRID} aria-hidden />
        {boxes.map((b, i) => (
          <div
            key={i}
            ref={(el) => {
              boxRefs.current[i] = el;
            }}
            role="button"
            tabIndex={0}
            aria-label={`Hidden area ${i + 1}, ${describe(b)}. Arrow keys move it, Shift and arrow keys resize it, Delete removes it.`}
            aria-pressed={selected === i}
            className={`absolute grid cursor-move place-items-center bg-black text-center outline-none ring-2 ${selected === i ? "ring-gold" : "ring-coral/80"} focus-visible:ring-4 focus-visible:ring-gold`}
            style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}
            onPointerDown={(e) => onBoxPointerDown(e, i, "move")}
            onFocus={() => setSelected(i)}
            onKeyDown={(e) => onBoxKey(e, i)}
            data-testid="camera-mask-box"
          >
            <span className="pointer-events-none px-1 font-display text-[clamp(0.62rem,1.4vw,0.85rem)] font-semibold leading-tight text-ivory-2">
              Hidden from the AI
            </span>
            <span
              className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize border-2 border-graphite-900 bg-gold"
              onPointerDown={(e) => onBoxPointerDown(e, i, "resize")}
              aria-hidden
            />
          </div>
        ))}
        {draft && <div className="pointer-events-none absolute border-2 border-dashed border-gold bg-black/70" style={{ left: pct(draft.x), top: pct(draft.y), width: pct(draft.w), height: pct(draft.h) }} aria-hidden />}
      </div>
      <p className="mt-2 text-[0.8rem] text-ivory-3">
        {picture
          ? "Your newest frame. Boxes you already saved show as black in it, exactly as the AI gets it."
          : "Up to three boxes."}{" "}
        Drag to draw, drag a box to move it, drag its gold corner to resize. With a keyboard, Tab to a box, then use the arrow keys (Shift resizes).
      </p>

      {boxes.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm" aria-label="Hidden areas">
          {boxes.map((b, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-ivory">Area {i + 1}</span>
              <span className="text-ivory-3">{describe(b)}</span>
              <button type="button" className="btn btn-quiet btn-sm px-1 underline" onClick={() => remove(i)} aria-label={`Remove hidden area ${i + 1}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={`btn btn-primary btn-sm ${BUSY}`} aria-disabled={busy || !dirty || undefined} onClick={() => dirty && void save()}>
          {busy ? "Saving…" : "Save boxes"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-disabled={!dirty || undefined}
          onClick={() => {
            if (!dirty) return;
            setBoxes(saved);
            setSelected(null);
            setStatus(null);
          }}
        >
          Undo changes
        </button>
        {boxes.length > 0 && (
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => {
              setBoxes([]);
              setSelected(null);
              setStatus(null);
            }}
          >
            Remove all
          </button>
        )}
        <span className="text-[0.8rem] text-ivory-3" aria-live="polite">
          {dirty ? "Not saved yet." : saved.length ? `${saved.length} ${saved.length === 1 ? "area is" : "areas are"} hidden from the AI.` : "Nothing is hidden from the AI."}
        </span>
      </div>
      {status && (
        <p role={status.kind === "error" ? "alert" : "status"} className={`mt-2 text-sm ${status.kind === "error" ? "text-coral" : "text-ivory"}`} data-testid="camera-mask-status">
          {status.text}
        </p>
      )}
    </div>
  );
}
