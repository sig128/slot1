import { z } from "zod";

/* ------------------------------------------------------------------------------------------ */
/* Visitor analytics (cookieless) — see docs/ADMIN.md                                          */
/* ------------------------------------------------------------------------------------------ */

/** Viewport width bucket sent by the browser instead of the exact size. */
export const ViewportBucket = z.enum(["s", "m", "l"]);
export type ViewportBucket = z.infer<typeof ViewportBucket>;

/** One page view. `p` is the path only (no query string or hash), `r` the referrer's host name. */
export const AnalyticsCollect = z.object({
  p: z.string().min(1).max(600),
  r: z.string().max(300).optional(),
  b: ViewportBucket.optional(),
});
export type AnalyticsCollect = z.infer<typeof AnalyticsCollect>;

/** Heartbeat while the tab is visible: keeps "on the site now" current. */
export const AnalyticsPing = z.object({ p: z.string().min(1).max(600) });
export type AnalyticsPing = z.infer<typeof AnalyticsPing>;

export const DeviceType = z.enum(["mobile", "tablet", "desktop"]);
export type DeviceType = z.infer<typeof DeviceType>;

export const BrowserFamily = z.enum(["chrome", "safari", "firefox", "edge", "opera", "samsung", "other"]);
export type BrowserFamily = z.infer<typeof BrowserFamily>;

/* ------------------------------------------------------------------------------------------ */
/* Contact form                                                                               */
/* ------------------------------------------------------------------------------------------ */

export const ContactTopic = z.enum(["general", "privacy", "copyright", "business", "support"]);
export type ContactTopic = z.infer<typeof ContactTopic>;

export const CONTACT_TOPIC_TEXT: Record<ContactTopic, string> = {
  general: "General question",
  privacy: "Privacy or my data",
  copyright: "Copyright notice",
  business: "Business or partnership",
  support: "Help with SLOT1",
};

/** Characters as people count them (an emoji is one), which is also how Postgres counts. */
export const codePoints = (s: string) => Array.from(s).length;

export const CONTACT_MESSAGE_MIN = 10;
export const CONTACT_MESSAGE_MAX = 5000;

export const ContactRequest = z.object({
  name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  email: z.string().trim().max(254).pipe(z.email("Enter a valid email address")),
  topic: ContactTopic,
  message: z
    .string()
    .trim()
    .refine((v) => codePoints(v) >= CONTACT_MESSAGE_MIN, `Write at least ${CONTACT_MESSAGE_MIN} characters`)
    .refine((v) => codePoints(v) <= CONTACT_MESSAGE_MAX, `Keep it under ${CONTACT_MESSAGE_MAX} characters`),
  /** Honeypot: hidden from people. Anything typed here means a bot filled the form. */
  website: z.string().max(500).optional(),
});
export type ContactRequest = z.input<typeof ContactRequest>;

export const ContactMessageStatus = z.enum(["open", "closed"]);
export type ContactMessageStatus = z.infer<typeof ContactMessageStatus>;

export const ContactMessageView = z.object({
  id: z.string(),
  createdAt: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  topic: ContactTopic,
  message: z.string(),
  status: ContactMessageStatus,
  closedAt: z.string().nullable(),
});
export type ContactMessageView = z.infer<typeof ContactMessageView>;

export const AdminMessagesResponse = z.object({
  messages: z.array(ContactMessageView),
  counts: z.object({ open: z.number(), closed: z.number() }),
  /** Pass as `before` to load older messages; null when there are no more. */
  nextBefore: z.string().nullable(),
});
export type AdminMessagesResponse = z.infer<typeof AdminMessagesResponse>;

export const AdminMessageUpdate = z.object({ status: ContactMessageStatus });
export type AdminMessageUpdate = z.infer<typeof AdminMessageUpdate>;

/* ------------------------------------------------------------------------------------------ */
/* /admin overview                                                                            */
/* ------------------------------------------------------------------------------------------ */

const Count = z.number().int().nonnegative();

export const AdminLiveStream = z.object({
  sessionId: z.string(),
  login: z.string(),
  displayName: z.string(),
  title: z.string().nullable(),
  /** ingest: video reaches SLOT1. twitch: live on Twitch only (SLOT1 sees platform data). */
  source: z.enum(["ingest", "twitch"]),
  label: z.string().nullable(),
  visibility: z.enum(["public", "private"]),
  analysisState: z.string(),
  startedAt: z.string(),
  framesAnalyzed: Count,
  lastResultAt: z.string().nullable(),
  /** People on this stream's watch page right now. */
  viewers: Count,
});
export type AdminLiveStream = z.infer<typeof AdminLiveStream>;

