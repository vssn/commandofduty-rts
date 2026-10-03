/** Half size of the playable area (world units). The map spans -MAP_HALF..MAP_HALF on x and z. */
export const MAP_HALF = 120;
/** Half size of the rendered terrain, larger than the playable area so the camera never sees the void. */
export const TERRAIN_HALF = 205;
/** Terrain grid cells per side. */
export const TERRAIN_RES = 310;

export type Team = 0 | 1;
export const PLAYER: Team = 0;
export const ENEMY: Team = 1;

export type UnitType = "rifleman" | "grenadier" | "jeep" | "agent" | "medic" | "drone" | "pilot" | StructureType;
/** Buildable defences (conquest): they share the unit machinery (targeting, damage, MG, gunner) but never move. */
export type StructureType = "mgnest" | "bollard";

export interface UnitStats {
  name: string;
  plural: string;
  cost: number;
  buildTime: number;
  hp: number;
  speed: number;
  /** Max turn rate in rad/s (vehicles turn slowly). */
  turn: number;
  range: number;
  acquire: number;
  damage: number;
  cooldown: number;
  radius: number;
  vehicle: boolean;
  /** Relative weight when units push each other aside. */
  mass: number;
  /** Built structure: stationary, placed near own outposts or the base. */
  structure?: boolean;
  /** Flies (drone): not pushed around by ground units, ignores obstacles. */
  flying?: boolean;
}

export const UNITS: Record<UnitType, UnitStats> = {
  rifleman: {
    name: "Soldat", plural: "Soldaten", cost: 100, buildTime: 4, hp: 100, speed: 4.4, turn: 11,
    range: 11, acquire: 15, damage: 9, cooldown: 1.0, radius: 0.55, vehicle: false, mass: 1,
  },
  grenadier: {
    name: "Grenadier", plural: "Grenadiere", cost: 150, buildTime: 5, hp: 90, speed: 4.2, turn: 11,
    range: 13, acquire: 16, damage: 55, cooldown: 3.6, radius: 0.55, vehicle: false, mass: 1,
  },
  jeep: {
    name: "Geländewagen", plural: "Geländewagen", cost: 400, buildTime: 8, hp: 360, speed: 9, turn: 2.6,
    range: 15, acquire: 17, damage: 13, cooldown: 0.12, radius: 1.8, vehicle: true, mass: 8,
  },
  /** Unarmed; heals one wounded soldier at a time (see MEDIC). Built at a field hospital. */
  medic: {
    name: "Sanitäter", plural: "Sanitäter", cost: 150, buildTime: 5, hp: 80, speed: 3.8, turn: 11,
    range: 0, acquire: 0, damage: 0, cooldown: 1, radius: 0.55, vehicle: false, mass: 1,
  },
  /** Sandbagged machine-gun position; fires only while a soldier mans it. */
  mgnest: {
    name: "MG-Nest", plural: "MG-Nester", cost: 400, buildTime: 6, hp: 480, speed: 0, turn: 0,
    range: 16, acquire: 18, damage: 13, cooldown: 0.12, radius: 1.45, vehicle: true, mass: 1000, structure: true,
  },
  /** Row of concrete bollards: vehicles cannot pass, infantry walks between the posts. */
  bollard: {
    name: "Poller", plural: "Poller", cost: 50, buildTime: 2, hp: 260, speed: 0, turn: 0,
    range: 0, acquire: 0, damage: 0, cooldown: 1, radius: 1.6, vehicle: true, mass: 1000, structure: true,
  },
  /** Commandos only: small FPV recon drone with a searchlight; cannot shoot. */
  drone: {
    name: "Drohne", plural: "Drohnen", cost: 0, buildTime: 0, hp: 20, speed: 7, turn: 4,
    range: 0, acquire: 0, damage: 0, cooldown: 1, radius: 0.6, vehicle: true, mass: 1, flying: true,
  },
  /** Commandos only: drone pilot, kneeling at his laptop at an outpost; his drone falls when he does. */
  pilot: {
    name: "Drohnenpilot", plural: "Drohnenpiloten", cost: 0, buildTime: 0, hp: 70, speed: 0, turn: 6,
    range: 0, acquire: 0, damage: 0, cooldown: 1, radius: 0.55, vehicle: false, mass: 2,
  },
  /** Commandos only: special agent in coat and cap. Fragile but fast; only fires when ordered. */
  agent: {
    name: "Agent", plural: "Agenten", cost: 0, buildTime: 0, hp: 60, speed: 6.6, turn: 12,
    range: 9, acquire: 0, damage: 14, cooldown: 0.9, radius: 0.5, vehicle: false, mass: 1,
  },
};

