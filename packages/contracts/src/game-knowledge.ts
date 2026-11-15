/**
 * Everything SLOT1 sees, sorted: what kind of moment an entry of the live log is (an activity in a
 * category) and where it happened (a place). Entries are tagged when they're saved, from their own
 * words (what the AI described, what was read on screen, what was said) and type, so every
 * stream adds to one searchable, countable picture of the game.
 *
 * Tags are plain strings: `act:<activity>` and `place:<Place Name>`. Matching is deliberately
 * conservative (whole words, game vocabulary), because a wrong tag is worse than a missing one.
 */

export interface ActivityCategory {
  key: string;
  label: string;
}

export interface Activity {
  key: string;
  category: string;
  label: string;
  /** Matches the entry's words (description, on-screen text, what was said), case-insensitive. */
  words?: RegExp;
  /** Matches by entry type alone (for types that already say what happened). */
  types?: string[];
  /** Broader words for questions people ask ("where do I get guns"), never used to tag entries. */
  ask?: RegExp;
}

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  { key: "driving", label: "Driving and vehicles" },
  { key: "police", label: "Police and wanted level" },
  { key: "combat", label: "Combat" },
  { key: "missions", label: "Missions and heists" },
  { key: "money", label: "Money and businesses" },
  { key: "shops", label: "Shops and services" },
  { key: "fun", label: "Races and activities" },
  { key: "social", label: "People, phone and roleplay" },
  { key: "world", label: "Exploring the world" },
  { key: "online", label: "GTA Online" },
];

const w = (source: string) => new RegExp(`\\b(?:${source})\\b`, "i");

