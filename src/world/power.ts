import { MAP_HALF } from "../config";
import { toLocal, toWorld, type MapLayout, type OutpostSpec, type V2 } from "./layout";
import { buildPowerLawns } from "./powerLawns";

/**
 * The Kohlekraftwerk (coal-fired power station): an asymmetric map by a harbour, laid out at angles.
 * The southern quay runs at 10° to the view, the western one tapers steeply (75°) towards the top
 * middle of the map, the northern quay closes it off; the east is green land. The plant stands turned
 * a little in the middle: the machine hall (its ground floor open to walk through, the storeys above
 * drawn see-through), the boiler house, a chimney and a cooling tower. Along both long sides of the hall
 * run raised walkways (6.5 m) - one can stand on them and underneath - that lead on to the bases: the
 * southern one east, then south to the player's base by the transformer yard; the northern one west,
 * then north to the enemy's base by the rail sidings. Platforms on them carry outposts; stairs lead up
 * and down. Water pipelines run from the northern quay to the cooling tower.
 */

/** Height of the walkways' floor (the hall's first floor). */
export const DECK_H = 6.5;

/** A rotated rectangle (centre, half sizes along its own x and z, rotation as `mesh.rotation.y`). */
export interface Box { x: number; z: number; hw: number; hd: number; rot: number }
/** A stair: a box rising along its own +z (top end at +hd, at DECK_H; bottom end at -hd, on the ground). */
export type Stair = Box;
/** A quay line: a point on it, its direction and the normal pointing onto land. */
export interface Quay { p: V2; d: V2; n: V2 }

export interface PowerPlant {
  /** Where the plant stands and how it is turned (its own frame: x along the hall). */
  centre: V2;
  rot: number;
  /** Walkways, galleries and platforms (their floor at DECK_H). */
  decks: Box[];
  stairs: Stair[];
  /** The machine hall, the boiler house at its eastern end (from `boilerX` in the hall's frame). */
  hall: Box & { boilerX: number; height: number; boilerHeight: number };
  tower: { x: number; z: number; r: number; height: number };
  chimney: { x: number; z: number; r: number; height: number };
  quays: { south: Quay; west: Quay; north: Quay };
  /** The paved compound (in the plant's frame). */
  compound: { x0: number; x1: number; z0: number; z1: number };
  /** Rail sidings along the northern quay: the tracks' offsets from the quay line, from x0 eastwards. */
  tracks: { offsets: number[]; x0: number };
  /** Coal wagons: position along the track (world x) and track index. */
  wagons: { x: number; track: number }[];
  /** The transformer yard (turned like the southern quay). */
  transformer: Box;
  /** High-voltage pylons from the yard eastwards out of the map. */
  pylons: V2[];
  pipes: V2[][];
  /** The coal bunker by the sidings (the wagons are emptied into it); the conveyor starts under it. */
  bunker: Box;
  /** Patches of bare earth in the lawns (ellipses; see powerLawns.ts). */
  earth: { x: number; z: number; rx: number; rz: number; rot: number }[];
  /** The coal conveyor: from the bunker's outlet (a) up to the boiler house (b, at height `top`). */
  conveyor: { a: V2; b: V2; top: number };
}

const DEG = Math.PI / 180;

/** Inside a rotated box (with a margin). */
export function inBox(b: Box, x: number, z: number, m = 0): boolean {
  const l = toLocal(b.x, b.z, b.rot, x, z);
  return Math.abs(l.x) <= b.hw + m && Math.abs(l.z) <= b.hd + m;
}

/** The height of the raised level at a point (a walkway, platform or stair), or null. */
export function deckHeight(P: PowerPlant, x: number, z: number): number | null {
  for (const d of P.decks) if (inBox(d, x, z)) return DECK_H;
  for (const s of P.stairs) {
    const l = toLocal(s.x, s.z, s.rot, x, z);
    if (Math.abs(l.x) <= s.hw && Math.abs(l.z) <= s.hd) return DECK_H * Math.min(1, Math.max(0, (l.z + s.hd) / (2 * s.hd)));
  }
  return null;
}

/** Signed distance from a quay line onto land (negative: in the water). */
export const quayDistance = (q: Quay, x: number, z: number) => (x - q.p.x) * q.n.x + (z - q.p.z) * q.n.z;
/** In the harbour (beyond any of the quays). */
export const inWater = (P: PowerPlant, x: number, z: number) =>
  quayDistance(P.quays.south, x, z) < 0 || quayDistance(P.quays.west, x, z) < 0 || quayDistance(P.quays.north, x, z) < 0;

/** A point at offset `o` from the northern quay line (onto land), at world x. */
/** Distance from (x, z) to the conveyor's line, seen from above. */
export function conveyorDistance(P: PowerPlant, x: number, z: number): number {
  const { a, b } = P.conveyor;
  const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
}

