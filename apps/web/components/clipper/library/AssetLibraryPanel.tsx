"use client";

import { Tabs } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioAsset, StudioAssetKind, StudioAssetsResponse } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import "./asset-library.css";

export interface AssetLibraryPanelProps {
  /** Limit the browser to these kinds (e.g. only audio while an audio track is selected). */
  kinds?: StudioAssetKind[];
  /** The creator picked an asset (click, Enter, or drop): the editor places it at the playhead. */
  onPick: (asset: StudioAsset) => void;
  /**
   * "pick" (default, inside the editor): every item has an Add button. "browse" (Studio): items
   * can be previewed and starred, and the starred ones come first in the editor.
   */
  mode?: "pick" | "browse";
}

/** Drag-and-drop payload type for dropping a library item onto the timeline. */
export const ASSET_DRAG_TYPE = "application/x-slot1-asset";

type TabId = "sounds" | "music" | "ambience" | "elements" | "frames" | "transitions";

const TABS: { id: TabId; label: string; kinds: StudioAssetKind[]; noun: string }[] = [
  { id: "sounds", label: "Sounds", kinds: ["sfx"], noun: "sounds" },
  { id: "music", label: "Music", kinds: ["music"], noun: "music loops" },
  { id: "ambience", label: "Ambience", kinds: ["ambience"], noun: "ambience beds" },
  { id: "elements", label: "Elements", kinds: ["sticker", "overlay"], noun: "elements" },
  { id: "frames", label: "Frames", kinds: ["frame"], noun: "frames" },
  { id: "transitions", label: "Transitions", kinds: ["transition"], noun: "transitions" },
];

const AUDIO: StudioAssetKind[] = ["sfx", "music", "ambience"];
const FAV_KEY = "slot1.studio.favorites.v1";

const CATEGORY_LABELS: Record<string, string> = {
  hud: "HUD",
  ui: "UI",
  sfx: "Sounds",
  lofi: "Lo-fi",
};

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1).replace(/-/g, " ");
}

