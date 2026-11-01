/**
 * Loading-screen tips that teach SLOT1 for real. Each one describes something this build does;
 * keep them true when features change. They take turns (CSS only, intro.css assumes exactly
 * seven); with reduced motion the first one stays. All of them are in the DOM, so screen
 * readers get the whole list.
 */
export const INTRO_TIPS = [
  "Type !slot1 clip in chat and SLOT1 posts the link once Twitch confirms the clip.",
  "Missed it? Instant replay jumps back to the moment while the stream is still live.",
  "Ask SLOT1 what happened. Every answer links to the frames it came from.",
  "Right now puts every public SLOT1 stream on one radio wheel.",
  "Stream once from OBS. SLOT1 can pass it on to Twitch, YouTube and Kick.",
  "When SLOT1 hasn’t seen something, it says so instead of guessing.",
  "Type !slot1 recap in chat for what SLOT1 saw in the last 10 minutes.",
] as const;

export function IntroTips() {
  return (
    <aside className="gx-tips gx-in" aria-label="Tips">
      <span className="gx-load" aria-hidden>
        <span className="gx-load-fill" />
      </span>
      <ul className="gx-tip-list">
        {INTRO_TIPS.map((t, i) => (
          <li key={i} className="gx-tip" style={{ ["--i" as string]: i }}>
            <b className="gx-tip-label">Tip:</b> {t}
          </li>
        ))}
      </ul>
    </aside>
  );
}
