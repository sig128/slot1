/**
 * The site's navigation, shared by the desktop tab row and the phone menu so the two never drift.
 * `hint` is the one line the phone menu shows under each name: what the page is, in plain words.
 */
export interface NavItem {
  href: string;
  label: string;
  hint: string;
  match: (pathname: string) => boolean;
}

export const PRIMARY_NAV: NavItem[] = [
  {
    href: "/",
    label: "On Air",
    hint: "Live channels and what SLOT1 logs",
    match: (p) => p === "/" || p.startsWith("/watch") || p.startsWith("/replay"),
  },
  { href: "/los-santos", label: "Right now", hint: "Every public GTA stream, live", match: (p) => p.startsWith("/los-santos") },
  { href: "/moments", label: "Moments", hint: "Search saved moments and clips", match: (p) => p.startsWith("/moments") },
  { href: "/studio", label: "Studio", hint: "Your stream, chat bot and clips", match: (p) => p.startsWith("/studio") },
  { href: "/setup", label: "Setup", hint: "How SLOT1 works with your stream", match: (p) => p.startsWith("/setup") },
];

/** The smaller links at the foot of the phone menu (the page footer carries them too). */
export const MORE_NAV: { href: string; label: string }[] = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
];

/** Where the tab row takes over from the menu (Tailwind's `md`): the row needs about 680 px. */
export const WIDE_QUERY = "(min-width: 768px)";
