"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Cookieless visitor counting for the operator dashboard (docs/ADMIN.md).
 *
 * - On each page (App Router route change) it reports the path, without query string or hash, the
 *   referrer's host name on the first page of a visit, and a coarse viewport bucket.
 * - While the tab is visible it sends a heartbeat every 30 s, so /admin can show who is on the
 *   site right now.
 * - It sets no cookie and uses no storage. Do Not Track, Global Privacy Control and automated
 *   browsers are never counted (the server checks the DNT/GPC headers too).
 */
const HEARTBEAT_MS = 30_000;

function counted(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const w = window as Window & { doNotTrack?: string };
  if (n.webdriver) return false;
  if (n.globalPrivacyControl === true) return false;
  return n.doNotTrack !== "1" && n.doNotTrack !== "yes" && w.doNotTrack !== "1" && n.msDoNotTrack !== "1";
}

const excluded = (path: string) => path === "/admin" || path.startsWith("/admin/");

function bucket(): "s" | "m" | "l" {
  const w = window.innerWidth;
  return w < 768 ? "s" : w < 1100 ? "m" : "l";
}

function send(url: string, payload: Record<string, string>) {
  const body = JSON.stringify(payload);
  try {
    // A string body goes out as text/plain, which needs no CORS preflight.
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, body)) return;
  } catch {
    /* fall through to fetch */
  }
  void fetch(url, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => undefined);
}

export function Beacon() {
  const pathname = usePathname();
  const current = useRef<string | null>(null);
  const firstView = useRef(true);

  useEffect(() => {
    if (!pathname) return;
    current.current = pathname;
    if (!counted() || excluded(pathname)) return;
    const payload: Record<string, string> = { p: pathname, b: bucket() };
    if (firstView.current) {
      try {
        const ref = document.referrer ? new URL(document.referrer) : null;
        if (ref && ref.host !== window.location.host && /^https?:$/.test(ref.protocol)) payload.r = ref.hostname;
      } catch {
        /* no usable referrer */
      }
    }
    firstView.current = false;
    send("/api/analytics/collect", payload);
  }, [pathname]);

  useEffect(() => {
    if (!counted()) return;
    const beat = () => {
      const p = current.current;
      if (document.visibilityState === "visible" && p && !excluded(p)) send("/api/analytics/ping", { p });
    };
    const timer = setInterval(beat, HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
