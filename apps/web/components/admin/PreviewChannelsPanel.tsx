"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { PREVIEW_CHANNELS_MAX, type PreviewChannels } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

const names = (l: string[]) => (l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);

/**
 * Admin → Featured channels: Twitch and Kick channels shown on the home page for everyone (Live now and On
 * air) like any channel, with Twitch's player and chat. Nothing is analyzed or recorded.
 */
export function PreviewChannelsPanel() {
  const id = useId();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<PreviewChannels>("/api/admin/preview-channels")
      .then((r) => {
        setSaved(r.logins);
        setText(r.logins.join(", "));
      })
      .catch(() => setNote({ ok: false, text: "Couldn’t load the featured channels. Reload the page." }));
  }, []);

  async function save(value: string) {
    setBusy(true);
    setNote(null);
    try {
      const logins = value.split(/[\s,]+/).filter(Boolean);
      const r = await api<PreviewChannels>("/api/admin/preview-channels", { method: "PUT", json: { logins } });
      setSaved(r.logins);
      setText(r.logins.join(", "));
      setNote({
        ok: true,
        text: r.logins.length ? `Saved. ${names(r.logins)} now show${r.logins.length === 1 ? "s" : ""} on the home page when live.` : "Cleared. The home page lists connected channels only.",
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : "Couldn’t save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[44rem]">
      <p className="text-[0.95rem] text-ivory-2">
        Twitch and Kick channels to show on the home page. When they’re live they appear in Live now and On air for everyone, with their platform’s player, Twitch chat for Twitch channels, and SLOT1
        chat for all of them.
      </p>
      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save(text);
        }}
      >
        <label htmlFor={`${id}-logins`} className="block text-[0.9rem] font-semibold text-ivory">
          Twitch and Kick channels
        </label>
        <p id={`${id}-help`} className="mt-0.5 text-[0.85rem] text-ivory-3">
          Twitch names or twitch.tv links, and kick.com links (or kick:name), separated by commas. Up to {PREVIEW_CHANNELS_MAX}.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id={`${id}-logins`}
            className="field min-w-0 flex-[1_1_18rem]"
            placeholder="vader"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-help`}
            value={text}
            disabled={busy || saved === null}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || saved === null}>
            {busy ? "Saving…" : "Save"}
          </button>
          {saved !== null && saved.length > 0 && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save("")}>
              Clear all
            </button>
          )}
        </div>
      </form>
      <div aria-live="polite" className="mt-3 min-h-6 text-[0.9rem]">
        {note && (
          <p className={note.ok ? "text-ivory-2" : "text-coral"}>
            {note.text}{" "}
            {note.ok && saved && saved.length > 0 && (
              <Link href="/#live-now" className="underline underline-offset-4 hover:text-ivory">
                Open the home page
              </Link>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
