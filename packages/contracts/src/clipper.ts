import { z } from "zod";
import type { Observation } from "./observation";

/* ------------------------------------------------------------------------------------------ */
/* Big moments (shared by the live banner and auto clips)                                     */
/* ------------------------------------------------------------------------------------------ */

const BIG = /\b(MISSION PASSED|MISSION FAILED|MISSION COMPLETE|WASTED|BUSTED)\b/i;
const BAD = /FAILED|WASTED|BUSTED/i;

/** A result message SLOT1 actually read on screen ("MISSION PASSED", "WASTED"…), or null. */
export function bigMoment(o: Pick<Observation, "rawText" | "type" | "description">): { text: string; tone: "good" | "bad" } | null {
  const source = o.rawText ?? (o.type === "result_screen" ? o.description : null);
  const m = source?.match(BIG);
  if (!m) return null;
  const text = m[1]!.toUpperCase();
  return { text, tone: BAD.test(text) ? "bad" : "good" };
}

/* ------------------------------------------------------------------------------------------ */
/* Edit decision list                                                                         */
/* ------------------------------------------------------------------------------------------ */

export const EdlAspect = z.enum(["9:16", "16:9", "1:1"]);
export type EdlAspect = z.infer<typeof EdlAspect>;

/** Output presets. Vertical for TikTok/Shorts/Reels, widescreen for YouTube, square for feeds. */
export const ASPECT_SIZE: Record<EdlAspect, { width: number; height: number; label: string }> = {
  "9:16": { width: 1080, height: 1920, label: "Vertical 1080×1920" },
  "16:9": { width: 1920, height: 1080, label: "Widescreen 1920×1080" },
  "1:1": { width: 1080, height: 1080, label: "Square 1080×1080" },
};

export const EDL_SPEEDS = [0.5, 1, 1.5, 2] as const;
export const EDL_MAX_MS = 10 * 60_000;

export const EdlSegment = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    sessionId: z.string().uuid(),
    /**
     * Set only for live auto clips cut before the recording is finalized: times are then in that
     * reader run's timeline. Finalizing a recording rewrites such segments onto the file timeline.
     */
    runId: z.string().regex(/^[a-z0-9]{4,24}$/).nullable().default(null),
    inMs: z.number().int().min(0),
    outMs: z.number().int().min(1),
    speed: z.union([z.literal(0.5), z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
    /** Crop centre (0..1) and zoom (1 = the largest crop of the target aspect). */
    reframe: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(1).max(4) }).default({ x: 0.5, y: 0.5, zoom: 1 }),
  })
  .refine((s) => s.outMs - s.inMs >= 300, { message: "A segment must be at least 0.3 s long", path: ["outMs"] })
  .refine((s) => s.outMs - s.inMs <= 5 * 60_000, { message: "A segment can be at most 5 minutes long", path: ["outMs"] });
export type EdlSegment = z.infer<typeof EdlSegment>;

export const EdlTextStyle = z.enum(["poster", "banner", "caption"]);
export const EdlText = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    text: z.string().trim().min(1).max(90),
    /** Output-timeline times (after cuts and speed changes). */
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    position: z.enum(["top", "center", "bottom"]).default("top"),
    style: EdlTextStyle.default("poster"),
  })
  .refine((t) => t.endMs > t.startMs, { message: "Text must end after it starts", path: ["endMs"] });
export type EdlText = z.infer<typeof EdlText>;

export const Edl = z
  .object({
    version: z.literal(1),
    aspect: EdlAspect,
    /** crop = fill the frame (reframe applies); fit = whole frame over a blurred backdrop. */
    layout: z.enum(["crop", "fit"]).default("crop"),
    segments: z.array(EdlSegment).min(1).max(20),
    texts: z.array(EdlText).max(20).default([]),
    /** Burn in transcript lines when the sessions have transcripts. */
    captions: z.boolean().default(false),
    fadeInMs: z.number().int().min(0).max(5000).default(0),
    fadeOutMs: z.number().int().min(0).max(5000).default(0),
    volume: z.number().min(0).max(2).default(1),
    /** Output-timeline time of the cover (poster) frame. */
    coverMs: z.number().int().min(0).nullable().default(null),
  })
  .superRefine((e, ctx) => {
    const total = edlDurationMs(e);
    if (total > EDL_MAX_MS) ctx.addIssue({ code: "custom", message: "An edit can be at most 10 minutes long", path: ["segments"] });
    e.texts.forEach((t, i) => {
      if (t.startMs >= total) ctx.addIssue({ code: "custom", message: "Text starts after the edit ends", path: ["texts", i, "startMs"] });
    });
    if (e.fadeInMs + e.fadeOutMs > total) ctx.addIssue({ code: "custom", message: "Fades are longer than the edit", path: ["fadeOutMs"] });
    if (e.coverMs !== null && e.coverMs > total) ctx.addIssue({ code: "custom", message: "Cover frame is after the end", path: ["coverMs"] });
    const ids = new Set<string>();
    for (const s of e.segments) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: "Segment ids must be unique", path: ["segments"] });
      ids.add(s.id);
    }
  });
export type Edl = z.infer<typeof Edl>;

