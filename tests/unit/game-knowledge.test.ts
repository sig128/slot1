import { describe, expect, it } from "vitest";
import { ACTIVITIES, ACTIVITY_CATEGORIES, knowledgeTags, normalizePlace, questionActivities, questionPlaces } from "@slot1/contracts";

const tags = (type: string, description: string, rawText: string | null = null, origin = "video") => knowledgeTags({ type, description, rawText, origin });

describe("everything SLOT1 sees, sorted", () => {
  it("has a category for every activity, and unique keys", () => {
    const cats = new Set(ACTIVITY_CATEGORIES.map((c) => c.key));
    for (const a of ACTIVITIES) expect(cats.has(a.category), a.key).toBe(true);
    expect(new Set(ACTIVITIES.map((a) => a.key)).size).toBe(ACTIVITIES.length);
    expect(ACTIVITIES.length).toBeGreaterThan(70);
  });

  it("tags what happened and where", () => {
    expect(tags("visible_text", "Sign reads AMMU-NATION over a gun store", "AMMU-NATION")).toEqual(["act:buy_weapons", "place:Ammu-Nation"]);
    expect(tags("movement", "Police chase through Vinewood")).toEqual(["act:police_chase", "place:Vinewood"]);
    expect(tags("combat", "Player shoots at two gang members near Grove Street")).toEqual(["act:gang_fight", "act:shootout", "place:Grove Street"]);
    expect(tags("vehicle_enter_exit", "Player pulls the driver out and steals the car")).toEqual(["act:steal_car"]);
    expect(tags("possible_collision", "Car hits a barrier")).toContain("act:crash");
    expect(tags("dialogue", "Said (Turkish): “Polis geliyor”", "Polis geliyor", "audio")).toEqual(["act:conversation"]);
  });

  it("reads results exactly, and the GTA model's scenes", () => {
    expect(tags("result_screen", "Result screen read", "MISSION PASSED", "ocr")).toEqual(["act:mission_passed"]);
    expect(tags("result_screen", "Result screen read", "WASTED", "ocr")).toEqual(["act:wasted"]);
    expect(tags("environment", "Scene: driving")).toEqual(["act:driving"]);
    expect(tags("environment", "Scene: menu_or_map")).toEqual(["act:map"]);
    expect(tags("mission_title", "Mission title read", "The Long Stretch", "ocr")).toEqual(["act:mission_start"]);
  });

  it("keeps the most precise place, and cleans up place names read on screen", () => {
    expect(tags("place_name", "Place name read", "VESPUCCI BEACH", "ocr")).toEqual(["act:beach", "place:Vespucci Beach"]);
    expect(tags("place_name", "Place name read", "SOME NEW STREET", "ocr")).toEqual(["place:Some New Street"]);
    expect(normalizePlace("los santos international airport")).toBe("Los Santos International Airport");
    expect(normalizePlace("x")).toBeNull();
  });

  it("doesn't tag noise: HUD money, plain prompts, Twitch chat", () => {
    expect(tags("hud_reading", "Money counter shows $12,450", "$12,450", "ocr")).toEqual([]);
    expect(tags("visible_text", "Text says press E to talk", "Press E", "ocr")).toEqual([]);
    expect(tags("chat_message", "Chat said police chase lol", "police chase lol", "twitch")).toEqual([]);
    expect(tags("movement", "Car passes another car")).not.toContain("act:mission_passed");
  });

  it("maps questions to what to look through", () => {
    expect(questionActivities("Where do I buy guns?")).toContain("buy_weapons");
    expect(questionActivities("How do I lose the cops?")).toContain("lose_cops");
    expect(questionActivities("best way to make money")).toContain("business");
    expect(questionActivities("how do I pass the heist finale")).toContain("heist");
    expect(questionPlaces("what happens at mount chiliad and paleto bay")).toEqual(["Mount Chiliad", "Paleto Bay"]);
  });
});
