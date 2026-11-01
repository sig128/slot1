"use client";

import { useEffect, useState } from "react";
import type { LiveVideoResponse } from "@slot1/contracts";
import { api } from "@/lib/api";
import { useReportPlayerKind } from "./InstantReplay";
import { LiveVideoPlayer } from "./LiveVideoPlayer";

/**
 * Shows SLOT1's own sub-second live video when the creator sends their stream to SLOT1, with a
 * switch to Twitch's player. Otherwise it is exactly the Twitch player. Availability is checked
 * now and every 30 seconds, so the SLOT1 video appears when the creator starts sending.
 */
export function LivePlayerSwitch({ sessionId, title, twitch }: { sessionId: string; title: string; twitch: React.ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [useTwitch, setUseTwitch] = useState(false);

  useEffect(() => {
    if (available) return;
    let alive = true;
    const check = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const r = await api<LiveVideoResponse>(`/api/sessions/${sessionId}/live-video`).catch(() => null);
      if (alive && r?.available) setAvailable(true);
    };
    void check();
    const t = setInterval(() => void check(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, available]);
  // Lets the page place instant replays over SLOT1's own video only, never over Twitch's.
  useReportPlayerKind(available && !useTwitch ? "slot1" : "twitch");

  if (!available) return <>{twitch}</>;
  return (
    <div className="min-w-0">
      {useTwitch ? twitch : <LiveVideoPlayer sessionId={sessionId} title={title} onEnded={() => setAvailable(false)} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8rem] text-ivory-3">
        <span>{useTwitch ? "Twitch’s player, usually a few seconds behind." : "SLOT1’s own stream, straight from the creator’s setup."}</span>
        <button type="button" className="underline underline-offset-4 hover:text-ivory" aria-pressed={useTwitch} onClick={() => setUseTwitch((v) => !v)}>
          {useTwitch ? "Switch to SLOT1 video" : "Twitch player"}
        </button>
      </div>
    </div>
  );
}