export const ACTIVITIES: Activity[] = [
  // Driving and vehicles
  { key: "driving", category: "driving", label: "Driving a car", words: w("driv(?:e|es|ing) (?:a |the )?(?:car|vehicle|sedan|suv|truck|van)|in traffic|on the (?:road|highway|freeway)") },
  { key: "motorbike", category: "driving", label: "Riding a motorbike", words: w("motor ?(?:bike|cycle)s?|dirt ?bike|on a bike|riding a bike|quad bike|atv") },
  { key: "plane", category: "driving", label: "Flying a plane", words: w("plane|jet|aircraft|airplane|cockpit|fl(?:y|ies|ying) (?:a |the )?(?:plane|jet)|lands? (?:the|a) plane") },
  { key: "helicopter", category: "driving", label: "Flying a helicopter", words: w("helicopter|heli|chopper") },
  { key: "boat", category: "driving", label: "On a boat", words: w("boat|jet ?ski|seashark|yacht|speedboat|submarine|on the water") },
  { key: "steal_car", category: "driving", label: "Stealing a car", words: w("steal(?:s|ing)? (?:a |the )?(?:car|vehicle)|car ?jack(?:s|ing|ed)?|pulls? (?:the )?driver out|breaks? into (?:a |the )?car|hotwir(?:e|es|ing)") },
  { key: "crash", category: "driving", label: "Crashing", words: w("crash(?:es|ed|ing)?|collid(?:e|es|ed|ing)|collision|wreck(?:s|ed)?|hits? (?:a |the )?(?:wall|pole|tree|car|barrier)"), types: ["possible_collision"] },
  { key: "car_mods", category: "driving", label: "Modding a car", ask: w("mod(?:ify|ding)? (?:my |a )?car|customi[sz]e (?:my |a )?car|upgrade (?:my |a )?car|car mods?|paint (?:my |a )?car"), words: w("los santos customs|lsc|mod shop|benny'?s|respray|car mods?|upgrad(?:e|es|ing) (?:the )?car|tuning|custom(?:i[sz](?:e|es|ing))? (?:the |a )?car") },
  { key: "garage", category: "driving", label: "Garage and parking", words: w("garage|parks? the car|parking (?:lot|garage)|personal vehicle") },
  { key: "offroad", category: "driving", label: "Off-road driving", words: w("off[- ]road|dirt (?:road|track)|through the desert|up the mountain") },
  { key: "taxi", category: "driving", label: "Taxi rides", words: w("taxi|cab ride") },

  // Police and wanted level
  { key: "police_chase", category: "police", label: "Police chase", words: w("police (?:chase|pursuit)|cops? (?:chase|chasing|pursue|pursuing)|chased by (?:the )?(?:police|cops)|pursuit|fleeing (?:the )?(?:police|cops)") },
  { key: "wanted", category: "police", label: "Wanted level", words: w("wanted (?:level|stars?)|\\d stars?|two stars|three stars|four stars|five stars") },
  { key: "lose_cops", category: "police", label: "Losing the cops", ask: w("lose (?:the )?(?:cops|police|stars|wanted level)|escape (?:the )?(?:cops|police)|get rid of (?:the )?(?:cops|stars)"), words: w("los(?:e|es|t|ing) (?:the )?(?:cops|police|wanted level)|evad(?:e|es|ed|ing) (?:the )?(?:cops|police)|wanted level (?:cleared|gone)") },
  { key: "busted", category: "police", label: "Busted", words: w("busted|arrested|handcuff(?:ed|s)?") },
  { key: "roadblock", category: "police", label: "Roadblock", words: w("roadblocks?|spike strips?") },
  { key: "police_heli", category: "police", label: "Police helicopter", words: w("police (?:helicopter|heli|chopper)|spotlight") },

  // Combat
  { key: "shootout", category: "combat", label: "Shootout", words: w("shoot(?:s|ing|out)?|shot|gun ?fight|firing|fires? (?:at|on)|exchange of fire|bullets?"), types: ["combat"] },
  { key: "melee", category: "combat", label: "Fist fight", words: w("punch(?:es|ing)?|fist ?fight|brawl|melee|knife fight|bat swing|kick(?:s|ing) (?:a|the) (?:man|person|ped|npc)") },
  { key: "sniping", category: "combat", label: "Sniping", words: w("snip(?:er|ing|es)|scope|long range shot") },
  { key: "explosion", category: "combat", label: "Explosion", words: w("explo(?:sion|des|ded|ding)|blows? up|blown up|grenade|sticky bomb|rpg|rocket launcher|fireball") },
  { key: "wasted", category: "combat", label: "Wasted", words: w("wasted|dies|died|player death|killed by") },
  { key: "gang_fight", category: "combat", label: "Gang fight", words: w("gang (?:fight|war|members?)|ballas|families|vagos|lost mc|triads?") },

  // Missions and heists
  { key: "mission_start", category: "missions", label: "Starting a mission", types: ["mission_title"] },
  { key: "mission_passed", category: "missions", label: "Mission passed", words: w("mission passed|mission complete|heist complete|job complete") },
  { key: "mission_failed", category: "missions", label: "Mission failed", words: w("mission failed|job failed|heist failed") },
  { key: "objective", category: "missions", label: "Following an objective", types: ["objective_text"] },
  { key: "heist", category: "missions", label: "Heists", ask: w("heists?|rob (?:a |the )?bank|bank job|cayo|casino heist"), words: w("heists?|bank job|vault|planning board|setup mission|finale|bank robbery|cayo perico|diamond casino heist|doomsday") },
  { key: "cutscene", category: "missions", label: "Cutscenes", words: w("cutscene|cinematic") },
  { key: "checkpoint", category: "missions", label: "Checkpoints and retries", words: w("checkpoint|retry|restart(?:s|ed)? the mission") },

  // Money and businesses
  { key: "store_robbery", category: "money", label: "Robbing a store", ask: w("rob(?:bing)? (?:a |the )?(?:stores?|shops?)|hold ?up|stick ?up"), words: w("rob(?:s|bing|bed)? (?:a |the )?(?:store|shop|clerk|register|cashier)|store robbery|hold(?:s|ing)? up (?:a |the )?(?:store|clerk)|(?:cash )?register|24/7|liquor (?:store|ace)|ltd gasoline") },
  { key: "atm", category: "money", label: "ATM and cash", words: w("atm|cash machine|withdraw(?:s|ing)?|deposit(?:s|ing)?|bank account") },
  { key: "cash_pickup", category: "money", label: "Picking up cash", words: w("picks? up (?:the )?(?:cash|money)|cash (?:bag|pickup|drop)|money bag") },
  { key: "armored_truck", category: "money", label: "Armored trucks", words: w("armou?red (?:truck|van|car)|security van|gruppe ?sechs") },
  { key: "business", category: "money", label: "Running a business", ask: w("make money|making money|earn money|get rich|money fast|grind(?:ing)?|business(?:es)?|passive income"), words: w("business(?:es)?|nightclub|bunker|warehouse|cargo|mc business|ceo office|meth lab|cocaine lockup|weed farm|counterfeit cash|document forgery|arcade business|auto shop|agency|acid lab") },
  { key: "selling", category: "money", label: "Selling goods", words: w("sell(?:s|ing)? (?:the )?(?:goods|product|cargo|stock|supplies)|sell mission|resupply|deliver(?:s|ing|y)? (?:the )?(?:goods|cargo|product)") },
  { key: "casino", category: "money", label: "Casino", words: w("casino|blackjack|poker|roulette|slot machines?|lucky wheel|chips") },
  { key: "property", category: "money", label: "Buying property", words: w("(?:buys?|buying|purchas(?:e|es|ing)) (?:an? )?(?:apartment|house|property|garage|office|penthouse)|dynasty 8|maze bank foreclosures") },
  { key: "stock_market", category: "money", label: "Stock market", words: w("stock market|lcn|bawsaq|stock (?:price|chart)s?|(?:buys?|sells?) shares") },

  // Shops and services
  {
    key: "buy_weapons",
    category: "shops",
    label: "Buying weapons (Ammu-Nation)",
    words: w("ammu-?nation|gun (?:store|shop|counter)|buy(?:s|ing)? (?:a |the )?(?:guns?|weapons?|rifles?|pistols?|shotguns?|ammo|ammunition)|weapon (?:shop|store|upgrades?)|gun range|shooting range"),
    ask: w("guns?|weapons?|ammo|ammunition|rifles?|pistols?|shotguns?|snipers?|rpg|armou?r"),
  },
  { key: "clothes", category: "shops", label: "Buying clothes", words: w("clothing (?:store|shop)|clothes (?:store|shop)|binco|ponsonbys|discount store|tries? on (?:clothes|an? outfit)|outfit") },
  { key: "barber", category: "shops", label: "Barber", words: w("barber|haircut|hairstyle|beard trim") },
  { key: "tattoo", category: "shops", label: "Tattoo parlor", words: w("tattoo") },
  { key: "car_dealer", category: "shops", label: "Buying a vehicle", ask: w("buy (?:a |new )?(?:cars?|vehicles?|bikes?|planes?|jets?|boats?|helicopters?)|(?:best|fastest) (?:cars?|vehicles?)"), words: w("buy(?:s|ing)? (?:a |the )?(?:cars?|vehicles?|bikes?|planes?|boats?|helicopters?)|car dealership|legendary motorsport|southern san andreas super autos|pedal and metal|warstock|premium deluxe motorsport|simeon") },
  { key: "hospital", category: "shops", label: "Hospital and respawn", words: w("hospital|respawn(?:s|ed)?|medical center|wakes? up outside") },
  { key: "safehouse", category: "shops", label: "Safehouse and saving", words: w("safehouse|save game|saves? the game|bed|sleeps?|apartment interior") },
  { key: "food_drink", category: "shops", label: "Food, drinks and snacks", words: w("snacks?|vending machine|burger shot|cluckin'? bell|bean machine|drinks? (?:a |at )|at the bar|bar counter|eats?") },
  { key: "gas_station", category: "shops", label: "Gas station", words: w("gas station|petrol station|fuel pump|globe oil|xero|ron gas") },

  // Races and activities
  { key: "race", category: "fun", label: "Racing", words: w("race|racing|lap \\d|position \\d+ ?(?:of|/) ?\\d+|finish line|start(?:ing)? grid|street race|time trial") },
  { key: "stunt", category: "fun", label: "Stunt jumps", words: w("stunt (?:jump|race)?|jumps? (?:off|over) (?:a |the )?ramp|unique stunt|flip(?:s|ped)?|airtime") },
  { key: "parachute", category: "fun", label: "Parachuting", words: w("parachut(?:e|es|ing)|skydiv(?:e|es|ing)|free ?fall") },
  { key: "sports", category: "fun", label: "Golf, tennis and darts", words: w("golf|tennis|darts|arm ?wrestl(?:e|ing)|yoga|triathlon") },
  { key: "hunting", category: "fun", label: "Hunting and fishing", words: w("hunting|hunts?|deer|elk|fishing|fish") },
  { key: "cycling", category: "fun", label: "Cycling", words: w("bicycle|cycling|bmx|mountain bike") },
  { key: "swimming", category: "fun", label: "Swimming and diving", words: w("swim(?:s|ming)?|underwater|diving|scuba") },
  { key: "arcade", category: "fun", label: "Arcade games", words: w("arcade (?:game|machine)|retro arcade") },
  { key: "photo", category: "fun", label: "Photos and selfies", words: w("selfie|takes? a (?:photo|picture)|snapmatic|photo mode") },

  // People, phone and roleplay
  { key: "conversation", category: "social", label: "Talking to people", words: w("talk(?:s|ing)? (?:to|with)|conversation|argu(?:e|es|ing) with"), types: ["dialogue", "subtitle"] },
  { key: "phone", category: "social", label: "Phone calls and texts", words: w("phone|phone call|text message|ifruit|contacts list|email") },
  { key: "contacts", category: "social", label: "Story characters and contacts", words: w("lester|martin madrazo|madrazo|gerald|simeon|trevor|lamar|franklin|michael de santa|agent 14|dr\\.? dre|contact mission") },
  { key: "roleplay", category: "social", label: "Roleplay", words: w("roleplay|rp server|role-?play|fivem|in character|ooc|mdt|ems|lspd officer|sasp|sheriff") },
  { key: "character", category: "social", label: "Character and looks", words: w("character (?:creator|creation|customi[sz]ation)|appearance|face (?:shape|features)|changes? (?:clothes|outfit)") },
  { key: "crew", category: "social", label: "Crews and gangs", words: w("crew|gang (?:hideout|turf)|mc club|motorcycle club|organi[sz]ation|associates?") },
  { key: "reaction", category: "social", label: "Reactions", types: ["reaction"], words: w("laugh(?:s|ter|ing)?|scream(?:s|ing)?|cheer(?:s|ing)?|applause") },

  // Exploring the world
  { key: "on_foot", category: "world", label: "On foot", words: w("on foot|walk(?:s|ing)|runs?|running|sprint(?:s|ing)?|climb(?:s|ing)?") },
  { key: "city", category: "world", label: "In the city", words: w("downtown|city street|skyscraper|city center|los santos") },
  { key: "countryside", category: "world", label: "Countryside and desert", words: w("countryside|desert|blaine county|sandy shores|paleto bay|grapeseed|farmland|farm fields|trailer park") },
  { key: "mountains", category: "world", label: "Mountains and forests", words: w("mountain|chiliad|forest|woods|cliff|canyon") },
  { key: "beach", category: "world", label: "Beach and coast", words: w("beach|coast|pier|ocean|sea|shore") },
  { key: "airport", category: "world", label: "Airports", words: w("airport|lsia|runway|hangar|airfield|sandy shores airfield|mckenzie field|fort zancudo") },
  { key: "night", category: "world", label: "Night time", words: w("night|dark street|street ?lights|moonlight") },
  { key: "weather", category: "world", label: "Rain and storms", words: w("rain(?:ing|y|storm)?|storm|thunder|lightning|fog(?:gy)?|snow") },
  { key: "map", category: "world", label: "Map and GPS", words: w("pause map|world map|waypoint|gps route|map screen|map menu") },
  { key: "loading", category: "world", label: "Loading screens", words: w("loading screen|loading|black screen|fades? to black") },

  // GTA Online
  { key: "online_session", category: "online", label: "Sessions and lobbies", words: w("gta online|online session|lobby|matchmaking|public session|invite only|joining session") },
  { key: "rank_up", category: "online", label: "Ranking up", words: w("rank ?up|rank \\d+|rp gained|reputation|level up") },
  { key: "freemode", category: "online", label: "Freemode events", words: w("freemode event|business battle|king of the castle|hunt the beast|daily objective|daily challenge|weekly challenge") },
  { key: "pvp", category: "online", label: "Player fights", words: w("player kill|killed by player|bounty|kill feed|deathmatch|pvp") },
];

