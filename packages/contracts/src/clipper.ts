import { z } from "zod";
import type { Observation } from "./observation";
import { StudioAsset } from "./studio-assets";

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
/* Edit decision list: a multi-track edit                                                     */
/* ------------------------------------------------------------------------------------------ */
/*
 * One self-describing schema for every edit, from the first auto clip to a full multi-track
 * project. Older edits (segments + texts only) still parse unchanged and render the same: every
 * field added since has a default that means "not used".
 *
 *   main video track   `segments`: clips played back to back, each with its own transition in
 *   overlay tracks     `overlays`: text, images and picture-in-picture placed freely in time
 *   audio tracks       `audioTracks`: music, sound effects and voice clips placed freely in time
 *   whole edit         layout, grade, effects, captions, source-audio processing, master
 *
 * Output-timeline times ("startMs" on overlays, audio clips, effects, captions) are measured on
 * the finished edit: after cuts, speed changes and transition overlaps.
 */

export const EdlAspect = z.enum(["9:16", "16:9", "1:1"]).describe("Output frame shape: 9:16 vertical (TikTok, Shorts, Reels), 16:9 widescreen (YouTube), 1:1 square.");
export type EdlAspect = z.infer<typeof EdlAspect>;

/** Output presets. Vertical for TikTok/Shorts/Reels, widescreen for YouTube, square for feeds. */
export const ASPECT_SIZE: Record<EdlAspect, { width: number; height: number; label: string }> = {
  "9:16": { width: 1080, height: 1920, label: "Vertical 1080×1920" },
  "16:9": { width: 1920, height: 1080, label: "Widescreen 1920×1080" },
  "1:1": { width: 1080, height: 1080, label: "Square 1080×1080" },
};

/** Speeds the editor offers; any value from 0.25× to 4× is valid. */
export const EDL_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const EDL_MAX_MS = 10 * 60_000;
/** A speed ramp is rendered as this many short steps of constant speed. */
export const RAMP_STEPS = 8;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe("Stable id, unique within its list (letters, digits, - and _).");
const Unit = z.number().min(0).max(1);
const OutMs = z.number().int().min(0);

/** A rectangle in fractions of a picture (0..1 from the top-left corner). */
export const EdlBox = z
  .object({ x: Unit, y: Unit, w: z.number().min(0.02).max(1), h: z.number().min(0.02).max(1) })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, { message: "The box has to stay inside the picture" })
  .describe("A rectangle in fractions of the picture: x, y from the top-left corner, w, h its size.");
export type EdlBox = z.infer<typeof EdlBox>;

export const ReframeKey = z
  .object({
    atMs: z.number().int().min(0).describe("Source-media time of this keyframe, inside its segment."),
    x: Unit.describe("Crop centre left to right (0..1)."),
    y: Unit.describe("Crop centre top to bottom (0..1)."),
    zoom: z.number().min(1).max(4).describe("1 = the largest crop of the output shape; up to 4×."),
  })
  .describe("Keyframed reframe: where the crop sits and how far it zooms at one moment; motion between keys is smooth.");
export type ReframeKey = z.infer<typeof ReframeKey>;

export const TransitionKind = z.enum(["cut", "crossfade", "flash", "dip", "whip", "glitch"]).describe("cut: hard cut. crossfade: blend. flash: through white. dip: through black. whip: fast smear. glitch: pixel break-up.");
export type TransitionKind = z.infer<typeof TransitionKind>;

export const EdlTransition = z
  .object({
    kind: TransitionKind.default("cut"),
    durationMs: z.number().int().min(0).max(2000).default(0).describe("Overlap with the previous segment. Ignored for cuts."),
  })
  .describe("How a segment starts after the previous one; the two overlap for the duration.");
export type EdlTransition = z.infer<typeof EdlTransition>;

