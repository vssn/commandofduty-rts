/** Half size of the playable area (world units). The map spans -MAP_HALF..MAP_HALF on x and z. */
export const MAP_HALF = 120;
/** Half size of the rendered terrain, larger than the playable area so the camera never sees the void. */
export const TERRAIN_HALF = 185;
/** Terrain grid cells per side. */
export const TERRAIN_RES = 280;

export type Team = 0 | 1;
export const PLAYER: Team = 0;
export const ENEMY: Team = 1;

export type UnitType = "rifleman" | "grenadier" | "jeep";

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
export type GameMode = "base" | "skirmish";

/** Skirmish: starting forces per side (no reinforcements) and starting credits. */
export const SKIRMISH = {
  forces: { rifleman: 10, grenadier: 5, jeep: 2 } as Record<UnitType, number>,
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
export const SIGHT = { rifleman: 18, grenadier: 17, jeep: 21, barracks: 20, outpost: 13 };

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

export type OutpostKind = "depot" | "bunker" | "trench" | "tower" | "workshop";

/** Capturable map objects. Income is credits per second while owned. */
export const OUTPOSTS: Record<OutpostKind, { name: string; income: number; radius: number }> = {
  depot: { name: "Vorratsstation", income: 3, radius: 7.5 },
  bunker: { name: "Unterstand", income: 2, radius: 6.5 },
  trench: { name: "Schützengraben", income: 1.5, radius: 8 },
  tower: { name: "Wachturm", income: 2, radius: 6.5 },
  /** Near each base; the owner can build jeeps here. */
  workshop: { name: "Werkstatt", income: 1, radius: 9 },
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
