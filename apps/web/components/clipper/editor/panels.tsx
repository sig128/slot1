"use client";

import { useEffect, useRef, useState } from "react";
import {
  EDL_LIMITS,
  addAudioClip,
  addOverlayItem,
  applyEdlTemplate,
  ASPECT_SIZE,
  EDL_TEMPLATES,
  edlId,
  edlLocate,
  pickOverlayTrack,
  type Edl,
  type OverlayItem,
  type EdlAspect,
  type EdlEffect,
  type GeneratedCaptionsView,
  type GradePreset,
  type MediaRef,
  type ProjectMediaView,
  type StudioAsset,
  type TemplateMarker,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";
import { bytes } from "@/lib/format";
import { useEditor, type EditorCtx } from "./context";
import { Panel, RangeField, Segmented, SelectField, Toggle, pct, secs } from "./fields";

const ASPECTS: EdlAspect[] = ["9:16", "16:9", "1:1"];

/* ------------------------------------------ placing media ---------------------------------- */

/** Put a Studio library item or an upload at the playhead on a suitable track. */
export function placeMedia(
  ctx: Pick<EditorCtx, "apply" | "playheadMs" | "total" | "select" | "announce" | "edl">,
  item: { ref: MediaRef; name: string; kind: "audio" | "image"; audioKind?: "music" | "sfx"; durationMs: number | null; visual?: StudioAsset["kind"] },
  atMs?: number,
) {
  const at = Math.max(0, Math.min(Math.round(atMs ?? ctx.playheadMs), ctx.total - 200));
  const room = ctx.total - at;
  if (item.kind === "audio") {
    const id = edlId("c");
    const music = item.audioKind === "music";
    const len = Math.max(200, Math.min(room, item.durationMs ?? room, music ? room : 30_000));
    ctx.apply(
      (e) => addAudioClip(e, { id, source: item.ref, startMs: at, offsetMs: 0, durationMs: len, volume: music ? 0.8 : 1, fadeInMs: music ? Math.min(400, len / 4) : 0, fadeOutMs: music ? Math.min(800, len / 4) : 0, loop: music && (item.durationMs ?? 0) < room, envelope: [] }, music ? "music" : "sfx"),
      `Add ${item.name}`,
    );
    ctx.announce(`${item.name} added at ${editTime(at)}`);
    return;
  }
  if (item.ref.kind === "session") return;
  const full = item.visual === "frame" || item.visual === "overlay" || item.visual === "transition";
  const len = Math.max(200, Math.min(room, item.visual === "frame" ? room : (item.durationMs ?? 3000)));
  const ov: OverlayItem = { type: "image", id: edlId("i"), startMs: at, endMs: at + len, x: 0.5, y: full ? 0.5 : 0.62, scale: 1, rotation: 0, opacity: 1, keys: [], source: item.ref, widthPct: full ? 1 : 0.32 };
  addOverlayAndSelect(ctx, ov, `Add ${item.name}`);
  ctx.announce(`${item.name} added at ${editTime(at)}`);
}

/** Add an overlay item and select it (the track is decided up front so the selection matches). */
export function addOverlayAndSelect(ctx: Pick<EditorCtx, "apply" | "select" | "edl">, item: OverlayItem, label: string) {
  const trackId = pickOverlayTrack(ctx.edl, item) ?? edlId("ov");
  ctx.apply((e) => addOverlayItem(e, item, trackId, trackId), label);
  ctx.select([{ kind: "overlay", trackId, id: item.id }]);
}

/* --------------------------------------------- format -------------------------------------- */

export function FormatPanel({ markers }: { markers: TemplateMarker[] }) {
  const ctx = useEditor();
  const { edl, apply, replace, total, playheadMs, sources, dims, title, announce } = ctx;
  const cam = sources.find((s) => s.sessionId === edl.segments[0]!.sessionId)?.cameraBox ?? sources.find((s) => s.cameraBox)?.cameraBox ?? null;
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <Panel title="Format">
        <div role="radiogroup" aria-label="Output size" className="grid grid-cols-3 border hairline">
          {ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={edl.aspect === a}
              onClick={() => apply((e) => ({ ...e, aspect: a, layout: a !== "9:16" && e.layout === "split" ? "fit" : e.layout }), "Output size")}
              className={`px-2 py-2 text-left ${edl.aspect === a ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
            >
              <span className="block font-display text-[1.05rem] font-bold leading-none">{ASPECT_SIZE[a].label.split(" ")[0]}</span>
              <span className="tnum mt-0.5 block text-[0.74rem] opacity-80">{ASPECT_SIZE[a].label.split(" ")[1]}</span>
            </button>
          ))}
        </div>
        <div className="mt-3">
          <Segmented
            label="Framing"
            value={edl.layout}
            columns={3}
            options={[
              ["crop", "Fill and reframe"],
              ["fit", "Whole frame, blurred backdrop"],
              ["split", "Facecam + gameplay"],
            ]}
            onChange={(l) =>
              apply(
                (e) => ({
                  ...e,
                  layout: l,
                  aspect: l === "split" ? "9:16" : e.aspect,
                  // First time in split with the default box: start from the creator's camera box.
                  split: l === "split" && cam && e.split.cam.x === 0.73 && e.split.cam.y === 0.02 && e.split.cam.w === 0.26 && e.split.cam.h === 0.3 ? { ...e.split, cam } : e.split,
                }),
                "Framing",
              )
            }
          />
        </div>
        {edl.layout === "split" && (
          <div className="mt-4 space-y-3 border hairline p-3">
            <p className="text-[0.8rem] text-ivory-2">The facecam box (where your camera is in the recording) goes in the {edl.split.camOnTop ? "top" : "bottom"} panel; the gameplay fills the rest.</p>
            <div className="grid grid-cols-2 gap-3">
              {(["x", "y", "w", "h"] as const).map((k) => (
                <RangeField
                  key={k}
                  id={`cam-${k}`}
                  label={k === "x" ? "Camera left" : k === "y" ? "Camera top" : k === "w" ? "Camera width" : "Camera height"}
                  value={Math.round(edl.split.cam[k] * 100)}
                  min={k === "w" || k === "h" ? 5 : 0}
                  max={100}
                  step={1}
                  format={(n) => `${n}%`}
                  onChange={(n) =>
                    apply(
                      (e) => {
                        const b = { ...e.split.cam, [k]: n / 100 };
                        b.w = Math.max(0.05, Math.min(b.w, 1 - b.x));
                        b.h = Math.max(0.05, Math.min(b.h, 1 - b.y));
                        return { ...e, split: { ...e.split, cam: b } };
                      },
                      "Camera box",
                      `cam-${k}`,
                    )
                  }
                />
              ))}
            </div>
            <RangeField id="cam-share" label="Camera panel height" value={Math.round(edl.split.camShare * 100)} min={20} max={60} step={1} format={(n) => `${n}%`} onChange={(n) => apply((e) => ({ ...e, split: { ...e.split, camShare: n / 100 } }), "Camera panel", "cam-share")} />
            <Toggle id="cam-top" label="Camera on top" checked={edl.split.camOnTop} onChange={(b) => apply((e) => ({ ...e, split: { ...e.split, camOnTop: b } }), "Camera position")} />
            {cam ? (
              <button type="button" className="btn btn-quiet btn-sm px-0" onClick={() => apply((e) => ({ ...e, split: { ...e.split, cam } }), "Use camera box")}>
                Use my camera box ({pct(cam.x)}, {pct(cam.y)}, {pct(cam.w)}×{pct(cam.h)})
              </button>
            ) : (
              <p className="text-[0.75rem] text-ivory-3">Tip: draw your camera once in Studio → Stream setup (“Hide your camera from the AI”) and new splits start from that box.</p>
            )}
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <RangeField id="fade-in" label="Fade in" value={edl.fadeInMs} min={0} max={5000} step={100} format={secs} onChange={(v) => apply((e) => ({ ...e, fadeInMs: Math.min(v, Math.max(0, total - e.fadeOutMs)) }), "Fade in", "fade-in")} />
          <RangeField id="fade-out" label="Fade out" value={edl.fadeOutMs} min={0} max={5000} step={100} format={secs} onChange={(v) => apply((e) => ({ ...e, fadeOutMs: Math.min(v, Math.max(0, total - e.fadeInMs)) }), "Fade out", "fade-out")} />
          <div>
            <p className="label">Cover frame</p>
            <p className="tnum text-sm">{edl.coverMs === null ? "Automatic" : editTime(edl.coverMs)}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <button type="button" className="btn btn-quiet btn-sm px-0" onClick={() => apply((e) => ({ ...e, coverMs: Math.round(Math.min(playheadMs, total)) }), "Cover frame")}>
                Use this frame
              </button>
              {edl.coverMs !== null && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => apply((e) => ({ ...e, coverMs: null }), "Cover frame")}>
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Templates">
        <ul className="space-y-2">
          {EDL_TEMPLATES.map((t) => (
            <li key={t.id} className="border hairline p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-[1.05rem] font-bold">{t.name}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const durations = Object.fromEntries(sources.map((s) => [s.sessionId, dims(s.sessionId).durationMs || s.durationMs]));
                    const r = applyEdlTemplate(t.id, edl, { title, markers, cameraBox: cam, durations });
                    if (r.changed) replace(r.edl, t.name);
                    setNote(r.note);
                    announce(r.note);
                  }}
                >
                  Apply<span className="sr-only"> {t.name}</span>
                </button>
              </div>
              <p className="mt-1 text-[0.8rem] text-ivory-3">{t.description}</p>
            </li>
          ))}
        </ul>
        {note && (
          <p className="mt-3 text-[0.82rem] text-ivory-2" role="status">
            {note} Undo restores your edit.
          </p>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------- look --------------------------------------- */

const GRADES: [GradePreset, string][] = [
  ["none", "None"],
  ["vice-night", "Vice City night"],
  ["golden-hour", "Los Santos golden hour"],
  ["noir", "Noir"],
  ["neon", "Neon"],
  ["bleach", "Bleach"],
];
const EFFECT_ADD: [EdlEffect["kind"], string, number][] = [
  ["wasted", "WASTED", 2200],
  ["passed", "MISSION PASSED", 2600],
  ["punch", "Punch-in", 700],
  ["shake", "Shake", 600],
  ["flash", "Flash", 300],
  ["glitch", "Glitch", 450],
];

export function LookPanel() {
  const { edl, apply, playheadMs, total, select, announce } = useEditor();
  const g = edl.grade;
  const set = (patch: Partial<Edl["grade"]>, label: string, key?: string) => apply((e) => ({ ...e, grade: { ...e.grade, ...patch } }), label, key);
  return (
    <div className="space-y-8">
      <Panel title="Look">
        <Segmented label="Colour grade" value={g.preset} columns={2} options={GRADES} onChange={(p) => set({ preset: p }, "Colour grade")} />
        <div className="mt-4 grid grid-cols-2 gap-4">
          <RangeField id="g-b" label="Brightness" value={Math.round(g.brightness * 100)} min={-50} max={50} step={1} format={(v) => `${v > 0 ? "+" : ""}${v}`} onChange={(v) => set({ brightness: v / 100 }, "Brightness", "g-b")} />
          <RangeField id="g-c" label="Contrast" value={Math.round(g.contrast * 100)} min={50} max={180} step={1} format={(v) => `${v}%`} onChange={(v) => set({ contrast: v / 100 }, "Contrast", "g-c")} />
          <RangeField id="g-s" label="Saturation" value={Math.round(g.saturation * 100)} min={0} max={250} step={1} format={(v) => `${v}%`} onChange={(v) => set({ saturation: v / 100 }, "Saturation", "g-s")} />
          <RangeField id="g-v" label="Vignette" value={Math.round(g.vignette * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => set({ vignette: v / 100 }, "Vignette", "g-v")} />
          <RangeField id="g-g" label="Grain" value={Math.round(g.grain * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => set({ grain: v / 100 }, "Grain", "g-g")} />
        </div>
        <button type="button" className="btn btn-quiet btn-sm mt-2 px-0" onClick={() => set({ preset: "none", brightness: 0, contrast: 1, saturation: 1, vignette: 0, grain: 0 }, "Reset look")}>
          Reset look
        </button>
      </Panel>
      <Panel title="Effects">
        <p className="mb-3 text-[0.8rem] text-ivory-3">Added at the playhead ({editTime(playheadMs)}). Original SLOT1 effects in the GTA spirit; no Rockstar audio, fonts or artwork.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {EFFECT_ADD.map(([kind, label, len]) => (
            <button
              key={kind}
              type="button"
              className="btn btn-ghost btn-sm justify-start"
              disabled={edl.effects.length >= 30 || playheadMs >= total - 100}
              onClick={() => {
                const id = edlId("e");
                const a = Math.round(Math.min(playheadMs, total - 200));
                apply((e) => ({ ...e, effects: [...e.effects, { id, kind, startMs: a, endMs: Math.min(total, a + len), text: "", amount: 0.5 }] }), `Add ${label}`);
                select([{ kind: "effect", id }]);
                announce(`${label} added at ${editTime(a)}`);
              }}
            >
              + {label}
            </button>
          ))}
        </div>
        {edl.effects.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {[...edl.effects]
              .sort((a, b) => a.startMs - b.startMs)
              .map((f) => (
                <li key={f.id}>
                  <button type="button" className="flex w-full justify-between gap-2 border hairline px-2 py-1.5 text-left hover:border-line-strong" onClick={() => select([{ kind: "effect", id: f.id }])}>
                    <span>{EFFECT_ADD.find(([k]) => k === f.kind)?.[1] ?? f.kind}</span>
                    <span className="tnum text-ivory-3">
                      {editTime(f.startMs)}–{editTime(f.endMs)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------- text --------------------------------------- */

const QUICK_TEXT = [
  ["Mission title", { text: "MISSION PASSED", subtext: "", style: "mission", animation: "pop", y: 0.3, len: 3000 }],
  ["Title card", { text: "THE HEIST", subtext: "Part 1", style: "title-card", animation: "pop", y: 0.22, len: 2500 }],
  ["Lower third", { text: "your_channel", subtext: "Live on SLOT1", style: "lower-third", animation: "slide", y: 0.84, len: 3500, x: 0.07 }],
  ["Typewriter", { text: "meanwhile, in Los Santos…", subtext: "", style: "caption", animation: "typewriter", y: 0.75, len: 3500 }],
] as const;

export function TextPanel() {
  const ctx = useEditor();
  const { edl, apply, playheadMs, total, select, selection, sources } = ctx;
  const add = (o: { text: string; subtext: string; style: "poster" | "mission" | "title-card" | "lower-third" | "caption"; animation: "pop" | "slide" | "typewriter"; y: number; len: number; x?: number }) => {
    const a = Math.round(Math.min(Math.max(0, total - 500), playheadMs));
    addOverlayAndSelect(ctx, { type: "text", id: edlId("t"), startMs: a, endMs: Math.min(total, a + o.len), x: o.x ?? 0.5, y: o.y, scale: 1, rotation: 0, opacity: 1, keys: [], text: o.text, subtext: o.subtext, style: o.style, animation: o.animation }, "Add text");
  };
  const texts = edl.overlays.flatMap((t) => t.items.flatMap((it) => (it.type === "text" ? [{ t, it }] : [])));
  const sid = edl.segments[edlLocate(edl, playheadMs).index]!.sessionId;
  const cam = ctx.sourceOf(sid)?.cameraBox ?? null;
  return (
    <div className="space-y-8">
      <Panel title="Text">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" disabled={texts.length >= 160} onClick={() => add({ text: "MISSION PASSED", subtext: "", style: "poster", animation: "pop", y: 0.14, len: 3000 })}>
            Add text at playhead
          </button>
          {QUICK_TEXT.map(([label, o]) => (
            <button key={label} type="button" className="btn btn-quiet btn-sm" onClick={() => add({ ...o })}>
              + {label}
            </button>
          ))}
        </div>
        {texts.length === 0 && edl.texts.length === 0 && <p className="mt-3 text-sm text-ivory-3">No text yet.</p>}
        <ul className="mt-3 space-y-3">
          {texts.map(({ t, it }) => {
            const on = selection.some((r) => r.kind === "overlay" && r.id === it.id);
            return (
              <li key={it.id} className={`border p-3 ${on ? "border-ivory-2" : "hairline"}`}>
                <label htmlFor={`tx-${it.id}`} className="sr-only">
                  Text
                </label>
                <input
                  id={`tx-${it.id}`}
                  className="field h-9"
                  value={it.text}
                  maxLength={160}
                  disabled={t.locked}
                  onChange={(e) => apply((x) => ({ ...x, overlays: x.overlays.map((tr) => (tr.id !== t.id ? tr : { ...tr, items: tr.items.map((q) => (q.id === it.id && q.type === "text" ? { ...q, text: e.target.value || " " } : q)) })) }), "Edit text", `ov:${it.id}:text`)}
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[0.8rem] text-ivory-3">
                  <span className="tnum">
                    {it.style} · {it.animation} · {editTime(it.startMs)}–{editTime(it.endMs)}
                  </span>
                  <span className="flex gap-1">
                    <button type="button" className="btn btn-quiet btn-sm px-1.5" onClick={() => select([{ kind: "overlay", trackId: t.id, id: it.id }])}>
                      Edit<span className="sr-only"> “{it.text}”</span>
                    </button>
                    <button type="button" className="btn btn-quiet btn-sm px-1.5 text-coral" disabled={t.locked} onClick={() => apply((x) => ({ ...x, overlays: x.overlays.map((tr) => (tr.id !== t.id ? tr : { ...tr, items: tr.items.filter((q) => q.id !== it.id) })) }), "Remove text")}>
                      Remove<span className="sr-only"> “{it.text}”</span>
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[0.78rem] text-ivory-3">Rendered in Passion One (SIL Open Font License).</p>
      </Panel>
      <Panel title="Picture in picture">
        <p className="mb-2 text-[0.8rem] text-ivory-3">Another moment, or part of the picture (like your facecam), in a small window.</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!sources.some((s) => s.playbackUrl)}
          onClick={() => {
            const a = Math.round(Math.min(Math.max(0, total - 500), playheadMs));
            const src = edlLocate(edl, a).sourceMs;
            addOverlayAndSelect(ctx, { type: "pip", id: edlId("p"), startMs: a, endMs: Math.min(total, a + 3000), x: 0.74, y: 0.78, scale: 1, rotation: 0, opacity: 1, keys: [], sessionId: sid, sourceInMs: src, box: cam ?? { x: 0, y: 0, w: 1, h: 1 }, widthPct: 0.38, border: true }, "Add picture in picture");
          }}
        >
          Add picture in picture
        </button>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------- audio -------------------------------------- */

export function AudioPanel() {
  const { edl, apply } = useEditor();
  const sa = edl.sourceAudio;
  return (
    <div className="space-y-8">
      <Panel title="Audio">
        <h3 className="font-display text-lg font-bold">Game audio</h3>
        <div className="mt-2 grid grid-cols-2 gap-4">
          <RangeField id="volume" label="Volume" value={Math.round(edl.volume * 100)} min={0} max={200} step={5} format={(v) => `${v}%`} onChange={(v) => apply((e) => ({ ...e, volume: v / 100 }), "Volume", "volume")} />
        </div>
        <div className="mt-3 space-y-2">
          <Toggle id="sa-mute" label="Mute game audio" checked={sa.muted} onChange={(b) => apply((e) => ({ ...e, sourceAudio: { ...e.sourceAudio, muted: b } }), "Mute game audio")} />
          <Toggle id="sa-dn" label="Reduce background noise" hint="An FFT noise filter for steady hiss and hum." checked={sa.denoise} onChange={(b) => apply((e) => ({ ...e, sourceAudio: { ...e.sourceAudio, denoise: b } }), "Noise reduction")} />
          <Toggle id="sa-vb" label="Voice boost" hint="EQ and compression on the voice band. Your voice and the game share one stream, so game sound in that band is lifted too." checked={sa.voiceBoost} onChange={(b) => apply((e) => ({ ...e, sourceAudio: { ...e.sourceAudio, voiceBoost: b } }), "Voice boost")} />
          <Toggle id="norm" label="Normalize loudness" hint="About −14 LUFS, a common platform target, with a peak limiter." checked={edl.normalize} onChange={(b) => apply((e) => ({ ...e, normalize: b }), "Normalize")} />
        </div>
        {edl.volume > 1 && <p className="mt-2 text-[0.78rem] text-ivory-3">The preview plays at full volume; the boost above 100% is applied in the render.</p>}
      </Panel>

      <Panel title="Audio tracks">
        {edl.audioTracks.length === 0 && <p className="text-sm text-ivory-3">No music or sound effects yet. Pick them in the Library tab: SLOT1 sounds or your own uploads.</p>}
        <ul className="space-y-3">
          {edl.audioTracks.map((t) => {
            const set = (patch: Partial<typeof t>, label: string, key?: string) => apply((e) => ({ ...e, audioTracks: e.audioTracks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) }), label, key);
            return (
              <li key={t.id} className="space-y-3 border hairline p-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor={`tn-${t.id}`} className="label">
                      Track name
                    </label>
                    <input id={`tn-${t.id}`} className="field h-9" maxLength={40} value={t.name} onChange={(e) => set({ name: e.target.value || "Audio" }, "Rename track", `tn-${t.id}`)} />
                  </div>
                  <SelectField id={`tk-${t.id}`} label="Kind" value={t.kind} options={[["music", "Music"], ["sfx", "Sound effects"], ["voice", "Voice"]] as const} onChange={(k) => set({ kind: k }, "Track kind")} />
                </div>
                <RangeField id={`tv-${t.id}`} label="Track volume" value={Math.round(t.volume * 100)} min={0} max={200} step={5} format={(v) => `${v}%`} onChange={(v) => set({ volume: v / 100 }, "Track volume", `tv-${t.id}`)} />
                <Toggle
                  id={`td-${t.id}`}
                  label="Duck under speech"
                  hint="Lowers this track while the game audio has sound in the voice band. Your voice and the game are one mixed stream that can't be separated, so loud game sound in that band ducks it too."
                  checked={t.duck}
                  onChange={(b) => set({ duck: b }, "Ducking")}
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-[0.8rem] text-ivory-3">
                  <span>
                    {t.clips.length} clip{t.clips.length === 1 ? "" : "s"}
                  </span>
                  <button type="button" className="btn btn-quiet btn-sm px-1.5 text-coral" onClick={() => apply((e) => ({ ...e, audioTracks: e.audioTracks.filter((x) => x.id !== t.id) }), "Remove track")}>
                    Remove track<span className="sr-only"> {t.name}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-3"
          disabled={edl.audioTracks.length >= EDL_LIMITS.audioTracks}
          onClick={() => apply((e) => ({ ...e, audioTracks: [...e.audioTracks, { id: edlId("au"), name: `Audio ${e.audioTracks.length + 1}`, kind: "sfx", muted: false, solo: false, locked: false, volume: 1, duck: false, clips: [] }] }), "Add track")}
        >
          Add audio track
        </button>
      </Panel>
    </div>
  );
}

/** The creator's own files for edits: upload (with a rights confirmation), place, delete. */
export function UploadsPanel() {
  const { uploads, setUploads, projectId, announce } = useEditor();
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return setErr("Choose a file first");
    if (!rights) return setErr("Confirm you own the file or have the rights to use it");
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("rightsConfirmed", "true");
      fd.append("projectId", projectId);
      fd.append("name", f.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Upload");
      fd.append("file", f);
      const m = await api<ProjectMediaView>("/api/editor/media", { method: "POST", body: fd });
      setUploads((list) => [m, ...list]);
      if (file.current) file.current.value = "";
      announce(`${m.name} uploaded`);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.requirement ? `. ${e.requirement}` : ""}` : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-8">
      <Panel title="Your uploads">
        <div className="space-y-3">
          <div>
            <label htmlFor="media-file" className="label">
              Music, voice-over, logo or sticker
            </label>
            <input id="media-file" ref={file} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,image/png,image/jpeg,image/webp,image/gif" className="block w-full text-sm file:mr-3 file:border file:border-line-strong file:bg-transparent file:px-3 file:py-1.5 file:text-ivory" />
          </div>
          <Toggle id="media-rights" label="I own this file or have the rights to use it in my videos" checked={rights} onChange={setRights} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void upload()}>
            {busy ? "Uploading" : "Upload"}
          </button>
          {err && (
            <p role="alert" className="text-[0.8rem] text-coral">
              {err}
            </p>
          )}
          <p className="text-[0.75rem] text-ivory-3">Audio up to 50 MB and 20 minutes; images up to 10 MB. Uploads stay private to your channel.</p>
        </div>
        <UploadList uploads={uploads} />
      </Panel>
    </div>
  );
}

function UploadList({ uploads }: { uploads: ProjectMediaView[] }) {
  const ctx = useEditor();
  const { setUploads, announce } = ctx;
  if (uploads.length === 0) return null;
  return (
    <ul className="mt-4 space-y-2">
      {uploads.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border hairline px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {m.name}
            <span className="ml-2 text-[0.78rem] text-ivory-3">
              {m.kind === "audio" ? (m.durationMs ? editTime(m.durationMs) : "audio") : m.width && m.height ? `${m.width}×${m.height}` : "image"} · {bytes(m.bytes)}
            </span>
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              className="btn btn-quiet btn-sm px-1.5"
              onClick={() => placeMedia(ctx, { ref: { kind: "upload", assetId: m.id }, name: m.name, kind: m.kind, audioKind: "music", durationMs: m.durationMs, visual: "sticker" })}
            >
              Add at playhead<span className="sr-only"> {m.name}</span>
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-sm px-1.5 text-coral"
              onClick={() => {
                void api(`/api/editor/media/${m.id}`, { method: "DELETE" })
                  .then(() => {
                    setUploads((l) => l.filter((x) => x.id !== m.id));
                    announce(`${m.name} deleted`);
                  })
                  .catch(() => announce("Couldn't delete the file"));
              }}
            >
              Delete<span className="sr-only"> {m.name}</span>
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------- captions ------------------------------------ */

export function CaptionsPanel() {
  const ctx = useEditor();
  const { edl, apply, playheadMs, total, select, projectId, saveNow, announce, sources, sequenceId } = ctx;
  const ct = edl.captionTrack;
  const [gen, setGen] = useState<GeneratedCaptionsView | null>(null);
  const [err, setErr] = useState<{ message: string; requirement: string | null } | null>(null);
  const captionLines = sources.reduce((n, s) => n + s.captionLines, 0);

  useEffect(() => {
    if (gen?.status !== "pending") return;
    const t = setInterval(() => {
      api<GeneratedCaptionsView>(`/api/projects/${projectId}/captions`)
        .then(setGen)
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(t);
  }, [gen?.status, projectId]);

  const generate = async () => {
    setErr(null);
    if (!(await saveNow())) return setErr({ message: "Save the edit first: it has a problem", requirement: null });
    try {
      setGen(await api<GeneratedCaptionsView>(`/api/projects/${projectId}/captions`, { method: "POST", json: { sequenceId } }));
    } catch (e) {
      setErr(e instanceof ApiError ? { message: e.message, requirement: e.requirement } : { message: "Couldn't start captions", requirement: null });
    }
  };

  return (
    <div className="space-y-8">
      <Panel title="Captions">
        <Segmented
          label="Caption style"
          value={ct.style}
          options={[
            ["karaoke", "Word highlight"],
            ["line", "Subtitle"],
            ["bold-pop", "Big words"],
          ]}
          onChange={(s) => apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, style: s } }), "Caption style")}
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <SelectField id="cc-pos" label="Where" value={ct.position} options={[["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"]] as const} onChange={(p) => apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, position: p } }), "Caption position")} />
          <div className="self-end">
            <Toggle id="cc-hide" label="Hide captions" checked={ct.hidden} onChange={(b) => apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, hidden: b } }), "Hide captions")} />
          </div>
        </div>
        <div className="mt-4 space-y-2 border hairline p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-lg font-bold">Generate captions</h3>
            <button type="button" className="btn btn-ghost btn-sm" disabled={gen?.status === "pending"} onClick={() => void generate()}>
              {gen?.status === "pending" ? "Transcribing…" : "Generate captions"}
            </button>
          </div>
          <p className="text-[0.78rem] text-ivory-3">Transcribes the edit&apos;s audio with the server&apos;s transcription provider. Check the words: speech under loud game audio is hard to hear.</p>
          {err && (
            <p role="alert" className="text-[0.82rem] text-coral">
              {err.message}
              {err.requirement && <span className="mt-1 block text-ivory-2">{err.requirement}</span>}
            </p>
          )}
          {gen?.status === "failed" && <p className="text-[0.82rem] text-coral">{gen.error ?? "Transcription failed"}</p>}
          {gen?.status === "ready" && gen.sequenceId !== sequenceId && <p className="text-[0.82rem] text-ivory-2">The last captions were made for another timeline. Generate them again for this one.</p>}
          {gen?.status === "ready" && gen.sequenceId === sequenceId && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{gen.cues.length ? `${gen.cues.length} captions ready.` : "No speech was found."}</span>
              {gen.cues.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, cues: gen.cues.filter((c) => c.startMs < total).map((c) => ({ ...c, endMs: Math.min(c.endMs, total) })) } }), "Generated captions");
                    announce(`${gen.cues.length} captions added`);
                  }}
                >
                  Use them{ct.cues.length ? " (replaces yours)" : ""}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={ct.cues.length >= 400 || playheadMs >= total - 200}
            onClick={() => {
              const id = edlId("k");
              const a = Math.round(Math.min(playheadMs, total - 300));
              apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, cues: [...e.captionTrack.cues, { id, startMs: a, endMs: Math.min(total, a + 2000), text: "type what's said", words: [] }].sort((x, y) => x.startMs - y.startMs) } }), "Add caption");
              select([{ kind: "caption", id }]);
            }}
          >
            Add caption at playhead
          </button>
          {ct.cues.length > 0 && (
            <button type="button" className="btn btn-quiet btn-sm text-coral" onClick={() => apply((e) => ({ ...e, captionTrack: { ...e.captionTrack, cues: [] } }), "Clear captions")}>
              Clear all
            </button>
          )}
        </div>
        <ol className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {ct.cues.map((c) => (
            <li key={c.id} className="grid grid-cols-[auto_1fr] items-center gap-2">
              <button type="button" className="tnum text-[0.78rem] text-ivory-3 underline decoration-line-strong underline-offset-2" onClick={() => select([{ kind: "caption", id: c.id }])}>
                {editTime(c.startMs)}
              </button>
              <label className="sr-only" htmlFor={`cq-${c.id}`}>
                Caption at {editTime(c.startMs)}
              </label>
              <input id={`cq-${c.id}`} className="field h-8 text-sm" maxLength={200} value={c.text} onChange={(e) => apply((x) => ({ ...x, captionTrack: { ...x.captionTrack, cues: x.captionTrack.cues.map((q) => (q.id === c.id ? { ...q, text: e.target.value || " ", words: [] } : q)) } }), "Edit caption", `cc:${c.id}`)} />
            </li>
          ))}
        </ol>
        <div className="mt-4 border-t hairline pt-3">
          <Toggle
            id="legacy-cc"
            label="Also burn in the session transcript"
            hint={captionLines === 0 ? "No transcript exists for this video yet." : `${captionLines} transcript line${captionLines === 1 ? "" : "s"}; lines inside your segments are captioned in the render (older caption style).`}
            checked={edl.captions}
            disabled={captionLines === 0 && !edl.captions}
            onChange={(b) => apply((e) => ({ ...e, captions: b }), "Transcript captions")}
          />
        </div>
      </Panel>
    </div>
  );
}
