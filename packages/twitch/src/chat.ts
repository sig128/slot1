import type { BotCommandName } from "@slot1/contracts";

export interface ParsedCommand {
  command: BotCommandName;
  args: string;
  /** Present when the user typed an unknown subcommand. */
  unknown: string | null;
  viaAlias: boolean;
}

const SUBCOMMANDS: ReadonlySet<string> = new Set(["help", "status", "now", "recap", "clip", "find", "ask", "pause", "resume", "mute", "unmute", "record", "autoclip", "relay"]);
/** Short aliases are opt-in per channel to avoid clashing with other bots. */
const ALIASES: Record<string, BotCommandName> = { "!clip": "clip", "!recap": "recap" };

export function parseChatCommand(text: string, opts: { aliasesEnabled: boolean }): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const lower = (head ?? "").toLowerCase();
  if (lower === "!slot1") {
    const sub = (rest[0] ?? "help").toLowerCase();
    const args = rest.slice(1).join(" ").trim().slice(0, 300);
    if (SUBCOMMANDS.has(sub)) return { command: sub as BotCommandName, args, unknown: null, viaAlias: false };
    return { command: "help", args: "", unknown: sub.slice(0, 20), viaAlias: false };
  }
  if (opts.aliasesEnabled && ALIASES[lower]) {
    return { command: ALIASES[lower]!, args: rest.join(" ").trim().slice(0, 300), unknown: null, viaAlias: true };
  }
  return null;
}

/**
 * Make a reply safe to post: single line, max 500 chars, and never starting with characters that
 * chat clients treat as commands.
 */
export function sanitizeReply(text: string): string {
  let t = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[/.\\]+/, "");
  if (t.length > 500) t = `${t.slice(0, 497)}…`;
  return t;
}

export interface ChatterBadges {
  isBroadcaster: boolean;
  isModerator: boolean;
  isVip: boolean;
  isSubscriber: boolean;
}

export function readBadges(badges: { set_id: string }[], chatterId: string, broadcasterId: string): ChatterBadges {
  const set = new Set(badges.map((b) => b.set_id));
  return {
    isBroadcaster: chatterId === broadcasterId || set.has("broadcaster"),
    isModerator: set.has("moderator"),
    isVip: set.has("vip"),
    isSubscriber: set.has("subscriber") || set.has("founder"),
  };
}
