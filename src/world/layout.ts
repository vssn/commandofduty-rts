import { MAP_HALF, OUTPOSTS, type OutpostKind } from "../config";
import { rng } from "../util/noise";

export interface V2 { x: number; z: number }
export type RGB = [number, number, number];

export interface Road { a: V2; b: V2; w: number; kind: "asphalt" | "dirt" }
export interface Field { cx: number; cz: number; hw: number; hd: number; rot: number; base: RGB; stripe: RGB; sw: number }
export interface Forest { x: number; z: number; r: number; conifer: number }
export interface Suburb { x: number; z: number; rot: number; r: number }
export interface OutpostSpec { kind: OutpostKind; x: number; z: number; rot: number }
export interface HouseSpec {
  x: number; z: number; rot: number;
  w: number; d: number; h: number; roofH: number;
  body: number; roof: number; church?: boolean;
}

/**
 * Rotations follow Babylon's convention for `mesh.rotation.y`:
 * a local offset (lx, lz) rotated by `rot` ends up at the returned world position.
 */
export function toWorld(cx: number, cz: number, rot: number, lx: number, lz: number): V2 {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
}

export function toLocal(cx: number, cz: number, rot: number, x: number, z: number): V2 {
  const dx = x - cx, dz = z - cz, c = Math.cos(rot), s = Math.sin(rot);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export function segDist(px: number, pz: number, a: V2, b: V2): number {
  const abx = b.x - a.x, abz = b.z - a.z;
  const len2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (pz - a.z) * abz) / len2));
  return Math.hypot(px - (a.x + abx * t), pz - (a.z + abz * t));
}

interface OrientedRect { cx: number; cz: number; hw: number; hd: number; rot: number }

