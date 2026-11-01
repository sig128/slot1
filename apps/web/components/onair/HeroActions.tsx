"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MeResponse } from "@slot1/contracts";
import { getMe, onMeChange } from "@/lib/api";
import { twitchSignInHref } from "@/lib/signin-notice";

const BIG = "h-12 px-5 text-[1.12rem]";
const GHOST = `btn btn-ghost ${BIG} bg-[rgb(10_5_14/0.78)]`;

/**
 * The hero's buttons. Signed out: "Sign in with Twitch" goes straight to Twitch and back into
 * Studio. Signed in: "Open Studio". Before sign-in is set up on the site: how creators connect.
 */
export function HeroActions({ twitchReady }: { twitchReady: boolean }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => onMeChange(setMe), []);
  useEffect(() => {
    getMe().then(setMe).catch(() => setMe(null));
  }, []);

  if (me?.broadcaster) {
    return (
      <>
        <Link href="/studio" className={`btn btn-coral ${BIG}`}>
          Open Studio
        </Link>
        <Link href="/setup" className={GHOST}>
          How it works
        </Link>
      </>
    );
  }
  if (!twitchReady) {
    return (
      <Link href="/setup" className={`btn btn-coral ${BIG}`}>
        How creators connect
      </Link>
    );
  }
  return (
    <>
      <a href={twitchSignInHref()} className={`btn btn-coral ${BIG}`}>
        Sign in with Twitch
      </a>
      <Link href="/setup" className={GHOST}>
        How it works
      </Link>
    </>
  );
}
