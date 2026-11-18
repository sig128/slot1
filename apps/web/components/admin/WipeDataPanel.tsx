"use client";

import { useEffect, useId, useState } from "react";
import { WIPE_CONFIRM_WORD, type AdminWipeResponse } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { useNow } from "@/components/watch/useSessionStream";
import { ago, num, Stat } from "./parts";

const hours = (h: number) => h.toLocaleString("en-US", { maximumFractionDigits: 1 });

/**
 * Admin → Wipe data: delete every stream and everything SLOT1's AI found, kept, heard and learned
 * from them, once the admin types the confirm word. The worker does the deleting; this follows it.
 */
export function WipeDataPanel() {
  const id = useId();
  const [data, setData] = useState<AdminWipeResponse | null>(null);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useNow(5000);

  // setState only ever runs in these promise callbacks, never straight from an effect.
  const load = () =>
    api<AdminWipeResponse>("/api/admin/wipe").then(
      (r) => setData(r),
      () => setError("Couldn’t load what’s stored. Reload the page."),
    );

  useEffect(() => {
    let alive = true;
    api<AdminWipeResponse>("/api/admin/wipe").then(
      (r) => {
        if (alive) setData(r);
      },
      () => {
        if (alive) setError("Couldn’t load what’s stored. Reload the page.");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const working = data?.status.state === "queued" || data?.status.state === "running";
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => {
      api<AdminWipeResponse>("/api/admin/wipe").then(
        (r) => setData(r),
        () => undefined,
      );
    }, 2000);
    return () => window.clearInterval(t);
  }, [working]);

  async function wipe() {
    setBusy(true);
    setError(null);
    try {
      setData(await api<AdminWipeResponse>("/api/admin/wipe", { method: "POST", json: { confirm: WIPE_CONFIRM_WORD } }));
      setWord("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn’t start the wipe. Try again.");
      void load();
    } finally {
      setBusy(false);
    }
  }

  const c = data?.counts;
  const s = data?.status;
  const live = (data?.liveVideo ?? 0) > 0;
  const ready = word.trim() === WIPE_CONFIRM_WORD;
  const empty = c ? c.streams + c.findings + c.files + c.trainingFrames + c.library + c.models === 0 : false;

  return (
    <div className="max-w-[52rem]">
      <p className="text-[0.95rem] text-ivory-2">
        Deletes every stream SLOT1 has and everything its AI found, saw, heard and learned from them: findings, frames, speech, missions, clips,
        recordings, the media library, and all training frames, labels, datasets and models. The hours-watched counter goes back to 0, so Ask
        SLOT1 starts counting toward 1,000 hours again.
      </p>
      <p className="mt-2 text-[0.9rem] text-ivory-3">
        Stays: accounts, channels and their settings, stream keys, featured channels, Admin settings, visitor stats, messages and the AI cost log.
      </p>

      {c && (
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
          <Stat label="Streams" value={num(c.streams)} note={`${num(c.clips)} clips`} />
          <Stat label="Findings" value={num(c.findings)} note={`${num(c.missions)} missions, ${num(c.speech)} lines heard`} />
          <Stat label="Stored files" value={num(c.files)} note={`${num(c.library)} in creators’ libraries`} />
          <Stat label="Hours watched" value={hours(c.hoursWatched)} note={`${num(c.trainingFrames)} training frames, ${num(c.models)} models`} />
        </div>
      )}

      <form
        className="mt-8 rounded-sm border border-coral/40 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy && !working && !live) void wipe();
        }}
      >
        <label htmlFor={`${id}-word`} className="block text-[0.95rem] font-semibold text-ivory">
          Type {WIPE_CONFIRM_WORD} to confirm
        </label>
        <p id={`${id}-help`} className="mt-0.5 text-[0.85rem] text-ivory-3">
          This can’t be undone. Nothing it deletes can be brought back.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            id={`${id}-word`}
            className="field min-w-0 flex-[1_1_12rem]"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={`${id}-help`}
            value={word}
            disabled={!data || busy || working}
            onChange={(e) => setWord(e.target.value)}
          />
          <button type="submit" className="btn btn-coral" disabled={!data || !ready || busy || working || live}>
            {working ? "Wiping…" : busy ? "Starting…" : "Wipe all stream and learning data"}
          </button>
        </div>
        {live && <p className="mt-3 text-[0.9rem] text-coral">Someone is sending video to SLOT1 right now. Wipe once that stream has ended.</p>}
        {!live && empty && s?.state !== "done" && <p className="mt-3 text-[0.9rem] text-ivory-3">Nothing is stored right now.</p>}
      </form>

      <div aria-live="polite" className="mt-3 min-h-6 text-[0.9rem]">
        {error && <p className="text-coral">{error}</p>}
        {!error && s?.state === "queued" && <p className="text-ivory-2">Wipe queued. It starts in a moment.</p>}
        {!error && s?.state === "running" && <p className="text-ivory-2">Wiping. This page updates when it’s done.</p>}
        {!error && s?.state === "done" && s.deleted && (
          <p className="text-ivory-2">
            Wiped {ago(s.finishedAt, now)}: {num(s.deleted.streams)} streams, {num(s.deleted.findings)} findings, {num(s.filesRemoved ?? 0)} files
            and {hours(s.deleted.hoursWatched)} hours watched.
          </p>
        )}
        {!error && s?.state === "failed" && <p className="text-coral">The last wipe stopped: {s.error ?? "unknown error"}. Try again.</p>}
      </div>
    </div>
  );
}
