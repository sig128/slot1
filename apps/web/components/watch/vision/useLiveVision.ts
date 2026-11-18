"use client";

import { useEffect, useState } from "react";
import type { DetectedObject } from "@slot1/contracts";
import { trackObjects, type TrackedObject } from "../AiView";
import type { DetectorIn, DetectorOut } from "./detector.worker";

/**
 * Live boxes for a playing video: frames go to the object finder in a worker as fast as it can
 * take them (at most ~15 a second), and each answer replaces the boxes. One worker per page,
 * started on first use and kept for the next stream.
 */

export const MODEL_URL = "/models/yolox-nano.onnx";
const MIN_GAP_MS = 66;

type Listener = (m: DetectorOut) => void;

class Detector {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL("./detector.worker.ts", import.meta.url), { type: "module", name: "slot1-vision" });
      this.worker = w;
      w.onmessage = (e: MessageEvent<DetectorOut>) => {
        const m = e.data;
        if (m.type === "ready") resolve();
        else if (m.type === "error" && m.fatal) {
          reject(new Error(m.message));
          this.ready = null;
          w.terminate();
          this.worker = null;
        }
        for (const l of this.listeners) l(m);
      };
      w.onerror = (e) => {
        reject(new Error(e.message || "the object finder couldn't start"));
        this.ready = null;
        this.worker = null;
      };
      w.postMessage({ type: "init", modelUrl: MODEL_URL } satisfies DetectorIn);
    });
    return this.ready;
  }

  send(id: number, bitmap: ImageBitmap) {
    this.worker?.postMessage({ type: "frame", id, bitmap } satisfies DetectorIn, [bitmap]);
  }

  listen(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}

let detector: Detector | null = null;
const shared = () => (detector ??= new Detector());

export interface LiveVision {
  state: "off" | "loading" | "running" | "error";
  objects: TrackedObject[];
  /** Size of the frames being read (the picture the boxes are relative to). */
  frame: { width: number; height: number } | null;
  /** Boxes per second right now. */
  fps: number | null;
  error: string | null;
}

const OFF: LiveVision = { state: "off", objects: [], frame: null, fps: null, error: null };

/** Run the object finder on `video` while `enabled`. The video must be readable (not cross-origin). */
export function useLiveVision(video: HTMLVideoElement | null, enabled: boolean): LiveVision {
  const [vision, setVision] = useState<LiveVision>(OFF);

  useEffect(() => {
    if (!video || !enabled) return;
    const det = shared();
    let alive = true;
    let busy = false;
    let nextId = 1;
    let waitingFor = 0;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done: number[] = [];
    let frame: { width: number; height: number } | null = null;

    const pump = () => {
      timer = null;
      if (!alive || busy) return;
      const gap = performance.now() - lastSent;
      if (gap < MIN_GAP_MS) {
        timer = setTimeout(pump, MIN_GAP_MS - gap);
        return;
      }
      if (video.readyState < 2 || video.videoWidth === 0 || video.paused) {
        timer = setTimeout(pump, 250);
        return;
      }
      busy = true;
      lastSent = performance.now();
      frame = { width: video.videoWidth, height: video.videoHeight };
      createImageBitmap(video).then(
        (bitmap) => {
          if (!alive) {
            bitmap.close();
            return;
          }
          waitingFor = nextId++;
          det.send(waitingFor, bitmap);
        },
        (err: unknown) => {
          busy = false;
          // A cross-origin video can't be read: there is nothing this page may look at.
          setVision({ ...OFF, state: "error", error: (err as Error).name === "SecurityError" ? "This video can't be read by the page" : "Couldn't read a frame" });
        },
      );
    };

    const stop = det.listen((m) => {
      if (!alive) return;
      if (m.type === "objects" && m.id === waitingFor) {
        busy = false;
        const now = performance.now();
        done.push(now);
        while (done.length > 0 && now - done[0]! > 2000) done.shift();
        const fps = done.length > 1 ? Math.round(((done.length - 1) * 1000) / (now - done[0]!)) : null;
        setVision((v) => ({ state: "running", objects: trackObjects(v.objects, m.objects as DetectedObject[]), frame, fps, error: null }));
        pump();
      } else if (m.type === "error" && !m.fatal) {
        busy = false;
        timer = setTimeout(pump, 500);
      }
    });

    det.start().then(
      () => {
        if (!alive) return;
        setVision((v) => (v.state === "running" ? v : { ...OFF, state: "loading" }));
        pump();
      },
      (err: unknown) => {
        if (alive) setVision({ ...OFF, state: "error", error: (err as Error).message });
      },
    );

    return () => {
      alive = false;
      stop();
      if (timer) clearTimeout(timer);
      setVision(OFF);
    };
  }, [video, enabled]);

  return enabled && video ? vision : OFF;
}
