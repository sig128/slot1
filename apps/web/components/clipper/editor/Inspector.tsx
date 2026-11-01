"use client";

import { useState } from "react";
import {
  EDL_LIMITS,
  EDL_SPEEDS,
  edlLocate,
  edlOutputTime,
  fixTransitions,
  instantReplay,
  interpolateKeys,
  moveSegment,
  overlapBefore,
  rippleDeleteSegments,
  segmentOutputMs,
  segmentStartsMs,
  trimRef,
  trimSegment,
  updateSegment,
  deleteRefs,
  edlId,
  addOverlayItem,
  type AudioClip,
  type Edl,
  type EdlEffect,
  type EdlSegment,
  type OverlayItem,
  type OverlayKey,
  type ReframeKey,
  type TimelineRef,
  type TransitionKind,
} from "@slot1/contracts";
import { editTime } from "@/lib/clipper";
import { useEditor } from "./context";
import { Panel, RangeField, SelectField, TimeField, Toggle, pct, secs } from "./fields";
import { followAction } from "./followAction";

const TRANSITIONS: [TransitionKind, string][] = [
  ["cut", "Cut"],
  ["crossfade", "Crossfade"],
  ["flash", "Flash (white)"],
  ["dip", "Dip to black"],
  ["whip", "Whip"],
  ["glitch", "Glitch"],
];
const SPEEDS = EDL_SPEEDS.map((v) => [v, `${v}×`] as const);
const STYLES = [
  ["poster", "Poster (gold)"],
  ["mission", "Mission title"],
  ["wasted", "Wasted red"],
  ["title-card", "Title card"],
  ["lower-third", "Lower third"],
  ["banner", "Banner"],
  ["caption", "Subtitle box"],
] as const;
const ANIMATIONS = [
  ["pop", "Pop"],
  ["slide", "Slide in"],
  ["typewriter", "Typewriter"],
  ["fade", "Fade"],
  ["none", "None"],
] as const;

/** Properties of whatever is selected on the timeline. */
export function SelectionPanel() {
  const { selection, edl, apply, select, announce } = useEditor();
  if (selection.length === 0) {
    return <p className="text-sm text-ivory-3">Select a block on the timeline to change it. Shift-click to select several.</p>;
  }
  if (selection.length > 1) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{selection.length} items selected.</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm text-coral"
            onClick={() => {
              apply((e) => deleteRefs(e, selection, false), "Delete");
              select([]);
              announce(`Deleted ${selection.length} items`);
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              apply((e) => deleteRefs(e, selection, true), "Ripple delete");
              select([]);
              announce(`Deleted ${selection.length} items and closed the gaps`);
            }}
          >
            Ripple delete
          </button>
        </div>
      </div>
    );
  }
  const r = selection[0]!;
  switch (r.kind) {
    case "segment":
      return edl.segments.some((s) => s.id === r.id) ? <SegmentInspector key={r.id} id={r.id} /> : null;
    case "overlay":
      return <OverlayInspector key={r.id} r={r} />;
    case "audio":
      return <AudioClipInspector key={r.id} r={r} />;
    case "effect":
      return <EffectInspector key={r.id} id={r.id} />;
    case "caption":
      return <CaptionInspector key={r.id} id={r.id} />;
    case "text":
      return <ClassicTextInspector key={r.id} id={r.id} />;
  }
}

/* ------------------------------------------ segments --------------------------------------- */