export const EdlSegment = z
  .object({
    id: Id,
    sessionId: z.string().uuid().describe("Session whose stored video this segment plays."),
    /**
     * Set only for live auto clips cut before the recording is finalized: times are then in that
     * reader run's timeline. Finalizing a recording rewrites such segments onto the file timeline.
     */
    runId: z.string().regex(/^[a-z0-9]{4,24}$/).nullable().default(null).describe("Live reader run, for clips cut before a recording is finalized."),
    inMs: z.number().int().min(0).describe("Source time where the segment starts."),
    outMs: z.number().int().min(1).describe("Source time where the segment ends."),
    speed: z.number().min(0.25).max(4).default(1).describe("Playback speed, 0.25× (slow motion) to 4×."),
    rampTo: z.number().min(0.25).max(4).nullable().default(null).describe("Speed ramp: speed changes smoothly from `speed` at the in-point to this at the out-point."),
    /** Crop centre (0..1) and zoom (1 = the largest crop of the target aspect). */
    reframe: z
      .object({ x: Unit, y: Unit, zoom: z.number().min(1).max(4) })
      .default({ x: 0.5, y: 0.5, zoom: 1 })
      .describe("Static crop centre and zoom (used when there are no keyframes)."),
    keys: z.array(ReframeKey).max(16).default([]).describe("Keyframed pan and zoom; overrides `reframe` when present."),
    volume: z.number().min(0).max(2).default(1).describe("This segment's source-audio volume (1 = 100%)."),
    transitionIn: EdlTransition.default({ kind: "cut", durationMs: 0 }).describe("Transition from the previous segment. Ignored on the first."),
  })
  .refine((s) => s.outMs - s.inMs >= 300, { message: "A segment must be at least 0.3 s long", path: ["outMs"] })
  .refine((s) => s.outMs - s.inMs <= 5 * 60_000, { message: "A segment can be at most 5 minutes long", path: ["outMs"] })
  .refine((s) => s.keys.every((k) => k.atMs >= s.inMs && k.atMs <= s.outMs), { message: "Keyframes must sit inside their segment", path: ["keys"] })
  .describe("One clip on the main video track.");
export type EdlSegment = z.infer<typeof EdlSegment>;

/** Legacy text overlay (drawn with drawtext; kept so older edits render exactly as before). */
export const EdlTextStyle = z.enum(["poster", "banner", "caption"]);
export const EdlText = z
  .object({
    id: Id,
    text: z.string().trim().min(1).max(90),
    /** Output-timeline times (after cuts and speed changes). */
    startMs: OutMs,
    endMs: z.number().int().min(1),
    position: z.enum(["top", "center", "bottom"]).default("top"),
    style: EdlTextStyle.default("poster"),
  })
  .refine((t) => t.endMs > t.startMs, { message: "Text must end after it starts", path: ["endMs"] })
  .describe("Simple text overlay (older format). New text goes on an overlay track.");
export type EdlText = z.infer<typeof EdlText>;

/* -------------------------------- media references ----------------------------------------- */

/** A file the edit uses: an item from SLOT1's Studio library, or something the creator uploaded. */
export const MediaRef = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("library"), assetId: StudioAsset.shape.id.describe("A Studio library item (sound, music, sticker, overlay, frame, transition).") }),
    z.object({ kind: z.literal("upload"), assetId: z.string().uuid().describe("A file the creator uploaded to this edit (music, voice-over, logo).") }),
  ])
  .describe("Where an overlay's image or an audio clip's sound comes from.");
export type MediaRef = z.infer<typeof MediaRef>;

/* ---------------------------------- overlay tracks ----------------------------------------- */

export const OverlayKey = z
  .object({
    atMs: OutMs.describe("Output-timeline time of this keyframe."),
    x: Unit.describe("Centre left to right (0..1)."),
    y: Unit.describe("Centre top to bottom (0..1)."),
    scale: z.number().min(0.1).max(4).describe("Size multiplier."),
    rotation: z.number().min(-180).max(180).describe("Degrees, clockwise."),
    opacity: Unit,
  })
  .describe("Overlay keyframe: position, scale, rotation and opacity at one moment; values glide between keys.");
export type OverlayKey = z.infer<typeof OverlayKey>;

export const OverlayTextStyle = z
  .enum(["poster", "banner", "caption", "mission", "wasted", "lower-third", "title-card"])
  .describe("poster: big gold. banner: coral bar. caption: subtitle box. mission: gold mission-result title. wasted: pale red result title. lower-third: name bar. title-card: big title with a sub-line.");
