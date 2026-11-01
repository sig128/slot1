"use client";

import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { wheelIndexFromPoint, wheelKey, wheelPosition } from "@/lib/wheel";

export interface WheelOption {
  id: string;
  label: string;
  /** What's happening there, in a few words. */
  detail: string;
  imageUrl: string | null;
  /** "TEST", "Twitch only"… */
  badge: string | null;
}

/**
 * The stream selector, styled after a game's radio wheel in SLOT1's own colors and type (no game
 * artwork). Wide screens get the wheel; narrow ones a compact strip with the same keys:
 * arrows to choose, Enter to switch, Esc (or Q) to close. Focus returns to `returnFocus`.
 */
export function RadioWheel({
  open,
  onOpenChange,
  options,
  value,
  onChoose,
  variant,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: WheelOption[];
  value: string | null;
  onChoose: (id: string) => void;
  variant: "wheel" | "strip";
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const start = Math.max(0, options.findIndex((o) => o.id === value));
  const [index, setIndex] = useState(start);
  const [prevOpen, setPrevOpen] = useState(open);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const wheel = useRef<HTMLDivElement>(null);

  // Each time it opens, start from the stream that's playing.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setIndex(start);
  }
  const at = Math.min(index, Math.max(0, options.length - 1));
  const active = options[at] ?? null;

  useEffect(() => {
    if (!open) return;
    const el = items.current[at];
    el?.focus({ preventScroll: variant === "wheel" });
    if (variant === "strip") el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [open, at, variant]);

  const commit = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChoose(o.id);
    onOpenChange(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return; // the dialog closes itself
    const action = wheelKey(e.key, at, options.length);
    if (!action) return;
    e.preventDefault();
    if (action.type === "move") setIndex(action.index);
    else if (action.type === "commit") commit(at);
    else onOpenChange(false);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const el = wheel.current;
    if (!el || variant !== "wheel") return;
    const r = el.getBoundingClientRect();
    const i = wheelIndexFromPoint(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), options.length, r.width * 0.2);
    if (i !== null && i !== at) setIndex(i);
  };

  const n = options.length;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-graphite-900/85 backdrop-blur-sm motion-safe:transition-opacity" />
        <Dialog.Content
          aria-describedby="wheel-help"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus({ preventScroll: true });
          }}
          onOpenAutoFocus={(e) => {
            // Start on the stream that's playing (the content is in the page by now).
            e.preventDefault();
            items.current[at]?.focus({ preventScroll: variant === "wheel" });
          }}
          className={
            variant === "wheel"
              ? "fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 p-4"
              : "fixed inset-x-0 bottom-0 z-50 border-t hairline bg-graphite-900 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
          }
          data-wheel={variant}
        >
          <div className={`flex items-center justify-between gap-3 px-4 ${variant === "wheel" ? "w-full max-w-[600px]" : ""}`}>
            <Dialog.Title className="font-display text-[1.05rem] font-semibold tracking-[0.06em] text-ivory-2">CHOOSE A STREAM</Dialog.Title>
            <Dialog.Close className="btn btn-quiet btn-sm" aria-label="Close the stream selector">
              <span aria-hidden>✕</span>
            </Dialog.Close>
          </div>
          <p id="wheel-help" className="sr-only">
            Use the arrow keys to choose a stream, Enter to switch to it, Escape to close.
          </p>
          {variant === "wheel" ? (
            <div
              ref={wheel}
              role="radiogroup"
              aria-label="Live streams"
              onKeyDown={onKeyDown}
              onPointerMove={onPointerMove}
              className="relative aspect-square w-[min(84vmin,600px)] touch-none select-none"
            >
              <svg viewBox="-100 -100 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
                <circle r="96" fill="var(--color-graphite-800)" stroke="var(--color-line-strong)" strokeWidth="0.6" />
                <circle r="42" fill="var(--color-graphite-900)" stroke="var(--color-line-strong)" strokeWidth="0.6" />
                {n > 1 &&
                  options.map((o, i) => {
                    const a0 = ((i - 0.5) / n) * 2 * Math.PI;
                    const a1 = ((i + 0.5) / n) * 2 * Math.PI;
                    const p = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
                    const large = a1 - a0 > Math.PI ? 1 : 0;
                    const d = `M ${p(44, a0)} L ${p(95, a0)} A 95 95 0 ${large} 1 ${p(95, a1)} L ${p(44, a1)} A 44 44 0 ${large} 0 ${p(44, a0)} Z`;
                    return <path key={o.id} d={d} fill={i === at ? "color-mix(in oklab, var(--color-apricot) 30%, transparent)" : "transparent"} stroke="var(--color-line)" strokeWidth="0.5" />;
                  })}
                {n === 1 && <circle r="70" fill="none" stroke="var(--color-apricot)" strokeOpacity="0.5" strokeWidth="25" />}
              </svg>
              {options.map((o, i) => {
                const pos = wheelPosition(i, n);
                const checked = i === at;
                return (
                  <button
                    key={o.id}
                    ref={(el) => {
                      items.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={`${o.label}${o.badge ? `, ${o.badge}` : ""}: ${o.detail}${o.id === value ? ", now watching" : ""}`}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => commit(i)}
                    onFocus={() => setIndex(i)}
                    className={`absolute grid aspect-square w-[17%] -translate-x-1/2 -translate-y-1/2 place-items-center overflow-hidden rounded-full border-2 bg-graphite-700 motion-safe:transition-transform ${
                      checked ? "z-[2] scale-110 border-apricot" : "border-line-strong opacity-80 hover:opacity-100"
                    }`}
                    style={{ left: `${50 + pos.x * 34}%`, top: `${50 + pos.y * 34}%` }}
                  >
                    {o.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={o.imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <span className="font-display text-[clamp(1rem,3vmin,1.6rem)] font-bold">{o.label.slice(0, 1).toUpperCase()}</span>
                    )}
                  </button>
                );
              })}
              <div className="pointer-events-none absolute left-1/2 top-1/2 flex w-[38%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center" aria-hidden>
                {active && (
                  <>
                    <span className="poster-title line-clamp-2 break-words text-[clamp(1.2rem,4vmin,2.1rem)] leading-[0.95]">{active.label}</span>
                    {active.badge && <span className="mt-1 font-display text-[0.75rem] font-semibold tracking-[0.08em] text-apricot">{active.badge.toUpperCase()}</span>}
                    <span className="mt-1.5 line-clamp-2 text-[clamp(0.72rem,2vmin,0.9rem)] text-ivory-2">{active.detail}</span>
                    <span className="mt-2 text-[0.7rem] text-ivory-3">Enter to switch · Esc to close</span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Live streams" onKeyDown={onKeyDown} className="mt-2 flex gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 pt-1 [scrollbar-width:thin]">
              {options.map((o, i) => {
                const checked = i === at;
                return (
                  <button
                    key={o.id}
                    ref={(el) => {
                      items.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={`${o.label}${o.badge ? `, ${o.badge}` : ""}: ${o.detail}${o.id === value ? ", now watching" : ""}`}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => commit(i)}
                    onFocus={() => setIndex(i)}
                    className={`w-36 shrink-0 border-2 text-left ${checked ? "border-apricot" : "border-line"}`}
                  >
                    <span className="block aspect-video w-full overflow-hidden bg-graphite-700">
                      {o.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={o.imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      ) : (
                        <span className="grid h-full place-items-center font-display text-xl font-bold">{o.label.slice(0, 1).toUpperCase()}</span>
                      )}
                    </span>
                    <span className="block truncate px-2 pt-1.5 font-display text-[0.98rem] font-bold">{o.label}</span>
                    <span className="block truncate px-2 pb-1.5 text-[0.75rem] text-ivory-2">{o.badge ? `${o.badge} · ` : ""}{o.detail}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
