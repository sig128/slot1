/**
 * GTA V's own names for things, so a name read on screen is recognized for what it is: a car's
 * name (shown when the player gets in) isn't a place, and a weapon's name (shown on the weapon
 * wheel) is a weapon. Only whole lines that are exactly one of these names count, never a word
 * inside a sentence, because many of them are ordinary words too ("Bullet", "Surge").
 */

/** Vehicle makers, as the game writes them. */
export const GTA_VEHICLE_MAKERS: string[] = [
  "Albany", "Annis", "Benefactor", "BF", "Bollokan", "Bravado", "Brute", "Buckingham", "Canis", "Chariot", "Cheval", "Coil",
  "Declasse", "Dewbauchee", "Dinka", "Dundreary", "Emperor", "Enus", "Fathom", "Gallivanter", "Grotti", "Hijak", "HVY", "Imponte",
  "Invetero", "JoBuilt", "Karin", "Lampadati", "Maibatsu", "Mammoth", "MTL", "Nagasaki", "Obey", "Ocelot", "Overflod", "Pegassi",
  "Pfister", "Principe", "Progen", "Rune", "Schyster", "Shitzu", "Stanley", "Truffade", "Ubermacht", "Übermacht", "Vapid", "Vulcar",
  "Vysser", "Weeny", "Western", "Willard", "Zirconium",
];

