import { describe, expect, it } from "vitest";
import { capabilitiesFor, loadConfig, PUBLIC_REASON, publicText, revealsServerSetup } from "@slot1/platform";
import { requirementText } from "../../apps/web/lib/requirements";

/** A fresh server: no Twitch app, no ingest, no AI. */
const caps = loadConfig({ NODE_ENV: "test", VISION_PROVIDER: "none", OCR_ENABLED: "false" } as NodeJS.ProcessEnv).capabilities;
const SETTING = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/;

describe("visitors and creators never read server settings", () => {
  it("swaps every unavailable reason for a plain one, and keeps the facts", () => {
    const pub = capabilitiesFor(caps, false);
    expect(JSON.stringify(pub)).not.toMatch(SETTING);
    expect(pub.twitch).toEqual({ available: false, reason: PUBLIC_REASON.twitch, detail: null, setup: null });
    expect(pub.ocr.reason).toBe(PUBLIC_REASON.ocr);
    // Everything that isn't a reason is unchanged.
    expect(pub.storage.driver).toBe(caps.storage.driver);
    expect(pub.environment).toBe("test");
  });

  it("gives operators the exact settings and the server command", () => {
    const op = capabilitiesFor(caps, true);
    expect(op.twitch.reason).toBe(caps.twitch.reason);
    expect(op.twitch.setup).toEqual({ missing: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_REDIRECT_URI", "SLOT1_TOKEN_ENCRYPTION_KEYS"], command: "slot1 twitch", settings: "Admin → Settings → Twitch app" });
    expect(op.vision.setup).toEqual({ missing: ["VISION_PROVIDER"], command: "slot1 ai", settings: "Admin → Settings → AI" });
    expect(op.transcription.setup).toEqual({ missing: ["TRANSCRIPTION_PROVIDER"], command: null, settings: null });
    expect(op.storage.setup).toBeNull(); // available: nothing to fix
  });

  it("cleans any other text: brackets and sentences about the server go, the rest stays", () => {
    expect(publicText(caps, caps.ingest.reason)).toBe(PUBLIC_REASON.ingest);
    expect(publicText(caps, "The demo generator isn't sending right now. On the server, check it with: slot1 logs demo")).toBe("The demo generator isn't sending right now.");
    expect(publicText(caps, "Streaming to SLOT1 isn't fully set up yet (INGEST_READ_URL_TEMPLATE is missing)")).toBe("Streaming to SLOT1 isn't fully set up yet");
    expect(publicText(caps, "Set VISION_PRICE_INPUT_PER_MTOK to estimate spend.", "No estimate yet.")).toBe("No estimate yet.");
    expect(publicText(caps, "Twitch rate limit reached — try again shortly")).toBe("Twitch rate limit reached — try again shortly");
    expect(publicText(caps, null)).toBeNull();
    // "SLOT1 sends…" is product language, not a server command.
    expect(revealsServerSetup("SLOT1 sends your stream on to Twitch")).toBe(false);
    expect(revealsServerSetup("Run slot1 twitch")).toBe(true);
  });

  it("shows an operator's reason without the list SetupFix spells out", () => {
    expect(requirementText(caps.twitch.reason)).toBe("Twitch not configured.");
    expect(requirementText(PUBLIC_REASON.ingest)).toBe("Streaming to SLOT1 isn't open yet.");
    expect(requirementText(null)).toBe("");
  });
});
