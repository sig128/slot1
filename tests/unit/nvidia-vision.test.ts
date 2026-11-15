import { describe, expect, it } from "vitest";
import { extractJson, getProfile, NvidiaVisionProvider, ProviderError, type VisionFrameInput } from "@slot1/analysis";

const frames: VisionFrameInput[] = [
  { index: 0, ptsMs: 1000, jpeg: Buffer.from("frame-a") },
  { index: 1, ptsMs: 2000, jpeg: Buffer.from("frame-b") },
];
const ctx = { profile: getProfile("gta5"), sourceLabel: "live" as const, previousSummary: null };

/** A fake chat-completions server: records the request, answers with `reply`. */
function fakeNvidia(reply: string, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const payload = status === 200 ? { model: "nvidia/cosmos3-nano-reasoner", choices: [{ message: { content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1500, completion_tokens: 220 } } : { error: { message: reply } };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("NVIDIA Cosmos Reason as the AI that watches streams", () => {
  it("finds the JSON after reasoning, inside answer tags or a code fence", () => {
    expect(extractJson('<think>a { b</think>\n<answer>\n{"x": "}"}\n</answer>')).toBe('{"x": "}"}');
    expect(extractJson('Here you go:\n```json\n{"a":{"b":1}}\n```')).toBe('{"a":{"b":1}}');
    expect(extractJson("no json at all")).toBe("no json at all");
  });

  it("sends the frames as images to the chat API and reads its JSON like any other AI's", async () => {
    const reply = [
      "<think>The car hits a wall between the frames.</think>",
      "```json",
      JSON.stringify({
        scene: { summary: "Driving in the city", isGameplay: "yes" },
        findings: [
          { type: "possible_collision", frameIndexes: [0, 1], description: "Car hits a wall", interpretation: "inferred", visibleText: null, confidence: 0.7, entities: [{ kind: "vehicle", label: "Red sports car", certainty: "visible" }] },
          // Made-up type: dropped. Temporal with one frame: rejected by the evidence rules.
          { type: "teleport", frameIndexes: [0], description: "Player teleports" },
          { type: "movement", frameIndexes: [1], description: "Car speeds away" },
          { type: "vehicle", frameIndexes: [5, 0], description: "A red sports car", entities: [{ kind: "spaceship", label: "Red car" }] },
        ],
      }),
      "```",
    ].join("\n");
    const { calls, fetchImpl } = fakeNvidia(reply);
    const p = new NvidiaVisionProvider("nvapi-test-key-0123456789", "nvidia/cosmos3-nano-reasoner", "https://integrate.api.nvidia.com/v1/", fetchImpl);
    const r = await p.analyze(frames, ctx);

    expect(calls[0]!.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer nvapi-test-key-0123456789");
    const body = calls[0]!.body as { model: string; messages: { role: string; content: unknown }[] };
    expect(body.model).toBe("nvidia/cosmos3-nano-reasoner");
    const parts = body.messages[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(parts.filter((c) => c.type === "image_url").map((c) => c.image_url!.url)).toEqual([
      `data:image/jpeg;base64,${Buffer.from("frame-a").toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.from("frame-b").toString("base64")}`,
    ]);

    expect(r.model).toEqual({ provider: "nvidia", version: "nvidia/cosmos3-nano-reasoner" });
    expect(r.usage).toEqual({ inputTokens: 1500, outputTokens: 220 });
    expect(r.analysis.scene).toEqual({ summary: "Driving in the city", isGameplay: "yes" });
    expect(r.analysis.findings.map((f) => [f.type, f.frameIndexes])).toEqual([
      ["possible_collision", [0, 1]],
      ["vehicle", [0]],
    ]);
    expect(r.analysis.findings[0]!.entities).toEqual([{ kind: "vehicle", label: "Red sports car", certainty: "visible" }]);
    // An unknown kind becomes "other"; a missing certainty is "uncertain", never "visible".
    expect(r.analysis.findings[1]!.entities).toEqual([{ kind: "other", label: "Red car", certainty: "uncertain" }]);
    expect(r.rejectedFindings).toBe(1);
  });

  it("works without a key for our own server, and reports errors instead of inventing output", async () => {
    const own = fakeNvidia('{"scene":{"summary":"Menu","isGameplay":"no"},"findings":[]}');
    const r = await new NvidiaVisionProvider(null, "nvidia/Cosmos-Reason2-8B", "http://10.0.0.5:8000/v1", own.fetchImpl).analyze(frames, ctx);
    expect(own.calls[0]!.headers.authorization).toBeUndefined();
    expect(r.analysis.findings).toEqual([]);

    const garbage = fakeNvidia("I think there is a car.");
    await expect(new NvidiaVisionProvider("k", "m", "https://x.example/v1", garbage.fetchImpl).analyze(frames, ctx)).rejects.toThrow(/invalid JSON/);
    const limited = fakeNvidia("Too many requests", 429);
    await expect(new NvidiaVisionProvider("k", "m", "https://x.example/v1", limited.fetchImpl).analyze(frames, ctx)).rejects.toBeInstanceOf(ProviderError);
  });
});