/**
 * Building defences (conquest). A structure may be placed within `outpostReach` of the edge of an
 * own outpost's area or within `baseReach` of the own barracks. Structures at an outpost change
 * hands when the outpost is taken; a manned MG nest prevents that until it is destroyed.
 */
export const BUILD = {
  outpostReach: 5,
  baseReach: 20,
  /** Footprints (half sizes); bollards only block vehicles. */
  footprint: { mgnest: { hw: 1.3, hd: 1.3 }, bollard: { hw: 1.65, hd: 0.3 } } as Record<StructureType, { hw: number; hd: number }>,
};

/**
 * Medic: treats one wounded soldier at a time, kneeling next to him. Only soldiers that are out of
 * combat (no shots fired or taken for `calm` seconds) can be treated; vehicles cannot.
 */
export const MEDIC = {
  /** HP restored per second while treating. */
  rate: 9,
  /** Distance at which treatment is possible. */
  reach: 1.6,
  /** Idle medics look for wounded comrades within this radius on their own. */
  search: 16,
  /** Seconds without firing or taking fire before a soldier counts as out of combat. */
  calm: 3,
};

/**
 * Terrain slope vs. speed. `grade` = height gain per unit of distance in the walking direction.
 * Uphill slows down (1 - grade * uphill), gentle downhill speeds up (1 + |grade| * downhill), clamped.
 * Vehicles feel slopes less (`vehicle` scales the effect).
 */
export const SLOPE = { uphill: 1.6, downhill: 0.6, min: 0.45, max: 1.2, vehicle: 0.6 };
/**
 * Roads and dirt tracks: on level ground units move as fast as walking downhill (`speed`). The
 * factor multiplies with the slope effect; the combined result is capped at `cap`.
 */
export const ROAD = { speed: 1.2, cap: 1.35 };

/** Game modes: "base" = build units at barracks/workshop; "skirmish" = fixed forces, credits buy artillery. */
export type GameMode = "base" | "skirmish" | "commandos";

/** Commandos: one agent against an enemy that holds the whole map. */
export const COMMANDOS = {
  /** Enemy outposts to blow up for victory. */
  targets: 6,
  /** Scharfschuss: kills any soldier outright, only scratches a vehicle. */
  sniper: { cooldown: 6, range: 42, vehicleDamage: 90 },
  /** Tarnen: invisible to the enemy for a few seconds (firing breaks it); long enough to slip past an MG nest. */
  cloak: { duration: 10, cooldown: 22 },
  /** Demolition charges: planted by hand on a vehicle or inside an outpost, then a short fuse. The agent starts without any. */
  charges: { count: 0, plantTime: 1.5, fuse: 5, damage: 900, radius: 5.5, reach: 2.6 },
  /** Hidden caches at the edge of woods, marked on the minimap; each holds `charges` charges. */
  caches: { count: 4, charges: 3, pickup: 1.8 },
  /** Seconds until the mission fails. */
  timeLimit: 600,
  /** Outposts that get a manned MG nest. */
  nests: 3,
  /**
   * Night: enemies spot the agent only at `dark` times their normal range, but at `lit` times it
   * when he stands in the light of a street lamp; a searchlight beam gives him away at once.
   */
  night: { dark: 0.55, lit: 1.25 },
  /**
   * Once more than `after` outposts are blown up the enemy turns aggressive: it notices the agent
   * sooner in the dark (`dark`), alarms reach further (`alertScale`) and drones take off.
   */
  escalation: { after: 1, dark: 0.75, alertScale: 1.5 },
  /**
   * Recon drones: fly at `altitude` above the ground and notice the (uncloaked) agent only when their
   * light catches him or he is right below them (`sight`); they keep him in their light while within
   * `trackSight` and lose him after `lose` seconds out of view.
   * The agent's rifle hits one only with `hitChance`, but a shot always draws its attention.
   */
  drones: { count: 2, altitude: 10.5, speed: 6.5, chase: 8.5, sight: 4.5, trackSight: 26, lose: 4, hitChance: 0.25, poolRadius: 4.5 },
  /** Searchlight beams sweep around each outpost (never farther than a soldier sees); the lit spot has this radius. */
  searchlight: { poolRadius: 3.4, near: 9, far: 17, lock: 4 },
  /** Enemy forces: guards per outpost, foot patrols (3 men each) and patrolling jeeps. */
  garrison: 2,
  patrols: 5,
  jeepPatrols: 2,
  /** Enemies within this distance of a spotting unit join the hunt. */
  alertRadius: 38,
};