function seconds(ms: number | undefined): string {
  if (!ms) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function readFavorites(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FAV_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFavorites(f: Set<string>): void {
  try {
    window.localStorage.setItem(FAV_KEY, JSON.stringify([...f]));
  } catch {
    /* private mode or storage blocked: favorites last for this visit only */
  }
}

function fileUrl(a: StudioAsset, rev: string): string {
  return `/api/studio/assets/file/${a.id}?v=${encodeURIComponent(rev)}`;
}

function motionOf(a: StudioAsset): string {
  return a.tags.find((t) => t.startsWith("motion:"))?.slice(7) ?? "fade";
}

export function AssetLibraryPanel({ kinds, onPick, mode = "pick" }: AssetLibraryPanelProps) {
  const [data, setData] = useState<StudioAssetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("sounds");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const load = useCallback(() => {
    setError(null);
    api<StudioAssetsResponse>("/api/studio/assets")
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setError("Sign in with your creator account to use the library.");
        else setError("Couldn't load the library. Check your connection and try again.");
      });
  }, []);

  useEffect(() => {
    load();
    // Favorites live in this browser only; read them after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavorites(readFavorites());
  }, [load]);

  const visibleTabs = useMemo(() => TABS.filter((t) => !kinds || t.kinds.some((k) => kinds.includes(k))), [kinds]);
  const activeTab = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];

  useEffect(() => {
    if (activeTab && activeTab.id !== tab) setTab(activeTab.id);
  }, [activeTab, tab]);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const tick = useCallback(() => {
    const el = audioRef.current;
    const bar = progressRef.current;
    if (el && bar && el.duration > 0) bar.style.setProperty("--alib-p", String(Math.min(1, el.currentTime / el.duration)));
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const toggle = useCallback(
    (a: StudioAsset) => {
      if (!data) return;
      if (playing === a.id) {
        stop();
        return;
      }
      stop();
      const el = audioRef.current ?? new Audio();
      audioRef.current = el;
      el.loop = Boolean(a.loop);
      el.src = fileUrl(a, data.rev);
      el.onended = () => stop();
      setPlaying(a.id);
      el.play().catch(() => {
        setPlaying(null);
        setAnnounce(`Couldn't play ${a.name}.`);
      });
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
    },
    [data, playing, stop, tick],
  );

  const toggleFavorite = useCallback((a: StudioAsset) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      writeFavorites(next);
      setAnnounce(next.has(a.id) ? `${a.name} added to favorites.` : `${a.name} removed from favorites.`);
      return next;
    });
  }, []);

  const pick = useCallback(
    (a: StudioAsset) => {
      onPick(a);
      setAnnounce(`${a.name} added.`);
    },
    [onPick],
  );

  const inTab = useMemo(() => {
    if (!data || !activeTab) return [];
    return data.assets.filter((a) => activeTab.kinds.includes(a.kind) && (!kinds || kinds.includes(a.kind)));
  }, [data, activeTab, kinds]);

  const categories = useMemo(() => [...new Set(inTab.map((a) => a.category))].sort(), [inTab]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = inTab.filter((a) => {
      if (category && a.category !== category) return false;
      if (favOnly && !favorites.has(a.id)) return false;
      if (!words.length) return true;
      const hay = `${a.name} ${a.category} ${a.tags.join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // Favorites first, then by category and name.
    return list.sort((x, y) => Number(favorites.has(y.id)) - Number(favorites.has(x.id)) || x.category.localeCompare(y.category) || x.name.localeCompare(y.name));
  }, [inTab, query, category, favOnly, favorites]);

  const total = data?.assets.length ?? 0;
  const isAudio = activeTab ? activeTab.kinds.some((k) => AUDIO.includes(k)) : false;

  return (
    <section className="alib" aria-label="Sound and element library">
      <header className="alib-head">
        <div className="alib-title">
          <h3 className="poster-title alib-h">Library</h3>
          {data && <span className="alib-count tnum">{total} items, all made for SLOT1</span>}
        </div>
        <label className="alib-search">
          <span className="sr-only">Search the library</span>
          <svg viewBox="0 0 24 24" aria-hidden className="alib-search-icon">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="field alib-search-input"
            placeholder={activeTab ? `Search ${activeTab.noun}` : "Search"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>

      {error && (
        <div className="alib-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {!error && !data && <div className="alib-loading" aria-busy="true">Loading the library…</div>}

      {data && activeTab && (
        <Tabs.Root
          value={activeTab.id}
          onValueChange={(v) => {
            stop();
            setTab(v as TabId);
            setCategory(null);
          }}
        >
          <Tabs.List className="alib-tabs" aria-label="Library sections">
            {visibleTabs.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id} className="alib-tab data-[state=active]:select-bar">
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <div className="alib-chips" role="group" aria-label="Filter">
            <button type="button" className="alib-chip" aria-pressed={favOnly} onClick={() => setFavOnly((v) => !v)}>
              <span aria-hidden>★</span> Favorites
            </button>
            <button type="button" className="alib-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
              All
            </button>
            {categories.map((c) => (
              <button key={c} type="button" className="alib-chip" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {categoryLabel(c)}
              </button>
            ))}
          </div>

          {visibleTabs.map((t) => (
            <Tabs.Content key={t.id} value={t.id} className="alib-body" tabIndex={-1}>
              {t.id === activeTab.id &&
                (results.length === 0 ? (
                  <p className="alib-empty">
                    {favOnly && favorites.size === 0
                      ? "No favorites yet. Star anything in the library and it shows up here, and first in the editor."
                      : `Nothing matches${query ? ` “${query}”` : ""}. Try another word or clear the filters.`}
                  </p>
                ) : isAudio ? (
                  <ul className="alib-audio" aria-label={`${t.label}: ${results.length} results`}>
                    {results.map((a) => (
                      <AudioRow
                        key={a.id}
                        asset={a}
                        peaks={data.peaks[a.id]}
                        playing={playing === a.id}
                        favorite={favorites.has(a.id)}
                        mode={mode}
                        onToggle={() => toggle(a)}
                        onFavorite={() => toggleFavorite(a)}
                        onPick={() => pick(a)}
                        progressRef={playing === a.id ? progressRef : undefined}
                      />
                    ))}
                  </ul>
                ) : (
                  <ul className="alib-grid" aria-label={`${t.label}: ${results.length} results`}>
                    {results.map((a) => (
                      <VisualTile key={a.id} asset={a} rev={data.rev} favorite={favorites.has(a.id)} mode={mode} onFavorite={() => toggleFavorite(a)} onPick={() => pick(a)} />
                    ))}
                  </ul>
                ))}
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}

function dragStart(e: React.DragEvent, a: StudioAsset) {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify({ id: a.id, kind: a.kind }));
  e.dataTransfer.setData("text/plain", a.id);
}

function Waveform({ peaks, active, progressRef }: { peaks: number[] | undefined; active: boolean; progressRef?: React.Ref<HTMLDivElement> }) {
  const bars = peaks && peaks.length ? peaks : Array.from({ length: 48 }, () => 0.15);
  const w = 3;
  const gap = 1.6;
  const width = bars.length * (w + gap);
  return (
    <div className="alib-wave" data-active={active || undefined} ref={progressRef} aria-hidden>
      <svg viewBox={`0 0 ${width} 28`} preserveAspectRatio="none" className="alib-wave-svg">
        {bars.map((p, i) => {
          const h = Math.max(2, p * 26);
          return <rect key={i} x={i * (w + gap)} y={(28 - h) / 2} width={w} height={h} rx={1} />;
        })}
      </svg>
    </div>
  );
}

function AudioRow({
  asset,
  peaks,
  playing,
  favorite,
  mode,
  onToggle,
  onFavorite,
  onPick,
  progressRef,
}: {
  asset: StudioAsset;
  peaks: number[] | undefined;
  playing: boolean;
  favorite: boolean;
  mode: "pick" | "browse";
  onToggle: () => void;
  onFavorite: () => void;
  onPick: () => void;
  progressRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <li className="alib-row" data-playing={playing || undefined} draggable={mode === "pick"} onDragStart={(e) => dragStart(e, asset)}>
      <button type="button" className="alib-play" aria-label={playing ? `Stop ${asset.name}` : `Play ${asset.name}`} aria-pressed={playing} onClick={onToggle}>
        {playing ? (
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="alib-row-text">
        <span className="alib-name">{asset.name}</span>
        <span className="alib-meta">
          {categoryLabel(asset.category)}
          {asset.durationMs ? ` · ${seconds(asset.durationMs)}` : ""}
          {asset.loop ? " · loops" : ""}
        </span>
      </div>
      <Waveform peaks={peaks} active={playing} progressRef={progressRef} />
      <FavButton name={asset.name} on={favorite} onClick={onFavorite} />
      {mode === "pick" && (
        <button type="button" className="btn btn-ghost btn-sm alib-add" onClick={onPick} aria-label={`Add ${asset.name}`}>
          Add
        </button>
      )}
    </li>
  );
}

function FavButton({ name, on, onClick }: { name: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="alib-fav" aria-pressed={on} aria-label={on ? `Remove ${name} from favorites` : `Add ${name} to favorites`} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2.8l2.7 6 6.5.6-4.9 4.3 1.5 6.4L12 16.8 6.2 20.1l1.5-6.4-4.9-4.3 6.5-.6z" />
      </svg>
    </button>
  );
}

function VisualTile({
  asset,
  rev,
  favorite,
  mode,
  onFavorite,
  onPick,
}: {
  asset: StudioAsset;
  rev: string;
  favorite: boolean;
  mode: "pick" | "browse";
  onFavorite: () => void;
  onPick: () => void;
}) {
  const fullFrame = asset.kind !== "sticker";
  return (
    <li className="alib-tile" draggable={mode === "pick"} onDragStart={(e) => dragStart(e, asset)}>
      <div className={fullFrame ? "alib-thumb alib-thumb-scene" : "alib-thumb alib-thumb-check"} data-motion={asset.kind === "transition" ? motionOf(asset) : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- library files are served by the API, sized by the grid */}
        <img src={fileUrl(asset, rev)} alt="" loading="lazy" decoding="async" draggable={false} />
      </div>
      <div className="alib-tile-foot">
        <span className="alib-name" title={asset.name}>
          {asset.name}
        </span>
        <FavButton name={asset.name} on={favorite} onClick={onFavorite} />
        {mode === "pick" && (
          <button type="button" className="btn btn-ghost btn-sm alib-add" onClick={onPick} aria-label={`Add ${asset.name}`}>
            Add
          </button>
        )}
      </div>
    </li>
  );
}