/** Separating-axis test for two rotated rectangles, each grown by `margin / 2`. */
function rectsOverlap(a: OrientedRect, b: OrientedRect, margin: number): boolean {
  const corners = (r: OrientedRect) =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => toWorld(r.cx, r.cz, r.rot, sx * (r.hw + margin / 2), sz * (r.hd + margin / 2)));
  const ca = corners(a), cb = corners(b);
  for (const r of [a, b]) {
    for (const ang of [r.rot, r.rot + Math.PI / 2]) {
      // local x axis of a rect rotated by `ang` (Babylon convention)
      const ax = Math.cos(ang), az = -Math.sin(ang);
      const pa = ca.map((p) => p.x * ax + p.z * az), pb = cb.map((p) => p.x * ax + p.z * az);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

const FIELD_COLORS: RGB[] = [
  [0.82, 0.68, 0.35], // stubble
  [0.88, 0.77, 0.5], // straw
  [0.46, 0.32, 0.2], // ploughed
  [0.37, 0.26, 0.18], // dark ploughed
  [0.46, 0.57, 0.24], // winter wheat
  [0.66, 0.52, 0.26], // harvested maize
];

export const HOUSE_BODY: RGB[] = [
  [0.93, 0.9, 0.83], [0.9, 0.8, 0.6], [0.8, 0.78, 0.74],
  [0.72, 0.42, 0.32], [0.87, 0.85, 0.7], [0.67, 0.71, 0.73],
];
export const HOUSE_ROOF: RGB[] = [
  [0.58, 0.2, 0.14], [0.3, 0.3, 0.33], [0.46, 0.28, 0.18], [0.66, 0.32, 0.18],
];

/** Static description of the map: bases, suburbs, roads, fields, forests. */
export class MapLayout {
  readonly playerBase: V2 = { x: -20, z: -92 };
  readonly enemyBase: V2 = { x: 20, z: 92 };

  readonly suburbs: Suburb[] = [
    { x: -58, z: 22, rot: 0.2, r: 36 },
    { x: 62, z: -20, rot: -0.3, r: 36 },
  ];

  readonly forests: Forest[] = [
    { x: -78, z: -82, r: 12, conifer: 0.2 },
    { x: -102, z: -32, r: 13, conifer: 0.7 },
    { x: 12, z: -58, r: 11, conifer: 0.1 },
    { x: 40, z: -80, r: 13, conifer: 0.3 },
    { x: 96, z: -88, r: 12, conifer: 0.6 },
    { x: 102, z: 34, r: 15, conifer: 0.2 },
    { x: 24, z: 30, r: 12, conifer: 0.15 },
    { x: -8, z: 4, r: 9, conifer: 0.1 },
    { x: -26, z: 62, r: 12, conifer: 0.35 },
    { x: -96, z: 78, r: 14, conifer: 0.75 },
    { x: 62, z: 96, r: 11, conifer: 0.2 },
    { x: 94, z: 82, r: 10, conifer: 0.5 },
    { x: -66, z: 104, r: 9, conifer: 0.3 },
    { x: 106, z: -52, r: 9, conifer: 0.2 },
  ];

  /** Capturable field hospitals, dugouts, trenches, watchtowers and workshops spread over the map. */
  readonly outposts: OutpostSpec[] = [
    // field hospitals: the outpost on the left near each base
    { kind: "hospital", x: -70, z: -55, rot: 0.3 },
    { kind: "hospital", x: 70, z: 55, rot: 0.3 + Math.PI },
    { kind: "bunker", x: 18, z: -42, rot: -0.2 },
    { kind: "bunker", x: -18, z: 40, rot: Math.PI - 0.2 },
    { kind: "trench", x: -94, z: 4, rot: 1.4 },
    { kind: "trench", x: 96, z: 2, rot: -1.4 },
    { kind: "tower", x: 22, z: 6, rot: 0.5 },
    { kind: "tower", x: -24, z: -10, rot: -0.4 },
    { kind: "bunker", x: -94, z: -102, rot: 0.8 },
    { kind: "bunker", x: 94, z: 104, rot: 0.8 + Math.PI },
    { kind: "workshop", x: 14, z: -84, rot: 0 },
    { kind: "workshop", x: -14, z: 84, rot: Math.PI },
  ];

  readonly roads: Road[] = [];
  /** Street lamps along the village streets; `rot` turns the lamp arm over the road. */
  readonly streetLights: { x: number; z: number; rot: number }[] = [];
  readonly fields: Field[] = [];
  readonly houses: HouseSpec[] = [];

  constructor(seed = 1337) {
    const r = rng(seed);
    this.suburbs.forEach((s, i) => this.buildSuburb(s, i, r));
    this.buildCountryRoads();
    this.buildFields(r);
  }

  private buildSuburb(s: Suburb, index: number, r: () => number) {
    const streets: [number, number, number, number, number][] = [
      [-36, 0, 36, 0, 5],
      [-10, -25, -10, 25, 4.5],
      [14, -25, 14, 25, 4.5],
    ];
    for (const [x1, z1, x2, z2, w] of streets) {
      this.roads.push({ a: toWorld(s.x, s.z, s.rot, x1, z1), b: toWorld(s.x, s.z, s.rot, x2, z2), w, kind: "asphalt" });
    }
    // street lamps every ~12 m, alternating sides, clear of the crossings
    const crossings = [[-10, 0], [14, 0]];
    for (const [x1, z1, x2, z2, w] of streets) {
      const len = Math.hypot(x2 - x1, z2 - z1), dx = (x2 - x1) / len, dz = (z2 - z1) / len;
      const n = Math.floor(len / 12);
      for (let i = 0; i <= n; i++) {
        const along = -len / 2 + 3 + i * ((len - 6) / Math.max(1, n));
        const lx = (x1 + x2) / 2 + dx * along, lz = (z1 + z2) / 2 + dz * along;
        if (crossings.some(([cx, cz]) => Math.hypot(lx - cx, lz - cz) < 6)) continue;
        const side = i % 2 === 0 ? 1 : -1;
        // perpendicular to the street, at the kerb
        const px = lx + dz * side * (w / 2 + 0.8), pz = lz - dx * side * (w / 2 + 0.8);
        const p = toWorld(s.x, s.z, s.rot, px, pz);
        // local direction from the lamp back over the road
        this.streetLights.push({ x: p.x, z: p.z, rot: s.rot + Math.atan2(-dz * side, dx * side) });
      }
    }

    const lots: { lx: number; lz: number; turn: number }[] = [];
    for (let lx = -31; lx <= 32; lx += 7) {
      if (Math.abs(lx + 10) < 5 || Math.abs(lx - 14) < 5) continue;
      lots.push({ lx, lz: 8, turn: 0 }, { lx, lz: -8, turn: 0 });
    }
    for (const cx of [-10, 14]) {
      for (const lz of [-21, -14.5, 14.5, 21]) {
        lots.push({ lx: cx - 7.5, lz, turn: Math.PI / 2 }, { lx: cx + 7.5, lz, turn: Math.PI / 2 });
      }
    }

    const church = index === 0 ? { lx: 26, lz: -16 } : null;
    if (church) {
      const p = toWorld(s.x, s.z, s.rot, church.lx, church.lz);
      this.houses.push({ x: p.x, z: p.z, rot: s.rot, w: 7, d: 13, h: 6.5, roofH: 3.5, body: 0, roof: 1, church: true });
    }

    for (const lot of lots) {
      if (church && Math.hypot(lot.lx - church.lx, lot.lz - church.lz) < 11) continue;
      if (r() < 0.12) continue; // empty lot / garden
      const p = toWorld(s.x, s.z, s.rot, lot.lx, lot.lz);
      const flip = r() < 0.5 ? 0 : Math.PI / 2;
      this.houses.push({
        x: p.x, z: p.z, rot: s.rot + lot.turn + flip,
        w: 4.6 + r() * 1.2, d: 4.6 + r() * 1.0, h: 2.8 + r() * 0.9, roofH: 1.6 + r() * 0.8,
        body: Math.floor(r() * HOUSE_BODY.length), roof: Math.floor(r() * HOUSE_ROOF.length),
      });
    }
  }

  private buildCountryRoads() {
    const [w, e] = this.suburbs;
    const polylines: V2[][] = [
      [{ x: -20, z: -84 }, { x: -26, z: -56 }, { x: -38, z: -28 }, { x: -54, z: -4 }, { x: w.x, z: w.z }],
      [{ x: w.x, z: w.z }, { x: -44, z: 50 }, { x: -14, z: 70 }, { x: 20, z: 84 }],
      [{ x: -38, z: -28 }, { x: -4, z: -32 }, { x: 30, z: -26 }, { x: e.x, z: e.z }],
      [{ x: e.x, z: e.z }, { x: 74, z: 14 }, { x: 52, z: 52 }, { x: 20, z: 84 }],
      [{ x: e.x, z: e.z }, { x: 125, z: -36 }],
      [{ x: w.x, z: w.z }, { x: -125, z: 30 }],
    ];
    for (const pl of polylines) {
      for (let i = 0; i < pl.length - 1; i++) this.roads.push({ a: pl[i], b: pl[i + 1], w: 3.6, kind: "dirt" });
    }
  }

  private buildFields(r: () => number) {
    const bases = [this.playerBase, this.enemyBase];
    const baseAng = 0.35;
    for (let tries = 0; tries < 900 && this.fields.length < 26; tries++) {
      const hw = 8 + r() * 9, hd = 6 + r() * 7;
      const ext = Math.hypot(hw, hd);
      const cx = (r() * 2 - 1) * (MAP_HALF - 10), cz = (r() * 2 - 1) * (MAP_HALF - 10);
      const rot = baseAng + (r() - 0.5) * 0.25 + (r() < 0.3 ? Math.PI / 2 : 0);
      if (bases.some((b) => Math.hypot(cx - b.x, cz - b.z) < 22 + ext)) continue;
      if (this.suburbs.some((s) => Math.hypot(cx - s.x, cz - s.z) < s.r + ext * 0.8)) continue;
      if (this.forests.some((f) => Math.hypot(cx - f.x, cz - f.z) < f.r + ext * 0.75)) continue;
      if (this.nearOutpost(cx, cz, ext + 6)) continue;
      if (this.nearestRoad(cx, cz).d < Math.min(hw, hd) + 1.5) continue;
      // fields must not overlap (the draped meshes would z-fight); keep room for a hedgerow in between
      const cand = { cx, cz, hw, hd, rot };
      if (this.fields.some((f) => rectsOverlap(cand, f, 3))) continue;
      const base = FIELD_COLORS[Math.floor(r() * FIELD_COLORS.length)];
      const k = r() < 0.5 ? 0.86 : 1.1;
      const stripe: RGB = [Math.min(1, base[0] * k), Math.min(1, base[1] * k), Math.min(1, base[2] * k)];
      this.fields.push({ cx, cz, hw, hd, rot, base, stripe, sw: 3.2 + r() * 1.2 });
    }
  }

  /** Signed distance to the nearest road edge (negative = on the road). Asphalt wins over dirt. */
  nearestRoad(x: number, z: number): { d: number; road: Road | null } {
    let best = Infinity, road: Road | null = null;
    for (const rd of this.roads) {
      // cheap bounding-box reject (the exact distance only matters close to the road)
      const m = rd.w / 2 + 4;
      if (x < Math.min(rd.a.x, rd.b.x) - m || x > Math.max(rd.a.x, rd.b.x) + m || z < Math.min(rd.a.z, rd.b.z) - m || z > Math.max(rd.a.z, rd.b.z) + m) continue;
      const d = segDist(x, z, rd.a, rd.b) - rd.w / 2;
      if (d < 0 && rd.kind === "asphalt") return { d, road: rd };
      if (d < best) { best = d; road = rd; }
    }
    return { d: best, road };
  }

  fieldAt(x: number, z: number): { f: Field; lx: number; lz: number } | null {
    for (const f of this.fields) {
      if (Math.abs(x - f.cx) > 25 || Math.abs(z - f.cz) > 25) continue;
      const l = toLocal(f.cx, f.cz, f.rot, x, z);
      if (Math.abs(l.x) < f.hw && Math.abs(l.z) < f.hd) return { f, lx: l.x, lz: l.z };
    }
    return null;
  }

  houseAt(x: number, z: number, pad = 0): boolean {
    for (const h of this.houses) {
      if (Math.abs(x - h.x) > 12 || Math.abs(z - h.z) > 12) continue;
      const l = toLocal(h.x, h.z, h.rot, x, z);
      if (Math.abs(l.x) < h.w / 2 + pad && Math.abs(l.z) < h.d / 2 + pad) return true;
    }
    return false;
  }

  nearOutpost(x: number, z: number, pad: number): boolean {
    return this.outposts.some((o) => Math.hypot(x - o.x, z - o.z) < OUTPOSTS[o.kind].radius + pad);
  }

  nearBase(x: number, z: number, r: number): boolean {
    return Math.hypot(x - this.playerBase.x, z - this.playerBase.z) < r || Math.hypot(x - this.enemyBase.x, z - this.enemyBase.z) < r;
  }
}
