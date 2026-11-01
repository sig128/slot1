"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  /** Shortcut shown on the right (display only). */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | "sep";

export interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
}

/**
 * A right-click menu: arrow keys move, Enter picks, Escape or a click elsewhere closes, and
 * focus returns to whatever opened it.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) return;
    opener.current = document.activeElement;
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 200;
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - w - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - h - 4)) });
    requestAnimationFrame(() => el?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", blur);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const close = () => {
    onClose();
    (opener.current as HTMLElement | null)?.focus?.();
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      className="nle-menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          (e.key === "Home" ? items[0] : items.at(-1))?.focus();
        } else if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <div key={`sep-${i}`} role="separator" className="nle-menu-sep" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={it.danger ? "nle-menu-danger" : undefined}
            onClick={() => {
              close();
              it.onSelect();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/** A small modal dialog with a title; Escape closes it and focus goes back where it was. */
export function Dialog({ title, onClose, children, className = "", labelledBy }: { title: string; onClose: () => void; children: ReactNode; className?: string; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("[autofocus], button, [href], input, select, textarea")?.focus());
    return () => before?.focus?.();
  }, []);
  const id = labelledBy ?? `dlg-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="nle-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={`nle-dialog ${className}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key !== "Tab") return;
          const f = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex='0']") ?? [])];
          if (f.length === 0) return;
          if (e.shiftKey && document.activeElement === f[0]) {
            e.preventDefault();
            f.at(-1)!.focus();
          } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
            e.preventDefault();
            f[0]!.focus();
          }
        }}
      >
        <h2 id={id} className="sr-only">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
