import { describe, expect, it } from "vitest";
import { buildShareCaption, canShareAsFile, shareFileName, UPLOAD_PAGES } from "../../apps/web/lib/share";

describe("share caption", () => {
  it("turns an auto clip's moment into a title line and a tag", () => {
    expect(buildShareCaption({ title: "MISSION PASSED", kind: "render" })).toBe("MISSION PASSED!\n\n#GTA #MissionPassed #gaming #clips");
    expect(buildShareCaption({ title: "WASTED", kind: "render" })).toBe("WASTED!\n\n#GTA #Wasted #gaming #clips");
  });

  it("keeps a creator's own title and still spots a moment inside it", () => {
    expect(buildShareCaption({ title: "Busted at the docks again", kind: "clip_export" })).toBe("Busted at the docks again\n\n#GTA #Busted #gaming #clips");
    expect(buildShareCaption({ title: "  Night drive  ", kind: "render" })).toBe("Night drive\n\n#GTA #gaming #clips");
  });

  it("caps tags at four and never invents a moment", () => {
    const c = buildShareCaption({ title: "Mission Failed, then wasted", kind: "render" });
    expect(c.split("\n\n")[1]!.split(" ")).toHaveLength(4);
    expect(buildShareCaption({ title: "Sunset", kind: "screenshot" })).toBe("Sunset\n\n#GTA #gaming");
  });
});

describe("share file", () => {
  it("names the file like the Library download", () => {
    expect(shareFileName("MISSION PASSED", "mp4")).toBe("MISSION-PASSED.mp4");
    expect(shareFileName("Docks run: 2 / 3!", "mp4")).toBe("Docks-run-2-3.mp4");
    expect(shareFileName("???", "mp4")).toBe("slot1.mp4");
  });

  it("shares only finished rendered videos, and only for the owner", () => {
    const base = { status: "ready", url: "/api/media/f/x", canEdit: true };
    expect(canShareAsFile({ ...base, kind: "render" })).toBe(true);
    expect(canShareAsFile({ ...base, kind: "clip_export" })).toBe(true);
    expect(canShareAsFile({ ...base, kind: "recording" })).toBe(false);
    expect(canShareAsFile({ ...base, kind: "twitch_clip" })).toBe(false);
    expect(canShareAsFile({ ...base, kind: "render", canEdit: false })).toBe(false);
    expect(canShareAsFile({ ...base, kind: "render", status: "processing" })).toBe(false);
    expect(canShareAsFile({ ...base, kind: "render", url: null })).toBe(false);
  });

  it("links only to the platforms' own sites over https", () => {
    for (const p of UPLOAD_PAGES) expect(new URL(p.href).protocol).toBe("https:");
    expect(UPLOAD_PAGES.map((p) => new URL(p.href).hostname)).toEqual(["www.tiktok.com", "studio.youtube.com", "www.instagram.com"]);
  });
});
