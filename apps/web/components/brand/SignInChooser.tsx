"use client";

import "./signin-chooser.css";
import { Popover } from "radix-ui";
import { chatSignInHref, signInHref, type SignInPlatform } from "@/lib/signin-notice";

const PLATFORMS: { id: SignInPlatform; name: string }[] = [
  { id: "twitch", name: "Twitch" },
  { id: "kick", name: "Kick" },
];

/** Where each choice goes: a creator's channel (Studio), or only an identity to chat with. */
function hrefFor(platform: SignInPlatform, purpose: "creator" | "chat", returnTo: string): string {
  return purpose === "chat" ? chatSignInHref(returnTo, platform) : signInHref(platform, returnTo);
}

/**
 * "Sign in": one button that opens the two ways in, Twitch or Kick. Each goes straight to that
 * platform and back. Used where there's room for one button (the header).
 */
export function SignInChooser({
  label = "Sign in",
  className = "btn btn-coral btn-sm",
  returnTo = "/studio",
  purpose = "creator",
  align = "end",
}: {
  label?: string;
  className?: string;
  returnTo?: string;
  purpose?: "creator" | "chat";
  align?: "start" | "center" | "end";
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={className}>
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={8} collisionPadding={12} className="signin-pop" aria-label="Sign in with">
          <p className="signin-pop-title">Sign in with</p>
          <SignInOptions purpose={purpose} returnTo={returnTo} />
          <p className="signin-pop-note">{purpose === "chat" ? "Only your name is used, to chat." : "Creators: use the account you stream from."}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The two platform buttons on their own: for pages with room to show both at once. */
export function SignInOptions({
  purpose = "creator",
  returnTo = "/studio",
  size = "md",
  prefix = "",
  onPick,
}: {
  purpose?: "creator" | "chat";
  returnTo?: string;
  size?: "sm" | "md" | "lg";
  /** Text before the platform name, like "Sign in with ". */
  prefix?: string;
  /** Lets a caller fill in the return path at click time (the current page). */
  onPick?: (platform: SignInPlatform) => string | null;
}) {
  return (
    <div className={`signin-options signin-options-${size}`}>
      {PLATFORMS.map((p) => (
        <a
          key={p.id}
          href={hrefFor(p.id, purpose, returnTo)}
          className={`signin-option signin-${p.id}`}
          data-platform={p.id}
          onClick={(e) => {
            const back = onPick?.(p.id);
            if (back) e.currentTarget.href = hrefFor(p.id, purpose, back);
          }}
        >
          <span className="signin-option-bar" aria-hidden />
          <span className="signin-option-name">
            {prefix}
            {p.name}
          </span>
        </a>
      ))}
    </div>
  );
}
