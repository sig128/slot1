"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MeResponse } from "@slot1/contracts";
import { HeaderAvatar } from "./HeaderAvatar";
import { MORE_NAV, PRIMARY_NAV, WIDE_QUERY } from "./site-nav";
import { Wordmark } from "./Wordmark";

const MENU_ID = "site-menu";

/**
 * The header below 768 px: the sign-in action and a Menu button that opens a full-screen pause
 * menu over the page. The menu is a native modal <dialog>, always in the page (so the button's
 * aria-controls always points at it): the browser keeps focus inside it, makes the page behind
 * inert and closes it on Escape. This component adds the motion, the scroll lock, moving focus in
 * and back to the button, and closing on navigation.
 */
export function MobileMenu({ pathname, me }: { pathname: string; me: MeResponse | null }) {
  // The page the menu was opened on: it is open only while that page shows, so a route change
  // (a link in the menu, back, forward) closes it with no extra effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const close = () => setOpenOn(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLAnchorElement>(null);
  const savedScroll = useRef<{ overflow: string; paddingRight: string } | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        // The page behind stays put: no scrolling, and no jump where a desktop scrollbar was.
        const root = document.documentElement;
        const scrollbar = window.innerWidth - root.clientWidth;
        savedScroll.current ??= { overflow: root.style.overflow, paddingRight: document.body.style.paddingRight };
        root.style.overflow = "hidden";
        if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
        dialog.showModal();
      }
      firstRef.current?.focus();
      return;
    }
    if (!dialog.open) return;
    // Let the closing motion finish (there is none with reduced motion), then close for real.
    let reopened = false;
    void Promise.allSettled(dialog.getAnimations().map((a) => a.finished)).then(() => {
      if (!reopened) dialog.close();
    });
    return () => {
      reopened = true;
    };
  }, [open]);

  // Turning a tablet to landscape brings the tab row back, and with it the header's own links.
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia(WIDE_QUERY);
    const onChange = () => {
      if (wide.matches) setOpenOn(null);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [open]);

  const onClosed = () => {
    const saved = savedScroll.current;
    if (saved) {
      document.documentElement.style.overflow = saved.overflow;
      document.body.style.paddingRight = saved.paddingRight;
      savedScroll.current = null;
    }
    setOpenOn(null);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const broadcaster = me?.broadcaster ?? null;

  return (
    <>
      <div className="sh-bar-actions">
        {broadcaster ? (
          <Link href="/studio" className="sh-bar-avatar" aria-label={broadcaster.displayName}>
            <HeaderAvatar broadcaster={broadcaster} className="h-8 w-8 text-[0.95rem]" />
          </Link>
        ) : (
          <Link href="/studio" className="btn btn-ghost sh-bar-connect">
            Connect my Twitch
          </Link>
        )}
        <button
          ref={triggerRef}
          type="button"
          className="sh-prompt"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={MENU_ID}
          onClick={() => setOpenOn(pathname)}
        >
          <span className="sh-key" aria-hidden>
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M2 3.5h12M2 8h12M2 12.5h12" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <span className="sh-prompt-label">Menu</span>
        </button>
      </div>

      <dialog
        ref={dialogRef}
        id={MENU_ID}
        aria-label="Menu"
        className="sh-menu"
        data-state={open ? "open" : "closed"}
        onCancel={(e) => {
          // Escape: close with the same motion as the Close button.
          e.preventDefault();
          close();
        }}
        onClose={onClosed}
      >
        <div className="sh-menu-bar">
          <Link href="/" className="flex min-h-11 shrink-0 items-center rounded-sm" aria-label="SLOT1 home" onClick={close}>
            <Wordmark size="sm" />
          </Link>
          <button type="button" className="sh-prompt" onClick={close}>
            <span className="sh-key" aria-hidden>
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="2.2" />
              </svg>
            </span>
            <span className="sh-prompt-label">Close</span>
          </button>
        </div>

        <div className="sh-menu-body">
          <nav aria-label="Primary">
            <ul className="sh-items">
              {PRIMARY_NAV.map((item, i) => (
                <li key={item.href}>
                  <Link
                    ref={i === 0 ? firstRef : undefined}
                    href={item.href}
                    className="sh-item"
                    aria-current={item.match(pathname) ? "page" : undefined}
                    aria-describedby={`sh-hint-${i}`}
                    onClick={close}
                  >
                    <span className="sh-item-name">{item.label}</span>
                    <span id={`sh-hint-${i}`} className="sh-item-hint" aria-hidden>
                      {item.hint}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="sh-account">
            {broadcaster ? (
              <Link href="/studio" className="sh-me" aria-describedby="sh-me-hint" onClick={close}>
                <HeaderAvatar broadcaster={broadcaster} className="h-10 w-10 text-[1.1rem]" />
                <span className="min-w-0">
                  <span className="sh-me-name">{broadcaster.displayName}</span>
                  <span id="sh-me-hint" className="sh-me-hint" aria-hidden>
                    {broadcaster.kind === "twitch" ? "Signed in with Twitch" : "Local workspace"}
                  </span>
                </span>
              </Link>
            ) : (
              <Link href="/studio" className="btn btn-ghost sh-connect" onClick={close}>
                Connect my Twitch
              </Link>
            )}
          </div>

          <nav aria-label="More" className="sh-more">
            <ul>
              {MORE_NAV.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="sh-more-link" aria-current={pathname === l.href ? "page" : undefined} onClick={close}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </dialog>
    </>
  );
}
