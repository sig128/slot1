"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItemView } from "@slot1/contracts";
import { bytes } from "@/lib/format";
import { AUTO_PREPARE_MAX_BYTES, buildShareCaption, SHARE_MAX_BYTES, shareFileName, UPLOAD_PAGES } from "@/lib/share";

type Support = "unknown" | "files" | "none";
type Prep = { state: "idle" } | { state: "loading"; progress: number | null; got: number } | { state: "ready"; file: File } | { state: "error"; message: string };

class TooBigError extends Error {}

/** Download the clip into memory so the share sheet can open inside the tap that asks for it. */
async function fetchAsFile(url: string, name: string, onProgress: (p: number | null, got: number) => void, signal: AbortSignal): Promise<File> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok) throw new Error(`Couldn't load the clip (${res.status}). Reload the page and try again.`);
  const total = Number(res.headers.get("content-length")) || null;
  if (total && total > SHARE_MAX_BYTES) throw new TooBigError();
  const type = (res.headers.get("content-type") ?? "").startsWith("video/") ? (res.headers.get("content-type") ?? "video/mp4").split(";")[0]! : "video/mp4";
  const reader = res.body?.getReader();
  if (!reader) return new File([await res.blob()], name, { type });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    got += value.byteLength;
    if (got > SHARE_MAX_BYTES) {
      await reader.cancel();
      throw new TooBigError();
    }
    onProgress(total ? got / total : null, got);
  }
  return new File(chunks, name, { type });
}

/**
 * Share a finished clip to TikTok, Instagram, YouTube or any app, with no platform API: the
 * phone's (or browser's) own share sheet receives the video file. Where file sharing isn't
 * available, it offers a download and the platforms' upload pages instead. Owner only.
 */
