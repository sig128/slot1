"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

// When this module first ran: mounts long after it are client-side navigations back to the page.
const loadedAt = typeof performance !== "undefined" ? performance.now() : 0;

/**
 * Holds the animated artwork still while it is off screen or the tab is in the background
 * (sets data-paused on the nearest [data-scene]; the CSS pauses every animation inside).
 * The intro plays on a full page load; coming back to the page within the app skips straight to
 * the final frame (data-intro="skip", set before the first paint).
 */
export function ScenePlayback() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-scene]");
    if (host && performance.now() - loadedAt > 1500) host.dataset.intro = "skip";
  }, []);
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