/** GTA V's places (Los Santos and Blaine County), as people and the game write them. */
export const PLACES: string[] = [
  "Alamo Sea", "Alta", "Banham Canyon", "Banning", "Burton", "Chamberlain Hills", "Chumash", "Cypress Flats", "Davis", "Del Perro",
  "Del Perro Pier", "Downtown Vinewood", "East Vinewood", "El Burro Heights", "Elysian Island", "Fort Zancudo", "Galileo Observatory",
  "Grand Senora Desert", "Grapeseed", "Great Chaparral", "Grove Street", "Harmony", "Hawick", "Humane Labs", "La Mesa", "La Puerta",
  "Legion Square", "Little Seoul", "Los Santos International Airport", "Maze Bank Arena", "Maze Bank Tower", "Mirror Park", "Mission Row",
  "Morningwood", "Mount Chiliad", "Mount Gordo", "Mount Josiah", "Murrieta Heights", "North Chumash", "Pacific Bluffs", "Paleto Bay",
  "Paleto Forest", "Pillbox Hill", "Port of Los Santos", "Raton Canyon", "Rancho", "Richman", "Rockford Hills", "Sandy Shores",
  "San Chianski Mountain Range", "Stab City", "Strawberry", "Tataviam Mountains", "Terminal", "Textile City", "Tongva Hills",
  "Vespucci", "Vespucci Beach", "Vespucci Canals", "Vinewood", "Vinewood Hills", "Vinewood Sign", "West Vinewood", "Zancudo River",
  "Diamond Casino", "Kortz Center", "Los Santos Golf Club", "Bolingbroke Penitentiary", "Paleto Bay Sheriff", "Pacific Standard Bank",
  "Fleeca Bank", "Union Depository", "Ammu-Nation", "Los Santos Customs", "Vanilla Unicorn", "Cayo Perico",
];

