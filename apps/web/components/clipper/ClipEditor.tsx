"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  addMarker,
  addSequence,
  ASPECT_SIZE,
  addTrack,
  closeGaps,
  copyRefs,
  docSequences,
  deleteRefs,
  duplicateRefs,
  Edl,
  edlDurationMs,
  edlEdges,
  edlLocate,
  edlOutputTime,
  extractRange,
  insertSourceClip,
  liftRange,
  MAIN_SEQUENCE_ID,
  markerOutputMs,
  moveSequence,
  moveTrack,
  NO_EXTRA_SEQUENCES,
  nudgeRefs,
  pasteClipboard,
  ProjectSequences,
  razorAll,
  refKeyOf,
  refSpan,
  removeMarker,
  removeSequence,
  removeTrack,
  renameSequence,
  renameTrack,
  splitAt,
  toggleTrack,
  trackRefs,
  trimSegment,
  updateMarker,
  nextMarkerColor,
  type Clipboard,
  type EdlMarker,
  type LibraryItemView,
  type MediaRef,
  type ProjectDoc,
  type ProjectMediaView,
  type ProjectSourceView,
  type ProjectView,
  type SpriteSheetView,
  type StudioAsset,
  type StudioAssetKind,
  type StudioAssetsResponse,
  type TemplateMarker,
  type TimelineRef,
  type TrackInfo,
  type TrackKey,
  type WaveformView,
} from "@slot1/contracts";
import { Wordmark } from "@/components/brand/Wordmark";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";
import { loadStudioAssets, studioAssetUrl } from "./library/studio-assets-client";
import { EditorContext, type EditorCtx } from "./editor/context";
import { placeMedia } from "./editor/panels";
import { PreviewStage, type MediaInfo, type PreviewHandle } from "./editor/PreviewStage";
import { SourceTimeline } from "./editor/SourceTimeline";
import { ExportDialog } from "./nle/ExportDialog";
import { InspectorDock, type InspectorTab } from "./nle/InspectorDock";
import { MediaBin } from "./nle/MediaBin";
import { ContextMenu, Dialog, type MenuEntry, type MenuState } from "./nle/Menu";
import { Monitor, type Guides, type MonitorMode } from "./nle/Monitor";
import { PhoneEditor } from "./nle/PhoneEditor";
import { Timeline, TOOLS, type AiMarker, type Range, type Tool } from "./nle/Timeline";
import { useProjectHistory } from "./nle/useProjectHistory";
import { clamp, startSplitDrag, timecode, useStored, useWideScreen, type SourceDrag } from "./nle/util";
import "./nle/nle.css";

type SaveState = "saved" | "saving" | "error";
const FPS = 30;
const MIN_PPS = 0.02;
const MAX_PPS = 1920;
const AUDIO_KINDS: StudioAssetKind[] = ["sfx", "music", "ambience"];
const NO_RANGE: Range = { inMs: null, outMs: null };

const SHORTCUTS: [string, string][] = [
  ["Space · K", "Play or pause · pause"],
  ["J / L", "Back one second / play (L again: 2× and 4× in Source)"],
  ["← / →", "One frame back or forward (Shift: one second)"],
  ["↑ / ↓", "Previous or next edit point"],
  ["Home / End", "Start or end"],
  ["I / O", "Source: in and out of the clip. Program: in and out of the timeline range"],
  ["Alt + X", "Clear in and out"],
  ["; / '", "Lift (leave a gap) / extract (close the gap) between in and out"],
  [", / .", "Insert the Source clip on V1 / place it on the top video track"],
  ["Ctrl/⌘ + K", "Cut every track at the playhead"],
  ["Q / W", "Trim the V1 clip under the playhead to the playhead (start / end)"],
  ["V C B N Y U H Z", "Tools: select, razor, ripple trim, roll, slip, slide, hand, zoom"],
  ["S", "Snapping on or off"],
  ["M · Shift + M", "Add a marker · next marker"],
  ["Delete · Shift + Delete", "Delete (magnetic: closes gaps) · ripple delete"],
  ["Ctrl/⌘ + C X V D A", "Copy, cut, paste, duplicate, select all"],
  ["Alt + ← / →", "Nudge the selection one frame (Shift: ten)"],
  ["Ctrl/⌘ + Z · Ctrl/⌘ + Shift + Z", "Undo · redo"],
  ["+ / − / \\  ·  Ctrl/⌘ + wheel", "Zoom the timeline in, out, to fit"],
  ["Alt while trimming", "Roll the cut between V1 clips"],
  ["Shift + F10", "Menu for the focused clip"],
  ["?", "This list"],
];

