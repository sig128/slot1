"use client";

import { useState } from "react";

/** Copies a chat command. Says "Copied" for a moment, and falls back to selecting the text. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }
  return (
    <button type="button" className="su-copy" onClick={copy} aria-label={`Copy ${label}`}>
      <span aria-hidden>{state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}</span>
      <span className="sr-only" role="status">
        {state === "copied" ? `${label} copied` : state === "failed" ? "Copying isn’t allowed here; select the command instead" : ""}
      </span>
    </button>
  );
}
