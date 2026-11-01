"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  allRefs,
  ASPECT_SIZE,
  deleteRefs,
  Edl,
  edlDurationMs,
  edlEdges,
  edlLocate,
  edlOutputTime,
  markerOutputMs,
  refSpan,
  splitAt,
  trimSegment,
  type LibraryItemView,
  type MediaRef,
  type ProjectMediaView,
  type ProjectView,
  type StudioAsset,
  type StudioAssetKind,
  type StudioAssetsResponse,
  type TemplateMarker,
  type TimelineRef,
  type WaveformView,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";
import { AssetLibraryPanel } from "./library/AssetLibraryPanel";
import { ClipAiPanel } from "./ai/ClipAiPanel";
import { EditorTimeline, type TimelineMarker } from "./EditorTimeline";
import { EditorContext, type EditorCtx } from "./editor/context";
import { ExportPanel } from "./editor/ExportPanel";
import { SegmentsPanel, SelectionPanel } from "./editor/Inspector";
import { AudioPanel, CaptionsPanel, FormatPanel, LookPanel, placeMedia, TextPanel, UploadsPanel } from "./editor/panels";
import { PreviewStage, type MediaInfo, type PreviewHandle } from "./editor/PreviewStage";
import { SourceTimeline } from "./editor/SourceTimeline";
import { useEditHistory } from "./editor/useEditHistory";

type Mode = "source" | "program";
type SaveState = "saved" | "saving" | "error";
type Tab = "clip" | "format" | "look" | "text" | "audio" | "captions" | "library" | "ai" | "export";

const TABS: [Tab, string][] = [
  ["clip", "Clip"],
  ["format", "Format"],
  ["look", "Look"],
  ["text", "Text"],
  ["audio", "Audio"],
  ["captions", "Captions"],
  ["library", "Library"],
  ["ai", "AI"],
  ["export", "Export"],
];
const ratio = (a: Edl["aspect"]) => ASPECT_SIZE[a].width / ASPECT_SIZE[a].height;
const AUDIO_KINDS: StudioAssetKind[] = ["sfx", "music", "ambience"];

const SHORTCUTS: [string, string][] = [
  ["Space", "Play or pause"],
  ["J / K / L", "Back one second / pause / play (L again: 2× and 4× in Source)"],
  ["← / →", "One frame back or forward (Shift: one second)"],
  ["↑ / ↓", "Previous or next edit point"],
  ["Home / End", "Start or end of the edit"],
  ["I / O", "Source: set the segment's in or out point. Edit: trim the segment under the playhead"],
  ["S", "Split at the playhead (the selected clip, or the video)"],
  ["Delete", "Delete the selection (video closes its gap)"],
  ["Shift + Delete", "Ripple delete: close the gaps on every track"],
  ["Ctrl/⌘ + Z", "Undo"],
  ["Ctrl/⌘ + Shift + Z, Ctrl + Y", "Redo"],
  ["+ / − / \\", "Zoom the timeline in, out, or to fit"],
  ["N", "Snapping on or off"],
  ["Alt while trimming", "Roll the cut (next segment gives up the time)"],
  ["?", "This list"],
  ["Esc", "Clear the selection"],
];