export function ClipEditor({ initial }: { initial: ProjectView }) {
  const wide = useWideScreen();
  const project = useProjectHistory({ main: initial.edl, sequences: initial.sequences ?? NO_EXTRA_SEQUENCES });
  const { edl, apply, replace, active: seqId, sequences } = project;
  const [title, setTitle] = useState(initial.title);
  const [titleRev, setTitleRev] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ProjectView>(initial);
  const [renders, setRenders] = useState<LibraryItemView[]>(initial.renders);
  const [rendering, setRendering] = useState(false);
  const [mode, setMode] = useState<MonitorMode>("source");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [srcSession, setSrcSession] = useState(initial.edl.segments[0]!.sessionId);
  const [srcPos, setSrcPos] = useState(initial.edl.segments[0]!.inMs);
  const [srcTarget, setSrcTarget] = useState<"segment" | "clip">("segment");
  const [outPos, setOutPos] = useState(0);
  const [dimsMap, setDims] = useState<Record<string, { width: number; height: number; durationMs: number }>>({});
  const [srcZoom, setSrcZoom] = useState<{ start: number; end: number } | null>(null);
  const [selection, setSelection] = useState<TimelineRef[]>([{ kind: "segment", id: initial.edl.segments[0]!.id }]);
  const [activeSeg, setActiveSeg] = useState(initial.edl.segments[0]!.id);
  const [tab, setTab] = useState<InspectorTab>("clip");
  const [tool, setTool] = useState<Tool>("select");
  const [snapping, setSnapping] = useState(true);
  const [magnetic, setMagnetic] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [uploads, setUploads] = useState<ProjectMediaView[]>([]);
  const [library, setLibrary] = useState<StudioAssetsResponse | null>(null);
  const [waves, setWaves] = useState<Record<string, WaveformView>>({});
  const [uploadPeaks, setUploadPeaks] = useState<Record<string, { peaks: number[]; durationMs: number } | null>>({});
  const [spriteMap, setSpriteMap] = useState<Record<string, SpriteSheetView>>({});
  const [extraSources, setExtraSources] = useState<ProjectSourceView[]>([]);
  const [ranges, setRanges] = useState<Record<string, Range>>({});
  const [marks, setMarks] = useState<Record<string, Range>>({});
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingSeq, setRenamingSeq] = useState<string | null>(null);
  const [layout, setLayout] = useStored("slot1.nle.layout", { bin: 260, insp: 340, tl: 300, pps: 40, quality: "full" as "full" | "half", guides: { safe: false, aspect: "none" } as Guides });
  const [tracksUi, setTracksUi] = useStored("slot1.nle.tracks", { heights: {} as Record<string, number>, expanded: [] as string[] });
  const preview = useRef<PreviewHandle>(null);
  const clipboard = useRef<Clipboard | null>(null);
  const tlBox = useRef<HTMLDivElement>(null);
  const seqPlayhead = useRef<Record<string, number>>({});
  const pps = clamp(layout.pps, MIN_PPS, MAX_PPS);
  const setPps = useCallback((v: number) => setLayout((l) => ({ ...l, pps: clamp(v, MIN_PPS, MAX_PPS) })), [setLayout]);

  const sources = useMemo(() => {
    const out = [...saved.sources];
    for (const s of [...initial.sources, ...extraSources]) if (!out.some((x) => x.sessionId === s.sessionId)) out.push(s);
    return out;
  }, [saved.sources, initial.sources, extraSources]);
  const sourceOf = useCallback((id: string) => sources.find((s) => s.sessionId === id), [sources]);
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

  // Every timeline must be valid before the project saves.
  const doc = project.doc;
  const validation = useMemo(() => validateDoc(doc), [doc]);

  const sel = useMemo(() => selection.filter((r) => refSpan(edl, r) !== null), [selection, edl]);
  const active = edl.segments.find((s) => s.id === activeSeg) ?? edl.segments.find((s) => s.sessionId === srcSession) ?? edl.segments[0]!;
  const activeIdx = edl.segments.indexOf(active);
  const playhead = mode === "program" ? outPos : srcTarget === "segment" && srcPos >= active.inMs && srcPos <= active.outMs && srcSession === active.sessionId ? edlOutputTime(edl, activeIdx, srcPos) : outPos;
  const range = ranges[seqId] ?? NO_RANGE;
  const setRange = (r: Range) => setRanges((m) => ({ ...m, [seqId]: r }));

  const select = useCallback((refs: TimelineRef[]) => {
    setSelection(refs);
    const seg = refs.find((r) => r.kind === "segment");
    if (seg) {
      setActiveSeg(seg.id);
      setSrcTarget("segment");
    }
  }, []);
  const onSelect = (refs: TimelineRef[], how: "replace" | "toggle" | "add" = "replace") => {
    const keys = new Set(sel.map(refKeyOf));
    let next = refs;
    if (how === "toggle") next = refs.every((r) => keys.has(refKeyOf(r))) ? sel.filter((r) => !refs.some((x) => refKeyOf(x) === refKeyOf(r))) : [...sel, ...refs.filter((r) => !keys.has(refKeyOf(r)))];
    if (how === "add") next = [...sel, ...refs.filter((r) => !keys.has(refKeyOf(r)))];
    select(next);
    if (next.length && tab !== "clip" && tab !== "effects" && tab !== "ai") setTab("clip");
  };

  /* -------------------------------------- sequences --------------------------------------- */

  useEffect(() => {
    try {
      const id = window.localStorage.getItem(`slot1.nle.seq.${initial.id}`);
      if (id) project.setActive(id);
    } catch {
      // No storage: open the main timeline.
    }
    // Once, after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lastSeq = useRef(seqId);
  useEffect(() => {
    if (lastSeq.current === seqId) return;
    seqPlayhead.current[lastSeq.current] = outPos;
    lastSeq.current = seqId;
    try {
      window.localStorage.setItem(`slot1.nle.seq.${initial.id}`, seqId);
    } catch {
      // Not remembered; fine.
    }
    const first = edl.segments[0]!;
    // A different timeline: start from its own state.
    setSelection([]);
    setActiveSeg(first.id);
    setSelectedMarker(null);
    setMode("program");
    const at = Math.min(seqPlayhead.current[seqId] ?? 0, Math.max(0, edlDurationMs(edl) - 1));
    setOutPos(at);
    requestAnimationFrame(() => preview.current?.seekProgram(at));
  }, [seqId, edl, outPos, initial.id]);

  const switchSeq = (id: string) => {
    preview.current?.pause();
    project.setActive(id);
  };

  /* ------------------------------------------ saving ---------------------------------------- */

  const dirty = project.rev > 0 || titleRev > 0;
  const [savedRev, setSavedRev] = useState({ edl: 0, title: 0 });
  const doSave = useCallback(
    async (main: Edl, seqs: ProjectSequences, t: string): Promise<boolean> => {
      setSave("saving");
      try {
        const v = await api<ProjectView>(`/api/projects/${initial.id}`, { method: "PATCH", json: { title: t.trim() || initial.title, edl: main, sequences: seqs } });
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
    if (!dirty || !validation.ok) return;
    const v = validation;
    const t = setTimeout(() => {
      setSavedRev({ edl: project.rev, title: titleRev });
      void doSave(v.main, v.sequences, title);
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, validation, title, titleRev, project.rev, doSave]);
  const pendingChanges = dirty && (savedRev.edl !== project.rev || savedRev.title !== titleRev);
  const saveLabel = !dirty ? "Saved" : !validation.ok ? "Not saved: fix the edit" : save === "saving" ? "Saving" : save === "error" ? "Not saved" : pendingChanges ? "Unsaved changes" : "Saved";
  const saveNow = useCallback(async () => {
    if (!validation.ok) return false;
    setSavedRev({ edl: project.rev, title: titleRev });
    return doSave(validation.main, validation.sequences, title);
  }, [validation, project.rev, titleRev, doSave, title]);

  // Renders and thumbnails run in the background: poll while one is processing.
  const busy = renders.filter((r) => r.status === "processing").length;
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
      const item = await api<LibraryItemView>(`/api/projects/${initial.id}/render`, { method: "POST", json: { sequences: [seqId] } });
      setRenders((r) => [item, ...r.filter((x) => x.id !== item.id)]);
      setExportOpen(true);
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
    loadStudioAssets()
      .then(setLibrary)
      .catch(() => undefined);
  }, []);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Waveforms of the videos on this timeline (built once on the server, then cached).
  const sessionIds = useMemo(() => [...new Set(edl.segments.map((s) => s.sessionId))], [edl.segments]);
  const wavesAsked = useRef(new Set<string>());
  useEffect(() => {
    const load = (id: string, tries: number) => {
      api<WaveformView>(`/api/editor/waveform/${id}`)
        .then((w) => {
          if (!alive.current) return;
          setWaves((m) => ({ ...m, [id]: w }));
          if (w.status === "pending" && tries < 20) setTimeout(() => load(id, tries + 1), 3000);
        })
        .catch(() => undefined);
    };
    for (const id of sessionIds) {
      if (wavesAsked.current.has(id)) continue;
      wavesAsked.current.add(id);
      load(id, 0);
    }
  }, [sessionIds]);

  // Filmstrips: sprite sheets per video and zoom tier, asked for as the timeline draws them.
  const spriteWanted = useRef(new Set<string>());
  const spriteAsked = useRef(new Set<string>());
  const sprites = useCallback(
    (sessionId: string, tier: number) => {
      const k = `${sessionId}:${tier}`;
      const v = spriteMap[k];
      if (!v) spriteWanted.current.add(k);
      return v ?? null;
    },
    [spriteMap],
  );
  useEffect(() => {
    for (const k of spriteWanted.current) {
      if (spriteAsked.current.has(k)) continue;
      spriteAsked.current.add(k);
      const [sid, tier] = k.split(":");
      let tries = 0;
      const load = () =>
        api<SpriteSheetView>(`/api/editor/sprites/${sid}?tier=${tier}`)
          .then((v) => {
            if (!alive.current) return;
            setSpriteMap((m) => ({ ...m, [k]: v }));
            if (v.status === "pending" && tries++ < 45) setTimeout(load, 4000);
          })
          .catch(() => undefined);
      void load();
    }
    spriteWanted.current.clear();
  });

  const assetOf = useCallback((id: string): StudioAsset | undefined => library?.assets.find((a) => a.id === id), [library]);
  const mediaInfo = useCallback(
    (ref: MediaRef): MediaInfo | null => {
      if (ref.kind === "library") {
        const a = assetOf(ref.assetId);
        if (!a) return null;
        const url = studioAssetUrl(a, library?.rev);
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
        const pk = library?.peaks[ref.assetId];
        const d = assetOf(ref.assetId)?.durationMs;
        return pk && d ? { peaks: pk, durationMs: d } : null;
      }
      return uploadPeaks[ref.assetId] ?? null;
    },
    [library, assetOf, uploadPeaks],
  );
  const peaksRequested = useRef(new Set<string>());
  useEffect(() => {
    const wanted = new Set(edl.audioTracks.flatMap((t) => t.clips.flatMap((c) => (c.source.kind === "upload" ? [c.source.assetId] : []))));
    for (const id of wanted) {
      const m = uploads.find((u) => u.id === id);
      if (!m?.url || peaksRequested.current.has(id)) continue;
      peaksRequested.current.add(id);
      void decodePeaks(m.url).then((r) => r && setUploadPeaks((pk) => ({ ...pk, [id]: r })));
    }
  }, [edl.audioTracks, uploads]);
  const sourcePeaks = useCallback(
    (id: string) => {
      const w = waves[id];
      return w && w.status === "ready" && w.durationMs ? { peaks: w.peaks, durationMs: w.durationMs } : null;
    },
    [waves],
  );

  /* ----------------------------------------- playback --------------------------------------- */

  const seekProgram = useCallback((ms: number) => {
    setMode("program");
    preview.current?.seekProgram(ms);
  }, []);
  const seekSource = (ms: number, sessionId = srcSession) => {
    setMode("source");
    if (sessionId !== srcSession) setSrcSession(sessionId);
    preview.current?.pause();
    preview.current?.seekSource(sessionId, Math.max(0, Math.round(ms)));
    setSrcPos(Math.max(0, Math.round(ms)));
  };
  const togglePlay = () => {
    const pv = preview.current;
    if (!pv) return;
    if (pv.isPlaying()) return pv.pause();
    pv.play(mode === "source" ? rate : 1);
  };
  const switchMode = (m: MonitorMode) => {
    preview.current?.pause();
    setMode(m);
    if (m === "program") requestAnimationFrame(() => preview.current?.seekProgram(outPos));
    else {
      const sid = srcTarget === "segment" ? active.sessionId : srcSession;
      const at = srcTarget === "segment" ? (srcSession === active.sessionId ? srcPos : active.inMs) : srcPos;
      if (sid !== srcSession) setSrcSession(sid);
      setSrcPos(at);
      requestAnimationFrame(() => preview.current?.seekSource(sid, at));
    }
  };
  const step = (frames: number) => {
    const d = (frames * 1000) / FPS;
    if (mode === "program") seekProgram(clamp(outPos + d, 0, Math.max(0, total - 1)));
    else seekSource(clamp(srcPos + d, 0, dims(srcSession).durationMs || Number.MAX_SAFE_INTEGER));
  };
  /** Load a video into the Source monitor to mark a part of it. */
  const openSource = (s: ProjectSourceView) => {
    if (!sources.some((x) => x.sessionId === s.sessionId)) setExtraSources((xs) => [...xs, s]);
    setSrcTarget("clip");
    const m = marks[s.sessionId];
    requestAnimationFrame(() => seekSource(m?.inMs ?? 0, s.sessionId));
    announce(`${s.title} is in the Source monitor. Press I and O, then , to insert`);
  };

  /* ------------------------------------------ editing --------------------------------------- */

  const setEdge = (id: string, edge: "in" | "out", ms: number) => {
    const s = edl.segments.find((x) => x.id === id);
    if (!s) return;
    apply((e) => trimSegment(e, id, edge, ms, maxSourceMs(s.sessionId)), edge === "in" ? "Set in point" : "Set out point", `edge:${id}:${edge}`);
  };
  const addAtPlayhead = () => {
    const r = razorAll(edl, Math.round(playhead));
    if (!r.cuts) return announce("Nothing to cut at the playhead (too close to an edge?)");
    apply(() => r.edl, "Cut at playhead");
    announce(`Cut ${r.cuts} clip${r.cuts === 1 ? "" : "s"} at the playhead`);
  };
  const splitSel = (at: number) => {
    const target = sel.length === 1 ? sel[0] : undefined;
    const r = splitAt(edl, Math.round(at), target);
    if (!r) return announce("Nothing to split there (too close to an edge?)");
    apply(() => r.edl, "Split");
    announce(r.note);
  };
  const deleteSel = (ripple: boolean, refs = sel) => {
    if (refs.length === 0) return;
    const segs = refs.filter((r) => r.kind === "segment");
    if (segs.length >= edl.segments.length) return announce("A timeline needs at least one clip on V1");
    apply((e) => deleteRefs(e, refs, ripple || magnetic), ripple || magnetic ? "Ripple delete" : "Delete");
    setSelection([]);
    announce(`Deleted ${refs.length} item${refs.length === 1 ? "" : "s"}${ripple || magnetic ? " and closed the gaps" : ""}`);
  };
  const copySel = (cut = false) => {
    const c = copyRefs(edl, sel);
    if (!c) return announce("Select something to copy");
    clipboard.current = c;
    announce(`${cut ? "Cut" : "Copied"} ${c.items.length} item${c.items.length === 1 ? "" : "s"}`);
    if (cut) deleteSel(false);
  };
  const paste = (at = playhead) => {
    const c = clipboard.current;
    if (!c) return announce("Nothing copied yet");
    const r = pasteClipboard(edl, c, Math.round(at));
    if (!r) return announce("Couldn't paste there");
    apply(() => r.edl, "Paste");
    select(r.refs);
    announce(`Pasted ${r.refs.length} item${r.refs.length === 1 ? "" : "s"}`);
  };
  const duplicate = () => {
    const r = duplicateRefs(edl, sel);
    if (!r) return announce("Select something to duplicate");
    apply(() => r.edl, "Duplicate");
    select(r.refs);
  };
  const insertSource = (src: SourceDrag, at: number, track: TrackKey) => {
    const r = insertSourceClip(edl, src, Math.round(at), track);
    if (!r) return announce(track.startsWith("ov:") ? "That track is locked or the edit ends there" : "V1 is locked, full, or the edit is at its 30 minute limit");
    const bin = sourceOf(src.sessionId);
    if (!bin) return announce("That video isn't loaded yet");
    apply(() => r.edl, "Insert clip");
    select([r.ref]);
    announce(r.note);
  };
  const dragRange = (s: ProjectSourceView) => {
    const m = marks[s.sessionId];
    const dur = s.durationMs ?? dims(s.sessionId).durationMs ?? 0;
    const a = m?.inMs ?? 0;
    const b = m?.outMs ?? (dur ? Math.min(dur, a + 60_000) : a + 30_000);
    return { inMs: a, outMs: Math.max(a + 500, b) };
  };
  const insertFromBin = (s: ProjectSourceView, track: TrackKey = "v1") => {
    if (!sources.some((x) => x.sessionId === s.sessionId)) setExtraSources((xs) => [...xs, s]);
    const r = insertSourceClip(edl, { sessionId: s.sessionId, ...dragRange(s) }, Math.round(mode === "program" ? outPos : playhead), track);
    if (!r) return announce("V1 is locked, full, or the edit is at its 30 minute limit");
    apply(() => r.edl, "Insert clip");
    select([r.ref]);
    announce(`${r.note}: ${s.title}`);
  };
  const topVideoTrack = (e: Edl): TrackKey | null => {
    const t = [...e.overlays].reverse().find((o) => o.kind !== "text" && !o.locked);
    return t ? `ov:${t.id}` : null;
  };
  const overlaySource = () => {
    const s = sourceOf(srcSession);
    if (!s) return;
    let key = topVideoTrack(edl);
    let base = edl;
    if (!key) {
      const added = addTrack(edl, "video");
      if (!added) return announce("No room for another video track");
      base = added.edl;
      key = added.key;
    }
    const r = insertSourceClip(base, { sessionId: s.sessionId, ...dragRange(s) }, Math.round(outPos), key);
    if (!r) return announce("Couldn't place it there");
    apply(() => r.edl, "Place on video track");
    select([r.ref]);
    announce(r.note);
  };
  const undo = () => {
    if (!project.canUndo) return;
    announce(`Undid: ${project.undoLabel ?? "change"}`);
    project.undo();
  };
  const redo = () => {
    if (!project.canRedo) return;
    announce(`Redid: ${project.redoLabel ?? "change"}`);
    project.redo();
  };
  const fit = () => {
    const w = (tlBox.current?.clientWidth ?? 1200) - 200;
    setPps(Math.max(MIN_PPS, w / Math.max(1, (total * 1.04) / 1000)));
  };
  const jumpEdge = (dir: -1 | 1) => {
    const edges = edlEdges(edl);
    const here = Math.round(playhead);
    const next = dir > 0 ? edges.find((t) => t > here + 1) : [...edges].reverse().find((t) => t < here - 1);
    if (next !== undefined) seekProgram(Math.min(next, Math.max(0, total - 1)));
  };
  const markHere = (which: "in" | "out") => {
    if (mode === "source") {
      if (srcTarget === "segment" && srcSession === active.sessionId) {
        setEdge(active.id, which, Math.round(srcPos));
        return announce(`${which === "in" ? "In" : "Out"} point set at ${editTime(srcPos)}`);
      }
      setMarks((m) => {
        const cur = m[srcSession] ?? NO_RANGE;
        return { ...m, [srcSession]: which === "in" ? { inMs: Math.round(srcPos), outMs: cur.outMs !== null && cur.outMs > srcPos ? cur.outMs : null } : { inMs: cur.inMs !== null && cur.inMs < srcPos ? cur.inMs : 0, outMs: Math.round(srcPos) } };
      });
      return announce(`Source ${which} set at ${editTime(srcPos)}`);
    }
    const t = Math.round(outPos);
    if (which === "in") setRange({ inMs: t, outMs: range.outMs !== null && range.outMs > t ? range.outMs : null });
    else setRange({ inMs: range.inMs !== null && range.inMs < t ? range.inMs : null, outMs: t });
    announce(`Timeline ${which} at ${timecode(t, FPS)}`);
  };
  const rangeOrSay = () => {
    const a = range.inMs ?? 0;
    const b = range.outMs ?? total;
    if (range.inMs === null && range.outMs === null) {
      announce("Set In and Out on the timeline first (I and O in Program)");
      return null;
    }
    return { a, b };
  };
  const lift = () => {
    const r = rangeOrSay();
    if (!r) return;
    apply((e) => liftRange(e, r.a, r.b), "Lift");
    announce("Lifted the range (V1 has no gaps: use Extract to cut it out)");
  };
  const extract = () => {
    const r = rangeOrSay();
    if (!r) return;
    const next = extractRange(edl, r.a, r.b);
    if (!next) return announce("Can't extract that range (V1 locked, or it would remove everything)");
    apply(() => next, "Extract");
    setRange(NO_RANGE);
    announce("Extracted the range and closed the gap");
  };
  const trimToPlayhead = (edge: "in" | "out") => {
    const { index, sourceMs } = edlLocate(edl, Math.round(playhead));
    const s = edl.segments[index]!;
    setEdge(s.id, edge, sourceMs);
    announce(`Clip ${index + 1} now ${edge === "in" ? "starts" : "ends"} at the playhead`);
  };
  const dropMarker = (at = playhead) => {
    const r = addMarker(edl, at);
    if (!r) return announce("There's a marker there already");
    apply(() => r.edl, "Add marker");
    setSelectedMarker(r.id);
    announce(`Marker at ${timecode(at, FPS)}`);
  };
  const nextMarker = () => {
    const m = (edl.markers ?? []).find((x) => x.atMs > playhead + 1);
    if (m) seekProgram(m.atMs);
  };

  /* --------------------------------------- menus -------------------------------------------- */

  const addTrackMenu = (): MenuEntry[] => [
    { label: "Add video track", onSelect: () => trackAdd("video") },
    { label: "Add text track", onSelect: () => trackAdd("text") },
    { label: "Add audio track", onSelect: () => trackAdd("audio") },
    { label: "Add music track", onSelect: () => trackAdd("audio", "music") },
  ];
  const trackAdd = (kind: "video" | "text" | "audio", audioKind: "music" | "sfx" | "voice" = "sfx") => {
    const r = addTrack(edl, kind, audioKind);
    if (!r) return announce("That's the most tracks of that kind an edit can have");
    apply(() => r.edl, "Add track");
    announce(`Added a ${kind === "audio" ? (audioKind === "music" ? "music" : "audio") : kind} track`);
  };
  const trackMenu = (t: TrackInfo): MenuEntry[] => {
    const free = t.kind === "video" || t.kind === "text" || t.kind === "audio";
    return [
      { label: "Select everything on this track", onSelect: () => select(trackRefs(edl, t.key)) },
      { label: "Close gaps", disabled: t.kind === "main" || t.kind === "source-audio" || t.locked, onSelect: () => apply((e) => closeGaps(e, t.key), "Close gaps") },
      ...(free
        ? ([
            { label: "Move track up", onSelect: () => apply((e) => moveTrack(e, t.key, -1), "Move track") },
            { label: "Move track down", onSelect: () => apply((e) => moveTrack(e, t.key, 1), "Move track") },
          ] as MenuEntry[])
        : []),
      "sep",
      ...addTrackMenu(),
      ...(free ? (["sep", { label: `Delete ${t.label}`, danger: true, onSelect: () => apply((e) => removeTrack(e, t.key), "Delete track") }] as MenuEntry[]) : []),
    ];
  };
  const laneMenu = (t: TrackInfo, at: number): MenuEntry[] => [
    { label: "Paste here", hint: "Ctrl V", disabled: !clipboard.current, onSelect: () => paste(at) },
    { label: "Add marker here", hint: "M", onSelect: () => dropMarker(at) },
    { label: "Cut every track here", onSelect: () => {
      const r = razorAll(edl, at);
      if (r.cuts) apply(() => r.edl, "Cut every track");
    } },
    "sep",
    ...trackMenu(t),
  ];
  const clipMenu = (ref: TimelineRef, at: number): MenuEntry[] => {
    const fx = ref.kind === "effect" ? edl.effects.find((f) => f.id === ref.id) : undefined;
    const seg = ref.kind === "segment" ? edl.segments.find((s) => s.id === ref.id) : undefined;
    return [
      { label: "Split here", onSelect: () => splitSel(at) },
      { label: "Split at playhead", hint: "Ctrl K", onSelect: () => splitSel(playhead) },
      "sep",
      { label: "Cut", hint: "Ctrl X", onSelect: () => copySel(true) },
      { label: "Copy", hint: "Ctrl C", onSelect: () => copySel() },
      { label: "Paste at playhead", hint: "Ctrl V", disabled: !clipboard.current, onSelect: () => paste() },
      { label: "Duplicate", hint: "Ctrl D", onSelect: duplicate },
      "sep",
      ...(fx ? [{ label: fx.enabled === false ? "Turn effect on" : "Turn effect off", onSelect: () => apply((e) => ({ ...e, effects: e.effects.map((f) => (f.id === fx.id ? { ...f, enabled: f.enabled === false } : f)) }), "Toggle effect") }] : []),
      ...(seg
        ? [
            {
              label: "Open in Source monitor",
              onSelect: () => {
                setActiveSeg(seg.id);
                setSrcTarget("segment");
                requestAnimationFrame(() => seekSource(seg.inMs, seg.sessionId));
              },
            },
            { label: seg.volume === 0 ? "Unmute clip audio" : "Mute clip audio", onSelect: () => apply((e) => ({ ...e, segments: e.segments.map((s) => (s.id === seg.id ? { ...s, volume: s.volume === 0 ? 1 : 0 } : s)) }), "Clip audio") },
          ]
        : []),
      { label: "Inspector", onSelect: () => setTab(ref.kind === "effect" ? "effects" : "clip") },
      "sep",
      { label: "Delete", hint: "Del", danger: true, onSelect: () => deleteSel(false) },
      { label: "Ripple delete", hint: "Shift Del", danger: true, onSelect: () => deleteSel(true) },
    ];
  };
  const markerMenu = (m: EdlMarker): MenuEntry[] => [
    { label: "Edit note", onSelect: () => setTab("markers") },
    { label: "Next colour", onSelect: () => apply((e) => updateMarker(e, m.id, { color: nextMarkerColor(m.color) }), "Marker colour") },
    { label: "Delete marker", danger: true, onSelect: () => apply((e) => removeMarker(e, m.id), "Delete marker") },
  ];
  const seqMenu = (id: string): MenuEntry[] => {
    const i = sequences.findIndex((s) => s.id === id);
    const s = sequences[i]!;
    return [
      { label: "Rename", onSelect: () => setRenamingSeq(id) },
      ...newSeqMenu(id),
      ...(id !== MAIN_SEQUENCE_ID
        ? ([
            { label: "Move left", disabled: i <= 1, onSelect: () => project.applyDoc((d) => moveSequence(d, id, -1), "Move timeline") },
            { label: "Move right", disabled: i >= sequences.length - 1, onSelect: () => project.applyDoc((d) => moveSequence(d, id, 1), "Move timeline") },
            "sep",
            { label: `Delete “${s.name}”`, danger: true, onSelect: () => project.applyDoc((d) => removeSequence(d, id), "Delete timeline", MAIN_SEQUENCE_ID) },
          ] as MenuEntry[])
        : []),
    ];
  };
  const newSeqMenu = (from: string): MenuEntry[] => {
    const full = sequences.length >= 8;
    const mk = (aspect: Edl["aspect"] | undefined, label: string): MenuEntry => ({
      label,
      disabled: full,
      onSelect: () => {
        const r = addSequence(project.doc, from, { aspect });
        if (!r) return announce("A project can have at most 8 timelines");
        project.applyDoc(() => r.doc, "Add timeline", r.id);
        announce(`Added the timeline ${r.doc.sequences.extra.at(-1)?.name}`);
      },
    });
    return [mk(undefined, "Duplicate timeline"), mk("16:9", "New 16:9 version"), mk("9:16", "New 9:16 version"), mk("1:1", "New 1:1 version")];
  };
  const openMenu = (label: string, items: MenuEntry[], el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ label, items, x: r.left, y: r.bottom + 2 });
  };

  /* ------------------------------------------ keyboard -------------------------------------- */

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!wide) return;
    const el = e.target as HTMLElement | null;
    const typing = el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
    const inDialog = el?.closest?.("[role=dialog], [role=menu]");
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (inDialog) return;
    if (mod && !e.altKey && (key === "z" || key === "y")) {
      if (typing) return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
    if (typing) return;
    if (mod && !e.altKey) {
      if (key === "k") {
        e.preventDefault();
        return addAtPlayhead();
      }
      if (key === "c") return copySel();
      if (key === "x") return copySel(true);
      if (key === "v") {
        e.preventDefault();
        return paste();
      }
      if (key === "d") {
        e.preventDefault();
        return duplicate();
      }
      if (key === "a") {
        e.preventDefault();
        return select(listAll(edl));
      }
      return;
    }
    if (el?.getAttribute("role") === "slider" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
    if ((e.key === " " || e.key === "Enter") && el && (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab")) return;
    const v = preview.current;
    if (e.altKey) {
      if (key === "x") {
        e.preventDefault();
        setRange(NO_RANGE);
        return announce("Cleared in and out");
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const d = ((e.shiftKey ? 10 : 1) * 1000) / FPS;
        apply((ed) => nudgeRefs(ed, sel, e.key === "ArrowLeft" ? -d : d), "Nudge", "nudge");
      }
      return;
    }
    const tl = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (tl && !e.shiftKey) {
      setTool(tl.id);
      return announce(`${tl.label} tool`);
    }
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
      markHere(key === "i" ? "in" : "out");
    } else if (key === ";") lift();
    else if (key === "'") extract();
    else if (key === ",") {
      const s = sourceOf(srcSession);
      if (s) insertSource({ sessionId: s.sessionId, ...dragRange(s) }, mode === "program" ? outPos : playhead, "v1");
    } else if (key === ".") overlaySource();
    else if (key === "q" || key === "w") trimToPlayhead(key === "q" ? "in" : "out");
    else if (key === "m") {
      if (e.shiftKey) nextMarker();
      else dropMarker();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      step((e.shiftKey ? FPS : 1) * (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      jumpEdge(e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      seekProgram(e.key === "Home" ? 0 : Math.max(0, total - 1));
    } else if (key === "s") {
      setSnapping((x) => !x);
      announce(`Snapping ${snapping ? "off" : "on"}`);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (selectedMarker && sel.length === 0) {
        apply((ed) => removeMarker(ed, selectedMarker), "Delete marker");
        setSelectedMarker(null);
      } else deleteSel(e.shiftKey);
    } else if (e.key === "+" || e.key === "=") setPps(pps * 1.5);
    else if (e.key === "-") setPps(pps / 1.5);
    else if (e.key === "\\") fit();
    else if (e.key === "?") setShortcutsOpen(true);
    else if (e.key === "Escape") {
      if (shortcutsOpen) setShortcutsOpen(false);
      else {
        setSelection([]);
        setSelectedMarker(null);
      }
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
    const mid = srcTarget === "segment" ? (active.inMs + active.outMs) / 2 : srcPos;
    const half = Math.max(60_000, srcTarget === "segment" ? (active.outMs - active.inMs) * 1.5 : 120_000);
    const start = Math.max(0, Math.min(srcDuration - 2 * half, mid - half));
    return { start, end: Math.min(srcDuration, start + 2 * half) };
  }, [srcZoom, srcDuration, active.inMs, active.outMs, srcTarget, srcPos]);
  const zoomSource = (f: number) => {
    const span = Math.min(srcDuration, Math.max(4000, (srcView.end - srcView.start) * f));
    const center = Math.min(Math.max(srcPos, srcView.start), srcView.end);
    const start = Math.max(0, Math.min(srcDuration - span, center - span / 2));
    setSrcZoom({ start, end: start + span });
  };
  const allMarkers: TemplateMarker[] = useMemo(() => sources.flatMap((s) => s.markers.map((m) => ({ sessionId: s.sessionId, ...m }))), [sources]);
  const aiMarkers: AiMarker[] = useMemo(
    () =>
      allMarkers.flatMap((m) => {
        const t = markerOutputMs(edl, m);
        return t === null ? [] : [{ ms: t, label: m.label, kind: m.kind }];
      }),
    [allMarkers, edl],
  );
  const bigMarkers = (src?.markers ?? []).filter((m) => m.kind === "big").slice(0, 24);
  const approx = edl.grade.preset !== "none" || edl.segments.some((s, i) => i > 0 && s.transitionIn.kind !== "cut") || edl.audioTracks.some((t) => t.duck) || edl.sourceAudio.denoise || edl.sourceAudio.voiceBoost || edl.normalize;
  const inEdit = useMemo(() => new Set(edl.segments.map((s) => s.sessionId)), [edl.segments]);
  const sourceTitle = useCallback((id: string) => sourceOf(id)?.title ?? "Video", [sourceOf]);
  const clipMarks = marks[srcSession] ?? NO_RANGE;

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
    sequenceId: seqId,
    sequences,
  };

  const pickAsset = (a: StudioAsset, atMs?: number) =>
    placeMedia(
      ctx,
      { ref: { kind: "library", assetId: a.id }, name: a.name, kind: AUDIO_KINDS.includes(a.kind) ? "audio" : "image", audioKind: a.kind === "music" || a.kind === "ambience" ? "music" : "sfx", durationMs: a.durationMs ?? null, visual: a.kind },
      atMs,
    );

  const onTime = (m: MonitorMode, ms: number) => (m === "program" ? setOutPos(ms) : setSrcPos(ms));
  const onDims = (id: string, d: { width: number; height: number; durationMs: number }) => setDims((xx) => ({ ...xx, [id]: { width: d.width || dims(id).width, height: d.height || dims(id).height, durationMs: d.durationMs || dims(id).durationMs } }));

  const sourcePanel = (
    <div className="nle-srcpanel">
      <div className="nle-srcpanel-head">
        <span>
          {srcTarget === "segment" && srcSession === active.sessionId ? `Clip ${activeIdx + 1} on V1: drag the handles or press I and O` : `Mark a part: I and O, then , to insert or . to overlay`}
        </span>
        <span className="nle-srcpanel-tools">
          <button type="button" className="nle-btn" onClick={() => zoomSource(0.5)} aria-label="Zoom the source timeline in">
            +
          </button>
          <button type="button" className="nle-btn" onClick={() => zoomSource(2)} aria-label="Zoom the source timeline out">
            −
          </button>
          <button type="button" className="nle-btn" onClick={() => setSrcZoom({ start: 0, end: srcDuration })}>
            Fit
          </button>
          {srcTarget === "clip" && (
            <>
              <button type="button" className="nle-btn nle-btn-gold" onClick={() => src && insertSource({ sessionId: src.sessionId, ...dragRange(src) }, outPos, "v1")} aria-keyshortcuts=",">
                Insert
              </button>
              <button type="button" className="nle-btn" onClick={overlaySource} aria-keyshortcuts=".">
                Overlay
              </button>
            </>
          )}
        </span>
      </div>
      <SourceTimeline
        durationMs={srcDuration}
        view={srcView}
        positionMs={srcTarget === "segment" && srcSession !== active.sessionId ? active.inMs : srcPos}
        markers={src?.markers ?? []}
        ranges={
          srcTarget === "segment"
            ? edl.segments.filter((s) => s.sessionId === srcSession).map((s) => ({ id: s.id, inMs: s.inMs, outMs: s.outMs, active: s.id === active.id }))
            : clipMarks.inMs !== null || clipMarks.outMs !== null
              ? [{ id: "__clip", inMs: clipMarks.inMs ?? 0, outMs: clipMarks.outMs ?? Math.min(srcDuration, (clipMarks.inMs ?? 0) + 60_000), active: true }]
              : []
        }
        onSeek={(ms) => seekSource(ms, srcSession)}
        onChangeRange={(id, edge, ms) => {
          if (id === "__clip") return setMarks((m) => ({ ...m, [srcSession]: { ...(m[srcSession] ?? NO_RANGE), [edge === "in" ? "inMs" : "outMs"]: Math.round(ms) } }));
          select([{ kind: "segment", id }]);
          setEdge(id, edge, ms);
        }}
      />
      <div className="nle-moments">
        <span className="nle-moments-label">AI moments</span>
        {bigMarkers.map((m, i) => (
          <button key={`${m.ms}-${i}`} type="button" className="nle-chip" onClick={() => seekSource(Math.max(0, m.ms - 1000), srcSession)}>
            <span className="nle-chip-blip" aria-hidden />
            <span className="text-gold">{m.label}</span>
            <span className="tnum">{editTime(m.ms)}</span>
          </button>
        ))}
        {(src?.markers.length ?? 0) > 0 ? (
          <>
            <label htmlFor="jump" className="sr-only">
              Jump to an AI moment
            </label>
            <select id="jump" className="nle-select" value="" onChange={(e) => e.target.value && seekSource(Math.max(0, Number(e.target.value) - 1000), srcSession)}>
              <option value="">Jump to a moment ({src!.markers.length})</option>
              {src!.markers.slice(0, 400).map((m, i) => (
                <option key={`${m.ms}-${i}`} value={m.ms}>
                  {editTime(m.ms)} {m.label.slice(0, 60)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="nle-moments-label">none on this video</span>
        )}
      </div>
    </div>
  );

  const viewer = (
    <Monitor
      preview={preview}
      edl={edl}
      total={total}
      fps={FPS}
      mode={mode}
      sources={sources}
      srcSession={srcSession}
      media={mediaInfo}
      title={title}
      quality={layout.quality}
      onQuality={(q) => setLayout((l) => ({ ...l, quality: q }))}
      guides={layout.guides}
      onGuides={(g) => setLayout((l) => ({ ...l, guides: g }))}
      playing={playing}
      rate={rate}
      outPos={outPos}
      srcPos={srcPos}
      srcDuration={srcDuration}
      onTime={onTime}
      onPlayingChange={setPlaying}
      onDims={onDims}
      onMode={switchMode}
      onTogglePlay={togglePlay}
      onStep={step}
      onJump={(to) => (mode === "program" ? seekProgram(to === "start" ? 0 : Math.max(0, total - 1)) : seekSource(to === "start" ? 0 : Math.max(0, srcDuration - 1)))}
      onMarkIn={() => markHere("in")}
      onMarkOut={() => markHere("out")}
      markInLabel={mode === "source" ? "Set the in point (I)" : "Timeline in (I)"}
      markOutLabel={mode === "source" ? "Set the out point (O)" : "Timeline out (O)"}
      sourcePanel={sourcePanel}
      approx={approx}
    />
  );

  /* ---------------------------------------- phones -------------------------------------------- */

  if (!wide) {
    return (
      <EditorContext.Provider value={ctx}>
        <PhoneEditor
          title={title}
          onTitle={(t) => {
            setTitle(t);
            setTitleRev((r) => r + 1);
          }}
          saveLabel={saveLabel}
          edl={edl}
          total={total}
          viewer={
            <div className="nle-phone-frame" style={{ aspectRatio: `${edl.aspect.replace(":", " / ")}`, width: `min(100%, calc(56dvh * ${(ASPECT_SIZE[edl.aspect].width / ASPECT_SIZE[edl.aspect].height).toFixed(4)}))` }}>
              <PreviewStage ref={preview} edl={edl} total={total} mode="program" sources={sources} sourceSession={srcSession} media={mediaInfo} title={title} quality="half" onTime={onTime} onPlayingChange={setPlaying} onDims={onDims} />
            </div>
          }
          playing={playing}
          onTogglePlay={togglePlay}
          outPos={outPos}
          onSeek={seekProgram}
          renders={renders}
          onRenders={setRenders}
          undo={{ can: project.canUndo, run: undo }}
          redo={{ can: project.canRedo, run: redo }}
        />
        <p className="sr-only" aria-live="assertive">
          {announcement}
        </p>
      </EditorContext.Provider>
    );
  }

  /* ---------------------------------------- desktop ------------------------------------------- */

  const resizeCol = (which: "bin" | "insp") => (e: React.PointerEvent) => {
    const start = layout[which];
    startSplitDrag(e, "x", (d) => setLayout((l) => ({ ...l, [which]: clamp(which === "bin" ? start + d : start - d, 200, 560) })));
  };
  const resizeRow = (e: React.PointerEvent) => {
    const start = layout.tl;
    startSplitDrag(e, "y", (d) => setLayout((l) => ({ ...l, tl: clamp(start - d, 160, Math.max(200, window.innerHeight - 260)) })));
  };
  const sepKeys = (which: "bin" | "insp" | "tl") => (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    setLayout((l) =>
      which === "tl" ? { ...l, tl: clamp(l.tl - dir * 20, 160, 900) } : { ...l, [which]: clamp(l[which] + (which === "bin" ? dir : -dir) * 20, 200, 560) },
    );
  };
  const zoomPos = Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);

  return (
    <EditorContext.Provider value={ctx}>
      <div className="nle-root" data-nle>
        <header className="nle-bar">
          <Link href="/studio" className="nle-brand" aria-label="Back to Studio">
            <Wordmark size="sm" />
            <span className="nle-brand-sub">Studio</span>
          </Link>
          <Link href="/studio#library" className="nle-back">
            ← Library
          </Link>
          <label htmlFor="edit-title" className="sr-only">
            Title
          </label>
          <input
            id="edit-title"
            className="nle-title"
            value={title}
            maxLength={120}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleRev((r) => r + 1);
            }}
          />
          <span className={`nle-save${!validation.ok && dirty ? " is-bad" : ""}`} aria-live="polite">
            <span className="nle-save-dot" aria-hidden />
            {initial.origin === "auto" ? "Auto clip draft · " : ""}
            {saveLabel}
            {!validation.ok && dirty ? `: ${validation.message}` : ""}
          </span>
          <span className="nle-bar-gap" />
          <button type="button" className="nle-ico" disabled={!project.canUndo} onClick={undo} aria-label="Undo" aria-keyshortcuts="Control+Z" title={project.undoLabel ? `Undo ${project.undoLabel}` : "Undo"}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M8 7V3L2 9l6 6v-4h7a4 4 0 0 1 0 8h-3v2h3a6 6 0 0 0 0-12z" />
            </svg>
          </button>
          <button type="button" className="nle-ico" disabled={!project.canRedo} onClick={redo} aria-label="Redo" aria-keyshortcuts="Control+Shift+Z" title={project.redoLabel ? `Redo ${project.redoLabel}` : "Redo"}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M16 7V3l6 6-6 6v-4H9a4 4 0 0 0 0 8h3v2H9a6 6 0 0 1 0-12z" />
            </svg>
          </button>
          <button type="button" className="nle-btn" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="?">
            Shortcuts
          </button>
          <button type="button" className="nle-btn nle-btn-ghost" disabled={rendering || !validation.ok} onClick={() => void render()} title="Render this timeline as edited">
            {rendering ? "Starting render" : "Render"}
          </button>
          <button type="button" className="nle-btn nle-btn-rec" onClick={() => setExportOpen(true)}>
            <span className="nle-rec-dot" aria-hidden />
            Export
            {busy > 0 && <span className="nle-badge">{busy}</span>}
          </button>
        </header>
        {error && (
          <p role="alert" className="nle-alert">
            {error}
          </p>
        )}
        <p className="sr-only" aria-live="assertive">
          {announcement}
        </p>

        <div className="nle-work" style={{ gridTemplateRows: `minmax(0,1fr) 6px ${layout.tl}px` }}>
          <div className="nle-top" style={{ gridTemplateColumns: `${layout.bin}px 6px minmax(0,1fr) 6px ${layout.insp}px` }}>
            <MediaBin
              projectSources={sources}
              inEdit={inEdit}
              onOpen={openSource}
              onInsert={(s) => insertFromBin(s)}
              dragRange={dragRange}
              onPickAsset={(a) => pickAsset(a)}
              libraryAvailable={Boolean(library)}
              onDragSource={(s) => {
                if (!sources.some((x) => x.sessionId === s.sessionId)) setExtraSources((xs) => [...xs, s]);
              }}
            />
            <div role="separator" aria-orientation="vertical" aria-label="Resize the media bin" aria-valuenow={layout.bin} aria-valuemin={200} aria-valuemax={560} tabIndex={0} className="nle-split nle-split-x" onPointerDown={resizeCol("bin")} onKeyDown={sepKeys("bin")} />
            {viewer}
            <div role="separator" aria-orientation="vertical" aria-label="Resize the inspector" aria-valuenow={layout.insp} aria-valuemin={200} aria-valuemax={560} tabIndex={0} className="nle-split nle-split-x" onPointerDown={resizeCol("insp")} onKeyDown={sepKeys("insp")} />
            <div className="nle-panels nle-insp-wrap">
              <InspectorDock
                tab={tab}
                onTab={setTab}
                aiProject={{ ...saved, title, edl }}
                onApplyEdl={(next) => replace(next, "AI edit")}
                templateMarkers={allMarkers}
                fps={FPS}
                selectedMarker={selectedMarker}
                onSelectMarker={setSelectedMarker}
              />
            </div>
          </div>
          <div role="separator" aria-orientation="horizontal" aria-label="Resize the timeline" aria-valuenow={layout.tl} aria-valuemin={160} aria-valuemax={900} tabIndex={0} className="nle-split nle-split-y" onPointerDown={resizeRow} onKeyDown={sepKeys("tl")} />
          <section aria-label="Timeline" className="nle-bottom" ref={tlBox}>
            <div className="nle-seqbar">
              <div role="tablist" aria-label="Timelines" className="nle-seqtabs">
                {sequences.map((s) =>
                  renamingSeq === s.id ? (
                    <input
                      key={s.id}
                      className="nle-seq-input"
                      aria-label="Timeline name"
                      defaultValue={s.name}
                      maxLength={40}
                      autoFocus
                      onBlur={(e) => {
                        project.applyDoc((d) => renameSequence(d, s.id, e.target.value), "Rename timeline");
                        setRenamingSeq(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenamingSeq(null);
                      }}
                    />
                  ) : (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      aria-selected={s.id === seqId}
                      className="nle-seqtab"
                      onClick={() => switchSeq(s.id)}
                      onDoubleClick={() => setRenamingSeq(s.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ label: "Timeline", items: seqMenu(s.id), x: e.clientX, y: e.clientY });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "F2") setRenamingSeq(s.id);
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          openMenu("Timeline", seqMenu(s.id), e.currentTarget);
                        }
                      }}
                    >
                      <span className="nle-seqtab-name">{s.name}</span>
                      <span className="nle-seqtab-shape">{s.edl.aspect}</span>
                    </button>
                  ),
                )}
              </div>
              <button type="button" className="nle-btn" aria-haspopup="menu" onClick={(e) => openMenu("Add timeline", newSeqMenu(seqId), e.currentTarget)} disabled={sequences.length >= 8}>
                + Add timeline
              </button>
              <button type="button" className="nle-tgl" aria-label="Timeline menu" aria-haspopup="menu" onClick={(e) => openMenu("Timeline", seqMenu(seqId), e.currentTarget)}>
                ⋯
              </button>
              <span className="nle-bar-gap" />
              <span className="nle-tc tnum" aria-label="Timeline length">
                {timecode(total, FPS)}
              </span>
            </div>
            <div className="nle-toolbar" role="toolbar" aria-label="Timeline tools">
              <div className="nle-toolgroup" role="radiogroup" aria-label="Tool">
                {TOOLS.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} className="nle-tool" title={`${t.label} (${t.key}): ${t.hint}`} aria-label={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d={t.glyph} />
                    </svg>
                  </button>
                ))}
              </div>
              <button type="button" className="nle-btn" aria-pressed={snapping} onClick={() => setSnapping((x) => !x)} aria-keyshortcuts="S" title="Snap to edges, the playhead and markers (S)">
                Snap
              </button>
              <button type="button" className="nle-btn" aria-pressed={magnetic} onClick={() => setMagnetic((x) => !x)} title="Magnetic: deleting closes the gap on every track">
                Magnetic
              </button>
              <span className="nle-toolsep" />
              <button type="button" className="nle-btn" onClick={addAtPlayhead} aria-keyshortcuts="Control+K" title="Cut every track at the playhead (Ctrl/⌘ K)">
                Cut
              </button>
              <button type="button" className="nle-btn" onClick={() => dropMarker()} aria-keyshortcuts="M" title="Add a marker at the playhead (M)">
                Marker
              </button>
              <button type="button" className="nle-btn" onClick={lift} aria-keyshortcuts=";" disabled={range.inMs === null && range.outMs === null} title="Lift: remove between in and out, leave a gap (;)">
                Lift
              </button>
              <button type="button" className="nle-btn" onClick={extract} aria-keyshortcuts="'" disabled={range.inMs === null && range.outMs === null} title="Extract: cut out between in and out and close the gap (')">
                Extract
              </button>
              {(range.inMs !== null || range.outMs !== null) && (
                <span className="nle-range-read tnum">
                  In {timecode(range.inMs ?? 0, FPS)} · Out {timecode(range.outMs ?? total, FPS)}
                  <button type="button" className="nle-tgl" aria-label="Clear in and out" onClick={() => setRange(NO_RANGE)}>
                    ×
                  </button>
                </span>
              )}
              <span className="nle-bar-gap" />
              <button type="button" className="nle-btn" aria-haspopup="menu" onClick={(e) => openMenu("Add track", addTrackMenu(), e.currentTarget)}>
                + Track
              </button>
              <button type="button" className="nle-ico" onClick={() => setPps(pps / 1.5)} aria-label="Zoom the timeline out">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 11h14v2H5z" />
                </svg>
              </button>
              <label htmlFor="tl-zoom" className="sr-only">
                Timeline zoom
              </label>
              <input
                id="tl-zoom"
                className="nle-zoom"
                type="range"
                min={0}
                max={1000}
                value={Math.round(zoomPos * 1000)}
                aria-valuetext={pps >= 1 ? `${Math.round(pps)} pixels per second` : `${Math.round(1 / pps)} seconds per pixel`}
                onChange={(e) => setPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, Number(e.target.value) / 1000))}
              />
              <button type="button" className="nle-ico" onClick={() => setPps(pps * 1.5)} aria-label="Zoom the timeline in">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                </svg>
              </button>
              <button type="button" className="nle-btn" onClick={fit} aria-keyshortcuts="\">
                Fit
              </button>
            </div>
            <Timeline
              edl={edl}
              total={total}
              fps={FPS}
              playheadMs={playhead}
              playing={playing}
              selection={sel}
              onSelect={onSelect}
              aiMarkers={aiMarkers}
              range={range}
              onRange={setRange}
              tool={tool}
              snapping={snapping}
              pps={pps}
              minPps={MIN_PPS}
              maxPps={MAX_PPS}
              onPps={setPps}
              heights={tracksUi.heights}
              onHeight={(k, h) => setTracksUi((t) => ({ ...t, heights: { ...t.heights, [k]: h } }))}
              expanded={tracksUi.expanded}
              onExpand={(k) => setTracksUi((t) => ({ ...t, expanded: t.expanded.includes(k) ? t.expanded.filter((x) => x !== k) : [...t.expanded, k] }))}
              sourcePeaks={sourcePeaks}
              clipPeaks={clipPeaks}
              clipName={refName}
              sourceTitle={sourceTitle}
              maxSourceMs={maxSourceMs}
              sprites={sprites}
              onSeek={seekProgram}
              onEdit={apply}
              announce={announce}
              onDropAsset={(a, ms) => pickAsset(a, ms)}
              onDropSource={(s, ms, track) => insertSource(s, ms, track.startsWith("ov:") ? track : "v1")}
              clipMenu={clipMenu}
              trackMenu={trackMenu}
              laneMenu={laneMenu}
              markerMenu={markerMenu}
              selectedMarker={selectedMarker}
              onSelectMarker={setSelectedMarker}
              onRename={(k, n) => apply((e) => renameTrack(e, k, n), "Rename track")}
              onToggle={(k, f) => apply((e) => toggleTrack(e, k, f), f === "hidden" ? "Show or hide track" : f === "locked" ? "Lock track" : f === "muted" ? "Mute track" : "Solo track")}
            />
          </section>
        </div>

        <ContextMenu menu={menu} onClose={() => setMenu(null)} />
        {exportOpen && <ExportDialog title={title} renders={renders} onRenders={setRenders} onClose={() => setExportOpen(false)} busy={busy} />}
        {shortcutsOpen && (
          <Dialog title="Shortcuts" onClose={() => setShortcutsOpen(false)} className="nle-shortcuts">
            <div className="nle-dialog-head">
              <span className="nle-pause-kicker">Keyboard</span>
              <button type="button" className="nle-btn" autoFocus onClick={() => setShortcutsOpen(false)}>
                Close
              </button>
            </div>
            <dl className="nle-keys">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </Dialog>
        )}
      </div>
    </EditorContext.Provider>
  );
}

