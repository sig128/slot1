"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminLearning } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { ago } from "./parts";

/**
 * Admin → Learning: turn SLOT1's watching of the featured channels on or off. Off until an admin
 * turns it on. The worker stops or starts within a few seconds of a change.
 */
export function LearningSwitchPanel() {
  const [data, setData] = useState<AdminLearning | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminLearning>("/api/admin/learning"));
    } catch {
      setError("Couldn’t load whether learning is on. Reload the page.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function set(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      setData(await api<AdminLearning>("/api/admin/learning", { method: "PUT", json: { on } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : on ? "Couldn’t turn learning on. Try again." : "Couldn’t turn learning off. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const on = data?.on ?? false;
  return (
    <div className="max-w-[52rem]">
      <p className="text-[0.95rem] text-ivory-2">
        While learning is on, SLOT1 watches every featured channel that’s live and learns from it. While it’s off, featured channels still
        show on the site, but SLOT1 doesn’t look at their streams or keep anything from them.
      </p>
      <p className="mt-2 text-[0.9rem] text-ivory-3">Streams that creators send to SLOT1 from OBS aren’t affected by this switch.</p>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-sm border hairline p-5">
        <div className="min-w-0 flex-[1_1_16rem]" aria-live="polite">
          <p className="font-display text-2xl font-bold text-ivory">{!data ? "…" : on ? "Learning is on" : "Learning is off"}</p>
          {data && (
            <p className="mt-0.5 text-[0.85rem] text-ivory-3">
              {data.changedAt ? `${on ? "Turned on" : "Turned off"} ${ago(data.changedAt, Date.now())}` : "Nobody has turned it on yet."}
            </p>
          )}
        </div>
        <button type="button" className={on ? "btn btn-ghost" : "btn btn-primary"} disabled={!data || busy} onClick={() => void set(!on)}>
          {busy ? (on ? "Turning off…" : "Turning on…") : on ? "Turn learning off" : "Turn learning on"}
        </button>
      </div>
      {!on && data && <p className="mt-3 text-[0.9rem] text-ivory-3">Starting fresh? Wipe data below first, then turn learning on.</p>}
      {error && (
        <p role="alert" className="mt-3 text-[0.9rem] text-coral">
          {error}
        </p>
      )}
    </div>
  );
}
