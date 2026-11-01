"use client";

import { useEffect, useRef, useState } from "react";
import { SECTIONS } from "./content";

/**
 * The pause-menu tab strip. Plain in-page links (every section stays in the page for readers and
 * search engines); the white selection bar follows the section being read.
 */
export function SetupTabs() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const bar = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const targets = SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    // A section is "current" once its top passes just under the two sticky bars.
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = SECTIONS.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-132px 0px -55% 0px" },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  // Keep the selected tab in view when the strip scrolls sideways (phones).
  useEffect(() => {
    const ul = bar.current;
    const tab = ul?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!ul || !tab || ul.scrollWidth <= ul.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ul.scrollTo({ left: tab.offsetLeft - ul.clientWidth / 2 + tab.clientWidth / 2, behavior: reduce ? "auto" : "smooth" });
  }, [active]);

  return (
    <nav aria-label="On this page" className="su-tabs">
      <ul ref={bar} className="su-tab-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              data-tab={s.id}
              aria-current={active === s.id ? "location" : undefined}
              className={active === s.id ? "su-tab select-bar" : "su-tab"}
              onClick={() => setActive(s.id)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