/** Skirmish: starting forces per side (no reinforcements) and starting credits. Every jeep starts
 *  with its own MG gunner aboard (extra riflemen on top of the listed infantry). */
export const SKIRMISH = {
  forces: { rifleman: 10, grenadier: 5, medic: 2, jeep: 3 } as Record<"rifleman" | "grenadier" | "medic" | "jeep", number>,
  credits: 400,
};

/** Artillery strike ordered with credits (skirmish): a salvo of shells scattered around the target. */
export const ARTILLERY = {
  cost: 300,
  /** Seconds before the same side can order the next strike. */
  cooldown: 25,
  /** Seconds from the order until the first shell lands. */
  delay: 3.2,
  shells: 7,
  /** Seconds between impacts. */
  interval: 0.38,
  /** Shells land within this radius of the target. */
  spread: 6,
  damage: 65,
  blastRadius: 3.8,
};

/** How far units and structures of the player can see (fog of war). */
export const SIGHT = { rifleman: 18, grenadier: 17, medic: 16, jeep: 21, agent: 26, mgnest: 19, bollard: 3, drone: 15, pilot: 10, barracks: 20, outpost: 13 };

/** Grenades: area damage that also hurts friendly units (and the thrower) inside the blast. */
export const GRENADE = {
  /** Blast radius; damage falls off from 100 % in the centre to 40 % at the edge. */
  radius: 3.2,
  /** Landing scatter: fixed part plus a share of the throw distance. */
  scatterBase: 0.5,
  scatterPerUnit: 0.07,
  /** Grenades never land closer than this to the thrower. */
  minDistance: 4,
};

/** Jeep machine gun: fires in bursts and partly ignores cover and stance bonuses. */
export const JEEP_MG = {
  burst: 7,
  burstPause: 1.3,
  /** Share of the target's defensive bonuses (cover, stance, outpost) the MG ignores. */
  pierce: 0.5,
  /** Turret turn rate in rad/s. */
  turretTurn: 4,
  /** Distance at which a soldier climbs aboard. */
  boardDistance: 2.8,
};

/**
 * Combat modifiers. Hit chance of a shot = base + elevation bonus of the shooter
 * - defensive bonuses of the target (stance, cover, outpost), never below `minHit`.
 */
export const COMBAT = {
  baseHit: 0.78,
  minHit: 0.2,
  kneel: 0.08,
  prone: 0.16,
  cover: 0.15,
  outpost: 0.12,
  /** Height advantage (world units) from which the elevation bonus starts. */
  elevationMin: 1.5,
  elevationHit: 0.1,
  /** Extra range per unit of height advantage, capped. */
  elevationRangePerUnit: 0.5,
  elevationRangeMax: 4,
  /** Rifle bullets do little against the jeep's steel body. */
  rifleVsVehicle: 0.5,
};

export const BARRACKS_HP = 1500;
export const START_CREDITS = 1000;

export type OutpostKind = "hospital" | "bunker" | "trench" | "tower" | "workshop" | "radar";

/** Capturable map objects. Income is credits per second while owned. */
export const OUTPOSTS: Record<OutpostKind, { name: string; income: number; radius: number }> = {
  /** Field hospital: the owner can train medics here, and soldiers inside recover faster. */
  hospital: { name: "Feldlazarett", income: 3, radius: 7.5 },
  bunker: { name: "Unterstand", income: 2, radius: 6.5 },
  trench: { name: "Schützengraben", income: 1.5, radius: 8 },
  tower: { name: "Wachturm", income: 2, radius: 6.5 },
  /** Near each base; the owner can build jeeps here. */
  workshop: { name: "Werkstatt", income: 1, radius: 9 },
  /** Near each base; whoever holds it has the minimap (conquest). */
  radar: { name: "Radarturm", income: 1, radius: 7 },
};
/** One-time reward for the first team that takes an outpost. */
export const CAPTURE_BONUS = 200;
/**
 * Seconds needed to take an outpost. Progress only runs while at least one soldier and no enemy
 * soldier is inside the area; while contested it is paused.
 */
export const CAPTURE_TIME = 20;
/** HP per second regained by soldiers standing in an outpost their team owns (not while contested). */
export const OUTPOST_HEAL = 1;
/** Healing rate inside a field hospital instead of OUTPOST_HEAL. */
export const HOSPITAL_HEAL = 3;