export type OverlayTextStyle = z.infer<typeof OverlayTextStyle>;

export const TextAnimation = z.enum(["none", "fade", "pop", "slide", "typewriter"]).describe("How text arrives: fade in, pop (scale bounce), slide in from the left, or typewriter.");
export type TextAnimation = z.infer<typeof TextAnimation>;

const overlayBase = {
  id: Id,
  startMs: OutMs.describe("Output-timeline time the item appears."),
  endMs: z.number().int().min(1).describe("Output-timeline time the item disappears."),
  x: Unit.default(0.5).describe("Centre left to right (0..1)."),
  y: Unit.default(0.5).describe("Centre top to bottom (0..1)."),
  scale: z.number().min(0.1).max(4).default(1),
  rotation: z.number().min(-180).max(180).default(0),
  opacity: Unit.default(1),
  keys: z.array(OverlayKey).max(16).default([]).describe("Keyframes; when present they override x, y, scale, rotation and opacity over time."),
};

export const OverlayText = z
  .object({
    type: z.literal("text"),
    ...overlayBase,
    text: z.string().trim().min(1).max(160),
    subtext: z.string().trim().max(120).default("").describe("Second line (title cards, lower thirds, mission titles)."),
    style: OverlayTextStyle.default("poster"),
    animation: TextAnimation.default("pop"),
  })
  .describe("Text on an overlay track.");
export const OverlayImage = z
  .object({
    type: z.literal("image"),
    ...overlayBase,
    source: MediaRef.describe("A library sticker, overlay, frame or transition, or an uploaded image."),
    widthPct: z.number().min(0.03).max(1).default(0.3).describe("Width as a fraction of the frame width, before `scale` (1 = full width, for frames)."),
  })
  .describe("A visual element (sticker, logo, overlay, frame) on an overlay track; animated library items play and loop.");
export const OverlayPip = z
  .object({
    type: z.literal("pip"),
    ...overlayBase,
    sessionId: z.string().uuid().describe("Session whose stored video the picture-in-picture plays."),
    sourceInMs: z.number().int().min(0).describe("Source time the picture-in-picture starts from."),
    box: EdlBox.default({ x: 0, y: 0, w: 1, h: 1 }).describe("Part of the source picture to show (e.g. the facecam)."),
    widthPct: z.number().min(0.1).max(1).default(0.35).describe("Width as a fraction of the frame width, before `scale`."),
    border: z.boolean().default(true).describe("Draw an ink border around it."),
  })
  .describe("Picture-in-picture: another moment, or part of the picture, in a small window.");
export const OverlayItem = z.discriminatedUnion("type", [OverlayText, OverlayImage, OverlayPip]).describe("One item on an overlay track.");
export type OverlayItem = z.infer<typeof OverlayItem>;
export type OverlayTextItem = z.infer<typeof OverlayText>;
export type OverlayImageItem = z.infer<typeof OverlayImage>;
export type OverlayPipItem = z.infer<typeof OverlayPip>;

export const OverlayTrack = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(40).default("Overlay"),
    hidden: z.boolean().default(false).describe("Hidden tracks are left out of the preview and the render."),
    locked: z.boolean().default(false).describe("Locked tracks can't be edited by hand."),
    items: z.array(OverlayItem).max(40).default([]),
  })
  .describe("A track of overlays. Higher tracks in the list draw on top.");
export type OverlayTrack = z.infer<typeof OverlayTrack>;

/* ----------------------------------- audio tracks ------------------------------------------ */

export const VolumeKey = z.object({ atMs: OutMs.describe("Output-timeline time."), volume: z.number().min(0).max(2) }).describe("Volume envelope point; the volume glides between points.");
export type VolumeKey = z.infer<typeof VolumeKey>;

