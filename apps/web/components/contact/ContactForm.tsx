"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { CONTACT_MESSAGE_MAX, CONTACT_MESSAGE_MIN, CONTACT_TOPIC_TEXT, ContactRequest, ContactTopic, codePoints } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

/** What each kind of message needs, shown under the message box. */
const HINTS: Record<ContactTopic, string> = {
  general: "Ask anything about SLOT1: how it works, what it can see, or what's coming.",
  privacy: "Say which Twitch account or channel this is about and what you want: a copy of your data, a correction, or deletion. We may ask you to confirm the account is yours before we act.",
  copyright:
    "Include a link to each page or clip, what you own and how it's being used, and your full name. Add this statement: “I believe in good faith that this use isn't authorized, and the information in this notice is accurate.”",
  business: "Tell us who you are, what you have in mind, and how to reach you.",
  support: "Tell us your channel name, what you were doing and what went wrong. The time it happened helps.",
};

type Field = "name" | "email" | "topic" | "message";
type Errors = Partial<Record<Field, string>>;

export function ContactForm({ initialTopic, contactEmail }: { initialTopic: ContactTopic; contactEmail: string | null }) {
  const id = useId();
  const [topic, setTopic] = useState<ContactTopic>(initialTopic);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const status = useRef<HTMLDivElement>(null);
  const length = codePoints(message.trim());

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFailure(null);
    const input = { name, email, topic, message, website };
    const check = ContactRequest.safeParse(input);
    if (!check.success) {
      const next: Errors = {};
      for (const issue of check.error.issues) {
        const f = issue.path[0] as Field | undefined;
        if (f && !next[f]) next[f] = issue.message === "Invalid input" ? "Check this field" : issue.message;
      }
      setErrors(next);
      const first = (["email", "message", "name", "topic"] as Field[]).find((f) => next[f]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    setErrors({});
    setState("sending");
    try {
      await api("/api/contact", { method: "POST", json: input });
      setSentTo(check.data.email);
      setState("sent");
      requestAnimationFrame(() => status.current?.focus());
    } catch (err) {
      setState("idle");
      setFailure(err instanceof ApiError ? err.message : "Couldn't reach SLOT1. Check your connection and try again.");
    }
  }

  function reset() {
    setMessage("");
    setState("idle");
    setFailure(null);
  }

  const errorText = (f: Field) =>
    errors[f] ? (
      <p id={`${id}-${f}-error`} className="mt-1.5 text-[0.85rem] text-coral">
        {errors[f]}
      </p>
    ) : null;
  const described = (f: Field, extra?: string) => [errors[f] ? `${id}-${f}-error` : null, extra].filter(Boolean).join(" ") || undefined;

  return (
    <div className="mt-10 grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,40rem)_minmax(0,22rem)]">
      {state === "sent" ? (
        <div ref={status} tabIndex={-1} role="status" className="border-l-2 border-gold pl-5 outline-none">
          <h2 className="font-display text-[2rem] font-extrabold">Message sent</h2>
          <p className="mt-3 max-w-[50ch] text-ivory-2">
            We&apos;ll reply to <span className="text-ivory">{sentTo}</span>.
          </p>
          <button type="button" className="btn btn-ghost mt-6" onClick={reset}>
            Write another message
          </button>
        </div>
      ) : (
        <form noValidate onSubmit={submit} aria-describedby={failure ? `${id}-failure` : undefined}>
          <div className="grid gap-6">
            <div>
              <label htmlFor={`${id}-topic`} className="label">
                What it&apos;s about
              </label>
              <select id={`${id}-topic`} className="field" value={topic} onChange={(e) => setTopic(e.target.value as ContactTopic)} aria-describedby={described("topic")}>
                {ContactTopic.options.map((t) => (
                  <option key={t} value={t}>
                    {CONTACT_TOPIC_TEXT[t]}
                  </option>
                ))}
              </select>
              {errorText("topic")}
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <label htmlFor={`${id}-name`} className="label">
                  Your name <span className="text-ivory-3">(optional)</span>
                </label>
                <input id={`${id}-name`} className="field" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} aria-describedby={described("name")} />
                {errorText("name")}
              </div>
              <div>
                <label htmlFor={`${id}-email`} className="label">
                  Email for our reply
                </label>
                <input
                  id={`${id}-email`}
                  className="field"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={described("email")}
                />
                {errorText("email")}
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-message`} className="label">
                Message
              </label>
              <textarea
                id={`${id}-message`}
                className="field min-h-[12rem] resize-y"
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-invalid={errors.message ? true : undefined}
                aria-describedby={described("message", `${id}-hint ${id}-count`)}
              />
              {errorText("message")}
              <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-1 text-[0.85rem]">
                <p id={`${id}-hint`} className="max-w-[52ch] text-ivory-2">
                  {HINTS[topic]}
                </p>
                <p id={`${id}-count`} className={`tnum shrink-0 ${length > CONTACT_MESSAGE_MAX ? "text-coral" : "text-ivory-3"}`}>
                  {length < CONTACT_MESSAGE_MIN ? `${CONTACT_MESSAGE_MIN - length} more to go` : `${length.toLocaleString("en-US")} / ${CONTACT_MESSAGE_MAX.toLocaleString("en-US")}`}
                </p>
              </div>
            </div>
            {/* Honeypot: hidden from people and screen readers; bots that fill it are ignored. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor={`${id}-website`}>Website</label>
              <input id={`${id}-website`} tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            {failure && (
              <p id={`${id}-failure`} role="alert" className="border-l-2 border-coral pl-3 text-[0.95rem] text-ivory">
                {failure}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <button type="submit" className="btn btn-coral" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Send message"}
              </button>
              <p className="max-w-[44ch] text-[0.85rem] text-ivory-3">
                We use your email only to reply. Messages are kept for up to 24 months. See the{" "}
                <Link href="/privacy" className="text-ivory-2 underline hover:text-ivory">
                  Privacy Policy
                </Link>
                .
              </p>
            </div>
          </div>
        </form>
      )}
      <aside aria-label="Other ways to reach us" className="border-t hairline pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-1">
        <h2 className="font-display text-[1.35rem] font-bold">Before you write</h2>
        <ul className="mt-4 grid gap-4 text-[0.95rem] text-ivory-2">
          <li>
            <span className="text-ivory">Your data.</span> Creators can delete sessions, clips, recordings or all of their data themselves in Studio. Use this form for anything else.
          </li>
          <li>
            <span className="text-ivory">Something on a stream.</span> Streams belong to their creators. For a problem with a Twitch channel itself, report it on Twitch.
          </li>
          {contactEmail ? (
            <li>
              <span className="text-ivory">Email.</span> You can also write to{" "}
              <a href={`mailto:${contactEmail}`} className="text-ivory underline">
                {contactEmail}
              </a>
              .
            </li>
          ) : null}
        </ul>
      </aside>
    </div>
  );
}
