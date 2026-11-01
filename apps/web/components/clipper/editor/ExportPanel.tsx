"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ASPECT_SIZE,
  EXPORT_PRESETS,
  edlDurationMs,
  edlLocate,
  outputSize,
  presetProblem,
  type ExportFormat,
  type ExportPresetId,
  type LibraryItemView,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";
import { bytes } from "@/lib/format";
import { useEditor } from "./context";
import { Panel, Segmented, SelectField } from "./fields";

const PRESET_IDS = Object.keys(EXPORT_PRESETS) as ExportPresetId[];

const fileName = (title: string, ext: string) => `${(title || "slot1").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "slot1"}.${ext}`;

/** Export: platform presets (several at once), GIF, audio only, resolution, frame rate and size. */
export function ExportPanel({ renders, onRenders }: { renders: LibraryItemView[]; onRenders: (fn: (r: LibraryItemView[]) => LibraryItemView[]) => void }) {
  const { edl, total, projectId, saveNow, announce, title, playheadMs, sources, sequenceId, sequences } = useEditor();
  const [seqIds, setSeqIds] = useState<string[]>([sequenceId]);
  const targets = sequences.filter((s) => seqIds.includes(s.id));
  const exportSeqs = targets.length ? targets : sequences.filter((s) => s.id === sequenceId);
  const [presets, setPresets] = useState<ExportPresetId[]>(["original"]);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [height, setHeight] = useState<720 | 1080>(1080);
  const [fps, setFps] = useState<24 | 30 | 60>(30);
  const [quality, setQuality] = useState<"high" | "standard" | "small">("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumb, setThumb] = useState({ text: title.slice(0, 60).toUpperCase(), subtext: "", style: "poster" as "poster" | "mission" | "wasted" | "title-card" | "banner", position: "bottom" as "top" | "center" | "bottom" });
  const [thumbBusy, setThumbBusy] = useState(false);

  // A preset is out when any timeline being exported can't take it.
  const problems = Object.fromEntries(
    PRESET_IDS.map((p) => {
      const bad = exportSeqs.map((s) => ({ s, why: presetProblem(p, format, s.id === sequenceId ? total : edlDurationMs(s.edl)) })).find((x) => x.why);
      return [p, bad ? (exportSeqs.length > 1 ? `${bad.s.name}: ${bad.why}` : bad.why) : null];
    }),
  ) as Record<ExportPresetId, string | null>;
  const chosen = presets.filter((p) => !problems[p]);
  const fail = (e: unknown, fallback: string) => setError(e instanceof ApiError ? `${e.message}${e.requirement ? `. ${e.requirement}.` : ""}` : fallback);

  const start = async () => {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await saveNow())) return setError("Fix the edit before exporting");
      const res = await api<{ items: LibraryItemView[] }>(`/api/projects/${projectId}/exports`, { method: "POST", json: { presets: chosen, format, height, fps, quality, sequences: exportSeqs.map((s) => s.id) } });
      onRenders((r) => [...res.items, ...r.filter((x) => !res.items.some((y) => y.id === x.id))]);
      announce(`${res.items.length} export${res.items.length === 1 ? "" : "s"} started`);
    } catch (e) {
      fail(e, "Couldn't start the export");
    } finally {
      setBusy(false);
    }
  };

  const makeThumb = async () => {
    setThumbBusy(true);
    setError(null);
    try {
      if (!(await saveNow())) return setError("Fix the edit before making a thumbnail");
      const item = await api<LibraryItemView>(`/api/projects/${projectId}/thumbnail`, { method: "POST", json: { ...thumb, atMs: Math.round(Math.min(playheadMs, total - 1)), sequenceId } });
      onRenders((r) => [item, ...r]);
      announce("Thumbnail started");
    } catch (e) {
      fail(e, "Couldn't make the thumbnail");
    } finally {
      setThumbBusy(false);
    }
  };

  const still = async () => {
    setError(null);
    const { index, sourceMs } = edlLocate(edl, Math.min(playheadMs, total - 1));
    const s = edl.segments[index]!;
    try {
      await api<LibraryItemView>("/api/library/screenshots", { method: "POST", json: { from: "media", sessionId: s.sessionId, atMs: sourceMs, title: `${title} · frame ${editTime(playheadMs)}`.slice(0, 120) } });
      announce("Frame saved to your library");
    } catch (e) {
      fail(e, "Couldn't save the frame");
    }
  };

  const shape = (p: ExportPresetId) => {
    const aspect = EXPORT_PRESETS[p].aspect ?? edl.aspect;
    const sz = outputSize(aspect, height);
    return `${sz.width}×${sz.height}`;
  };

  return (
    <div className="space-y-8">
      <Panel title="Export">
        {sequences.length > 1 && (
          <fieldset className="mb-4">
            <legend className="label">Timelines</legend>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {sequences.map((s) => (
                <li key={s.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 border hairline px-2.5 py-1.5 text-sm">
                    <input type="checkbox" aria-label={`${s.name} (${s.edl.aspect})`} checked={seqIds.includes(s.id)} onChange={(e) => setSeqIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="tnum text-[0.75rem] text-ivory-3">
                      {s.edl.aspect} · {editTime(s.id === sequenceId ? total : edlDurationMs(s.edl))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[0.75rem] text-ivory-3">One render per timeline and preset ({exportSeqs.length} × {chosen.length}).</p>
          </fieldset>
        )}
        <fieldset>
          <legend className="label">Where it&apos;s going</legend>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {PRESET_IDS.map((p) => {
              const problem = problems[p];
              const on = presets.includes(p);
              return (
                <li key={p}>
                  <label className={`flex h-full items-start gap-2 border px-2.5 py-2 text-sm ${on && !problem ? "border-apricot" : "hairline"} ${problem ? "opacity-60" : ""}`}>
                    <input type="checkbox" className="mt-1 accent-[#ffad72]" checked={on && !problem} disabled={Boolean(problem)} onChange={(e) => setPresets((l) => (e.target.checked ? [...l, p] : l.filter((x) => x !== p)))} />
                    <span className="min-w-0">
                      <span className="font-display text-[1rem] font-bold">{EXPORT_PRESETS[p].label}</span>
                      <span className="tnum ml-1.5 text-[0.75rem] text-ivory-3">{format === "audio" ? "audio" : shape(p)}</span>
                      <span className="block text-[0.74rem] text-ivory-3">{problem ?? EXPORT_PRESETS[p].note}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[0.72rem] text-ivory-3">Length limits are the platforms&apos; published ones as of 2025 and can change; check before posting.</p>
        </fieldset>
        <div className="mt-4 space-y-3">
          <Segmented
            label="File type"
            value={format}
            options={[
              ["mp4", "Video (MP4)"],
              ["gif", "GIF (no sound)"],
              ["audio", "Audio only"],
            ]}
            onChange={setFormat}
          />
          <div className="grid grid-cols-3 gap-2">
            <SelectField id="ex-h" label="Resolution" value={height} options={[[1080, "1080p"], [720, "720p"]] as const} onChange={setHeight} disabled={format !== "mp4"} />
            <SelectField id="ex-fps" label="Frame rate" value={fps} options={[[24, "24 fps"], [30, "30 fps"], [60, "60 fps"]] as const} onChange={setFps} disabled={format === "audio"} />
            <SelectField id="ex-q" label="Quality" value={quality} options={[["high", "High"], ["standard", "Standard"], ["small", "Small file"]] as const} onChange={setQuality} disabled={format !== "mp4"} />
          </div>
          {format === "gif" && <p className="text-[0.75rem] text-ivory-3">GIFs are up to 30 s, 15 fps and 480 px wide (640 for widescreen), without sound.</p>}
        </div>
        <button type="button" className="btn btn-coral mt-4" disabled={busy || chosen.length === 0} onClick={() => void start()}>
          {busy ? "Starting" : chosen.length > 1 ? `Export ${chosen.length} versions` : "Export"}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-sm text-coral">
            {error}
          </p>
        )}
      </Panel>

      <Panel title="Thumbnail">
        <p className="mb-3 text-[0.8rem] text-ivory-3">A 1280×720 PNG from the frame at the playhead ({editTime(playheadMs)}), with big text, saved to your library.</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label htmlFor="th-text" className="label">
              Thumbnail text
            </label>
            <input id="th-text" className="field h-9" maxLength={60} value={thumb.text} onChange={(e) => setThumb((t) => ({ ...t, text: e.target.value }))} />
          </div>
          <div className="col-span-2">
            <label htmlFor="th-sub" className="label">
              Second line
            </label>
            <input id="th-sub" className="field h-9" maxLength={80} value={thumb.subtext} onChange={(e) => setThumb((t) => ({ ...t, subtext: e.target.value }))} />
          </div>
          <SelectField id="th-style" label="Style" value={thumb.style} options={[["poster", "Poster"], ["mission", "Mission"], ["wasted", "Wasted"], ["title-card", "Title card"], ["banner", "Banner"]] as const} onChange={(s) => setThumb((t) => ({ ...t, style: s }))} />
          <SelectField id="th-pos" label="Where" value={thumb.position} options={[["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"]] as const} onChange={(p) => setThumb((t) => ({ ...t, position: p }))} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" disabled={thumbBusy || !thumb.text.trim()} onClick={() => void makeThumb()}>
            {thumbBusy ? "Starting" : "Make thumbnail"}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!sources.some((s) => s.playbackUrl)} onClick={() => void still()}>
            Save this frame (no overlays)
          </button>
        </div>
      </Panel>

      <Panel title="Renders">
        {renders.length === 0 ? (
          <p className="text-sm text-ivory-3">Press Render (or Export) to make a file of this edit. Renders land in your library.</p>
        ) : (
          <ul className="space-y-3">
            {renders.map((r) => {
              const ext = r.format === "gif" ? "gif" : r.format === "audio" ? "m4a" : r.format === "png" ? "png" : "mp4";
              const label = r.kind === "thumbnail" ? "Thumbnail" : r.preset && r.preset !== "original" ? EXPORT_PRESETS[r.preset].label : r.format === "gif" ? "GIF" : r.format === "audio" ? "Audio" : "Render";
              return (
                <li key={r.id} className="border hairline p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="tnum text-sm">
                      <span className="mr-1.5 font-display font-bold">{label}</span>
                      {r.width && r.height ? `${r.width}×${r.height}` : r.format === "audio" ? "AAC" : ASPECT_SIZE[edl.aspect].label}
                      {r.durationMs && r.kind !== "thumbnail" ? `, ${editTime(r.durationMs)}` : ""}
                      {r.bytes ? `, ${bytes(r.bytes)}` : ""}
                    </span>
                    <span className={`text-[0.8rem] ${r.status === "failed" ? "text-coral" : r.status === "ready" ? "text-signal" : "text-apricot"}`}>
                      {r.status === "processing" ? `Rendering ${Math.round((r.progress ?? 0) * 100)}%` : r.status === "ready" ? "Ready" : "Failed"}
                    </span>
                  </div>
                  {r.status === "processing" && (
                    <div role="progressbar" aria-label="Render progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((r.progress ?? 0) * 100)} className="mt-2 h-1 bg-graphite-600">
                      <span className="block h-full bg-apricot transition-[width]" style={{ width: `${Math.max(3, Math.round((r.progress ?? 0) * 100))}%` }} />
                    </div>
                  )}
                  {r.status === "failed" && r.error && <p className="mt-1 text-[0.8rem] text-coral">{r.error}</p>}
                  {r.status === "ready" && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Link href={r.viewPath} className="btn btn-quiet btn-sm px-0">
                        Open
                      </Link>
                      {r.url && (
                        <a href={r.url} download={fileName(title, ext)} className="btn btn-quiet btn-sm">
                          Download
                        </a>
                      )}
                      <Link href="/studio#library" className="btn btn-quiet btn-sm">
                        Share from Library
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