export const AudioClip = z
  .object({
    id: Id,
    source: MediaRef.describe("A library sound, music bed or ambience, or an uploaded audio file."),
    startMs: OutMs.describe("Output-timeline time the clip starts."),
    offsetMs: z.number().int().min(0).default(0).describe("Where in the audio file the clip starts."),
    durationMs: z.number().int().min(50).max(EDL_MAX_MS).describe("How long the clip plays."),
    volume: z.number().min(0).max(2).default(1),
    fadeInMs: z.number().int().min(0).max(10_000).default(0),
    fadeOutMs: z.number().int().min(0).max(10_000).default(0),
    loop: z.boolean().default(false).describe("Repeat the file to fill the clip (music beds)."),
    envelope: z.array(VolumeKey).max(24).default([]).describe("Keyframed volume, multiplied with `volume`."),
  })
  .describe("One clip on an audio track.");
export type AudioClip = z.infer<typeof AudioClip>;

export const AudioTrack = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(40).default("Audio"),
    kind: z.enum(["music", "sfx", "voice"]).default("sfx"),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false).describe("When any track is soloed, only soloed tracks are heard."),
    locked: z.boolean().default(false),
    volume: z.number().min(0).max(2).default(1),
    duck: z
      .boolean()
      .default(false)
      .describe("Lower this track while the source audio has voice-band sound. The source is one mixed stream, so loud game sound in that band ducks it too."),
    clips: z.array(AudioClip).max(60).default([]),
  })
  .describe("An audio track (music, sound effects or voice).");
export type AudioTrack = z.infer<typeof AudioTrack>;

/* ------------------------------------ whole-edit looks ------------------------------------- */

export const GradePreset = z
  .enum(["none", "vice-night", "golden-hour", "noir", "neon", "bleach"])
  .describe("Original colour grades: vice-night (cool magenta night), golden-hour (warm sunset), noir (black and white), neon (punchy), bleach (washed, high contrast).");
export type GradePreset = z.infer<typeof GradePreset>;

export const EdlGrade = z
  .object({
    preset: GradePreset.default("none"),
    brightness: z.number().min(-0.5).max(0.5).default(0),
    contrast: z.number().min(0.5).max(1.8).default(1),
    saturation: z.number().min(0).max(2.5).default(1),
    vignette: Unit.default(0).describe("Darkened corners, 0 = off."),
    grain: Unit.default(0).describe("Film grain, 0 = off."),
  })
  .describe("Colour and look for the whole edit (under overlays and text).");
export type EdlGrade = z.infer<typeof EdlGrade>;

export const EffectKind = z
  .enum(["wasted", "passed", "punch", "shake", "flash", "glitch"])
  .describe("wasted: freeze, desaturate, darken and a result banner. passed: gold mission banner with a flash. punch: zoom in. shake: camera shake. flash: white flash. glitch: RGB split.");
export type EffectKind = z.infer<typeof EffectKind>;

export const EdlEffect = z
  .object({
    id: Id,
    kind: EffectKind,
    startMs: OutMs,
    endMs: z.number().int().min(1),
    text: z.string().trim().max(60).default("").describe("Banner text for wasted and passed (empty: WASTED / MISSION PASSED)."),
    amount: Unit.default(0.5).describe("Strength: punch zoom, shake size, glitch offset."),
  })
  .refine((f) => f.endMs > f.startMs, { message: "An effect must end after it starts", path: ["endMs"] })
  .describe("An effect over a stretch of the finished edit.");
export type EdlEffect = z.infer<typeof EdlEffect>;

/* ------------------------------------------ captions --------------------------------------- */

export const CaptionWord = z.object({ text: z.string().min(1).max(40), startMs: OutMs, endMs: z.number().int().min(1) });
export const CaptionCue = z
  .object({
    id: Id,
    startMs: OutMs,
    endMs: z.number().int().min(1),
    text: z.string().trim().min(1).max(200),
    words: z.array(CaptionWord).max(60).default([]).describe("Word timings for the highlight. Empty: words are spread evenly over the cue."),
  })
  .refine((c) => c.endMs > c.startMs, { message: "A caption must end after it starts", path: ["endMs"] });
export type CaptionCue = z.infer<typeof CaptionCue>;

