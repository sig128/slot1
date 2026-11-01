"use client";

import Link from "next/link";
import { useState } from "react";
import type { ResolveLinkResponse } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

/**
 * Paste any public Twitch link. It opens a WATCH-ONLY embed unless the creator connected and
 * opted in to SLOT1. Pasting a link never claims a channel or authorizes recording.
 */
export function LinkOpener() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResolveLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<ResolveLinkResponse>(`/api/channels/resolve?url=${encodeURIComponent(value.trim())}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2" role="search" aria-label="Open a Twitch link">
        <label htmlFor="twitch-link" className="sr-only">
          Twitch channel or clip link
        </label>
        <input
          id="twitch-link"
          className="field"
          placeholder="twitch.tv/channel or a clip link"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
        <button className="btn btn-ghost shrink-0" disabled={busy || !value.trim()}>
          {busy ? "Checking" : "Open"}
        </button>
      </form>
      <div aria-live="polite" className="min-h-0">
        {error && <p className="mt-3 text-sm text-coral">{error}</p>}
        {result && (
          <div className="mt-4 border-l-2 border-line-strong pl-4">
            <p className="font-display text-xl font-bold">{result.metadata?.displayName ?? result.login ?? "Twitch link"}</p>
            <p className="mt-1 text-sm text-ivory-2">
              {result.slot1Authorized
                ? "This creator uses SLOT1. Analysis appears where they've made it public."
                : "Not a SLOT1 channel. You can watch it here, but SLOT1 won't analyze or record it."}
            </p>
            {result.metadataUnavailableReason && <p className="mt-1 text-xs text-ivory-3">{result.metadataUnavailableReason}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {result.login && (
                <Link href={result.watchHref} className="btn btn-primary btn-sm">
                  {result.slot1Authorized ? "Watch with SLOT1" : "Watch only"}
                </Link>
              )}
              <a href={result.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm">
                Open on Twitch
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
