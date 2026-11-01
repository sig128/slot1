"use client";

import { useState } from "react";
import {
  edlId,
  EDL_LIMITS,
  refSpan,
  removeMarker,
  updateMarker,
  type Edl,
  type EdlEffect,
  type EffectKind,
  type MarkerColor,
  type ProjectView,
  type TemplateMarker,
} from "@slot1/contracts";
import { ClipAiPanel } from "../ai/ClipAiPanel";
import { useEditor } from "../editor/context";
import { SegmentsPanel, SelectionPanel } from "../editor/Inspector";
import { AudioPanel, CaptionsPanel, FormatPanel, LookPanel, TextPanel } from "../editor/panels";
import { timecode } from "./util";

export type InspectorTab = "clip" | "effects" | "look" | "text" | "audio" | "captions" | "format" | "markers" | "ai";
export const INSPECTOR_TABS: [InspectorTab, string][] = [
  ["clip", "Clip"],
  ["effects", "Effects"],
  ["look", "Look"],
  ["text", "Text"],
  ["audio", "Audio"],
  ["captions", "Captions"],
  ["format", "Format"],
  ["markers", "Markers"],
  ["ai", "AI"],
];

const EFFECT_LABEL: Record<EffectKind, string> = { wasted: "Wasted", passed: "Mission passed", punch: "Punch zoom", shake: "Shake", flash: "Flash", glitch: "Glitch" };

interface Props {
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  aiProject: ProjectView;
  onApplyEdl: (next: Edl) => void;
  templateMarkers: TemplateMarker[];
  fps: number;
  selectedMarker: string | null;
  onSelectMarker: (id: string | null) => void;
}

