"use client";

import { Tabs } from "radix-ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import type { StudioAsset, StudioAssetKind, StudioAssetsResponse } from "@slot1/contracts";
import { ApiError } from "@/lib/api";
import { loadStudioAssets, setAssetDrag, studioAssetUrl } from "./studio-assets-client";
import "./asset-library.css";

export { ASSET_DRAG_TYPE, isAssetDrag, loadStudioAssets, readAssetDrag, studioAssetUrl } from "./studio-assets-client";

export interface AssetLibraryPanelProps {
  /** Show only these kinds (for example only audio while an audio track is selected). */
  kinds?: StudioAssetKind[];
  /** The creator picked an item (Add, or click or Enter on a thumbnail). The editor places it at the playhead. */
  onPick: (asset: StudioAsset) => void;
  /**
   * "pick" (default, in the editor): items can be added, or dragged onto the timeline.
   * "browse" (Studio): listen, look and star; no Add buttons.
   */
  mode?: "pick" | "browse";
}

type TabId = "sounds" | "music" | "ambience" | "elements" | "frames" | "transitions";

const TABS: readonly { id: TabId; label: string; kinds: readonly StudioAssetKind[]; noun: string }[] = [
  { id: "sounds", label: "Sounds", kinds: ["sfx"], noun: "sounds" },
  { id: "music", label: "Music", kinds: ["music"], noun: "music" },
  { id: "ambience", label: "Ambience", kinds: ["ambience"], noun: "ambience" },
  { id: "elements", label: "Elements", kinds: ["sticker", "overlay"], noun: "elements" },
  { id: "frames", label: "Frames", kinds: ["frame"], noun: "frames" },
  { id: "transitions", label: "Transitions", kinds: ["transition"], noun: "transitions" },
];

const AUDIO_KINDS: ReadonlySet<StudioAssetKind> = new Set<StudioAssetKind>(["sfx", "music", "ambience"]);

const CATEGORY_LABELS: Record<string, string> = { hud: "HUD", ui: "UI", lofi: "Lo-fi" };

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1).replace(/-/g, " ");
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function motionOf(a: StudioAsset): string {
  return a.tags.find((t) => t.startsWith("motion:"))?.slice("motion:".length) ?? "fade";
}

const byName = (x: StudioAsset, y: StudioAsset) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name, undefined, { numeric: true });

/* Favorites: remembered in this browser, shared by every panel on the page and across tabs. */

const FAV_KEY = "slot1.studio.favorites.v1";
const NO_FAVORITES: ReadonlySet<string> = new Set();
const favListeners = new Set<() => void>();
let favCache: ReadonlySet<string> | null = null;

function readFavorites(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(FAV_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return NO_FAVORITES;
  }
}

function favoritesSnapshot(): ReadonlySet<string> {
  favCache ??= readFavorites();
  return favCache;
}

function subscribeFavorites(onChange: () => void): () => void {
  favListeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== FAV_KEY && e.key !== null) return;
    favCache = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    favListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function setFavorite(id: string, on: boolean): void {
  const next = new Set(favoritesSnapshot());
  if (on) next.add(id);
  else next.delete(id);
  favCache = next;
  try {
    window.localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
  } catch {
    /* Storage is blocked (private mode, policy): favorites last for this visit. */
  }
  for (const l of favListeners) l();
}

/* Previews: one sound at a time across the whole page. */

interface PreviewHooks {
  playing: () => void;
  done: () => void;
  failed: () => void;
}

let previewEl: HTMLAudioElement | null = null;
let activePreview: { owner: object; halt: () => void } | null = null;

function startPreview(owner: object, url: string, loop: boolean, hooks: PreviewHooks): void {
  activePreview?.halt();
  const el = (previewEl ??= new Audio());
  let live = true;
  const entry = { owner, halt: () => finish(false) };
  function finish(failed: boolean) {
    if (!live) return;
    live = false;
    el.onplaying = el.onended = el.onerror = null;
    el.pause();
    el.removeAttribute("src");
    el.load();
    if (activePreview === entry) activePreview = null;
    if (failed) hooks.failed();
    else hooks.done();
  }
  activePreview = entry;
  el.loop = loop;
  el.preload = "auto";
  el.src = url;
  el.onplaying = () => {
    if (live) hooks.playing();
  };
  el.onended = () => finish(false);
  el.onerror = () => finish(true);
  el.play().catch((err: unknown) => {
    if (live && !(err instanceof DOMException && err.name === "AbortError")) finish(true);
  });
}