/** Output duration: each segment shortened or lengthened by its speed. */
export function edlDurationMs(e: { segments: { inMs: number; outMs: number; speed?: number }[] }): number {
  return Math.round(e.segments.reduce((sum, s) => sum + (s.outMs - s.inMs) / (s.speed ?? 1), 0));
}

/** Map a source time inside segment `index` to the output timeline. */
export function edlOutputTime(e: { segments: { inMs: number; outMs: number; speed?: number }[] }, index: number, sourceMs: number): number {
  let t = 0;
  for (let i = 0; i < index; i++) t += (e.segments[i]!.outMs - e.segments[i]!.inMs) / (e.segments[i]!.speed ?? 1);
  const s = e.segments[index]!;
  return Math.round(t + (Math.min(Math.max(sourceMs, s.inMs), s.outMs) - s.inMs) / (s.speed ?? 1));
}

/* ------------------------------------------------------------------------------------------ */
/* Library, recordings, profiles                                                              */
/* ------------------------------------------------------------------------------------------ */

export const LibraryItemKind = z.enum(["recording", "render", "screenshot", "twitch_clip", "clip_export"]);
export type LibraryItemKind = z.infer<typeof LibraryItemKind>;

/** private: owner only. unlisted: anyone with the link. public: listed on the profile. */
export const LibraryVisibility = z.enum(["private", "unlisted", "public"]);
export type LibraryVisibility = z.infer<typeof LibraryVisibility>;

export const LibraryItemView = z.object({
  id: z.string(),
  kind: LibraryItemKind,
  title: z.string(),
  visibility: LibraryVisibility,
  featured: z.boolean(),
  status: z.enum(["processing", "ready", "failed"]),
  error: z.string().nullable(),
  progress: z.number().nullable(),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
  recordingId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** A render SLOT1 cut on its own around a big moment (auto clips). */
  auto: z.boolean(),
  mediaMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  bytes: z.number().nullable(),
  /** Short-lived signed URLs, only for viewers allowed to see the item. */
  url: z.string().nullable(),
  posterUrl: z.string().nullable(),
  externalUrl: z.string().nullable(),
  /** Where the item opens on SLOT1. */
  viewPath: z.string(),
  canEdit: z.boolean(),
});
export type LibraryItemView = z.infer<typeof LibraryItemView>;

export const StorageUsage = z.object({ recordings: z.number(), library: z.number(), uploads: z.number(), analysis: z.number(), total: z.number() });
export type StorageUsage = z.infer<typeof StorageUsage>;

export const LibraryResponse = z.object({ items: z.array(LibraryItemView), usage: StorageUsage });
export type LibraryResponse = z.infer<typeof LibraryResponse>;

export const LibraryItemPatch = z
  .object({ title: z.string().trim().min(1).max(120), visibility: LibraryVisibility, featured: z.boolean() })
  .partial()
  .strict();
export type LibraryItemPatch = z.infer<typeof LibraryItemPatch>;

export const ScreenshotInput = z.discriminatedUnion("from", [
  /** A frame of the stored replay or recording at this media time, at full resolution. */
  z.object({ from: z.literal("media"), sessionId: z.string().uuid(), atMs: z.number().int().min(0), title: z.string().trim().min(1).max(120).optional() }),
  /** The latest frame received from a live ingest source. */
  z.object({ from: z.literal("live"), sessionId: z.string().uuid(), title: z.string().trim().min(1).max(120).optional() }),
  /** An evidence frame SLOT1 stored for an observation. */
  z.object({ from: z.literal("evidence"), observationId: z.string().uuid(), assetId: z.string().uuid().optional(), title: z.string().trim().min(1).max(120).optional() }),
]);
export type ScreenshotInput = z.infer<typeof ScreenshotInput>;

export const CreateProjectInput = z.object({
  sessionId: z.string().uuid(),
  inMs: z.number().int().min(0),
  outMs: z.number().int().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  aspect: EdlAspect.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ProjectSourceView = z.object({
  sessionId: z.string(),
  title: z.string(),
  playbackUrl: z.string().nullable(),
  posterUrl: z.string().nullable(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** AI moments to jump to, in this media's timeline. */
  markers: z.array(z.object({ ms: z.number(), label: z.string(), kind: z.enum(["big", "event", "text"]) })),
  /** Transcript lines (media timeline), for burned-in captions. */
  captionLines: z.number(),
});
export type ProjectSourceView = z.infer<typeof ProjectSourceView>;

export const ProjectView = z.object({
  id: z.string(),
  title: z.string(),
  origin: z.enum(["manual", "auto"]),
  edl: Edl,
  updatedAt: z.string(),
  sources: z.array(ProjectSourceView),
  renders: z.array(LibraryItemView),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectPatch = z.object({ title: z.string().trim().min(1).max(120).optional(), edl: Edl.optional() }).strict();
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const ProfileResponse = z.object({
  channel: z.object({ login: z.string(), displayName: z.string(), avatarUrl: z.string().nullable(), twitchUrl: z.string().nullable() }),
  live: z.object({ watchPath: z.string(), title: z.string().nullable() }).nullable(),
  /** The owner previews their own profile even while the channel is private. */
  viewer: z.object({ isOwner: z.boolean(), channelPublic: z.boolean() }),
  featured: z.array(LibraryItemView),
  clips: z.array(LibraryItemView),
  recordings: z.array(LibraryItemView),
  screenshots: z.array(LibraryItemView),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;