export function ClipEditor({ initial }: { initial: ProjectView }) {
  const history = useEditHistory(initial.edl);
  const { edl, apply, replace } = history;
  const [title, setTitle] = useState(initial.title);
  const [titleRev, setTitleRev] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ProjectView>(initial);
  const [renders, setRenders] = useState<LibraryItemView[]>(initial.renders);
  const [rendering, setRendering] = useState(false);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [srcSession, setSrcSession] = useState(initial.edl.segments[0]!.sessionId);
  const [srcPos, setSrcPos] = useState(initial.edl.segments[0]!.inMs);
  const [outPos, setOutPos] = useState(0);
  const [dimsMap, setDims] = useState<Record<string, { width: number; height: number; durationMs: number }>>({});
  const [srcZoom, setSrcZoom] = useState<{ start: number; end: number } | null>(null);
  const [pps, setPps] = useState(60);
  const [selection, setSelection] = useState<TimelineRef[]>([{ kind: "segment", id: initial.edl.segments[0]!.id }]);
  const [activeSeg, setActiveSeg] = useState(initial.edl.segments[0]!.id);
  const [tab, setTab] = useState<Tab>("clip");
  const [snapping, setSnapping] = useState(true);
  const [rollMode, setRollMode] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [uploads, setUploads] = useState<ProjectMediaView[]>([]);
  const [library, setLibrary] = useState<StudioAssetsResponse | null>(null);
  const [waves, setWaves] = useState<Record<string, WaveformView>>({});
  const [uploadPeaks, setUploadPeaks] = useState<Record<string, { peaks: number[]; durationMs: number } | null>>({});
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const preview = useRef<PreviewHandle>(null);

  const sources = initial.sources;
  const sourceOf = useCallback((id: string) => sources.find((s) => s.sessionId === id), [sources]);
  const validation = useMemo(() => Edl.safeParse(edl), [edl]);
  const invalid = validation.success ? null : (validation.error.issues[0]?.message ?? "This edit isn't valid yet");
  const total = edlDurationMs(edl);
  const announce = useCallback((m: string) => setAnnouncement(m), []);
  const dims = useCallback(
    (id: string) => {
      const s = sourceOf(id);
      return dimsMap[id] ?? { width: s?.width ?? 1920, height: s?.height ?? 1080, durationMs: s?.durationMs ?? 0 };
    },
    [dimsMap, sourceOf],
  );
  const maxSourceMs = useCallback((id: string) => dims(id).durationMs || Number.MAX_SAFE_INTEGER, [dims]);

  // Selection follows the edit: undo/redo or deletes can remove what was selected.
  const sel = useMemo(() => selection.filter((r) => refSpan(edl, r) !== null), [selection, edl]);
  const active = edl.segments.find((s) => s.id === activeSeg) ?? edl.segments.find((s) => s.sessionId === srcSession) ?? edl.segments[0]!;
  const activeIdx = edl.segments.indexOf(active);
  const playhead = mode === "program" ? outPos : srcPos >= active.inMs && srcPos <= active.outMs && srcSession === active.sessionId ? edlOutputTime(edl, activeIdx, srcPos) : outPos;
  const select = useCallback((refs: TimelineRef[]) => {
    setSelection(refs);
    const seg = refs.find((r) => r.kind === "segment");
    if (seg) setActiveSeg(seg.id);
  }, []);

  /* ------------------------------------------ saving ---------------------------------------- */

  const dirty = history.rev > 0 || titleRev > 0;
  const [savedRev, setSavedRev] = useState({ edl: 0, title: 0 });
  const doSave = useCallback(
    async (data: Edl, t: string): Promise<boolean> => {
      setSave("saving");
      try {
        const v = await api<ProjectView>(`/api/projects/${initial.id}`, { method: "PATCH", json: { title: t.trim() || initial.title, edl: data } });
        setSave("saved");
        setSaved(v);
        setRenders((r) => mergeRenders(r, v.renders));
        setError(null);
        return true;
      } catch (err) {
        setSave("error");
        setError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}` : ""}` : "Couldn't save the edit");
        return false;
      }
    },
    [initial.id, initial.title],
  );
  useEffect(() => {
    if (!dirty || !validation.success) return;
    const data = validation.data;
    const t = setTimeout(() => {
      setSavedRev({ edl: history.rev, title: titleRev });
      void doSave(data, title);
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, validation, title, titleRev, history.rev, doSave]);
  const pendingChanges = dirty && (savedRev.edl !== history.rev || savedRev.title !== titleRev);
  const saveLabel = !dirty ? "Saved" : !validation.success ? "Not saved: fix the edit" : save === "saving" ? "Saving" : save === "error" ? "Not saved" : pendingChanges ? "Unsaved changes" : "Saved";
  const saveNow = useCallback(async () => {
    if (!validation.success) return false;
    setSavedRev({ edl: history.rev, title: titleRev });
    return doSave(validation.data, title);
  }, [validation, history.rev, titleRev, doSave, title]);

  // Renders and thumbnails run in the background: poll while one is processing.
  const busy = renders.some((r) => r.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      api<ProjectView>(`/api/projects/${initial.id}`)
        .then((v) => setRenders((r) => mergeRenders(r, v.renders)))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [busy, initial.id]);

  const render = async () => {
    setRendering(true);
    setError(null);
    try {
      if (!(await saveNow())) return;
      const item = await api<LibraryItemView>(`/api/projects/${initial.id}/render`, { method: "POST" });
      setRenders((r) => [item, ...r.filter((x) => x.id !== item.id)]);
      setTab("export");
      announce("Render started");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}.` : ""}` : "Couldn't start the render");
    } finally {
      setRendering(false);
    }
  };

  /* ----------------------------------------- media --------------------------------------- */

  useEffect(() => {
    api<{ media: ProjectMediaView[] }>("/api/editor/media")
      .then((r) => setUploads(r.media))
      .catch(() => undefined);
    api<StudioAssetsResponse>("/api/studio/assets")
      .then(setLibrary)
      .catch(() => undefined);
  }, []);

  // Timeline waveforms of the sessions in the edit (built once on the server, then cached).
  const sessionIds = useMemo(() => [...new Set(edl.segments.map((s) => s.sessionId))], [edl.segments]);
  useEffect(() => {
    let stop = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = (id: string, tries: number) => {
      api<WaveformView>(`/api/editor/waveform/${id}`)
        .then((w) => {
          if (stop) return;
          setWaves((m) => ({ ...m, [id]: w }));
          if (w.status === "pending" && tries < 20) timers.push(setTimeout(() => load(id, tries + 1), 3000));
        })
        .catch(() => undefined);
    };
    for (const id of sessionIds) if (!waves[id] || waves[id]!.status === "pending") load(id, 0);
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
    };
    // Waveforms only need loading once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIds.join(",")]);

  const assetOf = useCallback((id: string): StudioAsset | undefined => library?.assets.find((a) => a.id === id), [library]);
  const mediaInfo = useCallback(
    (ref: MediaRef): MediaInfo | null => {
      if (ref.kind === "library") {
        const a = assetOf(ref.assetId);
        if (!a) return null;
        const url = `/api/studio/assets/file/${a.id}${library ? `?v=${encodeURIComponent(library.rev)}` : ""}`;
        const kind = AUDIO_KINDS.includes(a.kind) ? "audio" : /\.(webm|mp4|mov)$/i.test(a.file) ? "video" : "image";
        return { url, kind, name: a.name };
      }
      const m = uploads.find((u) => u.id === ref.assetId);
      return m?.url ? { url: m.url, kind: m.kind === "audio" ? "audio" : "image", name: m.name } : null;
    },
    [assetOf, library, uploads],
  );
  const refName = useCallback((ref: MediaRef) => (ref.kind === "library" ? (assetOf(ref.assetId)?.name ?? ref.assetId) : (uploads.find((u) => u.id === ref.assetId)?.name ?? "Uploaded file")), [assetOf, uploads]);
  const refDurationMs = useCallback((ref: MediaRef) => (ref.kind === "library" ? (assetOf(ref.assetId)?.durationMs ?? null) : (uploads.find((u) => u.id === ref.assetId)?.durationMs ?? null)), [assetOf, uploads]);
  const clipPeaks = useCallback(
    (ref: MediaRef) => {
      if (ref.kind === "library") {
        const p = library?.peaks[ref.assetId];
        const d = assetOf(ref.assetId)?.durationMs;
        return p && d ? { peaks: p, durationMs: d } : null;
      }
      return uploadPeaks[ref.assetId] ?? null;
    },
    [library, assetOf, uploadPeaks],
  );
  // Peaks for uploaded audio in the edit, decoded in the browser (skipped if the storage refuses).
  const peaksRequested = useRef(new Set<string>());
  useEffect(() => {
    const wanted = new Set(edl.audioTracks.flatMap((t) => t.clips.flatMap((c) => (c.source.kind === "upload" ? [c.source.assetId] : []))));
    for (const id of wanted) {
      const m = uploads.find((u) => u.id === id);
      if (!m?.url || peaksRequested.current.has(id)) continue;
      peaksRequested.current.add(id);
      void decodePeaks(m.url).then((r) => r && setUploadPeaks((p) => ({ ...p, [id]: r })));
    }
  }, [edl.audioTracks, uploads]);

  /* ----------------------------------------- playback --------------------------------------- */

  const seekProgram = useCallback((ms: number) => {
    setMode("program");
    preview.current?.seekProgram(ms);
  }, []);
  const seekSource = (ms: number, sessionId = active.sessionId) => {
    setMode("source");
    if (sessionId !== srcSession) setSrcSession(sessionId);
    preview.current?.pause();
    preview.current?.seekSource(sessionId, Math.max(0, Math.round(ms)));
    setSrcPos(Math.max(0, Math.round(ms)));
  };
  const togglePlay = () => {
    const p = preview.current;
    if (!p) return;
    if (p.isPlaying()) return p.pause();
    p.play(mode === "source" ? rate : 1);
  };
  const switchMode = (m: Mode) => {
    preview.current?.pause();
    setMode(m);
    if (m === "program") requestAnimationFrame(() => preview.current?.seekProgram(outPos));
    else requestAnimationFrame(() => preview.current?.seekSource(active.sessionId, srcSession === active.sessionId ? srcPos : active.inMs));
    if (m === "source" && srcSession !== active.sessionId) {
      setSrcSession(active.sessionId);
      setSrcPos(active.inMs);
    }
  };

  /* ------------------------------------------ editing --------------------------------------- */

  const setEdge = (id: string, edge: "in" | "out", ms: number) => {
    const s = edl.segments.find((x) => x.id === id);
    if (!s) return;
    apply((e) => trimSegment(e, id, edge, ms, maxSourceMs(s.sessionId)), edge === "in" ? "Set in point" : "Set out point", `edge:${id}:${edge}`);
  };
  const splitHere = () => {
    const target = sel.length === 1 && sel[0]!.kind !== "segment" ? sel[0] : undefined;
    const r = splitAt(edl, Math.round(playhead), target);
    if (!r) return announce("Nothing to split at the playhead (too close to an edge?)");
    apply(() => r.edl, "Split");
    announce(r.note);
  };
  const deleteSel = (ripple: boolean) => {
    if (sel.length === 0) return;
    const segs = sel.filter((r) => r.kind === "segment");
    if (segs.length >= edl.segments.length) return announce("An edit needs at least one segment");
    apply((e) => deleteRefs(e, sel, ripple), ripple ? "Ripple delete" : "Delete");
    setSelection([]);
    announce(`Deleted ${sel.length} item${sel.length === 1 ? "" : "s"}${ripple ? " and closed the gaps" : ""}`);
  };
  const undo = () => {
    if (!history.canUndo) return;
    announce(`Undid: ${history.undoLabel ?? "change"}`);
    history.undo();
  };
  const redo = () => {
    if (!history.canRedo) return;
    announce(`Redid: ${history.redoLabel ?? "change"}`);
    history.redo();
  };
  const fit = () => {
    const w = typeof window !== "undefined" ? Math.min(window.innerWidth, 1100) - 140 : 800;
    setPps(Math.min(400, Math.max(6, w / Math.max(1, total / 1000))));
  };
  const jumpEdge = (dir: -1 | 1) => {
    const edges = edlEdges(edl);
    const here = Math.round(playhead);
    const next = dir > 0 ? edges.find((t) => t > here + 1) : [...edges].reverse().find((t) => t < here - 1);
    if (next !== undefined) seekProgram(Math.min(next, Math.max(0, total - 1)));
  };

  /* ------------------------------------------ keyboard -------------------------------------- */

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y")) {
      if (typing) return;
      e.preventDefault();
      if (e.key === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
    if (typing || mod || e.altKey) return;
    if (el?.getAttribute("role") === "slider" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
    if ((e.key === " " || e.key === "Enter") && el && (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY" || el.getAttribute("role") === "button")) return;
    const key = e.key.toLowerCase();
    const v = preview.current;
    if (key === " " || key === "k") {
      e.preventDefault();
      if (key === "k") v?.pause();
      else togglePlay();
    } else if (key === "l") {
      e.preventDefault();
      if (mode === "program") return v?.play(1);
      const next = v?.isPlaying() ? Math.min(4, rate * 2) : 1;
      setRate(next);
      v?.play(next);
    } else if (key === "j") {
      e.preventDefault();
      if (mode === "program") seekProgram(Math.max(0, outPos - 1000));
      else seekSource(Math.max(0, srcPos - 1000), srcSession);
    } else if (key === "i" || key === "o") {
      e.preventDefault();
      if (mode === "source") {
        if (srcSession !== active.sessionId) return announce("The source shown isn't the selected segment's video");
        setEdge(active.id, key === "i" ? "in" : "out", Math.round(srcPos));
        announce(`${key === "i" ? "In" : "Out"} point set at ${editTime(srcPos)}`);
      } else {
        const { index, sourceMs } = edlLocate(edl, outPos);
        const s = edl.segments[index]!;
        setEdge(s.id, key === "i" ? "in" : "out", sourceMs);
        announce(`Segment ${index + 1} ${key === "i" ? "now starts" : "now ends"} at the playhead`);
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.shiftKey ? 1000 : 1000 / 30) * (e.key === "ArrowLeft" ? -1 : 1);
      if (mode === "program") seekProgram(Math.min(total, Math.max(0, outPos + step)));
      else seekSource(Math.min(dims(srcSession).durationMs || Number.MAX_SAFE_INTEGER, Math.max(0, srcPos + step)), srcSession);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      jumpEdge(e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      seekProgram(e.key === "Home" ? 0 : Math.max(0, total - 1));
    } else if (key === "s") {
      e.preventDefault();
      splitHere();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSel(e.shiftKey);
    } else if (key === "n") {
      setSnapping((x) => !x);
      announce(`Snapping ${snapping ? "off" : "on"}`);
    } else if (e.key === "+" || e.key === "=") setPps((p) => Math.min(400, p * 1.5));
    else if (e.key === "-") setPps((p) => Math.max(6, p / 1.5));
    else if (e.key === "\\") fit();
    else if (e.key === "?") setShortcutsOpen(true);
    else if (e.key === "Escape") {
      if (shortcutsOpen) setShortcutsOpen(false);
      else setSelection([]);
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ------------------------------------------ derived --------------------------------------- */

  const src = sourceOf(srcSession);
  const srcDims = dims(srcSession);
  const srcDuration = srcDims.durationMs || Math.max(active.outMs, 60_000);
  const srcView = useMemo(() => {
    if (srcZoom) return srcZoom;
    if (srcDuration <= 10 * 60_000) return { start: 0, end: srcDuration };
    const mid = (active.inMs + active.outMs) / 2;
    const half = Math.max(60_000, (active.outMs - active.inMs) * 1.5);
    const start = Math.max(0, Math.min(srcDuration - 2 * half, mid - half));
    return { start, end: Math.min(srcDuration, start + 2 * half) };
  }, [srcZoom, srcDuration, active.inMs, active.outMs]);
  const zoomSource = (f: number) => {
    const span = Math.min(srcDuration, Math.max(4000, (srcView.end - srcView.start) * f));
    const center = Math.min(Math.max(srcPos, srcView.start), srcView.end);
    const start = Math.max(0, Math.min(srcDuration - span, center - span / 2));
    setSrcZoom({ start, end: start + span });
  };
  const allMarkers: TemplateMarker[] = useMemo(() => sources.flatMap((s) => s.markers.map((m) => ({ sessionId: s.sessionId, ...m }))), [sources]);
  const outMarkers: TimelineMarker[] = useMemo(
    () =>
      allMarkers.flatMap((m) => {
        const t = markerOutputMs(edl, m);
        return t === null ? [] : [{ ms: t, label: m.label, kind: m.kind }];
      }),
    [allMarkers, edl],
  );
  const bigMarkers = (src?.markers ?? []).filter((m) => m.kind === "big").slice(0, 24);
  const frameWidth = `min(100%, calc(min(56vh, 600px) * ${ratio(edl.aspect).toFixed(4)}))`;
  const approx = edl.grade.preset !== "none" || edl.segments.some((s, i) => i > 0 && s.transitionIn.kind !== "cut") || edl.audioTracks.some((t) => t.duck) || edl.sourceAudio.denoise || edl.sourceAudio.voiceBoost || edl.normalize;

  const ctx: EditorCtx = {
    projectId: initial.id,
    title,
    edl,
    total,
    playheadMs: playhead,
    apply,
    replace,
    selection: sel,
    select,
    seek: seekProgram,
    sources,
    sourceOf,
    dims,
    uploads,
    setUploads,
    assets: library?.assets ?? [],
    mediaInfo,
    refName,
    refDurationMs,
    announce,
    saveNow,
  };

  const pickAsset = (a: StudioAsset) =>
    placeMedia(ctx, {
      ref: { kind: "library", assetId: a.id },
      name: a.name,
      kind: AUDIO_KINDS.includes(a.kind) ? "audio" : "image",
      audioKind: a.kind === "music" || a.kind === "ambience" ? "music" : "sfx",
      durationMs: a.durationMs ?? null,
      visual: a.kind,
    });

  return (
    <EditorContext.Provider value={ctx}>
      <div className="mx-auto max-w-[1600px] px-4 pb-20 pt-6 sm:px-6 lg:px-10">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <Link href="/studio#library" className="text-sm text-ivory-2 hover:text-ivory">
              ← Library
            </Link>
            <label htmlFor="edit-title" className="sr-only">
              Title
            </label>
            <input
              id="edit-title"
              value={title}
              maxLength={120}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleRev((r) => r + 1);
              }}
              className="poster-title mt-1 block w-full min-w-0 bg-transparent text-[length:var(--text-display-md)] font-black leading-[0.95] outline-none focus-visible:outline-2"
            />
            <p className="mt-1 text-sm text-ivory-3" aria-live="polite">
              {initial.origin === "auto" ? "Auto clip draft. " : ""}
              {saveLabel}
              {invalid && dirty ? `: ${invalid}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="tnum text-sm text-ivory-2">
              {ASPECT_SIZE[edl.aspect].label}, {editTime(total)}
            </span>
            <button type="button" className="btn btn-quiet btn-sm" disabled={!history.canUndo} onClick={undo} aria-keyshortcuts="Control+Z" title={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}>
              Undo
            </button>
            <button type="button" className="btn btn-quiet btn-sm" disabled={!history.canRedo} onClick={redo} aria-keyshortcuts="Control+Shift+Z" title={history.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}>
              Redo
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="?">
              Shortcuts
            </button>
            <button type="button" className="btn btn-coral" disabled={rendering || !validation.success} onClick={() => void render()}>
              {rendering ? "Starting render" : "Render"}
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="mt-3 text-sm text-coral">
            {error}
          </p>
        )}
        <p className="sr-only" aria-live="assertive">
          {announcement}
        </p>

        <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
          <div className="min-w-0">
            {/* The preview frame at the edit's output shape. */}
            <div className="flex justify-center bg-graphite-900 py-3">
              <div className="relative overflow-hidden bg-black" style={{ width: frameWidth, aspectRatio: `${ASPECT_SIZE[edl.aspect].width} / ${ASPECT_SIZE[edl.aspect].height}` }}>
                <PreviewStage
                  ref={preview}
                  edl={edl}
                  total={total}
                  mode={mode}
                  sources={sources}
                  sourceSession={srcSession}
                  media={mediaInfo}
                  title={title}
                  onTime={(m, ms) => (m === "program" ? setOutPos(ms) : setSrcPos(ms))}
                  onPlayingChange={setPlaying}
                  onDims={(id, d) => setDims((x) => ({ ...x, [id]: { width: d.width || dims(id).width, height: d.height || dims(id).height, durationMs: d.durationMs || dims(id).durationMs } }))}
                />
                {mode === "source" && <span className="pointer-events-none absolute left-2 top-2 bg-black/70 px-1.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-ivory-2">Source</span>}
                {!src?.playbackUrl && mode === "source" && <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-ivory-2">This session&apos;s video is no longer stored.</p>}
              </div>
            </div>
            {mode === "program" && approx && <p className="mt-1.5 text-center text-[0.75rem] text-ivory-3">The preview approximates the final render: colour grades, transitions, ducking and loudness are exact only in the render.</p>}

            {/* Transport */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-primary btn-sm min-w-[5.5rem]" onClick={togglePlay} aria-keyshortcuts="Space">
                {playing ? "Pause" : "Play"}
              </button>
              <div role="radiogroup" aria-label="What plays" className="flex border hairline">
                {(
                  [
                    ["source", "Source"],
                    ["program", "Edit"],
                  ] as const
                ).map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => switchMode(m)} className={`h-8 px-3 font-display text-[0.92rem] font-semibold ${mode === m ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="tnum text-sm text-ivory-2" aria-live="off">
                {mode === "program" ? `${editTime(outPos)} / ${editTime(total)}` : `${editTime(srcPos)}${rate !== 1 && playing ? ` (${rate}×)` : ""}`}
              </span>
              <span className="ml-auto flex flex-wrap gap-1">
                <button type="button" className="btn btn-ghost btn-sm" onClick={splitHere} aria-keyshortcuts="S">
                  Split
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={sel.length === 0} onClick={() => deleteSel(false)} aria-keyshortcuts="Delete">
                  Delete
                </button>
                {mode === "source" && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={srcSession !== active.sessionId} onClick={() => setEdge(active.id, "in", srcPos)} aria-keyshortcuts="I">
                      Set in
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={srcSession !== active.sessionId} onClick={() => setEdge(active.id, "out", srcPos)} aria-keyshortcuts="O">
                      Set out
                    </button>
                  </>
                )}
              </span>
            </div>

            {mode === "source" && (
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-sm text-ivory-2">
                    {src?.title ?? "Source"}
                    <span className="text-ivory-3"> · segment {activeIdx + 1}: drag the white handles or press I and O</span>
                  </p>
                  <div className="flex gap-1">
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => zoomSource(0.5)} aria-label="Zoom the source timeline in">
                      Zoom in
                    </button>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => zoomSource(2)} aria-label="Zoom the source timeline out">
                      Zoom out
                    </button>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSrcZoom({ start: 0, end: srcDuration })}>
                      Fit
                    </button>
                  </div>
                </div>
                <SourceTimeline
                  durationMs={srcDuration}
                  view={srcView}
                  positionMs={srcSession === active.sessionId ? srcPos : active.inMs}
                  markers={src?.markers ?? []}
                  ranges={edl.segments.filter((s) => s.sessionId === srcSession).map((s) => ({ id: s.id, inMs: s.inMs, outMs: s.outMs, active: s.id === active.id }))}
                  onSeek={(ms) => seekSource(ms, srcSession)}
                  onChangeRange={(id, edge, ms) => {
                    select([{ kind: "segment", id }]);
                    setEdge(id, edge, ms);
                  }}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[0.8rem] text-ivory-3">AI moments</span>
                  {bigMarkers.map((m, i) => (
                    <button key={`${m.ms}-${i}`} type="button" className="chip hover:border-ivory-2" onClick={() => seekSource(Math.max(0, m.ms - 1000), srcSession)}>
                      <span className="text-gold">{m.label}</span>
                      <span className="tnum text-ivory-3">{editTime(m.ms)}</span>
                    </button>
                  ))}
                  {(src?.markers.length ?? 0) > 0 ? (
                    <>
                      <label htmlFor="jump" className="sr-only">
                        Jump to an AI moment
                      </label>
                      <select
                        id="jump"
                        className="field h-8 w-auto max-w-full py-0 text-[0.85rem]"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) seekSource(Math.max(0, Number(e.target.value) - 1000), srcSession);
                        }}
                      >
                        <option value="">Jump to a moment ({src!.markers.length})</option>
                        {src!.markers.slice(0, 400).map((m, i) => (
                          <option key={`${m.ms}-${i}`} value={m.ms}>
                            {editTime(m.ms)} {m.label.slice(0, 60)}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <span className="text-[0.8rem] text-ivory-3">none on this source</span>
                  )}
                  {sources.length > 1 && (
                    <>
                      <label htmlFor="src-pick" className="sr-only">
                        Source video
                      </label>
                      <select id="src-pick" className="field h-8 w-auto max-w-full py-0 text-[0.85rem]" value={srcSession} onChange={(e) => seekSource(0, e.target.value)}>
                        {sources.map((s) => (
                          <option key={s.sessionId} value={s.sessionId}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* The multi-track edit timeline. */}
            <div className="mt-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">Timeline</h2>
                <div className="flex flex-wrap items-center gap-1">
                  <button type="button" className={`btn btn-sm ${snapping ? "btn-ghost" : "btn-quiet"}`} aria-pressed={snapping} onClick={() => setSnapping((x) => !x)} aria-keyshortcuts="N">
                    Snap
                  </button>
                  <button type="button" className={`btn btn-sm ${rollMode ? "btn-ghost" : "btn-quiet"}`} aria-pressed={rollMode} onClick={() => setRollMode((x) => !x)} title="Trimming a cut moves time between the two segments (or hold Alt)">
                    Roll
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPps((p) => Math.max(6, p / 1.5))} aria-label="Zoom the timeline out">
                    −
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPps((p) => Math.min(400, p * 1.5))} aria-label="Zoom the timeline in">
                    +
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={fit}>
                    Fit
                  </button>
                </div>
              </div>
              <EditorTimeline
                edl={edl}
                total={total}
                playheadMs={playhead}
                selection={sel}
                markers={outMarkers}
                sourcePeaks={(id) => {
                  const w = waves[id];
                  return w && w.status === "ready" && w.durationMs ? { peaks: w.peaks, durationMs: w.durationMs } : null;
                }}
                clipPeaks={clipPeaks}
                clipName={refName}
                maxSourceMs={maxSourceMs}
                snapping={snapping}
                rollMode={rollMode}
                pps={pps}
                onPps={setPps}
                onSeek={(ms) => seekProgram(ms)}
                onSelect={(refs, additive) => {
                  const keyOf = (r: TimelineRef) => JSON.stringify(r);
                  const next = additive ? (sel.some((r) => refs.some((x) => keyOf(x) === keyOf(r))) ? sel.filter((r) => !refs.some((x) => keyOf(x) === keyOf(r))) : [...sel, ...refs]) : refs;
                  select(next);
                  if (next.length) setTab("clip");
                }}
                onEdit={apply}
              />
              <p className="mt-1.5 text-[0.72rem] text-ivory-3">
                Drag blocks to move, their edges to trim (Shift: no snapping). {allRefs(edl).length} items · press ? for shortcuts.
              </p>
            </div>
          </div>

          <div className="min-w-0">
            <div role="tablist" aria-label="Editor panels" className="flex gap-1 overflow-x-auto border-b hairline pb-1 [scrollbar-width:thin]">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`panel-${id}`}
                  onClick={() => setTab(id)}
                  className={`shrink-0 px-2.5 py-1.5 font-display text-[0.95rem] font-semibold ${tab === id ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-5 space-y-8">
              {tab === "clip" && (
                <>
                  <SelectionPanelSection />
                  <SegmentsPanel />
                </>
              )}
              {tab === "format" && <FormatPanel markers={allMarkers} />}
              {tab === "look" && <LookPanel />}
              {tab === "text" && <TextPanel />}
              {tab === "audio" && <AudioPanel />}
              {tab === "captions" && <CaptionsPanel />}
              {tab === "library" && (
                <>
                  <section aria-label="Studio library" className="min-w-0">
                    <h2 className="mb-3 border-b hairline pb-2 font-display text-xl font-bold">Studio library</h2>
                    <AssetLibraryPanel onPick={pickAsset} />
                    {!library && <p className="text-sm text-ivory-3">The sound and element library isn&apos;t available right now.</p>}
                  </section>
                  <UploadsPanel />
                </>
              )}
              {tab === "ai" && <ClipAiPanel project={{ ...saved, title, edl }} edl={edl} onApplyEdl={(next) => replace(next, "AI edit")} />}
              {tab === "export" && <ExportPanel renders={renders} onRenders={setRenders} />}
            </div>
          </div>
        </div>

        {shortcutsOpen && (
          <div role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setShortcutsOpen(false)}>
            <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto border hairline bg-graphite-800 p-5" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3">
                <h2 id="shortcuts-title" className="poster-title text-2xl font-black">
                  Shortcuts
                </h2>
                <button type="button" className="btn btn-quiet btn-sm" autoFocus onClick={() => setShortcutsOpen(false)}>
                  Close
                </button>
              </div>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {SHORTCUTS.map(([k, d]) => (
                  <div key={k} className="contents">
                    <dt className="font-display font-semibold text-apricot">{k}</dt>
                    <dd className="text-ivory-2">{d}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
      </div>
    </EditorContext.Provider>
  );
}

function SelectionPanelSection() {
  return (
    <section aria-label="Selected" className="min-w-0">
      <h2 className="mb-3 border-b hairline pb-2 font-display text-xl font-bold">Selected</h2>
      <SelectionPanel />
    </section>
  );
}

/** Keep newer server state for known renders, add new ones. */
function mergeRenders(local: LibraryItemView[], server: LibraryItemView[]): LibraryItemView[] {
  const byId = new Map(server.map((r) => [r.id, r]));
  const merged = local.map((r) => byId.get(r.id) ?? r);
  for (const r of server) if (!merged.some((x) => x.id === r.id)) merged.push(r);
  return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Peak levels of an audio file, decoded in the browser. Null when the file can't be read. */
async function decodePeaks(url: string): Promise<{ peaks: number[]; durationMs: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    const ac = new Ctx();
    const audio = await ac.decodeAudioData(buf);
    void ac.close();
    const data = audio.getChannelData(0);
    const bins = Math.min(2000, Math.max(50, Math.round(audio.duration * 10)));
    const per = Math.max(1, Math.floor(data.length / bins));
    const peaks: number[] = [];
    let max = 0.0001;
    for (let b = 0; b < bins; b++) {
      let p = 0;
      for (let i = b * per; i < Math.min(data.length, (b + 1) * per); i += 4) p = Math.max(p, Math.abs(data[i]!));
      peaks.push(p);
      max = Math.max(max, p);
    }
    return { peaks: peaks.map((p) => Math.round((p / max) * 1000) / 1000), durationMs: Math.round(audio.duration * 1000) };
  } catch {
    return null;
  }
}