/** The right-hand inspector: properties of the selection and of the whole edit, in tabs. */
export function InspectorDock(p: Props) {
  return (
    <section aria-label="Inspector" className="nle-inspector">
      <div role="tablist" aria-label="Editor panels" className="nle-tabs nle-tabs-wrap">
        {INSPECTOR_TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={p.tab === id} aria-controls={`panel-${id}`} onClick={() => p.onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${p.tab}`} aria-labelledby={`tab-${p.tab}`} className="nle-insp-body">
        {p.tab === "clip" && (
          <>
            <section aria-label="Selected" className="min-w-0">
              <h2 className="nle-h">Selected</h2>
              <SelectionPanel />
            </section>
            <SegmentsPanel />
          </>
        )}
        {p.tab === "effects" && <EffectsStack />}
        {p.tab === "look" && <LookPanel />}
        {p.tab === "text" && <TextPanel />}
        {p.tab === "audio" && <AudioPanel />}
        {p.tab === "captions" && <CaptionsPanel />}
        {p.tab === "format" && <FormatPanel markers={p.templateMarkers} />}
        {p.tab === "markers" && <MarkersPanel fps={p.fps} selected={p.selectedMarker} onSelect={p.onSelectMarker} />}
        {p.tab === "ai" && (
          <section aria-label="AI assistant" className="min-w-0">
            <ClipAiPanel project={p.aiProject} edl={p.aiProject.edl} onApplyEdl={p.onApplyEdl} />
          </section>
        )}
      </div>
    </section>
  );
}

/**
 * Effects over the picture, in render order (top of the list renders first). The list shows the
 * effects under the selected clip, or all of them.
 */
function EffectsStack() {
  const { edl, apply, selection, select, playheadMs, total, announce } = useEditor();
  const [all, setAll] = useState(false);
  const [kind, setKind] = useState<EffectKind>("punch");
  const span = selection.map((r) => refSpan(edl, r)).find((s) => s !== null) ?? null;
  const target = span ?? { startMs: Math.round(Math.min(playheadMs, Math.max(0, total - 600))), endMs: Math.round(Math.min(total, playheadMs + 1500)) };
  const list = edl.effects.map((f, i) => ({ f, i })).filter(({ f }) => all || !span || (f.endMs > span.startMs && f.startMs < span.endMs));
  const set = (id: string, patch: Partial<EdlEffect>, label: string, key?: string) => apply((e) => ({ ...e, effects: e.effects.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), label, key);
  const move = (i: number, by: -1 | 1) =>
    apply((e) => {
      const j = i + by;
      if (j < 0 || j >= e.effects.length) return e;
      const fx = [...e.effects];
      [fx[i], fx[j]] = [fx[j]!, fx[i]!];
      return { ...e, effects: fx };
    }, "Reorder effects");

  return (
    <section aria-label="Effects" className="min-w-0">
      <h2 className="nle-h">Effects</h2>
      <p className="nle-note">{span ? `Under the selection, ${timecode(span.startMs)} to ${timecode(span.endMs)}.` : "Nothing selected: new effects go at the playhead."}</p>
      <div className="nle-fx-add">
        <label className="sr-only" htmlFor="fx-kind">
          Effect to add
        </label>
        <select id="fx-kind" className="nle-select" value={kind} onChange={(e) => setKind(e.target.value as EffectKind)}>
          {(Object.keys(EFFECT_LABEL) as EffectKind[]).map((k) => (
            <option key={k} value={k}>
              {EFFECT_LABEL[k]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="nle-btn nle-btn-gold"
          disabled={edl.effects.length >= EDL_LIMITS.effects || target.endMs - target.startMs < 100}
          onClick={() => {
            const id = edlId("f");
            apply((e) => ({ ...e, effects: [...e.effects, { id, kind, startMs: target.startMs, endMs: target.endMs, text: "", amount: 0.5, enabled: true }] }), "Add effect");
            announce(`${EFFECT_LABEL[kind]} added`);
          }}
        >
          Add effect
        </button>
        <label className="nle-check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all
        </label>
      </div>
      {list.length === 0 ? (
        <div className="nle-empty nle-empty-card">
          <b>No effects here</b>
          <span>Add one above, or let the AI tab suggest some.</span>
        </div>
      ) : (
        <ol className="nle-fx-list" aria-label="Effect stack">
          {list.map(({ f, i }) => (
            <li key={f.id} className={f.enabled === false ? "is-off" : undefined}>
              <div className="nle-fx-row">
                <input type="checkbox" aria-label={`${EFFECT_LABEL[f.kind]} on`} checked={f.enabled !== false} onChange={(e) => set(f.id, { enabled: e.target.checked }, e.target.checked ? "Turn effect on" : "Turn effect off")} />
                <button type="button" className="nle-linkish" onClick={() => select([{ kind: "effect", id: f.id }])}>
                  {EFFECT_LABEL[f.kind]}
                </button>
                <span className="nle-fx-time tnum">
                  {timecode(f.startMs)}–{timecode(f.endMs)}
                </span>
                <button type="button" className="nle-tgl" aria-label={`Move ${EFFECT_LABEL[f.kind]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="nle-tgl" aria-label={`Move ${EFFECT_LABEL[f.kind]} down`} disabled={i === edl.effects.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="nle-tgl" aria-label={`Remove ${EFFECT_LABEL[f.kind]}`} onClick={() => apply((e) => ({ ...e, effects: e.effects.filter((x) => x.id !== f.id) }), "Remove effect")}>
                  ×
                </button>
              </div>
              {(f.kind === "punch" || f.kind === "shake" || f.kind === "glitch") && (
                <label className="nle-fx-amount">
                  <span>Amount</span>
                  <input type="range" min={0} max={1} step={0.05} value={f.amount} onChange={(e) => set(f.id, { amount: Number(e.target.value) }, "Effect amount", `fx-amt:${f.id}`)} />
                  <span className="tnum">{Math.round(f.amount * 100)}%</span>
                </label>
              )}
              {(f.kind === "wasted" || f.kind === "passed") && (
                <label className="nle-fx-amount">
                  <span>Banner</span>
                  <input className="nle-input" maxLength={60} placeholder={f.kind === "wasted" ? "WASTED" : "MISSION PASSED"} value={f.text} onChange={(e) => set(f.id, { text: e.target.value }, "Banner text", `fx-txt:${f.id}`)} />
                </label>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="nle-note">Effects render in list order. Turned-off effects stay in the edit but are skipped in the preview and the render.</p>
    </section>
  );
}

const COLORS: MarkerColor[] = ["red", "gold", "blue", "green", "violet"];

function MarkersPanel({ fps, selected, onSelect }: { fps: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const { edl, apply, seek } = useEditor();
  const markers = edl.markers ?? [];
  return (
    <section aria-label="Markers" className="min-w-0">
      <h2 className="nle-h">Markers</h2>
      <p className="nle-note">Press M to drop a marker at the playhead. Markers are notes for you; they never show in the render.</p>
      {markers.length === 0 ? (
        <div className="nle-empty nle-empty-card">
          <b>No markers yet</b>
          <span>Mark the beats you want to cut on.</span>
        </div>
      ) : (
        <ol className="nle-marker-list">
          {markers.map((m) => (
            <li key={m.id} className={selected === m.id ? "is-on" : undefined}>
              <button type="button" className={`nle-swatch flag-${m.color}`} aria-label={`Colour: ${m.color}. Change`} onClick={() => apply((e) => updateMarker(e, m.id, { color: COLORS[(COLORS.indexOf(m.color) + 1) % COLORS.length]! }), "Marker colour")} />
              <button
                type="button"
                className="nle-linkish tnum"
                onClick={() => {
                  onSelect(m.id);
                  seek(m.atMs);
                }}
              >
                {timecode(m.atMs, fps)}
              </button>
              <label className="sr-only" htmlFor={`mk-${m.id}`}>
                Marker note
              </label>
              <input id={`mk-${m.id}`} className="nle-input" maxLength={80} placeholder="Note" value={m.label} onChange={(e) => apply((ed) => updateMarker(ed, m.id, { label: e.target.value }), "Marker note", `mk:${m.id}`)} />
              <button type="button" className="nle-tgl" aria-label="Delete marker" onClick={() => apply((e) => removeMarker(e, m.id), "Delete marker")}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