export const AdminVisitorTotals = z.object({
  views: Count,
  /** Sum of each day's unique visitors (IDs change daily, so a returning visitor counts once per day). */
  visitors: Count,
});
export type AdminVisitorTotals = z.infer<typeof AdminVisitorTotals>;

export const AdminDay = z.object({ day: z.string(), views: Count, visitors: Count });
export type AdminDay = z.infer<typeof AdminDay>;

const Ranked = z.array(z.object({ key: z.string(), views: Count, visitors: Count }));

export const AdminQueue = z.object({
  name: z.string(),
  waiting: Count,
  active: Count,
  delayed: Count,
  failed: Count,
  workers: Count,
});
export type AdminQueue = z.infer<typeof AdminQueue>;

export const AdminHealth = z.object({
  status: z.enum(["ok", "degraded", "down", "off"]),
  detail: z.string(),
});
export type AdminHealth = z.infer<typeof AdminHealth>;

export const AdminUsage = z.object({
  kind: z.enum(["vision", "transcription", "qa"]),
  calls: Count,
  frames: Count,
  inputTokens: Count,
  outputTokens: Count,
  audioSeconds: z.number(),
  /** Null when no price is configured for the provider (VISION_PRICE_* env). */
  estimatedCostUsd: z.number().nullable(),
});
export type AdminUsage = z.infer<typeof AdminUsage>;

export const AdminOverview = z.object({
  generatedAt: z.string(),
  /** How this viewer got in: a Twitch operator account, or a one-time admin link. */
  access: z.enum(["operator", "admin_link"]),
  analyticsEnabled: z.boolean(),
  now: z.object({
    online: Count,
    /** Window used for "on the site now", in seconds. */
    windowSec: Count,
    byPath: z.array(z.object({ path: z.string(), visitors: Count })),
    live: z.array(AdminLiveStream),
  }),
  visitors: z.object({
    today: AdminVisitorTotals,
    last7: AdminVisitorTotals,
    last30: AdminVisitorTotals,
    allTimeViews: Count,
    /** First day with any data, or null when nothing was counted yet. */
    since: z.string().nullable(),
    days: z.array(AdminDay),
    range: z.object({
      days: z.union([z.literal(7), z.literal(30)]),
      pages: Ranked,
      referrers: Ranked,
      devices: Ranked,
      browsers: Ranked,
    }),
  }),
  platform: z.object({
    users: z.object({ total: Count, new7: Count, operators: Count }),
    creators: z.object({ total: Count, connected: Count }),
    botChannels: Count,
    botLinked: z.boolean(),
    liveSources: z.object({ total: Count, publishing: Count }),
    sessions: z.object({ total: Count, today: Count, liveNow: Count }),
    observations24h: Count,
    clips: Count,
    library: z.object({ total: Count, recordings: Count, renders: Count, screenshots: Count }),
    storage: z.object({ trackedBytes: Count, files: Count }),
    relay: z.object({ total: Count, enabled: Count, live: Count }),
  }),
  ai: z.object({
    vision: z.object({ available: z.boolean(), provider: z.string().nullable(), model: z.string().nullable(), reason: z.string().nullable() }),
    transcription: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    ocr: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    usage24h: z.array(AdminUsage),
    usage30d: z.array(AdminUsage),
    models: z.array(z.object({ task: z.string(), name: z.string(), version: z.string(), activatedAt: z.string().nullable() })),
    candidateModels: Count,
  }),
  system: z.object({
    version: z.string().nullable(),
    node: z.string(),
    apiUptimeSec: Count,
    database: z.object({ ok: z.boolean(), version: z.string().nullable(), sizeBytes: Count.nullable() }),
    redis: z.object({ ok: z.boolean(), usedMemoryBytes: Count.nullable() }),
    disk: z.object({ driver: z.string(), freeBytes: Count.nullable(), totalBytes: Count.nullable() }),
    queues: z.array(AdminQueue),
    worker: AdminHealth,
    inference: AdminHealth,
    gateway: AdminHealth,
    failedJobs24h: Count,
    recentFailures: z.array(z.object({ at: z.string(), where: z.string(), message: z.string() })),
  }),
  messages: z.object({ open: Count, total: Count }),
});
export type AdminOverview = z.infer<typeof AdminOverview>;