export function ShareFilePanel({ item, onClose }: { item: LibraryItemView; onClose?: () => void }) {
  const [support, setSupport] = useState<Support>("unknown");
  const [prep, setPrep] = useState<Prep>({ state: "idle" });
  const [caption, setCaption] = useState(() => buildShareCaption(item));
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const fileName = shareFileName(item.title, "mp4");
  const tooBig = item.bytes !== null && item.bytes > SHARE_MAX_BYTES;
  const landscape = Boolean(item.width && item.height && item.width > item.height);

  const prepare = useCallback(async () => {
    if (!item.url) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPrep({ state: "loading", progress: null, got: 0 });
    try {
      const file = await fetchAsFile(item.url, fileName, (progress, got) => setPrep({ state: "loading", progress, got }), ac.signal);
      if (ac.signal.aborted) return;
      // Ask about this exact file: some browsers share text but not files, or not this type.
      setSupport(navigator.canShare?.({ files: [file] }) ? "files" : "none");
      setPrep({ state: "ready", file });
    } catch (err) {
      if (ac.signal.aborted) return;
      setPrep({
        state: "error",
        message: err instanceof TooBigError ? `Too big to share from the browser (over ${bytes(SHARE_MAX_BYTES)}). Download it instead.` : (err as Error).message,
      });
    }
  }, [item.url, fileName]);

  // Browser-only checks run after hydration. Small clips are prepared right away so the next tap can share.
  useEffect(() => {
    const maybe = typeof navigator.share === "function" && typeof navigator.canShare === "function";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- share support only exists in the browser
    setSupport(maybe ? "unknown" : "none");
    if (maybe && !tooBig && (item.bytes === null || item.bytes <= AUTO_PREPARE_MAX_BYTES)) void prepare();
    return () => abort.current?.abort();
  }, [prepare, tooBig, item.bytes]);

  const share = async () => {
    if (prep.state !== "ready") return;
    setNote(null);
    try {
      await navigator.share({ files: [prep.file], title: item.title, text: caption });
      setNote("Sent to the share sheet. Paste your caption in the app if it isn't there.");
    } catch (err) {
      const name = (err as Error).name;
      if (name === "AbortError") return; // the share sheet was closed
      if (name === "NotAllowedError") setNote("Your browser needs a fresh tap. Press Share again.");
      else {
        setSupport("none");
        setNote("This browser couldn't share the file. Download it and upload it in the app instead.");
      }
    }
  };

  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNote("Couldn't copy automatically. Select the caption and copy it.");
    }
  };

  const fallback = support === "none" || tooBig || prep.state === "error";
  const loading = prep.state === "loading";
  const pct = loading && prep.progress !== null ? Math.round(prep.progress * 100) : null;

  return (
    <section aria-label={`Share ${item.title}`} className="mt-3 border hairline bg-graphite-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold">Share to TikTok, Instagram or YouTube</h3>
        {onClose && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            Close<span className="sr-only"> sharing for {item.title}</span>
          </button>
        )}
      </div>

      {landscape && (
        <p className="mt-2 text-sm text-ivory-2">
          This clip is widescreen. TikTok, Reels and Shorts are vertical, so a vertical version fits better.{" "}
          {item.projectId && (
            <Link href={`/studio/edit/${item.projectId}`} className="underline hover:text-ivory">
              Make it vertical in the editor
            </Link>
          )}
        </p>
      )}

      {!fallback && (
        <div className="mt-3 space-y-2">
          {prep.state === "idle" && (
            <button type="button" className="btn btn-ghost" onClick={() => void prepare()}>
              Prepare to share{item.bytes ? ` (${bytes(item.bytes)})` : ""}
            </button>
          )}
          {loading && (
            <div>
              <p className="text-sm text-ivory-2">Getting the video ready{pct !== null ? `, ${pct}%` : `, ${bytes(prep.got)}`}</p>
              <div role="progressbar" aria-label="Preparing the video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="mt-1 h-1 bg-graphite-600">
                <span className="block h-full bg-apricot transition-[width]" style={{ width: `${pct ?? 8}%` }} />
              </div>
            </div>
          )}
          {prep.state === "ready" && (
            <button type="button" className="btn btn-primary" onClick={() => void share()}>
              Share
            </button>
          )}
          <p className="text-[0.82rem] text-ivory-3">Pick TikTok, Instagram, YouTube or any app. The video opens there ready to post.</p>
        </div>
      )}

      {fallback && (
        <div className="mt-3 space-y-2">
          {prep.state === "error" && <p className="text-sm text-coral">{prep.message}</p>}
          <p className="text-sm text-ivory-2">Download the video, then upload it in the app or on the site.</p>
          <div className="flex flex-wrap gap-2">
            {item.url && (
              <a href={item.url} download={fileName} className="btn btn-primary btn-sm">
                Download<span className="sr-only"> {item.title}</span>
              </a>
            )}
            {UPLOAD_PAGES.map((p) => (
              <a key={p.id} href={p.href} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm" title={p.hint}>
                Open {p.label}
                <span className="sr-only">, {p.hint}, in a new tab</span>
              </a>
            ))}
          </div>
          <p className="text-[0.78rem] text-ivory-3">{UPLOAD_PAGES.map((p) => `${p.label}: ${p.hint.toLowerCase()}`).join(". ")}.</p>
        </div>
      )}

      <div className="mt-4">
        <label className="label" htmlFor={`cap-${item.id}`}>
          Caption
        </label>
        <textarea id={`cap-${item.id}`} className="field min-h-[5.5rem] font-sans" value={caption} maxLength={2200} onChange={(e) => setCaption(e.target.value)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCaption()}>
            {copied ? "Caption copied" : "Copy caption"}
          </button>
          <span className="text-[0.78rem] text-ivory-3">Apps don&rsquo;t always take a caption from the share sheet, so paste it in.</span>
        </div>
      </div>

      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm text-ivory-2">
        {note}
      </p>
    </section>
  );
}

/** Share the page link (public and unlisted items, profiles). Never offered for private items. */
export function ShareLinkButton({ path, title, className = "btn btn-quiet btn-sm" }: { path: string; title: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const onClick = async () => {
    const url = `${window.location.origin}${path}`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ url, title });
        return;
      }
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setState("copied");
      } catch {
        setState("failed");
      }
    }
    setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" className={className} onClick={() => void onClick()}>
      {state === "copied" ? "Link copied" : state === "failed" ? "Couldn't copy" : "Share link"}
    </button>
  );
}