export const EdlCaptionTrack = z
  .object({
    style: z.enum(["karaoke", "line", "bold-pop"]).default("karaoke").describe("karaoke: each word lights up gold as it's said. line: plain subtitle. bold-pop: big words that pop in."),
    position: z.enum(["top", "center", "bottom"]).default("bottom"),
    hidden: z.boolean().default(false),
    cues: z.array(CaptionCue).max(400).default([]),
  })
  .describe("Caption track on the finished edit's timeline.");
export type EdlCaptionTrack = z.infer<typeof EdlCaptionTrack>;

/* -------------------------------------------- the edit ------------------------------------- */

export const EdlLayout = z.enum(["crop", "fit", "split"]).describe("crop: fill the frame (reframe applies). fit: whole frame over a blurred backdrop. split: facecam panel and gameplay stacked (vertical only).");

export const Edl = z
  .object({
    version: z.literal(1),
    aspect: EdlAspect,
    /** crop = fill the frame (reframe applies); fit = whole frame over a blurred backdrop. */
    layout: EdlLayout.default("crop"),
    split: z
      .object({
        cam: EdlBox.default({ x: 0.73, y: 0.02, w: 0.26, h: 0.3 }).describe("Where the facecam sits in the source picture."),
        camShare: z.number().min(0.2).max(0.6).default(0.38).describe("Share of the output height for the camera panel."),
        camOnTop: z.boolean().default(true),
      })
      .default({ cam: { x: 0.73, y: 0.02, w: 0.26, h: 0.3 }, camShare: 0.38, camOnTop: true })
      .describe("Facecam + gameplay layout settings."),
    segments: z.array(EdlSegment).min(1).max(20).describe("The main video track, played in order."),
    texts: z.array(EdlText).max(20).default([]),
    /** Burn in transcript lines when the sessions have transcripts. */
    captions: z.boolean().default(false).describe("Burn in the session transcript's lines (older option; the caption track is the new way)."),
    fadeInMs: z.number().int().min(0).max(5000).default(0),
    fadeOutMs: z.number().int().min(0).max(5000).default(0),
    volume: z.number().min(0).max(2).default(1).describe("Source-audio volume for the whole edit."),
    /** Output-timeline time of the cover (poster) frame. */
    coverMs: z.number().int().min(0).nullable().default(null),
    mainTrack: z.object({ locked: z.boolean().default(false) }).default({ locked: false }).describe("Main video track settings."),
    sourceAudio: z
      .object({
        muted: z.boolean().default(false),
        solo: z.boolean().default(false),
        denoise: z.boolean().default(false).describe("Reduce steady background noise (FFT denoiser)."),
        voiceBoost: z.boolean().default(false).describe("EQ and compression that bring the voice band forward."),
        envelope: z.array(VolumeKey).max(24).default([]),
      })
      .default({ muted: false, solo: false, denoise: false, voiceBoost: false, envelope: [] })
      .describe("The main video track's audio."),
    overlays: z.array(OverlayTrack).max(4).default([]).describe("Overlay tracks, bottom to top."),
    audioTracks: z.array(AudioTrack).max(4).default([]).describe("Audio tracks mixed with the source audio."),
    effects: z.array(EdlEffect).max(30).default([]),
    grade: EdlGrade.default({ preset: "none", brightness: 0, contrast: 1, saturation: 1, vignette: 0, grain: 0 }),
    captionTrack: EdlCaptionTrack.default({ style: "karaoke", position: "bottom", hidden: false, cues: [] }),
    normalize: z.boolean().default(false).describe("Normalize loudness to about −14 LUFS, a common platform target."),
  })
  .superRefine((e, ctx) => {
    const total = edlDurationMs(e);
    if (total > EDL_MAX_MS) ctx.addIssue({ code: "custom", message: "An edit can be at most 10 minutes long", path: ["segments"] });
    if (total < 300) ctx.addIssue({ code: "custom", message: "The edit is too short", path: ["segments"] });
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
    e.segments.forEach((s, i) => {
      if (i === 0 || s.transitionIn.kind === "cut") return;
      const limit = Math.min(segmentOutputMs(s), segmentOutputMs(e.segments[i - 1]!)) - 100;
      if (s.transitionIn.durationMs < 100) ctx.addIssue({ code: "custom", message: "A transition needs at least 0.1 s", path: ["segments", i, "transitionIn"] });
      if (s.transitionIn.durationMs > limit) ctx.addIssue({ code: "custom", message: "A transition is longer than the segments it joins", path: ["segments", i, "transitionIn"] });
    });
    const itemIds = new Set<string>();
    e.overlays.forEach((t, ti) =>
      t.items.forEach((it, ii) => {
        if (it.endMs <= it.startMs) ctx.addIssue({ code: "custom", message: "An overlay must end after it starts", path: ["overlays", ti, "items", ii, "endMs"] });
        if (it.startMs >= total) ctx.addIssue({ code: "custom", message: "An overlay starts after the edit ends", path: ["overlays", ti, "items", ii, "startMs"] });
        if (itemIds.has(it.id)) ctx.addIssue({ code: "custom", message: "Overlay ids must be unique", path: ["overlays", ti, "items", ii, "id"] });
        itemIds.add(it.id);
      }),
    );
    e.audioTracks.forEach((t, ti) =>
      t.clips.forEach((c, ci) => {
        if (c.startMs >= total) ctx.addIssue({ code: "custom", message: "An audio clip starts after the edit ends", path: ["audioTracks", ti, "clips", ci, "startMs"] });
        if (c.fadeInMs + c.fadeOutMs > c.durationMs) ctx.addIssue({ code: "custom", message: "Audio fades are longer than the clip", path: ["audioTracks", ti, "clips", ci, "fadeOutMs"] });
        if (itemIds.has(c.id)) ctx.addIssue({ code: "custom", message: "Clip ids must be unique", path: ["audioTracks", ti, "clips", ci, "id"] });
        itemIds.add(c.id);
      }),
    );
    e.effects.forEach((f, i) => {
      if (f.startMs >= total) ctx.addIssue({ code: "custom", message: "An effect starts after the edit ends", path: ["effects", i, "startMs"] });
    });
    e.captionTrack.cues.forEach((c, i) => {
      if (c.startMs >= total) ctx.addIssue({ code: "custom", message: "A caption starts after the edit ends", path: ["captionTrack", "cues", i, "startMs"] });
    });
  })
  .describe("A SLOT1 edit: the main video track, overlay tracks, audio tracks and whole-edit settings.");