/** Vehicle models, as the game writes them. */
export const GTA_VEHICLES: string[] = [
  // Super and sports
  "Adder", "Autarch", "Banshee", "Banshee 900R", "Bestia GTS", "Bullet", "Carbonizzare", "Cheetah", "Cheetah Classic", "Comet", "Coquette",
  "Cyclone", "Deveste Eight", "Elegy RH8", "Elegy Retro Custom", "Emerus", "Entity XF", "Entity XXR", "ETR1", "Feltzer", "FMJ", "Furore GT",
  "Fusilade", "Futo", "GP1", "Infernus", "Itali GTB", "Itali GTO", "Jester", "Jester Classic", "Khamelion", "Krieger", "Kuruma", "Lynx",
  "Massacro", "Nero", "Ninef", "Omnis", "Osiris", "Penetrator", "Pfister 811", "Rapid GT", "Reaper", "Schafter", "Schlagen GT", "Seven-70",
  "Sultan", "Sultan RS", "Surano", "T20", "Taipan", "Tempesta", "Tezeract", "Thrax", "Turismo R", "Tyrant", "Tyrus", "Vacca", "Vagner",
  "Visione", "Voltic", "X80 Proto", "XA-21", "Zentorno", "Zorrusso", "Ignus", "Zeno", "Comet S2", "Jugular", "Calico GTF", "ZR350", "Euros",
  "Growler", "Vectre", "Remus", "Cypher", "Comet Retro Custom",
  // Muscle and classics
  "Blade", "Buccaneer", "Chino", "Coquette BlackFin", "Coquette Classic", "Dominator", "Dominator GTX", "Dukes", "Ellie", "Faction",
  "Gauntlet", "Hermes", "Hotknife", "Hustler", "Impaler", "Imperator", "Nightshade", "Phoenix", "Picador", "Rat-Loader", "Ruiner",
  "Sabre Turbo", "Slamvan", "Stallion", "Tampa", "Tulip", "Vamos", "Vigero", "Virgo", "Voodoo", "Yosemite", "Casco", "JB 700", "Mamba",
  "Manana", "Monroe", "Peyote", "Pigalle", "Roosevelt", "Stinger", "Stinger GT", "Stirling GT", "Swinger", "Torero", "Tornado", "Z-Type",
  "Rapid GT Classic", "Retinue", "Savestra", "Viseris", "Cheburek", "Fagaloa", "Michelli GT",
  // Sedans, coupes, compacts
  "Asea", "Asterope", "Cognoscenti", "Emperor", "Exemplar", "F620", "Felon", "Fugitive", "Glendale", "Ingot", "Intruder", "Jackal",
  "Oracle", "Premier", "Primo", "Regina", "Romero Hearse", "Schafter V12", "Sentinel", "Stafford", "Stanier", "Stratum", "Stretch",
  "Super Diamond", "Surge", "Tailgater", "Warrener", "Washington", "Windsor", "Zion", "Blista", "Brioso R/A", "Dilettante", "Issi",
  "Panto", "Prairie", "Rhapsody", "Club",
  // SUVs, off-road, vans, trucks
  "Baller", "BeeJay XL", "Cavalcade", "Contender", "Dubsta", "FQ 2", "Granger", "Gresley", "Habanero", "Huntley S", "Landstalker",
  "Mesa", "Novak", "Patriot", "Radius", "Rebla GTS", "Rocoto", "Seminole", "Serrano", "Toros", "XLS", "Bifta", "Blazer", "Bodhi",
  "Brawler", "Caracara", "Dune Buggy", "Injection", "Kamacho", "Rebel", "Sandking", "Trophy Truck", "Desert Raid", "Riata", "Everon",
  "Bison", "Bobcat XL", "Burrito", "Camper", "Gang Burrito", "Journey", "Minivan", "Paradise", "Pony", "Rumpo", "Speedo", "Surfer",
  "Youga", "Benson", "Biff", "Hauler", "Mule", "Packer", "Phantom", "Phantom Wedge", "Pounder", "Stockade", "Boxville", "Flatbed",
  "Tow Truck", "Trashmaster", "Tipper", "Mixer", "Dozer", "Forklift", "Tractor", "Lawn Mower", "Caddy", "Airtug", "Ripley",
  // Emergency, service, military
  "Ambulance", "Fire Truck", "Police Cruiser", "Police Buffalo", "Police Interceptor", "Police Transporter", "Police Rancher",
  "Sheriff Cruiser", "Riot", "FIB", "Lifeguard", "Park Ranger", "Bus", "Coach", "Airport Bus", "Dashound", "Rental Shuttle Bus", "Taxi",
  "Barracks", "Crusader", "Rhino Tank", "Khanjali", "APC", "Half-track", "Insurgent", "Insurgent Pick-Up", "Technical", "Nightshark",
  "Menacer", "Barrage", "Chernobog", "TM-02 Khanjali", "Thruster", "Oppressor", "Oppressor Mk II", "Deluxo", "Stromberg", "Toreador",
  "Scramjet", "Vigilante", "Ruiner 2000", "Weaponized Tampa", "Armored Kuruma", "Duke O'Death",
  // Motorcycles and bicycles
  "Akuma", "Avarus", "Bagger", "Bati 801", "Bati 801RR", "BF400", "Carbon RS", "Chimera", "Cliffhanger", "Daemon", "Defiler",
  "Double-T", "Enduro", "Esskey", "Faggio", "Fcr 1000", "Gargoyle", "Hakuchou", "Hakuchou Drag", "Hexer", "Innovation", "Lectro",
  "Manchez", "Nemesis", "Nightblade", "PCJ 600", "Ratbike", "Ruffian", "Sanchez", "Sanctus", "Shotaro", "Sovereign", "Thrust",
  "Vader", "Vindicator", "Vortex", "Wolfsbane", "Zombie Bobber", "Zombie Chopper", "Shinobi", "Reever", "BMX", "Cruiser", "Fixter",
  "Scorcher", "Tri-Cycles Race Bike", "Whippet Race Bike", "Endurex Race Bike",
  // Aircraft
  "Alpha-Z1", "Avenger", "Besra", "Bombushka", "Cargo Plane", "Cuban 800", "Dodo", "Duster", "Howard NX-25", "Hydra", "Jet",
  "Lazer", "Luxor", "Luxor Deluxe", "Mallard", "Mammatus", "Miljet", "Mogul", "Molotok", "Nimbus", "Nokota", "Pyro", "Rogue",
  "Seabreeze", "Shamal", "Starling", "Strikeforce", "Stunt", "Titan", "Tula", "Ultralight", "Velum", "Vestra", "Volatol", "Akula",
  "Annihilator", "Buzzard", "Buzzard Attack Chopper", "Cargobob", "Frogger", "Havok", "Hunter", "Maverick", "Police Maverick",
  "Savage", "Sea Sparrow", "Skylift", "Sparrow", "Super Volito", "Swift", "Swift Deluxe", "Valkyrie", "Volatus", "Blimp",
  // Boats
  "Dinghy", "Jetmax", "Kosatka", "Kraken", "Marquis", "Seashark", "Speeder", "Squalo", "Submersible", "Suntrap", "Toro", "Tropic",
  "Tug", "Longfin", "Weaponized Dinghy", "Police Predator",
];