const placeRes = PLACES.map((name) => ({ name, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+").replace(/-/g, "[- ]?")}\\b`, "i") }));
const activityByKey = new Map(ACTIVITIES.map((a) => [a.key, a]));

export function activityOf(key: string): Activity | undefined {
  return activityByKey.get(key);
}

/** A place name read on screen, cleaned up into the way it's written (title case). */
export function normalizePlace(raw: string): string | null {
  const v = raw.replace(/[^\p{L}\p{N}' &-]/gu, " ").replace(/\s+/g, " ").trim();
  if (v.length < 3 || v.length > 48 || !/\p{L}{3}/u.test(v)) return null;
  const known = PLACES.find((p) => p.toLowerCase() === v.toLowerCase());
  if (known) return known;
  return v
    .toLowerCase()
    .split(" ")
    .map((x) => (x.length <= 2 && x !== "la" && x !== "el" ? x : x.charAt(0).toUpperCase() + x.slice(1)))
    .join(" ");
}

/** Scenes SLOT1's own GTA model names ("Scene: driving"), as activities. */
const SCENE_ACTIVITY: Record<string, string> = {
  driving: "driving",
  on_foot: "on_foot",
  shootout: "shootout",
  cutscene: "cutscene",
  menu_or_map: "map",
  phone: "phone",
  loading_or_black: "loading",
};

/** The activities and places an entry of the live log is about. */
export function knowledgeTags(entry: { type: string; description: string; rawText: string | null; origin?: string }): string[] {
  // Twitch-side entries (chat, follows) say nothing about the gameplay itself.
  if (entry.origin === "twitch") return [];
  const text = `${entry.description} ${entry.rawText ?? ""}`;
  const tags = new Set<string>();
  const scene = entry.type === "environment" ? /^Scene: ([a-z_]+)\s*$/i.exec(entry.description) : null;
  if (scene) {
    const key = SCENE_ACTIVITY[scene[1]!.toLowerCase()];
    if (key) tags.add(`act:${key}`);
    return [...tags];
  }
  for (const a of ACTIVITIES) {
    if (a.types?.includes(entry.type) || (a.words && a.words.test(text))) tags.add(`act:${a.key}`);
  }
  // Results are read exactly: WASTED on a result screen is a death, not a mission result.
  if (entry.type === "result_screen" && /\bwasted\b/i.test(text)) tags.delete("act:mission_passed");
  if (entry.type === "place_name" || entry.type === "landmark") {
    const p = normalizePlace(entry.rawText ?? entry.description.replace(/^(?:place|landmark)(?: name)?(?: read)?:?\s*/i, ""));
    if (p) tags.add(`place:${p}`);
  }
  for (const { name, re } of placeRes) if (re.test(text)) tags.add(`place:${name}`);
  // "Vespucci Beach" already says "Vespucci": keep the most precise place.
  const places = [...tags].filter((t) => t.startsWith("place:")).map((t) => t.slice(6));
  for (const p of places) if (places.some((q) => q !== p && q.toLowerCase().startsWith(`${p.toLowerCase()} `))) tags.delete(`place:${p}`);
  return [...tags].sort();
}

/** The activities a question is about (the same words as the entries), for searching. */
export function questionActivities(question: string): string[] {
  const keys: string[] = [];
  for (const a of ACTIVITIES) if (a.ask?.test(question) || a.words?.test(question)) keys.push(a.key);
  return keys;
}

/** Places a question names. */
export function questionPlaces(question: string): string[] {
  return placeRes.filter(({ re }) => re.test(question)).map(({ name }) => name);
}