export type Edl = z.infer<typeof Edl>;
/** What a client may send: defaults not filled in yet. */
export type EdlInput = z.input<typeof Edl>;

/* ------------------------------------------- timing ---------------------------------------- */

interface SegTiming {
  inMs: number;
  outMs: number;
  speed?: number;
  rampTo?: number | null;
  transitionIn?: { kind: string; durationMs: number };
}

/** The constant-speed steps a segment plays as: one, or RAMP_STEPS for a speed ramp. */
export function segmentPieces(s: SegTiming): { inMs: number; outMs: number; speed: number }[] {
  const speed = s.speed ?? 1;
  const ramp = s.rampTo ?? null;
  if (ramp === null || ramp === speed) return [{ inMs: s.inMs, outMs: s.outMs, speed }];
  const d = (s.outMs - s.inMs) / RAMP_STEPS;
  return Array.from({ length: RAMP_STEPS }, (_, k) => ({
    inMs: Math.round(s.inMs + k * d),
    outMs: k === RAMP_STEPS - 1 ? s.outMs : Math.round(s.inMs + (k + 1) * d),
    speed: Math.round((speed + ((ramp - speed) * (k + 0.5)) / RAMP_STEPS) * 1000) / 1000,
  }));
}

/** A segment's length in the finished edit (unrounded). */
export function segmentOutputMs(s: SegTiming): number {
  return segmentPieces(s).reduce((t, p) => t + (p.outMs - p.inMs) / p.speed, 0);
}

/** How much segment `index` overlaps the previous one (its transition). */
export function transitionOverlapMs(segments: SegTiming[], index: number): number {
  const tr = segments[index]?.transitionIn;
  if (index === 0 || !tr || tr.kind === "cut") return 0;
  return tr.durationMs;
}

