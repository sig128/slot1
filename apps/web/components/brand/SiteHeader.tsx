"use client";

import "./site-header.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { MeResponse } from "@slot1/contracts";
import { getMe, onMeChange } from "@/lib/api";
import { HeaderAvatar } from "./HeaderAvatar";
import { MobileMenu } from "./MobileMenu";
import { PRIMARY_NAV } from "./site-nav";
import { twitchSignInHref } from "@/lib/signin-notice";
import { Wordmark } from "./Wordmark";

/**
 * Pause-menu style navigation: the active tab is the ivory selection bar. From 768 px the tabs and
 * the account sit in the header; below that a Menu button opens them as a full-screen pause menu.
 */
export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => onMeChange(setMe), []);
  useEffect(() => {
    getMe().then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b hairline bg-graphite/92 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-6 px-4 sm:px-6 lg:px-10">
        <Link href="/" className="flex min-h-11 shrink-0 items-center rounded-sm" aria-label="SLOT1 home">
          <Wordmark size="sm" reveal />
        </Link>
        <nav aria-label="Primary" className="-mx-1 hidden min-w-0 flex-1 overflow-x-auto md:flex">
          <ul className="flex items-stretch gap-1">
            {PRIMARY_NAV.map((t) => {
              const active = t.match(pathname);
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-9 items-center whitespace-nowrap px-3 font-display text-[1.05rem] font-semibold tracking-[0.02em] transition-colors ${
                      active ? "select-bar" : "text-ivory-2 hover:text-ivory"
                    }`}
                  >
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          {me?.broadcaster ? (
            <Link href="/studio" className="flex items-center gap-2 text-sm text-ivory-2 hover:text-ivory">
              <HeaderAvatar broadcaster={me.broadcaster} className="h-7 w-7 text-sm" />
              <span className="max-w-[10rem] truncate">{me.broadcaster.displayName}</span>
            </Link>
          ) : (
            <a href={twitchSignInHref()} className="btn btn-coral btn-sm">
              Sign in with Twitch
            </a>
          )}
        </div>
        <MobileMenu pathname={pathname} me={me} />
      </div>
    </header>
  );
}