export function alongNorth(P: PowerPlant, x: number, o: number): V2 {
  const q = P.quays.north;
  const t = (x - q.p.x) / q.d.x;
  return { x: q.p.x + q.d.x * t + q.n.x * o, z: q.p.z + q.d.z * t + q.n.z * o };
}

export function buildPower(L: MapLayout) {
  L.suburbs.length = 0;
  L.forests.length = 0;
  L.playerBase.x = 38; L.playerBase.z = -86;
  L.enemyBase.x = -12; L.enemyBase.z = 80;

  const quay = (px: number, pz: number, angle: number, landLeft: boolean): Quay => {
    const d = { x: Math.cos(angle), z: Math.sin(angle) };
    // the land lies to the left of the direction (counter-clockwise normal) or to its right
    const n = landLeft ? { x: -d.z, z: d.x } : { x: d.z, z: -d.x };
    return { p: { x: px, z: pz }, d, n };
  };
  const C = { x: 18, z: 4 }, rot = 10 * DEG;
  /** From the plant's frame to the world. */
  const W = (lx: number, lz: number) => toWorld(C.x, C.z, rot, lx, lz);
  const box = (lx: number, lz: number, hw: number, hd: number, turn = 0): Box => ({ ...W(lx, lz), hw, hd, rot: rot + turn });
  /**
   * A stair whose top meets a deck at (lx, lz) of the plant's frame and that runs down in direction
   * `dir` (radians in the plant's frame, 0 = +x): 12 m long, 3.6 m wide.
   */
  const stair = (lx: number, lz: number, dir: number): Stair => {
    const len = 12, ux = Math.cos(dir), uz = Math.sin(dir);
    const cx = lx + ux * len / 2, cz = lz + uz * len / 2;
    // its own +z points up (back towards the deck): the box turns so that +z = -u
    const turn = Math.atan2(-ux, -uz);
    return { ...W(cx, cz), hw: 1.8, hd: len / 2, rot: rot + turn };
  };

  const P: PowerPlant = {
    centre: C, rot,
    decks: [
      // the southern gallery along the hall, on east, a platform, south to the player's base, a platform
      box(0, -14.5, 30, 2.5), box(44, -14.5, 14, 2.5), box(65, -14, 7, 7),
      box(65, -39.5, 2.5, 18.5), box(65, -65, 7, 7),
      // the northern gallery along the hall, on west, a platform, north to the enemy's base, a platform
      box(0, 14.5, 30, 2.5), box(-44, 14.5, 14, 2.5), box(-65, 14, 7, 7),
      box(-65, 34.5, 2.5, 13.5), box(-65, 55, 7, 7),
    ],
    stairs: [
      // out of the hall's ends onto the galleries
      stair(-30, -14.5, Math.PI), stair(30, 14.5, 0),
      // the southern walkway: down north from its first platform, west from its leg, south at its end
      stair(65, -7, Math.PI / 2), stair(62.5, -36, Math.PI), stair(65, -72, -Math.PI / 2),
      // the northern walkway: down south from its first platform, east from its leg, north at its end
      stair(-65, 7, -Math.PI / 2), stair(-62.5, 38, 0), stair(-65, 62, Math.PI / 2),
    ],
    hall: { ...box(0, 0, 30, 12), boilerX: 14, height: 18, boilerHeight: 30 },
    tower: { ...W(26, 38), r: 15, height: 52 },
    chimney: { ...W(-30, 30), r: 2.6, height: 78 },
    quays: {
      south: quay(0, -100, -10 * DEG, true),
      west: quay(-95, -84, 75 * DEG, false),
      north: quay(0, 106, 3.4 * DEG, false),
    },
    compound: { x0: -60, x1: 60, z0: -33, z1: 33 },
    tracks: { offsets: [4.5, 8.5, 12.5], x0: -40 },
    wagons: [],
    transformer: { x: 96, z: -94, hw: 18, hd: 11, rot: 10 * DEG },
    pylons: [{ x: 124, z: -98 }, { x: 150, z: -103 }, { x: 178, z: -108 }, { x: 205, z: -113 }],
    pipes: [],
    bunker: { x: 0, z: 0, hw: 3.6, hd: 3.6, rot: -3.4 * DEG },
    conveyor: { a: { x: 0, z: 0 }, b: W(22, 0), top: 26 },
    earth: [],
  };
  // the bunker beside the sidings, south of the last track; the conveyor leaves it towards the boiler house
  Object.assign(P.bunker, alongNorth(P, 12, 20));
  P.conveyor.a = { x: P.bunker.x, z: P.bunker.z };
  for (const [track, from, n] of [[0, -24, 4], [2, 26, 3]] as const) for (let k = 0; k < n; k++) P.wagons.push({ x: from + k * 13, track });
  // two pipelines from the northern quay down to the cooling tower
  for (const off of [-2.2, 2.2]) {
    const q = alongNorth(P, P.tower.x + 14 + off, 0);
    P.pipes.push([q, { x: q.x - 2, z: q.z - 30 }, { x: P.tower.x + 8 + off, z: P.tower.z + 13 }]);
  }
  L.plant = P;

  // ---- roads: from the bases into the plant, along the hall
  const road = (pts: V2[], w = 7) => { for (let i = 0; i < pts.length - 1; i++) L.roads.push({ a: pts[i], b: pts[i + 1], w, kind: "asphalt" }); };
  road([{ x: 38, z: -74 }, W(30, -26)]);
  road([W(-56, -26), W(56, -26)]);
  road([{ x: -12, z: 68 }, W(-8, 26)]);
  road([W(-56, 26), W(6, 26)]);
  for (const r of L.roads) {
    const len = Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z), dx = (r.b.x - r.a.x) / len, dz = (r.b.z - r.a.z) / len;
    for (let t = 8, i = 0; t < len - 6; t += 18, i++) {
      const side = i % 2 ? 1 : -1, off = r.w / 2 + 0.9;
      const x = r.a.x + dx * t + dz * side * off, z = r.a.z + dz * t - dx * side * off;
      if (deckHeight(P, x, z) !== null || P.decks.some((d) => inBox(d, x, z, 1.5))) continue; // (not under a walkway)
      L.streetLights.push({ x, z, rot: Math.atan2(-dz * side, dx * side) });
    }
  }

  // ---- outposts: on the walkways' platforms, on the ground (one under the hall), near the bases
  const at = (lx: number, lz: number, turn = 0) => ({ ...W(lx, lz), rot: rot + turn });
  const posts: OutpostSpec[] = [
    { kind: "workshop", x: 4, z: -72, rot: 0.15 },
    { kind: "hospital", x: -32, z: -78, rot: 0.4 },
    { kind: "workshop", x: 30, z: 74, rot: Math.PI - 0.1 },
    { kind: "hospital", x: 26, z: 54, rot: Math.PI + 0.3 },
    { kind: "radar", ...at(65, -14, 0.2), level: 1 },
    { kind: "radar", ...at(-65, 14, Math.PI + 0.2), level: 1 },
    { kind: "tower", ...at(65, -65, 0.3), level: 1 },
    { kind: "tower", ...at(-65, 55, -0.3), level: 1 },
    { kind: "bunker", ...at(-2, 0) },
    { kind: "bunker", ...at(38, -44, -0.5) },
    { kind: "bunker", ...at(-40, 42, 0.6) },
    { kind: "trench", ...at(-24, -48, 0.3) },
    { kind: "trench", x: 62, z: 74, rot: -1.2 },
  ];
  L.outposts.length = 0;
  L.outposts.push(...posts);

  // ---- trees in the green outside the plant
  L.forests.push(
    { x: 106, z: 46, r: 9, conifer: 0.3 }, { x: 108, z: 16, r: 7, conifer: 0.2 }, { x: 104, z: -40, r: 7, conifer: 0.4 },
    { x: 96, z: 86, r: 6, conifer: 0.5 }, { x: -60, z: 10, r: 6, conifer: 0.3 }, { x: -78, z: -40, r: 6, conifer: 0.2 },
    { x: -62, z: -72, r: 6, conifer: 0.3 }, { x: 78, z: 64, r: 6, conifer: 0.3 },
  );

  // ---- the lawns: mown panels, long-grass verges, dry patches, bare earth
  buildPowerLawns(L, P);
}

/** Green (unpaved, dry) ground where trees may grow: outside the plant and its yards, off the walkways. */
export function powerGreen(L: MapLayout, x: number, z: number): boolean {
  const P = L.plant;
  if (!P) return false;
  if (quayDistance(P.quays.south, x, z) < 9 || quayDistance(P.quays.west, x, z) < 9 || quayDistance(P.quays.north, x, z) < 22) return false;
  const l = toLocal(P.centre.x, P.centre.z, P.rot, x, z);
  if (l.x > P.compound.x0 - 3 && l.x < P.compound.x1 + 3 && l.z > P.compound.z0 - 3 && l.z < P.compound.z1 + 3) return false;
  if (inBox(P.transformer, x, z, 3)) return false;
  for (const d of [...P.decks, ...P.stairs]) if (inBox(d, x, z, 4)) return false;
  if (Math.hypot(x - P.tower.x, z - P.tower.z) < P.tower.r + 6) return false;
  return Math.abs(x) < MAP_HALF + 90;
}
