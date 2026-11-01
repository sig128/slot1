"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AnalysisStatus, ClipView, JobView, Observation, SourceHealthView, SourceRef } from "@slot1/contracts";

export type ConnectionState = "connecting" | "live" | "polling" | "closed" | "disabled";

interface StreamEvent {
  id: string;
  sessionId: string;
  at: string;
  kind: string;
  data: unknown;
}

const KINDS = [
  "observation.created",
  "observation.updated",
  "analysis.status",
  "broadcast.status",
  "source.health",
  "job.updated",
  "clip.updated",
  "moment.created",
  "session.ended",
] as const;

export interface SessionStreamState {
  observations: Observation[];
  sources: SourceRef[];
  status: AnalysisStatus | null;
  health: SourceHealthView | null;
  broadcast: { state: "unknown" | "live" | "offline" | "error"; title: string | null; category: string | null } | null;
  clips: ClipView[];
  job: JobView | null;
  connection: ConnectionState;
  /** Ids of observations that arrived after mount (for controlled insertion animation). */
  freshIds: Set<string>;
}

/**
 * Subscribe to a session's event stream. Events carry monotonically increasing ids; on reconnect
 * the browser sends Last-Event-ID and the server backfills from Postgres, so nothing is lost or
 * duplicated. If SSE keeps failing, falls back to polling and says so.
 */
export function useSessionStream(
  sessionId: string | null,
  initial: { observations: Observation[]; sources: SourceRef[]; lastEventId: string | null; status: AnalysisStatus | null },
  opts: { disabled?: boolean } = {},
): SessionStreamState {
  const [observations, setObservations] = useState<Map<string, Observation>>(() => new Map(initial.observations.map((o) => [o.id, o])));
  const [status, setStatus] = useState<AnalysisStatus | null>(initial.status);
  const [health, setHealth] = useState<SourceHealthView | null>(null);
  const [broadcast, setBroadcast] = useState<SessionStreamState["broadcast"]>(null);
  const [clips, setClips] = useState<Map<string, ClipView>>(new Map());
  const [job, setJob] = useState<JobView | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(opts.disabled || !sessionId ? "disabled" : "connecting");
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const lastId = useRef<string | null>(initial.lastEventId);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!sessionId || opts.disabled) return;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let errors = 0;
    let stopped = false;

    const apply = (e: StreamEvent) => {
      if (e.sessionId !== sessionId) return; // never mix sessions
      if (seen.current.has(e.id)) return;
      seen.current.add(e.id);
      if (lastId.current === null || BigInt(e.id) > BigInt(lastId.current)) lastId.current = e.id;
      switch (e.kind) {
        case "observation.created":
        case "observation.updated": {
          const o = e.data as Observation;
          setObservations((m) => {
            const next = new Map(m);
            if (!m.has(o.id)) setFreshIds((f) => new Set(f).add(o.id));
            next.set(o.id, o);
            return next;
          });
          break;
        }
        case "analysis.status":
          setStatus(e.data as AnalysisStatus);
          break;
        case "source.health":
          setHealth(e.data as SourceHealthView);
          break;
        case "broadcast.status":
          setBroadcast(e.data as SessionStreamState["broadcast"]);
          break;
        case "clip.updated": {
          const c = e.data as ClipView;
          setClips((m) => new Map(m).set(c.id, c));
          break;
        }
        case "job.updated":
          setJob(e.data as JobView);
          break;
      }
    };

    const onMessage = (msg: MessageEvent<string>) => {
      try {
        apply(JSON.parse(msg.data) as StreamEvent);
      } catch {
        /* ignore malformed */
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/events/poll${lastId.current ? `?after=${lastId.current}` : ""}`, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { events: StreamEvent[] };
        for (const e of body.events) apply(e);
      } catch {
        setConnection("closed");
      }
    };

    const startPolling = () => {
      if (stopped || pollTimer) return;
      setConnection("polling");
      void poll();
      pollTimer = setInterval(() => void poll(), 5000);
      // Try streaming again later.
      retryTimer = setTimeout(() => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        errors = 0;
        openStream();
      }, 60_000);
    };

    const openStream = () => {
      if (stopped) return;
      setConnection("connecting");
      es = new EventSource(`/api/sessions/${sessionId}/events${lastId.current ? `?after=${lastId.current}` : ""}`);
      es.onopen = () => {
        errors = 0;
        setConnection("live");
      };
      for (const k of KINDS) es.addEventListener(k, onMessage as EventListener);
      es.onerror = () => {
        errors += 1;
        if (errors >= 3) {
          es?.close();
          es = null;
          startPolling();
        } else setConnection("connecting");
      };
    };

    openStream();
    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId, opts.disabled]);

  return {
    observations: [...observations.values()],
    sources: initial.sources,
    status,
    health,
    broadcast,
    clips: [...clips.values()],
    job,
    connection,
    freshIds,
  };
}

/**
 * Wall clock for ages and windows. Starts at 0 during server render and hydration (so server
 * and client markup match), then ticks from the browser clock. Callers treat 0 as "unknown".
 */
interface Clock {
  now: number;
  subscribe: (onChange: () => void) => () => void;
  get: () => number;
}

const clocks = new Map<number, Clock>();
const serverNow = () => 0;

/** One shared ticking clock per interval, created outside React so renders stay pure. */
function getClock(intervalMs: number): Clock {
  const existing = clocks.get(intervalMs);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const c: Clock = {
    now: 0,
    subscribe(onChange) {
      listeners.add(onChange);
      if (!timer) {
        c.now = Date.now();
        timer = setInterval(() => {
          c.now = Date.now();
          for (const l of listeners) l();
        }, intervalMs);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    get: () => c.now,
  };
  clocks.set(intervalMs, c);
  return c;
}

export function useNow(intervalMs = 1000): number {
  const c = getClock(intervalMs);
  return useSyncExternalStore(c.subscribe, c.get, serverNow);
}
