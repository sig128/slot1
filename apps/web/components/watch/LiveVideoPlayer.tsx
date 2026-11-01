"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveVideoResponse } from "@slot1/contracts";
import { api } from "@/lib/api";

export type LivePlayerState = "connecting" | "live" | "reconnecting" | "ended";

/** Parse WHEP `Link: <turn:host>; rel="ice-server"; username="u"; credential="c"` headers. */
export function parseIceLinks(header: string | null): RTCIceServer[] {
  if (!header) return [];
  const out: RTCIceServer[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url || !/rel="?ice-server"?/i.test(part)) continue;
    const username = part.match(/username="([^"]*)"/)?.[1];
    const credential = part.match(/credential="([^"]*)"/)?.[1];
    out.push({ urls: url, ...(username ? { username } : {}), ...(credential ? { credential } : {}) });
  }
  return out;
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(t);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Estimated playout delay on this connection: the video jitter buffer plus half the round trip.
 * It covers SLOT1 → this browser only, not the streamer's encoder or upload.
 */
async function estimateDelay(pc: RTCPeerConnection, prev: { jb: number; n: number }): Promise<number | null> {
  const stats = await pc.getStats();
  let jb: number | null = null;
  let n: number | null = null;
  let rtt: number | null = null;
  stats.forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "video") {
      jb = typeof r.jitterBufferDelay === "number" ? r.jitterBufferDelay : null;
      n = typeof r.jitterBufferEmittedCount === "number" ? r.jitterBufferEmittedCount : null;
    }
    if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number") rtt = r.currentRoundTripTime;
  });
  if (jb === null || n === null) return null;
  const dn = (n as number) - prev.n;
  const buffer = dn > 0 ? ((jb as number) - prev.jb) / dn : n > 0 ? (jb as number) / (n as number) : null;
  prev.jb = jb;
  prev.n = n;
  if (buffer === null) return null;
  return buffer + (rtt ?? 0) / 2;
}

/**
 * SLOT1-hosted live video over WebRTC (WHEP). Each (re)connect asks SLOT1 for a fresh,
 * short-lived playback token, so a dropped connection recovers without a page reload.
 */
export function LiveVideoPlayer({
  sessionId,
  title,
  getGrant,
  onEnded,
}: {
  sessionId: string;
  title: string;
  /** Override how the playback grant is fetched (tests). Defaults to SLOT1's API. */
  getGrant?: () => Promise<LiveVideoResponse>;
  /** Called when SLOT1 says the video isn't available any more (e.g. the creator stopped sending). */
  onEnded?: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grantRef = useRef(getGrant);
  const endedRef = useRef(onEnded);
  const [state, setState] = useState<LivePlayerState>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [delay, setDelay] = useState<number | null>(null);

  useEffect(() => {
    grantRef.current = getGrant;
    endedRef.current = onEnded;
  });

  useEffect(() => {
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let resource: string | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const fetchGrant = () => (grantRef.current ? grantRef.current() : api<LiveVideoResponse>(`/api/sessions/${sessionId}/live-video`));

    const teardown = () => {
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      pc?.close();
      pc = null;
      if (resource) {
        // End the WHEP session on the server; failures don't matter.
        void fetch(resource, { method: "DELETE" }).catch(() => undefined);
        resource = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      teardown();
      setState("reconnecting");
      attempts += 1;
      retry = setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** Math.min(attempts - 1, 3)));
    };

    const connect = async () => {
      if (stopped) return;
      let grant: LiveVideoResponse;
      try {
        grant = await fetchGrant();
      } catch {
        return scheduleReconnect();
      }
      if (stopped) return;
      if (!grant.available || !grant.whepUrl || !grant.token) {
        teardown();
        setState("ended");
        setReason(grant.reason);
        endedRef.current?.(grant.reason ?? "Live video isn't available");
        return;
      }
      const auth = { authorization: `Bearer ${grant.token}` };
      try {
        // WHEP servers may advertise STUN/TURN servers in Link headers.
        const options = await fetch(grant.whepUrl, { method: "OPTIONS", headers: auth }).catch(() => null);
        const peer = new RTCPeerConnection({ iceServers: parseIceLinks(options?.headers.get("link") ?? null), bundlePolicy: "max-bundle" });
        pc = peer;
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        peer.ontrack = (ev) => {
          stream.addTrack(ev.track);
          const v = videoRef.current;
          if (v && v.srcObject !== stream) v.srcObject = stream;
        };
        peer.onconnectionstatechange = () => {
          if (peer !== pc) return;
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = null;
          if (peer.connectionState === "connected") {
            attempts = 0;
            setState("live");
            setReason(null);
          } else if (peer.connectionState === "disconnected") {
            // Often a brief network blip: give it a moment before starting over.
            quietTimer = setTimeout(() => peer === pc && scheduleReconnect(), 4000);
          } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
            scheduleReconnect();
          }
        };
        await peer.setLocalDescription(await peer.createOffer());
        await waitForIce(peer, 1500);
        const res = await fetch(grant.whepUrl, {
          method: "POST",
          headers: { ...auth, "content-type": "application/sdp" },
          body: peer.localDescription?.sdp ?? "",
        });
        if (res.status !== 201 && res.status !== 200) throw new Error(`WHEP ${res.status}`);
        const location = res.headers.get("location");
        resource = location ? new URL(location, grant.whepUrl).toString() : null;
        await peer.setRemoteDescription({ type: "answer", sdp: await res.text() });
        const prev = { jb: 0, n: 0 };
        statsTimer = setInterval(() => {
          void estimateDelay(peer, prev)
            .then((d) => d !== null && setDelay(d))
            .catch(() => undefined);
        }, 2000);
      } catch {
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      teardown();
    };
  }, [sessionId]);

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-graphite-900" data-live-player={state}>
      <video ref={videoRef} className="block h-full w-full bg-black object-contain" autoPlay playsInline muted={muted} aria-label={title} />
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-2">
        {state === "live" ? (
          <span className="chip chip-live">
            <span className="live-dot" aria-hidden />
            SLOT1 live
          </span>
        ) : state === "reconnecting" ? (
          <span className="chip chip-stale">Reconnecting</span>
        ) : state === "connecting" ? (
          <span className="chip chip-muted">Connecting</span>
        ) : null}
        {state === "live" && delay !== null && (
          <span
            className="tnum rounded-sm bg-graphite/80 px-2 py-0.5 text-[0.78rem] text-ivory-2"
            title="Estimated delay between SLOT1 and this browser (network and buffer). It doesn't include the streamer's encoder or upload."
            data-latency-badge
          >
            {delay < 0.1 ? "under 0.1" : `~${delay.toFixed(1)}`} s delay, estimated
          </span>
        )}
      </div>
      {state === "ended" && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <p className="max-w-[44ch] text-sm text-ivory-2">{reason ?? "The live video ended."}</p>
        </div>
      )}
      {state === "live" && (
        <button
          type="button"
          className="btn btn-ghost btn-sm absolute bottom-3 right-3 bg-graphite/80"
          aria-pressed={!muted}
          onClick={() => {
            setMuted((m) => !m);
            void videoRef.current?.play().catch(() => undefined);
          }}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
      )}
    </div>
  );
}
