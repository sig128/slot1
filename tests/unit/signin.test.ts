import { describe, expect, it } from "vitest";
import { TwitchSignInWhy } from "@slot1/contracts";
import { classifyExchangeError } from "../../apps/api/src/lib/signin-events";
import { signInNotice, twitchSignInHref } from "../../apps/web/lib/signin-notice";

const ORIGIN = "https://slot1.example";
const q = (s: string) => new URLSearchParams(s);
/** Setting names and server commands never reach visitors (see tests/e2e/onboarding.spec.ts). */
const SERVER_WORDS = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bslot1 (?:twitch|ai|update|demo|logs)\b/;

describe("Sign in with Twitch: why it didn't finish", () => {
  it("sorts Twitch's token errors into reasons a person can act on", () => {
    expect(classifyExchangeError(403, "invalid client secret")).toBe("app_secret");
    expect(classifyExchangeError(400, "invalid client")).toBe("app_client");
    expect(classifyExchangeError(400, "Parameter redirect_uri does not match registered URI")).toBe("redirect");
    expect(classifyExchangeError(400, "Invalid authorization code")).toBe("code");
    expect(classifyExchangeError(403, "something new")).toBe("app_secret");
    expect(classifyExchangeError(0, "fetch failed")).toBe("twitch_down");
    expect(classifyExchangeError(502, "bad gateway")).toBe("twitch_down");
    expect(classifyExchangeError(400, "something else")).toBe("server");
  });

  it("has a plain message for every reason, never a setting name or command", () => {
    for (const why of TwitchSignInWhy.options) {
      const n = why === "denied" ? signInNotice(q("twitch=denied"), ORIGIN) : signInNotice(q(`twitch=error&why=${why}`), ORIGIN);
      expect(n, why).not.toBeNull();
      expect(n!.title.length, why).toBeGreaterThan(5);
      expect(JSON.stringify(n), why).not.toMatch(SERVER_WORDS);
    }
    expect(signInNotice(q("twitch=error&why=app_secret"), ORIGIN)).toMatchObject({ tone: "error", code: "app_secret", retry: true });
    expect(signInNotice(q("twitch=error&why=redirect"), ORIGIN)!.owner).toContain(`${ORIGIN}/api/auth/twitch/callback`);
    expect(signInNotice(q("twitch=error"), ORIGIN)).toMatchObject({ title: "Twitch sign-in didn't finish.", retry: true });
    expect(signInNotice(q("twitch=connected"), ORIGIN)).toMatchObject({ tone: "ok", retry: false });
    expect(signInNotice(q("bot=not_admin"), ORIGIN)).toMatchObject({ tone: "warn" });
    expect(signInNotice(q(""), ORIGIN)).toBeNull();
  });

  it("links every sign-in button straight to Twitch and back into Studio", () => {
    expect(twitchSignInHref()).toBe("/api/auth/twitch/start?returnTo=%2Fstudio");
    expect(twitchSignInHref("/studio?tab=stream")).toBe("/api/auth/twitch/start?returnTo=%2Fstudio%3Ftab%3Dstream");
  });
});