/** Where each segment starts in the finished edit (unrounded). */
export function segmentStartsMs(e: { segments: SegTiming[] }): number[] {
  const starts: number[] = [];
  let t = 0;
  e.segments.forEach((s, i) => {
    t -= transitionOverlapMs(e.segments, i);
    starts.push(t);
    t += segmentOutputMs(s);
  });
  return starts;
}

/** Output duration: segments shortened or lengthened by their speed, minus transition overlaps. */
export function edlDurationMs(e: { segments: SegTiming[] }): number {
  let t = 0;
  e.segments.forEach((s, i) => (t += segmentOutputMs(s) - transitionOverlapMs(e.segments, i)));
  return Math.round(t);
}

/** Map a source time inside segment `index` to the output timeline. */
export function edlOutputTime(e: { segments: SegTiming[] }, index: number, sourceMs: number): number {
  const s = e.segments[index]!;
  const start = segmentStartsMs(e)[index]!;
  const at = Math.min(Math.max(sourceMs, s.inMs), s.outMs);
  let t = 0;
  for (const p of segmentPieces(s)) {
    if (at <= p.outMs) return Math.round(start + t + (Math.max(at, p.inMs) - p.inMs) / p.speed);
    t += (p.outMs - p.inMs) / p.speed;
  }
  return Math.round(start + t);
}

/** Where an output-timeline time falls: which segment, and the source time inside it. */
export function edlLocate(e: { segments: SegTiming[] }, outMs: number): { index: number; sourceMs: number } {
  const starts = segmentStartsMs(e);
  for (let i = e.segments.length - 1; i >= 0; i--) {
    if (outMs >= starts[i]! || i === 0) {
      const s = e.segments[i]!;
      let rest = Math.max(0, outMs - starts[i]!);
      for (const p of segmentPieces(s)) {
        const d = (p.outMs - p.inMs) / p.speed;
        if (rest <= d) return { index: i, sourceMs: Math.round(Math.min(p.outMs, p.inMs + rest * p.speed)) };
        rest -= d;
      }
      return { index: i, sourceMs: s.outMs };
    }
  }
  return { index: 0, sourceMs: e.segments[0]!.inMs };
}

/** Piecewise-linear value of keyframes at `t` (keys sorted by time; clamps at both ends). */
export function interpolateKeys<K extends { atMs: number }>(keys: readonly K[], t: number, pick: (k: K) => number): number {
  if (keys.length === 0) return 0;
  const sorted = [...keys].sort((a, b) => a.atMs - b.atMs);
  if (t <= sorted[0]!.atMs) return pick(sorted[0]!);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (t <= b.atMs) return b.atMs === a.atMs ? pick(b) : pick(a) + ((pick(b) - pick(a)) * (t - a.atMs)) / (b.atMs - a.atMs);
  }
  return pick(sorted.at(-1)!);
}

/* ------------------------------------------- exports --------------------------------------- */

/**
 * Export presets. Length caps are the platforms' published upload limits as of 2025 (they change;
 * check the platform before relying on them). Bitrates are SLOT1's own encode settings.
 */
export const EXPORT_PRESETS = {
  original: { label: "As edited", aspect: null, maxMs: null, maxrateKbps: 12_000, note: "The edit's own shape" },
  tiktok: { label: "TikTok", aspect: "9:16", maxMs: 10 * 60_000, maxrateKbps: 10_000, note: "Vertical, up to 10 min in the app" },
  shorts: { label: "YouTube Shorts", aspect: "9:16", maxMs: 3 * 60_000, maxrateKbps: 10_000, note: "Vertical, up to 3 min" },
  reels: { label: "Instagram Reels", aspect: "9:16", maxMs: 3 * 60_000, maxrateKbps: 8_000, note: "Vertical, up to 3 min" },
  x: { label: "X", aspect: null, maxMs: 140_000, maxrateKbps: 8_000, note: "Up to 2:20 for most accounts" },
  youtube: { label: "YouTube", aspect: "16:9", maxMs: null, maxrateKbps: 16_000, note: "Widescreen" },
} as const satisfies Record<string, { label: string; aspect: EdlAspect | null; maxMs: number | null; maxrateKbps: number; note: string }>;
export type ExportPresetId = keyof typeof EXPORT_PRESETS;
export const ExportPresetIdSchema = z.enum(Object.keys(EXPORT_PRESETS) as [ExportPresetId, ...ExportPresetId[]]);