/** Weapons, as the weapon wheel writes them. */
export const GTA_WEAPONS: string[] = [
  "Pistol", "Combat Pistol", "AP Pistol", "Pistol .50", "SNS Pistol", "Heavy Pistol", "Vintage Pistol", "Marksman Pistol", "Heavy Revolver",
  "Double-Action Revolver", "Ceramic Pistol", "Navy Revolver", "Perico Pistol", "Stun Gun", "Flare Gun", "Up-n-Atomizer",
  "Micro SMG", "SMG", "Assault SMG", "Combat PDW", "Machine Pistol", "Mini SMG", "Gusenberg Sweeper", "MG", "Combat MG", "Unholy Hellbringer",
  "Assault Rifle", "Carbine Rifle", "Advanced Rifle", "Special Carbine", "Bullpup Rifle", "Compact Rifle", "Military Rifle", "Heavy Rifle",
  "Service Carbine", "Pump Shotgun", "Sawed-Off Shotgun", "Assault Shotgun", "Bullpup Shotgun", "Musket", "Heavy Shotgun",
  "Double Barrel Shotgun", "Sweeper Shotgun", "Combat Shotgun", "Sniper Rifle", "Heavy Sniper", "Marksman Rifle", "Precision Rifle",
  "RPG", "Grenade Launcher", "Minigun", "Firework Launcher", "Railgun", "Homing Launcher", "Compact Grenade Launcher", "Widowmaker",
  "Compact EMP Launcher", "Grenade", "BZ Gas", "Tear Gas", "Molotov Cocktail", "Sticky Bomb", "Proximity Mine", "Pipe Bomb", "Snowball",
  "Knife", "Nightstick", "Hammer", "Baseball Bat", "Crowbar", "Golf Club", "Broken Bottle", "Antique Cavalry Dagger", "Hatchet",
  "Knuckle Duster", "Machete", "Flashlight", "Switchblade", "Pool Cue", "Pipe Wrench", "Battle Axe", "Stone Hatchet", "Parachute",
  "Jerry Can", "Fire Extinguisher",
];

const key = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const vehicleKeys = new Map(GTA_VEHICLES.map((v) => [key(v), v]));
const makerKeys = new Map(GTA_VEHICLE_MAKERS.map((m) => [key(m), m]));
const weaponKeys = new Map(GTA_WEAPONS.map((w) => [key(w), w]));

/** The vehicle a whole line of on-screen text names ("PEGASSI ZENTORNO", "Bati 801"), or null. */
export function vehicleName(line: string | null | undefined): string | null {
  if (!line) return null;
  const k = key(line);
  if (!k || k.length > 40) return null;
  const direct = vehicleKeys.get(k);
  if (direct) return direct;
  // "<maker> <model>": the model has to be one the game has too.
  const [first, ...rest] = k.split(" ");
  const maker = makerKeys.get(first ?? "");
  const model = rest.length ? vehicleKeys.get(rest.join(" ")) : undefined;
  return maker && model ? `${maker} ${model}` : null;
}

/** The weapon a whole line of on-screen text names ("Combat Pistol"), or null. */
export function weaponName(line: string | null | undefined): string | null {
  if (!line) return null;
  return weaponKeys.get(key(line)) ?? null;
}

/** Every known vehicle and weapon name, normalized, for matching in the database. */
export function gtaNameKeys(): { vehicles: string[]; weapons: string[] } {
  return { vehicles: [...vehicleKeys.keys()], weapons: [...weaponKeys.keys()] };
}
