"use client";

import { useEffect, useRef } from "react";

/**
 * Holds the animated artwork still while it is off screen or the tab is in the background
 * (sets data-paused on the nearest [data-scene]; the CSS pauses every animation inside).
 */
export function ScenePlayback() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-scene]");
    if (!host) return;
    let visible = true;
    const apply = () => {
      host.dataset.paused = String(!visible || document.hidden);
    };
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        apply();
      },
      { rootMargin: "64px" },
    );
    io.observe(host);
    document.addEventListener("visibilitychange", apply);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);
  return <span ref={ref} hidden />;
}
