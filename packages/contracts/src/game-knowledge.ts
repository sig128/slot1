import { vehicleName, weaponName } from "./gta-names";

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
  { key: "driving", label: "Driving" },
  { key: "vehicles", label: "Vehicles by type" },
  { key: "stunts", label: "Stunts and tricks" },
  { key: "police", label: "Police and wanted level" },
  { key: "crime", label: "Crime" },
  { key: "combat", label: "Combat" },
  { key: "weapons", label: "Weapons" },
  { key: "missions", label: "Missions and heists" },
  { key: "money", label: "Money and businesses" },
  { key: "shops", label: "Shops and services" },
  { key: "fun", label: "Races and activities" },
  { key: "social", label: "People, phone and roleplay" },
  { key: "world", label: "Exploring the world" },
  { key: "places", label: "Around the map" },
  { key: "nature", label: "Animals and nature" },
  { key: "online", label: "GTA Online" },
  { key: "glitches", label: "Glitches and bugs" },
  { key: "stream", label: "On stream" },
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
  { key: "crash", category: "driving", label: "Crashing", words: w("(?<!game )crash(?:es|ed|ing)?(?! to (?:desktop|dashboard|home))|collid(?:e|es|ed|ing)|collision|wreck(?:s|ed)?|hits? (?:a |the )?(?:wall|pole|tree|car|barrier)"), types: ["possible_collision"] },
  { key: "car_mods", category: "driving", label: "Modding a car", ask: w("mod(?:ify|ding)? (?:my |a )?car|customi[sz]e (?:my |a )?car|upgrade (?:my |a )?car|car mods?|paint (?:my |a )?car"), words: w("los santos customs|lsc|mod shop|benny'?s|respray|car mods?|upgrad(?:e|es|ing) (?:the )?car|tuning|custom(?:i[sz](?:e|es|ing))? (?:the |a )?car") },
  { key: "garage", category: "driving", label: "Garage and parking", words: w("garage|parks? the car|parking (?:lot|garage)|personal vehicle") },
  { key: "offroad", category: "driving", label: "Off-road driving", words: w("off[- ]road|dirt (?:road|track)|through the desert|up the mountain") },
  { key: "taxi", category: "driving", label: "Taxi rides", words: w("taxi|cab ride") },
  { key: "enter_exit", category: "driving", label: "Getting in and out of vehicles", types: ["vehicle_enter_exit"], words: w("gets? (?:in|into|out of) (?:a |the )?(?:car|vehicle|truck|van|helicopter|plane|boat)|climbs? (?:in|into|out of) (?:a |the )?(?:car|vehicle|truck|helicopter|plane)") },

  // Police and wanted level
  { key: "police_chase", category: "police", label: "Police chase", words: w("police (?:chase|pursuit)|cops? (?:chase|chasing|pursue|pursuing)|chased by (?:the )?(?:police|cops)|pursuit|fleeing (?:the )?(?:police|cops)") },
  { key: "wanted", category: "police", label: "Wanted level", words: w("wanted (?:level|stars?)|\\d stars?|two stars|three stars|four stars|five stars") },
  { key: "lose_cops", category: "police", label: "Losing the cops", ask: w("lose (?:the )?(?:cops|police|stars|wanted level)|escape (?:the )?(?:cops|police)|get rid of (?:the )?(?:cops|stars)"), words: w("los(?:e|es|t|ing) (?:the )?(?:cops|police|wanted level)|evad(?:e|es|ed|ing) (?:the )?(?:cops|police)|wanted level (?:cleared|gone)") },
  { key: "busted", category: "police", label: "Busted", words: w("busted|arrested|handcuff(?:ed|s)?") },
  { key: "roadblock", category: "police", label: "Roadblock", words: w("roadblocks?|spike strips?") },
  { key: "police_heli", category: "police", label: "Police helicopter", words: w("police (?:helicopter|heli|chopper)|spotlight") },

  // Combat
  { key: "shootout", category: "combat", label: "Shootout", words: w("shoot(?:s|ing|out)?|shot|gun ?fight|firing|fires? (?:at|on)|exchange of fire|bullets?") },
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
  // Vehicles by type
  { key: "supercar", category: "vehicles", label: "Supercars and sports cars", words: w("super ?cars?|sports ?cars?|hypercars?|zentorno|adder|t20|osiris|infernus|vacca|banshee|elegy|carbonizzare|feltzer|pegassi|grotti|truffade|ocelot|dewbauchee|overflod") },
  { key: "muscle_car", category: "vehicles", label: "Muscle cars and lowriders", words: w("muscle cars?|lowriders?|hydraulics|dominator|gauntlet|vigero|sabre turbo|dukes") },
  { key: "truck", category: "vehicles", label: "Trucks and big rigs", words: w("semi[- ]?trucks?|big rigs?|18[- ]wheelers?|tanker trucks?|dump trucks?|tow trucks?|flatbed|box truck|pickup trucks?") },
  { key: "bus", category: "vehicles", label: "Buses", words: w("bus(?:es)?(?! stop)|coach bus|tour bus|bus (?:route|driver)") },
  { key: "emergency_vehicle", category: "vehicles", label: "Police cars, ambulances and fire trucks", words: w("police cars?|cop cars?|squad cars?|cruisers?|ambulances?|fire ?trucks?|fire engines?|paramedics?") },
  { key: "military_vehicle", category: "vehicles", label: "Military vehicles", words: w("rhino tank|in a tank|drives? a tank|tank (?:shell|fires|cannon)|apcs?|military (?:trucks?|vehicles?|jets?|helicopters?|convoy)|lazer|hydra|fighter jets?") },
  { key: "weaponized_vehicle", category: "vehicles", label: "Flying and armed vehicles", words: w("oppressor(?: mk ?ii)?|deluxo|flying (?:car|bike|motorbike)|rocket (?:boost|car)|weaponi[sz]ed (?:vehicles?|cars?)|vehicle missiles?|homing missiles?|ruiner 2000|scramjet") },
  { key: "train", category: "vehicles", label: "Trains and trams", words: w("trains?|freight trains?|subway|trams?|railway|train tracks|railroad") },
  { key: "work_vehicle", category: "vehicles", label: "Work vehicles", words: w("garbage trucks?|forklifts?|tractors?|lawn ?mowers?|golf carts?|caddy|street sweepers?|cement mixers?|bulldozers?|excavators?") },
  { key: "speeding", category: "vehicles", label: "Speeding", words: w("speed(?:s|ing)? (?:through|down|along|past)|top speed|\\d+ ?mph|\\d+ ?km/?h|full throttle|nitrous|nos boost|redlin(?:e|ing)") },
  { key: "traffic", category: "vehicles", label: "Traffic", words: w("traffic jam|heavy traffic|weav(?:e|es|ing) through traffic|oncoming traffic|wrong side of the road|red lights?|traffic lights?") },
  { key: "car_wash", category: "vehicles", label: "Car wash", words: w("car ?wash") },

  // Weapons
  { key: "pistol", category: "weapons", label: "Pistols", words: w("pistols?|handguns?|revolvers?|deagle|stun gun|flare gun") },
  { key: "smg", category: "weapons", label: "SMGs and machine pistols", words: w("smgs?|sub ?machine guns?|micro smg|uzi|machine pistols?") },
  { key: "assault_rifle", category: "weapons", label: "Assault rifles", words: w("assault rifles?|carbine rifles?|carbine|ak-?47|bullpup rifle|special carbine") },
  { key: "shotgun", category: "weapons", label: "Shotguns", words: w("shotguns?|pump shotgun|sawed-?off") },
  { key: "heavy_weapon", category: "weapons", label: "Miniguns and heavy weapons", words: w("miniguns?|machine guns?|gatling|railgun|grenade launchers?|homing launchers?|widowmaker|combat mg") },
  { key: "throwable", category: "weapons", label: "Grenades, molotovs and bombs", words: w("molotovs?|tear gas|pipe bombs?|proximity mines?|sticky bombs?|throws? (?:a |the )?(?:grenade|molotov|bomb)") },
  { key: "melee_weapon", category: "weapons", label: "Knives, bats and melee weapons", words: w("knife(?![- ]fl)|knives|baseball bats?|crowbars?|machetes?|hatchets?|wrench|nightsticks?|knuckle ?dusters?|switchblades?") },
  { key: "weapon_wheel", category: "weapons", label: "Weapon wheel, ammo and reloading", words: w("weapon wheel|weapon select(?:ion)?|switch(?:es|ing)? weapons?|ammo count|reload(?:s|ing)?|out of ammo|ammo pickup") },
  { key: "body_armor", category: "weapons", label: "Body armor", words: w("body armou?r|armou?r (?:bar|vest)|bulletproof vest|heavy armou?r") },

  // Crime
  { key: "drive_by", category: "crime", label: "Drive-bys", words: w("drive-?bys?|shoots? from (?:a|the) (?:car|vehicle|window)|shooting from (?:a|the) (?:car|vehicle|window)") },
  { key: "run_over", category: "crime", label: "Running people over", words: w("runs? (?:over|down) (?:a |the )?(?:pedestrian|ped|person|man|woman|npc)|hits? (?:a |the )?pedestrian|hit and run") },
  { key: "mugging", category: "crime", label: "Mugging people", words: w("mugg(?:ing|ed|er|ers)|mugs? (?:a |the )?(?:pedestrian|person|man|woman|npc)|robs? (?:a |the )?(?:pedestrian|person|man|woman|npc)|steals? (?:a |the )?wallet") },
  { key: "break_in", category: "crime", label: "Breaking in", words: w("break(?:s|ing)? in(?:to)?|broke into|lock ?pick(?:s|ing)?|forces? (?:the |a )?door|smash(?:es|ing)? (?:the |a )?window") },
  { key: "assassination", category: "crime", label: "Assassinations and hits", words: w("assassinat(?:e|es|ed|ion|ions)|hit ?man|contract kill|target eliminated|payphone hits?") },
  { key: "hostage", category: "crime", label: "Hostages", words: w("hostages?") },
  { key: "drug_business", category: "crime", label: "Drug labs and deals", words: w("meth lab|cocaine (?:lockup|lab)|weed farm|drug (?:deals?|labs?|runs?|bust|shipments?)|acid lab") },
  { key: "vandalism", category: "crime", label: "Smashing and destroying things", words: w("vandal(?:i[sz]e|i[sz]es|ism)|destroy(?:s|ing|ed)? (?:a |the )?(?:car|vehicle|property|truck|van)|sets? (?:a |the )?(?:car|vehicle) on fire") },
  { key: "stealth", category: "crime", label: "Stealth and sneaking", words: w("stealth(?:ily)?|sneak(?:s|ing|y)?|crouch(?:es|ing)?|silenced|suppressor|takedown|undetected|without being seen") },
  { key: "getaway", category: "crime", label: "Getaways", words: w("getaway|gets? away|flee(?:s|ing)? the scene|escap(?:e|es|ed|ing) (?:in|on|by|with|from|the scene)") },
  { key: "prison", category: "crime", label: "Prison and jail", words: w("prison|jail|bolingbroke|cell ?block|inmates?|jail ?break|prison break") },

  // More police
  { key: "swat", category: "police", label: "SWAT, FIB and the army", words: w("swat|noose|fib (?:agents?|building)|iaa|federal agents?|military response|army (?:response|soldiers?)|soldiers") },
  { key: "surrender", category: "police", label: "Hands up and surrendering", words: w("hands up|surrender(?:s|ing|ed)?|gives? up to (?:the )?(?:police|cops)") },
  { key: "police_station", category: "police", label: "Police stations", words: w("police station|mission row station|precinct|sheriff'?s (?:office|station)") },
  { key: "sirens", category: "police", label: "Sirens", types: ["siren"], words: w("sirens?") },

  // Stunts and tricks
  { key: "drift", category: "stunts", label: "Drifting", words: w("drift(?:s|ing|ed)?|slides? sideways|handbrake turns?") },
  { key: "wheelie", category: "stunts", label: "Wheelies", words: w("wheelies?|stoppies?|on one wheel") },
  { key: "burnout", category: "stunts", label: "Burnouts and donuts", words: w("burnouts?|(?:does|doing) donuts|spins? (?:the )?wheels|tire smoke|tyre smoke") },
  { key: "bail_out", category: "stunts", label: "Bailing out", words: w("bails? out|jumps? out of (?:the |a )?(?:car|vehicle|plane|helicopter|jet)|ejects?") },
  { key: "rollover", category: "stunts", label: "Rolling and flipping vehicles", words: w("rolls? (?:over|the car)|flips? (?:the car|over)|upside down|on its roof|barrel rolls?") },
  { key: "base_jump", category: "stunts", label: "Base jumping", words: w("base jump(?:s|ing)?|jumps? off (?:a |the )?(?:building|roof|cliff|tower|bridge|dam)") },
  { key: "under_bridge", category: "stunts", label: "Under bridges and between buildings", words: w("under (?:the |a )?bridge|knife[- ]fl(?:y|ies|ying|ight)|between (?:the )?(?:buildings|skyscrapers)") },
  { key: "rooftop_landing", category: "stunts", label: "Landing on rooftops", words: w("lands? on (?:a |the )?(?:roof|rooftop|helipad)|rooftop landing|helipad") },

  // Getting around the map
  { key: "interior", category: "places", label: "Getting inside buildings", words: w("goes inside|enters? (?:the |a |an )?(?:building|house|warehouse|office|club|store|bank|hospital)|inside (?:the |a |an )?(?:building|house|warehouse|office|bank|club|store)|building interior|way inside|gets inside|indoors") },
  { key: "rooftop", category: "places", label: "Rooftops", words: w("rooftops?|on (?:the |a )?(?:building'?s )?roof(?! of (?:the |a |his |her )?(?:car|van|truck|vehicle|bus))") },
  { key: "tunnel", category: "places", label: "Tunnels and storm drains", words: w("tunnels?|storm drains?|sewers?|underground|culverts?|la river") },
  { key: "bridge", category: "places", label: "Bridges", words: w("bridges?|overpass(?:es)?") },
  { key: "docks", category: "places", label: "Docks and the port", words: w("docks?|shipping containers?|cargo ships?|container yard|harbou?r|port of los santos") },
  { key: "construction", category: "places", label: "Construction sites", words: w("construction sites?|cranes?|scaffolding|unfinished building") },
  { key: "military_base", category: "places", label: "Military base", words: w("military base|fort zancudo|army base|restricted area") },
  { key: "landmark", category: "places", label: "Landmarks", types: ["landmark"] },
  { key: "secrets", category: "places", label: "Secrets and easter eggs", words: w("easter eggs?|secret (?:areas?|rooms?|locations?|doors?|entrances?|passages?)|hidden (?:areas?|rooms?|locations?|doors?|entrances?|passages?|items?)|ufos?|bigfoot|sasquatch|aliens?|mystery") },
  { key: "collectibles", category: "places", label: "Collectibles", words: w("collectibles?|spaceship parts?|letter scraps?|playing cards|action figures?|signal jammers?|movie props?|hidden packages?|peyote") },
  { key: "freeway", category: "places", label: "Freeways and highways", words: w("freeways?|highways?|interstate|great ocean highway") },
  { key: "sunset", category: "places", label: "Sunrise and sunset", words: w("sunset|sunrise|dusk|dawn|golden hour") },

  // Animals and nature
  { key: "dogs", category: "nature", label: "Dogs (Chop too)", words: w("dogs?|chop(?! shop)|husky|rottweiler|poodle|retriever") },
  { key: "wildlife", category: "nature", label: "Wild animals", words: w("deer|coyotes?|cougars?|mountain lions?|boars?|rabbits?|hawks?|crows?|seagulls?|pigeons?|wildlife") },
  { key: "sea_life", category: "nature", label: "Sharks and sea life", words: w("sharks?|whales?|dolphins?|stingrays?") },
  { key: "farm_animals", category: "nature", label: "Farm animals", words: w("cows?|horses?|cattle|livestock") },
  { key: "animal_attack", category: "nature", label: "Animal attacks", words: w("attacked by (?:a |an )?(?:cougar|mountain lion|shark|dog|boar)|mauled|bitten by") },

  // More money and businesses (GTA Online)
  { key: "nightclub", category: "money", label: "Nightclubs", words: w("nightclubs?|dance floor|dj booth") },
  { key: "bunker", category: "money", label: "Bunker and gunrunning", words: w("bunker|gunrunning|mobile operations center") },
  { key: "ceo", category: "money", label: "CEO, VIP and cargo", words: w("ceo|vip work|securoserv|special cargo|vehicle cargo") },
  { key: "mc_business", category: "money", label: "Motorcycle club", words: w("motorcycle club|mc clubhouse|clubhouse|biker business") },
  { key: "auto_shop", category: "money", label: "Auto shop and car meet", words: w("auto shop|car meet|test track|exotic exports") },
  { key: "agency", category: "money", label: "Agency and contracts", words: w("agency|security contracts?|vip contracts?") },
  { key: "salvage", category: "money", label: "Salvage yard and chop shop", words: w("salvage yard|chop shop|robbery project") },
  { key: "payout", category: "money", label: "Getting paid", words: w("payouts?|heist (?:payout|cut)|takes? (?:the |a )?cut|money (?:earned|received)|earned \\$") },

  // More missions
  { key: "heist_prep", category: "missions", label: "Heist setups and preps", words: w("setup missions?|heist preps?|prep missions?|scope(?:s|d)? out|scouting|planning board|casing the (?:store|bank|jewel(?:ry|lery)? store|place)") },
  { key: "strangers", category: "missions", label: "Strangers and Freaks", words: w("strangers and freaks|epsilon program|epsilonism|cris formage|mrs\\.? thornhill|beverly felton") },
  { key: "random_event", category: "missions", label: "Random events", words: w("random events?|hitchhik(?:er|ers|ing)") },
  { key: "escort", category: "missions", label: "Escorting and protecting", words: w("escort(?:s|ing)?|protect(?:s|ing)? (?:the |a )?(?:target|vip|convoy|truck|package)|bodyguard|defend(?:s|ing)? (?:the )?(?:area|point|position)") },
  { key: "chase_target", category: "missions", label: "Chasing a target", words: w("chas(?:e|es|ing) (?:the |a )?(?:target|thief|suspect|car|vehicle|van|truck)|following (?:the |a )?(?:target|car|vehicle)|tail(?:s|ing) (?:the |a )?(?:car|target)") },
  { key: "delivery", category: "missions", label: "Deliveries", words: w("deliver(?:s|ing|y)? (?:the |a )?(?:car|vehicle|package|cargo|goods|truck|van)|drop[- ]off (?:point|location)") },
  { key: "timer", category: "missions", label: "Against the clock", words: w("time (?:left|remaining|limit)|countdown|timer|before time runs out") },

  // More people, phone and roleplay
  { key: "character_switch", category: "social", label: "Switching characters", words: w("character (?:switch|wheel)|switch(?:es|ing)? (?:to )?(?:michael|franklin|trevor)") },
  { key: "special_ability", category: "social", label: "Special abilities", words: w("special ability|slow[- ]?motion|bullet time|red mist") },
  { key: "dancing", category: "social", label: "Dancing and parties", words: w("danc(?:e|es|ing)|part(?:y|ies)|club night") },
  { key: "drunk", category: "social", label: "Drunk and stumbling", words: w("drunk|stumbl(?:e|es|ing)|tipsy|hungover") },
  { key: "emote", category: "social", label: "Emotes and gestures", words: w("emotes?|gestures?|middle finger|waves? at|thumbs up|salutes?") },
  { key: "gym", category: "social", label: "Working out", words: w("gym|muscle beach|pull-?ups?|bench press|working out|lift(?:s|ing) weights") },
  { key: "radio", category: "social", label: "Radio and music", words: w("radio stations?|radio|music|songs?|non stop pop|flylo fm|west coast classics") },
  { key: "internet", category: "social", label: "In-game internet and TV", words: w("eyefind|lifeinvader|website|browser|laptop|computer screen|watches? tv|television|movie theater|cinema") },

  // More GTA Online
  { key: "adversary", category: "online", label: "Adversary modes", words: w("adversary modes?|team deathmatch|capture (?:mode|job)|last team standing|king of the hill") },
  { key: "survival", category: "online", label: "Survivals", words: w("survival mode|survivals?|waves? of enemies|wave \\d+") },
  { key: "griefing", category: "online", label: "Griefers", words: w("griefers?|griefing|spawn kill(?:s|ing)?|tryhards?") },
  { key: "passive", category: "online", label: "Passive mode and hiding", words: w("passive mode|ghost organi[sz]ation|off the radar") },
  { key: "cayo", category: "online", label: "Cayo Perico and the submarine", words: w("kosatka|cayo perico|el rubio|drainage tunnel") },

  // Glitches and bugs
  { key: "glitch", category: "glitches", label: "Glitches", words: w("glitch(?:es|ed|ing|y)?|bug(?:ged|gy)?|exploits?") },
  { key: "stuck", category: "glitches", label: "Stuck in the world", words: w("stuck (?:in|on|under|inside) (?:the |a )?(?:wall|ground|floor|map|geometry|rock|building|car|terrain)|f(?:alls?|ell|alling) through the (?:map|floor|ground|world)|glitch(?:es|ed|ing)? through|under the map|clip(?:s|ping|ped)? through|floating (?:cars?|vehicles?|in (?:the )?(?:air|mid-?air))") },
  { key: "softlock", category: "glitches", label: "Softlocks and broken missions", words: w("soft ?lock(?:s|ed)?|mission (?:won't|will not|doesn't|does not) (?:start|progress|continue|end)|can'?t progress|objective (?:missing|not appearing)|broken mission") },
  { key: "physics", category: "glitches", label: "Physics going wild", words: w("ragdoll(?:s|ing|ed)?|launched (?:into the air|into space|across the map)|spinning out of control|physics (?:glitch|bug)") },
  { key: "game_error", category: "glitches", label: "Game crashes and errors", words: w("game crash(?:es|ed)?|crash(?:es|ed)? to (?:desktop|dashboard|home screen)|error (?:screen|message|code)|alert screen|connection lost|disconnected|transaction failed|infinite loading") },
  { key: "lag", category: "glitches", label: "Lag and desync", words: w("lag(?:gy|ging|s)?|desync(?:ed|s)?|rubber ?band(?:ing)?|frame (?:drops?|rate drops?)|stutter(?:s|ing)?|low fps") },
  { key: "textures", category: "glitches", label: "Textures not loading", words: w("textures? (?:not loading|missing|loading in)|low[- ]res(?:olution)? textures?|invisible (?:car|road|building|wall|floor)|pop[- ]in") },

  // On stream
  { key: "stream_alert", category: "stream", label: "Stream alerts", words: w("new (?:subscriber|follower)s?|gifted subs?|donat(?:ed|ion|ions)|cheered \\d+|bits alert|raid(?:ed)? (?:by|with) \\d+") },
  { key: "talk_to_chat", category: "stream", label: "Talking to chat", words: w("talks? to (?:the )?chat|reads? (?:the )?chat|tells? (?:the )?chat|chat (?:says|asks|votes?)|thanks? (?:you )?(?:for )?the (?:sub|follow|donation|bits|raid)") },
  { key: "facecam", category: "stream", label: "Facecam moments", words: w("face ?cam|web ?cam|streamer (?:laughs|reacts|screams|smiles|cheers|yells|facepalms)") },
  { key: "rage", category: "stream", label: "Rage moments", words: w("rage ?quit(?:s|ting)?|throws? (?:the )?controller|furious|yells? at|slams? (?:the )?desk") },
  { key: "celebration", category: "stream", label: "Celebrations", words: w("celebrat(?:e|es|ing|ion|ions)|gg|fist pump|we did it|finally passed") },

  // More of everything
  { key: "flight_school", category: "fun", label: "Flight school", words: w("flight school") },
  { key: "fairground", category: "fun", label: "Pier rides and the fairground", words: w("ferris wheel|roller ?coaster|fairground|pier rides?") },
  { key: "paparazzi", category: "fun", label: "Paparazzi photos", words: w("paparazz(?:i|o)") },
  { key: "bounty_hunting", category: "fun", label: "Bounty hunting", words: w("bounty (?:hunt(?:ing|er|ers)?|targets?)|bail ?bonds?") },
  { key: "treasure_hunt", category: "fun", label: "Treasure hunts", words: w("treasure (?:hunt|chest|map)|buried (?:stash|treasure)") },
  { key: "custom_jobs", category: "online", label: "Player-made jobs", words: w("custom jobs?|player-?made (?:races?|jobs?|deathmatch(?:es)?)|creator jobs?") },
  { key: "bank", category: "money", label: "Banks", words: w("banks?|fleeca|pacific standard|blaine county savings") },
  { key: "rp_jobs", category: "social", label: "Roleplay jobs and shifts", words: w("(?:tow|taxi|bus|delivery|garbage|mechanic|ems|police) (?:job|shift)|clocks? (?:in|out)|on duty|paycheck") },
  { key: "jewelry_store", category: "crime", label: "Jewelry store robberies", words: w("jewel(?:ry|lery) store|vangelico|display cases?") },
  { key: "headshot", category: "combat", label: "Headshots", words: w("headshots?") },
  { key: "cover", category: "combat", label: "Taking cover", words: w("takes? cover|behind cover|in cover|cover system") },
  { key: "fight_police", category: "combat", label: "Fighting the police", words: w("shoot(?:s|ing)? (?:at )?(?:the )?(?:police|cops|officers)|kills? (?:a |the )?(?:cop|police officer)|firefight with (?:the )?police") },
  { key: "classic_car", category: "vehicles", label: "Classic cars", words: w("classic cars?|vintage cars?|sports classics?") },
  { key: "npc_moment", category: "glitches", label: "Strange NPC moments", words: w("npcs? (?:glitch(?:es|ing)?|stuck|walks? into|falls?|t-?pos(?:e|ing))|pedestrians? (?:stuck|glitch(?:es|ing)?)|t-?pos(?:e|ing)") },
  { key: "fire", category: "world", label: "Fires", words: w("on fire|burning|flames|fire spreads|wildfire|sets? (?:a |the )?\\w+ on fire") },
  { key: "sinking", category: "vehicles", label: "Sinking and driving into water", words: w("sinks?|sinking|drives? (?:off|into) (?:the |a )?(?:water|ocean|sea|lake|river|pier)|underwater (?:car|vehicle)") },
  { key: "hacking", category: "missions", label: "Hacking", words: w("hack(?:s|ing|ed)?|fingerprint (?:hack|scanner)|keypad|hacking device") },
  { key: "drilling", category: "missions", label: "Drilling vaults and safes", words: w("drill(?:s|ing)? (?:the |a |into )?(?:vault|safe|box|lock|door)|thermal charges?|safe ?crack(?:ing|er)?") },
  { key: "disguise", category: "missions", label: "Masks and disguises", words: w("disguise(?:s|d)?|masks?|balaclavas?") },
  { key: "loot", category: "missions", label: "Grabbing the loot", words: w("loot(?:s|ing)?|grabs? (?:the )?(?:cash|gold|diamonds|art|paintings|jewel(?:ry|s))|duffel bags?") },
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
  // A car's name shows where the area name does when the player gets in: a vehicle, not a place.
  const vehicle = entry.type === "place_name" ? vehicleName(entry.rawText) : null;
  if (vehicle) tags.add("act:driving");
  if ((entry.type === "place_name" && !vehicle) || entry.type === "landmark") {
    // A landmark the AI described in its own words isn't a name; only text read on screen is.
    const raw = entry.rawText ?? (entry.type === "place_name" ? entry.description.replace(/^(?:place|landmark)(?: name)?(?: read)?:?\s*/i, "") : null);
    const p = raw ? normalizePlace(raw) : null;
    if (p) tags.add(`place:${p}`);
  }
  // A weapon's name read on its own: the weapon wheel.
  if (entry.origin === "ocr" && entry.type === "visible_text" && weaponName(entry.rawText)) tags.add("act:weapon_wheel");
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
