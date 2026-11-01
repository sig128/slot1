import type { SignInNotice } from "@/lib/signin-notice";
import { twitchSignInHref } from "@/lib/signin-notice";

const BAR: Record<SignInNotice["tone"], string> = {
  ok: "border-apricot",
  warn: "border-gold",
  error: "border-coral",
};

/** The result of "Sign in with Twitch", right where the person lands. */
export function SignInNoticeBox({ notice, showRetry = true }: { notice: SignInNotice; showRetry?: boolean }) {
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      data-testid="signin-notice"
      data-tone={notice.tone}
      className={`max-w-[68ch] border-l-4 bg-graphite-800/80 py-3 pl-4 pr-5 ${BAR[notice.tone]}`}
    >
      <p className="font-display text-xl font-bold leading-tight text-ivory">{notice.title}</p>
      {notice.body && <p className="mt-1 text-ivory-2">{notice.body}</p>}
      {notice.owner && <p className="mt-2 text-sm text-ivory-3">{notice.owner}</p>}
      {showRetry && notice.retry && (
        <a href={twitchSignInHref()} className="btn btn-coral btn-sm mt-3">
          Sign in with Twitch again
        </a>
      )}
    </div>
  );
}
