"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { AdminLoginStatus } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

/** The automatic reopen below happens at most once per page load. */
let reopenTried = false;

/**
 * The /admin door for everyone without access: the admin password (docs/ADMIN.md). Operators and
 * open admin sessions get the dashboard instead. Wrong passwords get one generic answer; the
 * limits (5 per connection per 15 minutes, then a pause for everyone) come back as their own text.
 */
export function AdminLogin({ passwordSet }: { passwordSet: boolean }) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "opening">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const router = useRouter();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The admin cookie is SameSite=Strict, so a link from another site arrives without it. If this
  // browser is signed in after all, this same-site check sees it and renders the dashboard.
  useEffect(() => {
    if (reopenTried) return;
    let cancelled = false;
    api<AdminLoginStatus>("/api/admin/login")
      .then((s) => {
        if (cancelled || !s.signedIn || reopenTried) return;
        reopenTried = true;
        router.refresh();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state !== "idle") return;
    if (!password) {
      setFailure("Enter the admin password.");
      field.current?.focus();
      return;
    }
    setState("checking");
    setFailure(null);
    try {
      await api<{ ok: true; redirect: string }>("/api/admin/login", { method: "POST", json: { password } });
      setState("opening");
      // The answer names /admin, this page: rendered again with the new session, it is the dashboard.
      router.refresh();
      // Still here a while later: the browser didn't keep the session cookie (e.g. HTTPS missing).
      setTimeout(() => {
        if (!mounted.current) return;
        setState("idle");
        setFailure("The password was right, but this browser didn’t keep the admin session. Reload the page and try again.");
      }, 8000);
    } catch (err) {
      setState("idle");
      setPassword("");
      setFailure(err instanceof ApiError ? err.message : "Couldn’t reach SLOT1. Check your connection and try again.");
      field.current?.focus();
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-10 sm:px-6 lg:px-10">
      <div className="max-w-[34rem]">
        <p className="font-display text-[0.95rem] font-semibold tracking-[0.06em] text-coral">SLOT1 ADMIN</p>
        <h1 className="poster-title mt-3 text-[length:var(--text-display-lg)] leading-[0.9]">Staff only.</h1>

        {passwordSet ? (
          <>
            <p className="mt-4 text-[1.05rem] text-ivory-2">Enter the admin password to open the control room.</p>
            <form noValidate onSubmit={submit} className="mt-8 border-l-2 border-gold pl-5">
              <label htmlFor={`${id}-password`} className="label">
                Admin password
              </label>
              <input
                ref={field}
                id={`${id}-password`}
                name="password"
                type="password"
                className="field"
                autoComplete="current-password"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                maxLength={4096}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={failure ? true : undefined}
                aria-describedby={failure ? `${id}-failure` : undefined}
              />
              {failure ? (
                <p id={`${id}-failure`} role="alert" className="mt-4 border-l-2 border-coral pl-3 text-[0.95rem] text-ivory">
                  {failure}
                </p>
              ) : null}
              <button type="submit" className="btn btn-primary mt-6" disabled={state !== "idle"}>
                {state === "checking" ? "Checking…" : state === "opening" ? "Opening…" : "Sign in"}
              </button>
            </form>
            <p className="mt-10 max-w-[48ch] text-[0.9rem] text-ivory-3">
              Locked out? On the server, <code className="bg-graphite-800 px-1 text-ivory">slot1 admin-link</code> prints a one‑time sign-in link.
            </p>
          </>
        ) : (
          <div className="mt-4">
            <p className="text-[1.05rem] text-ivory">No admin password is set on this server yet.</p>
            <div className="mt-8 border-l-2 border-apricot pl-5">
              <p className="text-ivory-2">To set one, run this on the server:</p>
              <p className="mt-3">
                <code className="inline-block bg-graphite-900 px-3 py-2 text-[0.95rem] text-ivory">slot1 admin-password</code>
              </p>
              <p className="mt-3 max-w-[52ch] text-[0.95rem] text-ivory-2">It asks for the new password (12 characters or more) without showing it. Only a hash of it is stored.</p>
            </div>
            <p className="mt-10 max-w-[48ch] text-[0.9rem] text-ivory-3">
              Until then, <code className="bg-graphite-800 px-1 text-ivory">slot1 admin-link</code> prints a one‑time sign-in link.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