export const ExportFormat = z.enum(["mp4", "gif", "audio"]).describe("mp4 video, animated GIF (no sound, at most 30 s), or audio only (AAC).");
export type ExportFormat = z.infer<typeof ExportFormat>;

export const RenderOptions = z
  .object({
    presets: z.array(ExportPresetIdSchema).min(1).max(6).default(["original"]).describe("One render per preset."),
    format: ExportFormat.default("mp4"),
    height: z.union([z.literal(720), z.literal(1080)]).default(1080).describe("Resolution of the shorter side: 720 or 1080."),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
    quality: z.enum(["high", "standard", "small"]).default("high").describe("high: largest file, best picture. small: for slow uploads."),
  })
  .strict();
export type RenderOptions = z.infer<typeof RenderOptions>;
export const GIF_MAX_MS = 30_000;

/** Output size for an aspect at a resolution (the shorter side), kept even. */
export function outputSize(aspect: EdlAspect, height: 720 | 1080 = 1080): { width: number; height: number } {
  const base = ASPECT_SIZE[aspect];
  if (height === 1080) return { width: base.width, height: base.height };
  const f = 720 / Math.min(base.width, base.height);
  return { width: Math.round((base.width * f) / 2) * 2, height: Math.round((base.height * f) / 2) * 2 };
}

/** Why a preset can't take this edit, or null when it can. */
export function presetProblem(preset: ExportPresetId, format: ExportFormat, durationMs: number): string | null {
  const p = EXPORT_PRESETS[preset];
  if (format === "gif" && durationMs > GIF_MAX_MS) return "GIFs can be at most 30 seconds; trim the edit or export video";
  if (p.maxMs !== null && durationMs > p.maxMs) return `${p.label} takes at most ${Math.round(p.maxMs / 1000)} s; this edit is ${Math.round(durationMs / 1000)} s`;
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Library, recordings, profiles                                                              */
/* ------------------------------------------------------------------------------------------ */

export const LibraryItemKind = z.enum(["recording", "render", "screenshot", "twitch_clip", "clip_export", "thumbnail"]);
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
  /** Renders: the export preset and container. */
  preset: ExportPresetIdSchema.nullable().default(null),
  format: z.enum(["mp4", "gif", "audio", "png"]).default("mp4"),
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
  /** The creator's webcam box from "Hide your camera from the AI", when set: prefills the facecam split. */
  cameraBox: EdlBox.nullable().default(null),
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

/** A file the creator uploaded for their edits. */
export const ProjectMediaView = z.object({
  id: z.string(),
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number(),
  url: z.string().nullable(),
  createdAt: z.string(),
});
export type ProjectMediaView = z.infer<typeof ProjectMediaView>;

/** POST /api/projects/:id/thumbnail: a 1280×720 still with big text, saved to the library. */
export const ThumbnailInput = z
  .object({
    atMs: z.number().int().min(0).describe("Output-timeline time of the frame."),
    text: z.string().trim().min(1).max(60),
    subtext: z.string().trim().max(80).default(""),
    style: z.enum(["poster", "mission", "wasted", "title-card", "banner"]).default("poster"),
    position: z.enum(["top", "center", "bottom"]).default("bottom"),
  })
  .strict();
export type ThumbnailInput = z.infer<typeof ThumbnailInput>;

/** GET /api/projects/:id/waveform?sessionId=: peaks (0..1) across the whole source. */
export const WaveformView = z.object({ status: z.enum(["ready", "pending", "unavailable"]), peaks: z.array(z.number()), durationMs: z.number().nullable() });
export type WaveformView = z.infer<typeof WaveformView>;

/** Captions generated from an edit's audio by the configured transcription provider. */
export const GeneratedCaptionsView = z.object({
  status: z.enum(["none", "pending", "ready", "failed"]),
  error: z.string().nullable(),
  cues: z.array(CaptionCue),
});
export type GeneratedCaptionsView = z.infer<typeof GeneratedCaptionsView>;

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
