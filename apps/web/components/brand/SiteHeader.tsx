"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { MeResponse } from "@slot1/contracts";
import { getMe, onMeChange } from "@/lib/api";
import { twitchSignInHref } from "@/lib/signin-notice";
import { Wordmark } from "./Wordmark";

const TABS = [
  { href: "/", label: "On Air", match: (p: string) => p === "/" || p.startsWith("/watch") || p.startsWith("/replay") },
  { href: "/los-santos", label: "Right now", match: (p: string) => p.startsWith("/los-santos") },
  { href: "/moments", label: "Moments", match: (p: string) => p.startsWith("/moments") },
  { href: "/studio", label: "Studio", match: (p: string) => p.startsWith("/studio") },
  { href: "/setup", label: "Setup", match: (p: string) => p.startsWith("/setup") },
];

/** Pause-menu style navigation: the active tab is the ivory selection bar. */
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
        <Link href="/" className="shrink-0 rounded-sm" aria-label="SLOT1 home">
          <Wordmark size="sm" reveal />
        </Link>
        <nav aria-label="Primary" className="-mx-1 flex min-w-0 flex-1 overflow-x-auto">
          <ul className="flex items-stretch gap-1">
            {TABS.map((t) => {
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
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {me?.broadcaster ? (
            <Link href="/studio" className="flex items-center gap-2 text-sm text-ivory-2 hover:text-ivory">
              {me.broadcaster.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.broadcaster.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-graphite-600 font-display text-sm font-bold">
                  {me.broadcaster.displayName.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="max-w-[10rem] truncate">{me.broadcaster.displayName}</span>
            </Link>
          ) : (
            <a href={twitchSignInHref()} className="btn btn-coral btn-sm">
              Sign in with Twitch
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
