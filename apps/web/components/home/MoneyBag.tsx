import "./money-bag.css";

/**
 * SLOT1's own money bag, drawn in the intro's ink-outline poster style (no emoji, no game
 * asset). It hops and a coin glints every few seconds; it's still under reduced motion and,
 * inside the hero, pauses off screen like the rest of the scene ([data-paused] in skyline.css).
 */
export function MoneyBag({ className = "" }: { className?: string }) {
  return (
    <svg className={`mb-bag ${className}`} viewBox="0 0 48 48" aria-hidden focusable="false">
      <g className="mb-hop">
        {/* the sack */}
        <path
          d="M18.5 17.5C10 21.5 6.2 30 8 37c1.6 5.6 8 8 16 8s14.4-2.4 16-8c1.8-7-2-15.5-10.5-19.5Z"
          fill="#ffc94d"
          stroke="#140715"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path d="M32.6 20.4c4.6 3.6 6.6 9.8 5.6 15.6-.9 4.6-4.4 7.2-9.6 8.2 3.6-3.4 5.6-8.4 5.4-14.4-.1-3.6-.6-6.8-1.4-9.4Z" fill="#e2a531" />
        <path d="M13.2 26.4c-1.2 2.6-1.6 5.2-1.2 7.6" fill="none" stroke="#fff2c2" strokeWidth="2" strokeLinecap="round" />
        {/* the gathered top and the coral tie */}
        <path
          d="M19.4 16.4c-3-3.6-4-7.6-2.4-10.2 2.2 1.8 4.4 2.6 7 2 2.6.6 4.8-.2 7-2 1.6 2.6.6 6.6-2.4 10.2Z"
          fill="#ffc94d"
          stroke="#140715"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <rect x="16.4" y="14.6" width="15.2" height="4.4" rx="2.2" fill="#ff4f87" stroke="#140715" strokeWidth="2.2" />
        {/* the $ */}
        <path
          d="M28.4 26.8c-1-1.4-2.6-2-4.4-2-2.5 0-4.2 1.3-4.2 3.1 0 4.3 8.8 2.6 8.8 7.3 0 1.9-1.9 3.2-4.6 3.2-2.1 0-3.9-.8-5-2.2"
          fill="none"
          stroke="#140715"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M24 22.4v18.2" stroke="#140715" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      {/* a coin at its foot, and the glint */}
      <circle cx="39.6" cy="40.4" r="5.4" fill="#ffc94d" stroke="#140715" strokeWidth="2.2" />
      <circle cx="39.6" cy="40.4" r="2.6" fill="none" stroke="#e2a531" strokeWidth="1.4" />
      <path className="mb-glint" d="M43.2 29.6l1 3.1 3.1 1-3.1 1-1 3.1-1-3.1-3.1-1 3.1-1Z" fill="#fffaf0" />
    </svg>
  );
}