function SegmentInspector({ id }: { id: string }) {
  const { edl, apply, playheadMs, sourceOf, dims, announce, select, seek } = useEditor();
  const [follow, setFollow] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const i = edl.segments.findIndex((s) => s.id === id);
  const s = edl.segments[i]!;
  const src = sourceOf(s.sessionId);
  const maxSrc = dims(s.sessionId).durationMs || Number.MAX_SAFE_INTEGER;
  const change = (fn: (x: EdlSegment) => EdlSegment, label: string, key?: string) => apply((e) => updateSegment(e, id, fn), label, key ? `seg:${id}:${key}` : undefined);
  // Source time at the playhead, when the playhead is over this segment.
  const loc = edlLocate(edl, playheadMs);
  const here = loc.index === i ? loc.sourceMs : null;
  const at = here ?? s.inMs;
  const view = s.keys.length ? { x: interpolateKeys(s.keys, at, (k) => k.x), y: interpolateKeys(s.keys, at, (k) => k.y), zoom: interpolateKeys(s.keys, at, (k) => k.zoom) } : s.reframe;
  const setFrame = (patch: Partial<{ x: number; y: number; zoom: number }>, key: string) =>
    change(
      (x) => {
        if (x.keys.length === 0) return { ...x, reframe: { ...x.reframe, ...patch } };
        // With keyframes, the sliders set the keyframe at the playhead (made if needed).
        const near = x.keys.find((k) => Math.abs(k.atMs - at) <= 80);
        const base = { atMs: at, x: view.x, y: view.y, zoom: view.zoom };
        const keys = near ? x.keys.map((k) => (k === near ? { ...k, ...patch } : k)) : [...x.keys, { ...base, ...patch }].sort((a, b) => a.atMs - b.atMs).slice(0, 16);
        return { ...x, keys };
      },
      "Reframe",
      `frame-${key}`,
    );
  const trLimit = i > 0 ? Math.floor(Math.min(segmentOutputMs(s), segmentOutputMs(edl.segments[i - 1]!)) - 100) : 0;
  const reframes = edl.layout === "crop" || (edl.layout === "split" && edl.aspect === "9:16");

  const runFollow = async () => {
    if (!src?.playbackUrl) return;
    setFollow({ busy: true, msg: "Measuring movement…" });
    const exclude = edl.layout === "split" ? edl.split.cam : (src.cameraBox ?? null);
    const res = await followAction({ url: src.playbackUrl, inMs: s.inMs, outMs: s.outMs, exclude, zoom: Math.max(1.2, s.reframe.zoom) });
    if (!res.ok) {
      setFollow({ busy: false, msg: res.reason });
      return;
    }
    change((x) => ({ ...x, keys: res.keys }), "Follow the action");
    const msg = `Placed ${res.keys.length} keyframes where the picture moved (${res.moving} of ${res.samples} moments).`;
    setFollow({ busy: false, msg });
    announce(msg);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">Segment {i + 1}</h3>
        <span className="tnum text-[0.8rem] text-ivory-3">
          {editTime(segmentOutputMs(s))} in the edit{src && edl.segments.some((x) => x.sessionId !== s.sessionId) ? ` · ${src.title}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TimeField id={`in-${id}`} label="In (source)" value={s.inMs} onCommit={(ms) => apply((e) => trimSegment(e, id, "in", ms, maxSrc), "Trim segment")} />
        <TimeField id={`out-${id}`} label="Out (source)" value={s.outMs} onCommit={(ms) => apply((e) => trimSegment(e, id, "out", ms, maxSrc), "Trim segment")} />
        <SelectField id={`sp-${id}`} label="Speed" value={s.speed} options={SPEEDS} onChange={(v) => change((x) => ({ ...x, speed: v }), "Change speed")} />
        <SelectField
          id={`ramp-${id}`}
          label="Ramp to"
          value={s.rampTo ?? 0}
          options={[[0, "No ramp"] as const, ...SPEEDS]}
          onChange={(v) => change((x) => ({ ...x, rampTo: v === 0 || v === x.speed ? null : v }), "Speed ramp")}
        />
      </div>
      <RangeField id={`vol-${id}`} label="Segment volume" value={Math.round(s.volume * 100)} min={0} max={200} step={5} format={(v) => `${v}%`} onChange={(v) => change((x) => ({ ...x, volume: v / 100 }), "Segment volume", "vol")} />
      {i > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            id={`tr-${id}`}
            label="Transition in"
            value={s.transitionIn.kind}
            options={TRANSITIONS}
            onChange={(k) =>
              apply(
                (e) => fixTransitions({ ...e, segments: e.segments.map((x) => (x.id === id ? { ...x, transitionIn: { kind: k, durationMs: k === "cut" ? 0 : Math.max(100, Math.min(trLimit, x.transitionIn.durationMs || 400)) } } : x)) }),
                "Transition",
              )
            }
          />
          {s.transitionIn.kind !== "cut" && (
            <RangeField
              id={`trd-${id}`}
              label="Length"
              value={s.transitionIn.durationMs}
              min={100}
              max={Math.max(100, Math.min(2000, trLimit))}
              step={50}
              format={secs}
              onChange={(v) => apply((e) => fixTransitions({ ...e, segments: e.segments.map((x) => (x.id === id ? { ...x, transitionIn: { ...x.transitionIn, durationMs: v } } : x)) }), "Transition length", `seg:${id}:trd`)}
            />
          )}
          {trLimit < 100 && <p className="col-span-2 text-[0.78rem] text-ivory-3">These segments are too short for a transition.</p>}
        </div>
      )}
      {reframes ? (
        <div className="space-y-3 border-t hairline pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display font-semibold">Framing {s.keys.length ? `(${s.keys.length} keyframes)` : ""}</h4>
            {here === null && <span className="text-[0.75rem] text-ivory-3">Playhead isn&apos;t on this segment: editing its first frame</span>}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <RangeField id={`rx-${id}`} label="Left–right" value={Math.round(view.x * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => setFrame({ x: v / 100 }, "x")} />
            <RangeField id={`ry-${id}`} label="Up–down" value={Math.round(view.y * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => setFrame({ y: v / 100 }, "y")} />
            <RangeField id={`rz-${id}`} label="Zoom" value={Math.round(view.zoom * 100)} min={100} max={400} step={5} format={(v) => `${(v / 100).toFixed(2)}×`} onChange={(v) => setFrame({ zoom: v / 100 }, "z")} />
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={s.keys.length >= 16}
              onClick={() => change((x) => ({ ...x, keys: [...x.keys.filter((k) => Math.abs(k.atMs - at) > 80), { atMs: at, x: view.x, y: view.y, zoom: view.zoom }].sort((a, b) => a.atMs - b.atMs).slice(0, 16) }), "Add keyframe")}
            >
              Keyframe at playhead
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={follow.busy || !src?.playbackUrl} onClick={() => void runFollow()}>
              {follow.busy ? "Measuring…" : "Follow the action"}
            </button>
            {s.keys.length > 0 && (
              <button type="button" className="btn btn-quiet btn-sm text-coral" onClick={() => change((x) => ({ ...x, keys: [] }), "Clear keyframes")}>
                Clear keyframes
              </button>
            )}
          </div>
          {follow.msg && (
            <p className="text-[0.78rem] text-ivory-2" role="status">
              {follow.msg}
            </p>
          )}
          {s.keys.length > 0 && (
            <ol className="space-y-1 text-[0.8rem]">
              {s.keys.map((k: ReframeKey, ki) => (
                <li key={`${k.atMs}-${ki}`} className="flex flex-wrap items-center gap-2">
                  <button type="button" className="tnum underline decoration-line-strong underline-offset-2 hover:text-apricot" onClick={() => seek(edlOutputTime(edl, i, k.atMs))}>
                    {editTime(k.atMs)}
                  </button>
                  <span className="tnum text-ivory-3">
                    {pct(k.x)} · {pct(k.y)} · {k.zoom.toFixed(2)}×
                  </span>
                  <button type="button" className="btn btn-quiet btn-sm px-1 text-coral" onClick={() => change((x) => ({ ...x, keys: x.keys.filter((_, j) => j !== ki) }), "Remove keyframe")}>
                    Remove<span className="sr-only"> keyframe at {editTime(k.atMs)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="text-[0.75rem] text-ivory-3">Follow the action measures where the picture moves and only follows real movement; with none it changes nothing.</p>
        </div>
      ) : (
        <p className="text-[0.78rem] text-ivory-3">Fit layout shows the whole frame; switch Format to Fill to reframe and keyframe.</p>
      )}
      <div className="flex flex-wrap gap-1 border-t hairline pt-3">
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={i === 0} onClick={() => apply((e) => moveSegment(e, id, i - 1), "Move segment")}>
          Move earlier
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={i === edl.segments.length - 1} onClick={() => apply((e) => moveSegment(e, id, i + 1), "Move segment")}>
          Move later
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-sm px-1.5"
          disabled={edl.segments.length >= EDL_LIMITS.segments}
          onClick={() => apply((e) => fixTransitions({ ...e, segments: [...e.segments.slice(0, i + 1), { ...s, id: edlId("s"), transitionIn: { kind: "cut", durationMs: 0 } }, ...e.segments.slice(i + 1)] }), "Duplicate segment")}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-sm px-1.5 text-coral"
          disabled={edl.segments.length <= 1}
          onClick={() => {
            apply((e) => rippleDeleteSegments(e, [id]) ?? e, "Delete segment");
            select([]);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** The main track as a list: the accessible way to pick and reorder segments. */
export function SegmentsPanel() {
  const { edl, selection, select, seek, apply, playheadMs, announce } = useEditor();
  const starts = segmentStartsMs(edl);
  return (
    <Panel title="Segments">
      <ol className="space-y-1.5">
        {edl.segments.map((s, i) => {
          const on = selection.some((r) => r.kind === "segment" && r.id === s.id);
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  select([{ kind: "segment", id: s.id }]);
                  seek(Math.round(starts[i]! + 1));
                }}
                className={`flex w-full items-baseline justify-between gap-2 border px-3 py-2 text-left ${on ? "border-ivory-2 bg-graphite-800" : "hairline hover:border-line-strong"}`}
              >
                <span className="font-display text-[1.02rem] font-bold">
                  Segment {i + 1}
                  {s.speed !== 1 || s.rampTo !== null ? <span className="ml-2 font-sans text-[0.78rem] font-normal text-apricot">{s.rampTo !== null ? `${s.speed}→${s.rampTo}×` : `${s.speed}×`}</span> : null}
                  {i > 0 && s.transitionIn.kind !== "cut" ? <span className="ml-2 font-sans text-[0.78rem] font-normal text-coral">{s.transitionIn.kind}</span> : null}
                </span>
                <span className="tnum shrink-0 text-[0.8rem] text-ivory-3">
                  {editTime(starts[i]! + overlapBefore(edl, i))}–{editTime(starts[i]! + segmentOutputMs(s))}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const r = instantReplay(edl, playheadMs);
            if (!r) return announce("No room for an instant replay here (needs at least 0.6 s before the playhead)");
            apply(() => r.edl, "Instant replay");
            announce(r.note);
          }}
        >
          Instant replay here
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------ overlays --------------------------------------- */

function keyedProps(it: OverlayItem, t: number) {
  if (!it.keys.length) return { x: it.x, y: it.y, scale: it.scale, rotation: it.rotation, opacity: it.opacity };
  return {
    x: interpolateKeys(it.keys, t, (k) => k.x),
    y: interpolateKeys(it.keys, t, (k) => k.y),
    scale: interpolateKeys(it.keys, t, (k) => k.scale),
    rotation: interpolateKeys(it.keys, t, (k) => k.rotation),
    opacity: interpolateKeys(it.keys, t, (k) => k.opacity),
  };
}

function OverlayInspector({ r }: { r: Extract<TimelineRef, { kind: "overlay" }> }) {
  const { edl, apply, playheadMs, sources, sourceOf, refName, seek } = useEditor();
  const track = edl.overlays.find((t) => t.id === r.trackId);
  const it = track?.items.find((x) => x.id === r.id);
  if (!track || !it) return null;
  const locked = track.locked;
  const change = (fn: (x: OverlayItem) => OverlayItem, label: string, key?: string) =>
    apply((e) => ({ ...e, overlays: e.overlays.map((t) => (t.id !== r.trackId ? t : { ...t, items: t.items.map((x) => (x.id === r.id ? fn(x) : x)) })) }), label, key ? `ov:${r.id}:${key}` : undefined);
  const inside = playheadMs >= it.startMs && playheadMs < it.endMs;
  const at = inside ? Math.round(playheadMs) : it.startMs;
  const v = keyedProps(it, at);
  const setProp = (patch: Partial<Omit<OverlayKey, "atMs">>, key: string) =>
    change(
      (x) => {
        if (!x.keys.length) return { ...x, ...patch } as OverlayItem;
        const near = x.keys.find((k) => Math.abs(k.atMs - at) <= 80);
        const keys = near ? x.keys.map((k) => (k === near ? { ...k, ...patch } : k)) : [...x.keys, { atMs: at, ...v, ...patch }].sort((a, b) => a.atMs - b.atMs).slice(0, 16);
        return { ...x, keys } as OverlayItem;
      },
      "Move overlay",
      key,
    );
  const kind = it.type === "text" ? `Text` : it.type === "image" ? `Image · ${refName(it.source)}` : "Picture in picture";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{kind}</h3>
        <span className="text-[0.8rem] text-ivory-3">
          on {track.name}
          {locked ? " · locked" : ""}
        </span>
      </div>
      <fieldset disabled={locked} className="space-y-4">
        {it.type === "text" && (
          <>
            <div>
              <label htmlFor={`ot-${it.id}`} className="label">
                Text
              </label>
              <input id={`ot-${it.id}`} className="field h-9" value={it.text} maxLength={160} onChange={(e) => change((x) => ({ ...x, text: e.target.value || " " }) as OverlayItem, "Edit text", "text")} />
            </div>
            <div>
              <label htmlFor={`os-${it.id}`} className="label">
                Second line
              </label>
              <input id={`os-${it.id}`} className="field h-9" value={it.subtext} maxLength={120} onChange={(e) => change((x) => ({ ...x, subtext: e.target.value }) as OverlayItem, "Edit text", "sub")} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SelectField id={`ost-${it.id}`} label="Style" value={it.style} options={STYLES} onChange={(s) => change((x) => ({ ...x, style: s }) as OverlayItem, "Text style")} />
              <SelectField id={`oa-${it.id}`} label="Animation" value={it.animation} options={ANIMATIONS} onChange={(a) => change((x) => ({ ...x, animation: a }) as OverlayItem, "Text animation")} />
            </div>
          </>
        )}
        {it.type === "image" && (
          <RangeField id={`ow-${it.id}`} label="Width" value={Math.round(it.widthPct * 100)} min={3} max={100} step={1} format={(n) => `${n}%`} onChange={(n) => change((x) => ({ ...x, widthPct: n / 100 }) as OverlayItem, "Resize", "w")} />
        )}
        {it.type === "pip" && (
          <div className="space-y-3">
            <SelectField
              id={`ps-${it.id}`}
              label="Video"
              value={it.sessionId}
              options={sources.filter((s) => s.playbackUrl).map((s) => [s.sessionId, s.title] as const)}
              onChange={(sid) => change((x) => ({ ...x, sessionId: sid }) as OverlayItem, "Picture in picture source")}
            />
            <TimeField id={`pin-${it.id}`} label="Starts from (source)" value={it.sourceInMs} onCommit={(ms) => change((x) => ({ ...x, sourceInMs: Math.max(0, ms) }) as OverlayItem, "Picture in picture start")} />
            <div className="grid grid-cols-2 gap-3">
              {(["x", "y", "w", "h"] as const).map((k) => (
                <RangeField
                  key={k}
                  id={`pb${k}-${it.id}`}
                  label={k === "x" ? "Crop left" : k === "y" ? "Crop top" : k === "w" ? "Crop width" : "Crop height"}
                  value={Math.round(it.box[k] * 100)}
                  min={k === "w" || k === "h" ? 5 : 0}
                  max={100}
                  step={1}
                  format={(n) => `${n}%`}
                  onChange={(n) =>
                    change(
                      (x) => {
                        if (x.type !== "pip") return x;
                        const b = { ...x.box, [k]: n / 100 };
                        b.w = Math.min(b.w, 1 - b.x);
                        b.h = Math.min(b.h, 1 - b.y);
                        return { ...x, box: { ...b, w: Math.max(0.05, b.w), h: Math.max(0.05, b.h) } };
                      },
                      "Picture in picture crop",
                      `box${k}`,
                    )
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {sourceOf(it.sessionId)?.cameraBox && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => change((x) => ({ ...x, box: sourceOf(it.sessionId)!.cameraBox! }) as OverlayItem, "Use camera box")}>
                  Use my camera box
                </button>
              )}
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => change((x) => ({ ...x, box: { x: 0, y: 0, w: 1, h: 1 } }) as OverlayItem, "Whole picture")}>
                Whole picture
              </button>
            </div>
            <RangeField id={`pw-${it.id}`} label="Width" value={Math.round(it.widthPct * 100)} min={10} max={100} step={1} format={(n) => `${n}%`} onChange={(n) => change((x) => ({ ...x, widthPct: n / 100 }) as OverlayItem, "Resize", "w")} />
            <Toggle id={`pbd-${it.id}`} label="Ink border" checked={it.border} onChange={(b) => change((x) => ({ ...x, border: b }) as OverlayItem, "Border")} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <TimeField id={`of-${it.id}`} label="From" value={it.startMs} onCommit={(ms) => apply((e) => trimRef(e, r, "start", ms), "Trim")} />
          <TimeField id={`oe-${it.id}`} label="To" value={it.endMs} onCommit={(ms) => apply((e) => trimRef(e, r, "end", ms), "Trim")} />
        </div>
        <div className="space-y-3 border-t hairline pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display font-semibold">Position {it.keys.length ? `(${it.keys.length} keyframes)` : ""}</h4>
            {!inside && <span className="text-[0.75rem] text-ivory-3">Playhead isn&apos;t over it: editing its first frame</span>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <RangeField id={`ox-${it.id}`} label="Left–right" value={Math.round(v.x * 100)} min={0} max={100} step={1} format={(n) => `${n}%`} onChange={(n) => setProp({ x: n / 100 }, "x")} />
            <RangeField id={`oy-${it.id}`} label="Up–down" value={Math.round(v.y * 100)} min={0} max={100} step={1} format={(n) => `${n}%`} onChange={(n) => setProp({ y: n / 100 }, "y")} />
            <RangeField id={`oz-${it.id}`} label="Size" value={Math.round(v.scale * 100)} min={10} max={400} step={5} format={(n) => `${n}%`} onChange={(n) => setProp({ scale: n / 100 }, "s")} />
            <RangeField id={`or-${it.id}`} label="Rotation" value={Math.round(v.rotation)} min={-180} max={180} step={1} format={(n) => `${n}°`} onChange={(n) => setProp({ rotation: n }, "r")} />
            <RangeField id={`oo-${it.id}`} label="Opacity" value={Math.round(v.opacity * 100)} min={0} max={100} step={1} format={(n) => `${n}%`} onChange={(n) => setProp({ opacity: n / 100 }, "o")} />
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={it.keys.length >= 16}
              onClick={() => change((x) => ({ ...x, keys: [...x.keys.filter((k) => Math.abs(k.atMs - at) > 80), { atMs: at, ...v }].sort((a, b) => a.atMs - b.atMs).slice(0, 16) }) as OverlayItem, "Add keyframe")}
            >
              Keyframe at playhead
            </button>
            {it.keys.length > 0 && (
              <button type="button" className="btn btn-quiet btn-sm text-coral" onClick={() => change((x) => ({ ...x, keys: [] }) as OverlayItem, "Clear keyframes")}>
                Clear keyframes
              </button>
            )}
          </div>
          {it.keys.length > 0 && (
            <ol className="space-y-1 text-[0.8rem]">
              {it.keys.map((k, ki) => (
                <li key={`${k.atMs}-${ki}`} className="flex flex-wrap items-center gap-2">
                  <button type="button" className="tnum underline decoration-line-strong underline-offset-2 hover:text-apricot" onClick={() => seek(k.atMs)}>
                    {editTime(k.atMs)}
                  </button>
                  <span className="tnum text-ivory-3">
                    {pct(k.x)}, {pct(k.y)} · {pct(k.scale)} · {Math.round(k.rotation)}° · {pct(k.opacity)}
                  </span>
                  <button type="button" className="btn btn-quiet btn-sm px-1 text-coral" onClick={() => change((x) => ({ ...x, keys: x.keys.filter((_, j) => j !== ki) }) as OverlayItem, "Remove keyframe")}>
                    Remove<span className="sr-only"> keyframe at {editTime(k.atMs)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </fieldset>
    </div>
  );
}

/* ------------------------------------------ audio clips ------------------------------------ */

function AudioClipInspector({ r }: { r: Extract<TimelineRef, { kind: "audio" }> }) {
  const { edl, apply, playheadMs, refName, refDurationMs, seek } = useEditor();
  const track = edl.audioTracks.find((t) => t.id === r.trackId);
  const c = track?.clips.find((x) => x.id === r.id);
  if (!track || !c) return null;
  const change = (fn: (x: AudioClip) => AudioClip, label: string, key?: string) =>
    apply((e) => ({ ...e, audioTracks: e.audioTracks.map((t) => (t.id !== r.trackId ? t : { ...t, clips: t.clips.map((x) => (x.id === r.id ? fn(x) : x)) })) }), label, key ? `au:${r.id}:${key}` : undefined);
  const fileMs = refDurationMs(c.source);
  const inside = playheadMs >= c.startMs && playheadMs < c.startMs + c.durationMs;
  const at = Math.round(inside ? playheadMs : c.startMs);
  const current = c.envelope.length ? interpolateKeys(c.envelope, at, (k) => k.volume) : 1;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{refName(c.source)}</h3>
        <span className="text-[0.8rem] text-ivory-3">
          on {track.name}
          {fileMs ? ` · file ${editTime(fileMs)}` : ""}
        </span>
      </div>
      <fieldset disabled={track.locked} className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <TimeField id={`as-${c.id}`} label="Starts at" value={c.startMs} onCommit={(ms) => apply((e) => trimRef(e, r, "start", ms, { maxDurationMs: fileMs ?? undefined }), "Trim clip")} />
          <TimeField id={`ae-${c.id}`} label="Ends at" value={c.startMs + c.durationMs} onCommit={(ms) => apply((e) => trimRef(e, r, "end", ms, { maxDurationMs: fileMs ?? undefined }), "Trim clip")} />
          <TimeField id={`ao-${c.id}`} label="From file at" value={c.offsetMs} onCommit={(ms) => change((x) => ({ ...x, offsetMs: Math.max(0, fileMs && !x.loop ? Math.min(ms, fileMs - 50) : ms) }), "Clip offset")} />
        </div>
        <RangeField id={`av-${c.id}`} label="Volume" value={Math.round(c.volume * 100)} min={0} max={200} step={5} format={(n) => `${n}%`} onChange={(n) => change((x) => ({ ...x, volume: n / 100 }), "Clip volume", "v")} />
        <div className="grid grid-cols-2 gap-3">
          <RangeField id={`afi-${c.id}`} label="Fade in" value={c.fadeInMs} min={0} max={Math.min(10_000, c.durationMs)} step={50} format={secs} onChange={(n) => change((x) => ({ ...x, fadeInMs: Math.min(n, x.durationMs - x.fadeOutMs) }), "Fade in", "fi")} />
          <RangeField id={`afo-${c.id}`} label="Fade out" value={c.fadeOutMs} min={0} max={Math.min(10_000, c.durationMs)} step={50} format={secs} onChange={(n) => change((x) => ({ ...x, fadeOutMs: Math.min(n, x.durationMs - x.fadeInMs) }), "Fade out", "fo")} />
        </div>
        <Toggle id={`al-${c.id}`} label="Loop to fill the clip" hint="For music beds shorter than the edit." checked={c.loop} onChange={(b) => change((x) => ({ ...x, loop: b }), "Loop")} />
        <div className="space-y-2 border-t hairline pt-3">
          <h4 className="font-display font-semibold">Volume envelope</h4>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={c.envelope.length >= 24}
              onClick={() => change((x) => ({ ...x, envelope: [...x.envelope.filter((k) => Math.abs(k.atMs - at) > 50), { atMs: at, volume: Math.round(current * 100) / 100 }].sort((a, b) => a.atMs - b.atMs) }), "Add volume point")}
            >
              Volume point at playhead
            </button>
            {c.envelope.length > 0 && (
              <button type="button" className="btn btn-quiet btn-sm text-coral" onClick={() => change((x) => ({ ...x, envelope: [] }), "Clear envelope")}>
                Clear envelope
              </button>
            )}
          </div>
          {c.envelope.map((k, ki) => (
            <div key={`${k.atMs}-${ki}`} className="grid grid-cols-[auto_1fr_auto] items-end gap-2">
              <button type="button" className="tnum mb-1 text-[0.8rem] underline decoration-line-strong underline-offset-2" onClick={() => seek(k.atMs)}>
                {editTime(k.atMs)}
              </button>
              <RangeField id={`aek-${c.id}-${ki}`} label="Level" value={Math.round(k.volume * 100)} min={0} max={200} step={5} format={(n) => `${n}%`} onChange={(n) => change((x) => ({ ...x, envelope: x.envelope.map((q, j) => (j === ki ? { ...q, volume: n / 100 } : q)) }), "Envelope", `env${ki}`)} />
              <button type="button" className="btn btn-quiet btn-sm px-1 text-coral" onClick={() => change((x) => ({ ...x, envelope: x.envelope.filter((_, j) => j !== ki) }), "Remove volume point")}>
                Remove<span className="sr-only"> volume point at {editTime(k.atMs)}</span>
              </button>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/* ---------------------------------------- effects, captions -------------------------------- */

const EFFECTS: [EdlEffect["kind"], string][] = [
  ["wasted", "WASTED (freeze, grey, banner)"],
  ["passed", "MISSION PASSED (gold banner)"],
  ["punch", "Punch-in zoom"],
  ["shake", "Camera shake"],
  ["flash", "Flash"],
  ["glitch", "Glitch (RGB split)"],
];

function EffectInspector({ id }: { id: string }) {
  const { edl, apply } = useEditor();
  const f = edl.effects.find((x) => x.id === id);
  if (!f) return null;
  const r: TimelineRef = { kind: "effect", id };
  const change = (fn: (x: EdlEffect) => EdlEffect, label: string, key?: string) => apply((e) => ({ ...e, effects: e.effects.map((x) => (x.id === id ? fn(x) : x)) }), label, key ? `fx:${id}:${key}` : undefined);
  return (
    <div className="space-y-4">
      <h3 className="font-display text-lg font-bold">Effect</h3>
      <SelectField id={`fk-${id}`} label="Effect" value={f.kind} options={EFFECTS} onChange={(k) => change((x) => ({ ...x, kind: k }), "Change effect")} />
      <div className="grid grid-cols-2 gap-2">
        <TimeField id={`fs-${id}`} label="From" value={f.startMs} onCommit={(ms) => apply((e) => trimRef(e, r, "start", ms), "Trim effect")} />
        <TimeField id={`fe-${id}`} label="To" value={f.endMs} onCommit={(ms) => apply((e) => trimRef(e, r, "end", ms), "Trim effect")} />
      </div>
      {(f.kind === "wasted" || f.kind === "passed") && (
        <div>
          <label htmlFor={`ft-${id}`} className="label">
            Banner text
          </label>
          <input id={`ft-${id}`} className="field h-9" maxLength={60} placeholder={f.kind === "wasted" ? "WASTED" : "MISSION PASSED"} value={f.text} onChange={(e) => change((x) => ({ ...x, text: e.target.value }), "Banner text", "text")} />
        </div>
      )}
      {(f.kind === "punch" || f.kind === "shake" || f.kind === "glitch") && (
        <RangeField id={`fa-${id}`} label="Strength" value={Math.round(f.amount * 100)} min={0} max={100} step={5} format={(n) => `${n}%`} onChange={(n) => change((x) => ({ ...x, amount: n / 100 }), "Effect strength", "amount")} />
      )}
      <p className="text-[0.75rem] text-ivory-3">Original SLOT1 effects in the GTA spirit; no Rockstar audio, fonts or artwork.</p>
    </div>
  );
}

function CaptionInspector({ id }: { id: string }) {
  const { edl, apply } = useEditor();
  const c = edl.captionTrack.cues.find((x) => x.id === id);
  if (!c) return null;
  const r: TimelineRef = { kind: "caption", id };
  return (
    <div className="space-y-4">
      <h3 className="font-display text-lg font-bold">Caption</h3>
      <div>
        <label htmlFor={`ct-${id}`} className="label">
          Caption text
        </label>
        <textarea
          id={`ct-${id}`}
          className="field min-h-16"
          maxLength={200}
          value={c.text}
          onChange={(e) => apply((x) => ({ ...x, captionTrack: { ...x.captionTrack, cues: x.captionTrack.cues.map((q) => (q.id === id ? { ...q, text: e.target.value || " ", words: [] } : q)) } }), "Edit caption", `cc:${id}`)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TimeField id={`cs-${id}`} label="From" value={c.startMs} onCommit={(ms) => apply((e) => trimRef(e, r, "start", ms), "Trim caption")} />
        <TimeField id={`ce-${id}`} label="To" value={c.endMs} onCommit={(ms) => apply((e) => trimRef(e, r, "end", ms), "Trim caption")} />
      </div>
    </div>
  );
}

function ClassicTextInspector({ id }: { id: string }) {
  const { edl, apply, select } = useEditor();
  const t = edl.texts.find((x) => x.id === id);
  if (!t) return null;
  return (
    <div className="space-y-4">
      <h3 className="font-display text-lg font-bold">Classic text</h3>
      <p className="text-[0.78rem] text-ivory-3">Made with an earlier editor; renders exactly as before. Convert it to get animations and keyframes.</p>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          const nid = edlId("t");
          apply(
            (e) =>
              addOverlayItem(
                { ...e, texts: e.texts.filter((x) => x.id !== id) },
                { type: "text", id: nid, startMs: t.startMs, endMs: t.endMs, x: 0.5, y: t.position === "top" ? 0.12 : t.position === "center" ? 0.5 : 0.78, scale: 1, rotation: 0, opacity: 1, keys: [], text: t.text, subtext: "", style: t.style, animation: "none" },
              ),
            "Convert text",
          );
          select([]);
        }}
      >
        Convert to animated text
      </button>
    </div>
  );
}

export type { Edl };
