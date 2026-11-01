"use client";

import { useEffect, useRef, useState } from "react";
import { SECTIONS } from "./content";

/**
 * The pause-menu tab strip. Plain in-page links (every section stays in the page for readers and
 * search engines); the white selection bar (aria-current, styled in setup.css) follows the
 * section being read.
 */
export function SetupTabs() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const bar = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const targets = SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    // The current section is the last one whose top has passed the line just under the two sticky
    // bars (site header + this strip). Measured from geometry on every scroll frame, so anchor
    // jumps, late font loads and resizes all land on the right tab.
    const LINE = 140;
    let raf = 0;
    const update = () => {
      raf = 0;
      let current = targets[0]!.id;
      for (const el of targets) {
        if (el.getBoundingClientRect().top <= LINE) current = el.id;
        else break;
      }
      // The last sections are short: at the very bottom of the page the last one wins.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = targets[targets.length - 1]!.id;
      setActive(current);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, []);

  // Keep the selected tab in view when the strip scrolls sideways (phones).
  useEffect(() => {
    const ul = bar.current;
    const tab = ul?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!ul || !tab || ul.scrollWidth <= ul.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ul.scrollTo({
      left: tab.offsetLeft - ul.clientWidth / 2 + tab.clientWidth / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [active]);

  return (
    <nav aria-label="On this page" className="su-tabs">
      <ul ref={bar} className="su-tab-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} data-tab={s.id} aria-current={active === s.id ? "location" : undefined} className="su-tab" onClick={() => setActive(s.id)}>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