/** Every timeline must be valid before the project saves. */
function validateDoc(doc: ProjectDoc): { ok: true; main: Edl; sequences: ProjectSequences } | { ok: false; message: string } {
  const all = docSequences(doc);
  const bad = all.map((s) => ({ s, r: Edl.safeParse(s.edl) })).find((x) => !x.r.success);
  if (bad && !bad.r.success) return { ok: false, message: `${all.length > 1 ? `${bad.s.name}: ` : ""}${bad.r.error.issues[0]?.message ?? "This edit isn't valid yet"}` };
  const seqs = ProjectSequences.safeParse(doc.sequences);
  if (!seqs.success) return { ok: false, message: seqs.error.issues[0]?.message ?? "A timeline isn't valid" };
  return { ok: true, main: Edl.parse(doc.main), sequences: seqs.data };
}

/** Every selectable item on the timeline being edited. */
function listAll(edl: Edl): TimelineRef[] {
  return [
    ...edl.segments.map((s): TimelineRef => ({ kind: "segment", id: s.id })),
    ...edl.overlays.flatMap((t) => t.items.map((x): TimelineRef => ({ kind: "overlay", trackId: t.id, id: x.id }))),
    ...edl.audioTracks.flatMap((t) => t.clips.map((x): TimelineRef => ({ kind: "audio", trackId: t.id, id: x.id }))),
    ...edl.effects.map((x): TimelineRef => ({ kind: "effect", id: x.id })),
    ...edl.captionTrack.cues.map((x): TimelineRef => ({ kind: "caption", id: x.id })),
  ];
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
      let pk = 0;
      for (let i = b * per; i < Math.min(data.length, (b + 1) * per); i += 4) pk = Math.max(pk, Math.abs(data[i]!));
      peaks.push(pk);
      max = Math.max(max, pk);
    }
    return { peaks: peaks.map((pk) => Math.round((pk / max) * 1000) / 1000), durationMs: Math.round(audio.duration * 1000) };
  } catch {
    return null;
  }
}
