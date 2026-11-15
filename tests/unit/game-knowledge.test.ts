import { describe, expect, it } from "vitest";
import { ACTIVITIES, ACTIVITY_CATEGORIES, knowledgeTags, normalizePlace, questionActivities, questionPlaces, vehicleName, weaponName } from "@slot1/contracts";

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
    expect(tags("vehicle_enter_exit", "Player pulls the driver out and steals the car")).toEqual(["act:enter_exit", "act:steal_car"]);
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

describe("the whole game: more activities, and names read on screen", () => {
  it("has about 200 activities in their own groups, every key unique", () => {
    expect(ACTIVITIES.length).toBeGreaterThanOrEqual(190);
    expect(ACTIVITY_CATEGORIES.length).toBeGreaterThanOrEqual(18);
    for (const c of ACTIVITY_CATEGORIES) expect(ACTIVITIES.some((a) => a.category === c.key), c.key).toBe(true);
  });

  it("sorts the new kinds of moments", () => {
    expect(tags("movement", "Player drifts around the corner in a sports car")).toEqual(expect.arrayContaining(["act:drift", "act:supercar"]));
    expect(tags("environment", "Player goes inside the building through a side door")).toContain("act:interior");
    expect(tags("visible_text", "Text says glitched through the map", "Fell through the map")).toEqual(expect.arrayContaining(["act:glitch", "act:stuck"]));
    expect(tags("combat", "Player throws a molotov at the police car")).toEqual(expect.arrayContaining(["act:throwable", "act:emergency_vehicle"]));
    expect(tags("movement", "Player does a wheelie on a motorbike")).toEqual(expect.arrayContaining(["act:wheelie", "act:motorbike"]));
    expect(tags("vehicle", "A shark swims under the boat")).toEqual(expect.arrayContaining(["act:sea_life", "act:boat"]));
  });

  it("doesn't take ordinary words for the new kinds", () => {
    expect(tags("environment", "Coffee mug on the kitchen table")).not.toContain("act:mugging");
    expect(tags("environment", "Player eats donuts at the counter")).not.toContain("act:burnout");
    expect(tags("vehicle", "Rain on the roof of the car")).not.toContain("act:rooftop");
    expect(tags("visible_text", "Text says the game crashed to desktop", "Crashed to desktop")).not.toContain("act:crash");
    expect(tags("movement", "Bullet casings fly across the floor")).not.toContain("act:heist_prep");
    expect(tags("movement", "Player walks down the street")).toEqual(["act:on_foot"]);
  });

  it("reads car and weapon names the game shows, and never takes a car for a place", () => {
    expect(vehicleName("PEGASSI ZENTORNO")).toBe("Pegassi Zentorno");
    expect(vehicleName("Bati 801")).toBe("Bati 801");
    expect(vehicleName("VINEWOOD HILLS")).toBeNull();
    expect(vehicleName("A bullet hits the car")).toBeNull();
    expect(weaponName("COMBAT PISTOL")).toBe("Combat Pistol");
    expect(weaponName("Pistol shots ring out")).toBeNull();
    expect(tags("place_name", "Place name read", "ZENTORNO", "ocr")).toEqual(["act:driving", "act:supercar"]);
    expect(tags("place_name", "Place name read", "PILLBOX HILL", "ocr")).toEqual(["place:Pillbox Hill"]);
    expect(tags("visible_text", "On-screen text read", "Combat Pistol", "ocr")).toContain("act:weapon_wheel");
  });
});