function stopPreview(owner?: object): void {
  if (activePreview && (!owner || activePreview.owner === owner)) activePreview.halt();
}

type PlayState = { id: string; on: boolean } | null;

export function AssetLibraryPanel({ kinds, onPick, mode = "pick" }: AssetLibraryPanelProps) {
  const [data, setData] = useState<StudioAssetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("sounds");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [playing, setPlaying] = useState<PlayState>(null);
  const [announce, setAnnounce] = useState("");
  const [owner] = useState(() => ({}));
  const favorites = useSyncExternalStore(subscribeFavorites, favoritesSnapshot, () => NO_FAVORITES);
  const pickMode = mode === "pick";

  const fetchLibrary = useCallback((force: boolean) => {
    loadStudioAssets(force)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? "Sign in with your creator account to use the library."
            : "Couldn't load the library. Check your connection, then try again.",
        );
      });
  }, []);

  useEffect(() => {
    fetchLibrary(false);
  }, [fetchLibrary]);

  // Stop this panel's preview when it unmounts (leaving the editor, closing a drawer).
  useEffect(() => () => stopPreview(owner), [owner]);

  const visibleTabs = useMemo(() => TABS.filter((t) => !kinds || t.kinds.some((k) => kinds.includes(k))), [kinds]);
  const activeTab = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];

  const inKinds = useMemo(() => (data ? data.assets.filter((a) => !kinds || kinds.includes(a.kind)) : []), [data, kinds]);
  const inTab = useMemo(() => (activeTab ? inKinds.filter((a) => activeTab.kinds.includes(a.kind)) : []), [inKinds, activeTab]);
  const categories = useMemo(() => [...new Set(inTab.map((a) => a.category))].sort(), [inTab]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return inTab
      .filter((a) => {
        if (category && a.category !== category) return false;
        if (favOnly && !favorites.has(a.id)) return false;
        if (!words.length) return true;
        const hay = `${a.name} ${a.category} ${a.tags.join(" ")} ${a.id}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(byName);
  }, [inTab, query, category, favOnly, favorites]);

  const toggle = useCallback(
    (a: StudioAsset) => {
      if (!data) return;
      if (playing?.id === a.id) {
        stopPreview(owner);
        return;
      }
      setPlaying({ id: a.id, on: false });
      startPreview(owner, studioAssetUrl(a, data.rev), a.loop, {
        playing: () => setPlaying((p) => (p?.id === a.id ? { id: a.id, on: true } : p)),
        done: () => setPlaying((p) => (p?.id === a.id ? null : p)),
        failed: () => {
          setPlaying((p) => (p?.id === a.id ? null : p));
          setAnnounce(`Couldn't play ${a.name}.`);
        },
      });
    },
    [data, playing, owner],
  );

  const toggleFavorite = useCallback(
    (a: StudioAsset) => {
      const on = !favorites.has(a.id);
      setFavorite(a.id, on);
      setAnnounce(on ? `Added ${a.name} to favorites.` : `Removed ${a.name} from favorites.`);
    },
    [favorites],
  );

  const pick = useCallback(
    (a: StudioAsset) => {
      onPick(a);
      setAnnounce(`Added ${a.name}.`);
    },
    [onPick],
  );

  const clearFilters = () => {
    setQuery("");
    setCategory(null);
    setFavOnly(false);
  };

  const isAudio = activeTab ? activeTab.kinds.some((k) => AUDIO_KINDS.has(k)) : false;
  const noun = activeTab?.noun ?? "the library";

  return (
    <section className="alib" data-mode={mode} aria-label="Sounds and elements library">
      <div className="alib-head">
        <div className="alib-title">
          {pickMode && <h3 className="alib-h poster-title">Library</h3>}
          {data && <p className="alib-count tnum">{inKinds.length} items, all made for SLOT1</p>}
        </div>
        <label className="alib-search">
          <span className="sr-only">Search {noun}</span>
          <svg viewBox="0 0 24 24" aria-hidden className="alib-search-icon">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
            <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="field alib-search-input"
            placeholder={`Search ${noun}`}
            value={query}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {error && (
        <div className="alib-state" role="alert">
          <p>{error}</p>
          {!/Sign in/.test(error) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setError(null);
                fetchLibrary(true);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}

      {!error && !data && (
        <p className="alib-state" aria-busy="true">
          Loading the library…
        </p>
      )}

      {data && activeTab && (
        <Tabs.Root
          className="alib-tabsroot"
          value={activeTab.id}
          onValueChange={(v) => {
            stopPreview(owner);
            setTab(v as TabId);
            setCategory(null);
          }}
        >
          <Tabs.List className="alib-tabs" aria-label="Library sections">
            {visibleTabs.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id} className="alib-tab">
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <div className="alib-chips" role="group" aria-label={`Filter ${noun}`}>
            <button type="button" className="alib-chip alib-chip-fav" aria-pressed={favOnly} onClick={() => setFavOnly((v) => !v)}>
              <StarGlyph />
              Favorites
            </button>
            {categories.length > 1 && (
              <>
                <button type="button" className="alib-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
                  All
                </button>
                {categories.map((c) => (
                  <button key={c} type="button" className="alib-chip" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                    {categoryLabel(c)}
                  </button>
                ))}
              </>
            )}
          </div>

          {visibleTabs.map((t) => (
            <Tabs.Content key={t.id} value={t.id} className="alib-body">
              {t.id !== activeTab.id ? null : results.length === 0 ? (
                <div className="alib-state">
                  <p>
                    {favOnly && !query && !category
                      ? `You haven't starred any ${noun} yet. Star one and it shows up here.`
                      : `No ${noun} match${query ? ` “${query.trim()}”` : " these filters"}. Try another word, or clear the filters.`}
                  </p>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                    Clear filters
                  </button>
                </div>
              ) : isAudio ? (
                <ul className="alib-list" aria-label={`${t.label}, ${results.length} ${results.length === 1 ? "result" : "results"}`}>
                  {results.map((a) => (
                    <AudioRow
                      key={a.id}
                      asset={a}
                      peaks={data.peaks[a.id]}
                      state={playing?.id === a.id ? (playing.on ? "playing" : "loading") : undefined}
                      favorite={favorites.has(a.id)}
                      pickMode={pickMode}
                      onToggle={() => toggle(a)}
                      onFavorite={() => toggleFavorite(a)}
                      onPick={() => pick(a)}
                    />
                  ))}
                </ul>
              ) : (
                <ul className="alib-grid" aria-label={`${t.label}, ${results.length} ${results.length === 1 ? "result" : "results"}`}>
                  {results.map((a) => (
                    <VisualTile
                      key={a.id}
                      asset={a}
                      rev={data.rev}
                      favorite={favorites.has(a.id)}
                      pickMode={pickMode}
                      onFavorite={() => toggleFavorite(a)}
                      onPick={() => pick(a)}
                    />
                  ))}
                </ul>
              )}
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

const FLAT_PEAKS: number[] = Array.from({ length: 48 }, () => 0.12);
const BAR_STEP = 4.6;
const BAR_W = 2.6;
const WAVE_H = 28;

function Waveform({ peaks, playing, style }: { peaks: number[] | undefined; playing: boolean; style: CSSProperties }) {
  const bars = peaks?.length ? peaks : FLAT_PEAKS;
  const width = bars.length * BAR_STEP - (BAR_STEP - BAR_W);
  const rects = bars.map((p, i) => {
    const h = Math.max(2, Math.min(1, p) * (WAVE_H - 2));
    return <rect key={i} x={i * BAR_STEP} y={(WAVE_H - h) / 2} width={BAR_W} height={h} rx={1} />;
  });
  return (
    <span className="alib-wave" style={style} aria-hidden>
      <svg viewBox={`0 0 ${width} ${WAVE_H}`} preserveAspectRatio="none" className="alib-wave-base" focusable="false">
        {rects}
      </svg>
      {playing && (
        <svg viewBox={`0 0 ${width} ${WAVE_H}`} preserveAspectRatio="none" className="alib-wave-on" focusable="false">
          {rects}
        </svg>
      )}
    </span>
  );
}

function AudioRow({
  asset,
  peaks,
  state,
  favorite,
  pickMode,
  onToggle,
  onFavorite,
  onPick,
}: {
  asset: StudioAsset;
  peaks: number[] | undefined;
  state: "loading" | "playing" | undefined;
  favorite: boolean;
  pickMode: boolean;
  onToggle: () => void;
  onFavorite: () => void;
  onPick: () => void;
}) {
  const style = { "--alib-dur": `${Math.max(asset.durationMs ?? 1000, 50)}ms`, "--alib-iter": asset.loop ? "infinite" : "1" } as CSSProperties;
  return (
    <li
      className="alib-row"
      data-state={state}
      draggable={pickMode || undefined}
      onDragStart={pickMode ? (e) => setAssetDrag(e.dataTransfer, asset) : undefined}
    >
      <button type="button" className="alib-play" aria-label={state ? `Stop ${asset.name}` : `Play ${asset.name}`} onClick={onToggle}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          {state ? <rect x="6.5" y="6.5" width="11" height="11" rx="1" /> : <path d="M8.5 5.8v12.4L18.6 12z" />}
        </svg>
      </button>
      <span className="alib-text">
        <span className="alib-name">{asset.name}</span>
        <span className="alib-cat">{categoryLabel(asset.category)}</span>
      </span>
      <Waveform peaks={peaks} playing={state === "playing"} style={style} />
      <span className="alib-dur tnum">
        {asset.loop && (
          <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="alib-loop">
            <path d="M5 11a6 6 0 0 1 10.2-4.3L17 8.5M17 4v4.5h-4.5M19 13a6 6 0 0 1-10.2 4.3L7 15.5M7 20v-4.5h4.5" />
          </svg>
        )}
        {asset.loop && <span className="sr-only">Loops, </span>}
        {formatDuration(asset.durationMs)}
      </span>
      <FavButton name={asset.name} on={favorite} onClick={onFavorite} />
      {pickMode && (
        <button type="button" className="btn btn-ghost btn-sm alib-add" aria-label={`Add ${asset.name}`} onClick={onPick}>
          Add
        </button>
      )}
    </li>
  );
}

function StarGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="alib-star">
      <path d="M12 3.2l2.6 5.6 6.1.6-4.6 4.1 1.4 6L12 16.4l-5.5 3.1 1.4-6-4.6-4.1 6.1-.6z" />
    </svg>
  );
}

function FavButton({ name, on, onClick }: { name: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="alib-fav" aria-pressed={on} aria-label={`Favorite ${name}`} onClick={onClick}>
      <StarGlyph />
    </button>
  );
}

function VisualTile({
  asset,
  rev,
  favorite,
  pickMode,
  onFavorite,
  onPick,
}: {
  asset: StudioAsset;
  rev: string;
  favorite: boolean;
  pickMode: boolean;
  onFavorite: () => void;
  onPick: () => void;
}) {
  const thumbClass = asset.kind === "sticker" ? "alib-thumb alib-thumb-check" : "alib-thumb alib-thumb-scene";
  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- library files come from the API at their own size
    <img src={studioAssetUrl(asset, rev)} alt="" width={asset.width} height={asset.height} loading="lazy" decoding="async" draggable={false} />
  );
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onPick();
  };
  return (
    <li
      className="alib-tile"
      data-kind={asset.kind}
      data-motion={asset.kind === "transition" ? motionOf(asset) : undefined}
      draggable={pickMode || undefined}
      onDragStart={pickMode ? (e) => setAssetDrag(e.dataTransfer, asset) : undefined}
    >
      {pickMode ? (
        // A div, not a button, so the tile can still be dragged in every browser.
        <div role="button" tabIndex={0} className={thumbClass} aria-label={`Add ${asset.name}`} onClick={onPick} onKeyDown={onKey}>
          {image}
          <span className="alib-thumb-add" aria-hidden>
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </div>
      ) : (
        <div className={thumbClass}>{image}</div>
      )}
      <div className="alib-tile-foot">
        <span className="alib-name" title={asset.name}>
          {asset.name}
        </span>
        <FavButton name={asset.name} on={favorite} onClick={onFavorite} />
      </div>
    </li>
  );
}
