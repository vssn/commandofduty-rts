import { smoothstep, valueNoise } from "../util/noise";
import type { V2 } from "./layout";

/**
 * Escarpments of the hill country: two rock walls right across the map, point-symmetric, that lift the
 * middle of the map (outposts, villages) as a plateau a few metres above the two bases' lowland. They
 * cannot be climbed (see scarpBarrier.ts); ramps lead up them - each climbs slantwise along the wall, so
 * one walks up it mostly sideways and never straight towards the camera (which looks north: a unit
 * climbing southwards would seem to stand still). The tracks run over the ramps. They are laid out
 * first - fields, meadows and trees keep to them, the fields lie parallel. A slope is either `stone`
 * (grey rubble and rock) or `earth` (a brown bank with a few stones).
 *
 * Pure geometry: the terrain adds `height()` to its ground, the ground colours and the realistic
 * ground's baked mask use `cover()`, the rocks of the classic look are scattered over the same area.
 */

export type ScarpKind = "stone" | "earth";

export interface Scarp {
  /** The centre line of the slope, a point about every 2 m. The high ground lies to the left of the direction of travel. */
  pts: V2[];
  /** Arc length at each point and in all. */
  arc: number[];
  total: number;
  /** Height of the step (m) and the horizontal width of its slope (m). */
  drop: number;
  w: number;
  kind: ScarpKind;
  /** Ramps up the wall (from `a` at its foot to `b` on top). */
  ramps: Ramp[];
  /** Bounding box, widened by the reach of the slope and its rubble. */
  box: { x0: number; x1: number; z0: number; z1: number };
  seed: number;
  /** The pieces of the centre line near each 8 m cell of the box (see locate). */
  grid: number[][];
  gnx: number;
}

/** Cell size of a slope's grid of nearby centre-line pieces. */
const GRID = 8;

/** Where the rubble lies, measured across the slope from its centre line: the foot's apron and the shoulder. */
const FOOT = 3.2, SHOULDER = 0.6;
/** The slope fades out over this length at both ends (m); the rubble stops a little inside. */
const TAPER = 16, CAP = 5;
/** Width of a ramp's level corridor, and the band over which it blends into the wall beside it. */
const RAMP_W = 9, RAMP_EDGE = 2.5;
/** How far beside the wall's centre line a ramp starts and ends (on the low and the high ground). */
const RAMP_OFF = 6;

/** A ramp: a level corridor climbing slantwise across the wall from `a` (foot, low side) to `b` (top). */
export interface Ramp { a: V2; b: V2; drop: number; w: number }
/** Range (m) of the signed distance baked for the realistic ground. */
export const SCREE_RANGE = 3;

/** `ramps`: x of each ramp's foot and top (it climbs from one to the other along the wall). */
interface Control { pts: [number, number][]; drop: number; w: number; kind: ScarpKind; ramps: [number, number][] }

/**
 * The two walls: control points of a smooth curve, the high ground on its left (the southern wall runs
 * east, the northern one - its mirror image through the middle of the map - west, so both lift the
 * middle). They reach past the edges of the map. Their course keeps clear of the bases, villages and
 * outposts (the ground is levelled there); three ramps each: west, east and the middle one, whose foot lies just in front
 * of the base's gate (the road swings onto it, see layout.ts).
 */
const SOUTH: [number, number][] = [[-140, -78], [-100, -77], [-62, -75], [-40, -67], [-16, -62], [14, -63], [44, -64], [80, -65], [140, -66]];
const SOUTH_RAMPS: [number, number][] = [[-104, -66], [-24, 16], [56, 96]];
const CONTROLS: Control[] = [
  { pts: SOUTH, drop: 5, w: 6, kind: "stone", ramps: SOUTH_RAMPS },
  { pts: SOUTH.map(([x, z]) => [-x, -z] as [number, number]), drop: 5, w: 6, kind: "stone", ramps: SOUTH_RAMPS.map(([a, b]) => [-a, -b] as [number, number]) },
];

/** Catmull-Rom through the control points, sampled about every 2 m. */
function curve(ctrl: [number, number][]): V2[] {
  const p = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const out: V2[] = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const n = Math.max(2, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0[0], p1[0], p2[0], p3[0]), z: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const last = ctrl[ctrl.length - 1];
  out.push({ x: last[0], z: last[1] });
  return out;
}

/** What the nearest escarpment says about a point. */
export interface ScarpHit {
  scarp: Scarp;
  /** Signed distance to the centre line (m), positive on the high side, with the slope's irregular edge in it. */
  s: number;
  /** Position along the slope (m from its start). */
  t: number;
}

export class ScarpSet {
  readonly list: Scarp[];

  /** `enabled` false: no slopes at all (the city map). */
  constructor(enabled = true) {
    this.list = (enabled ? CONTROLS : []).map((c, seed) => {
      const pts = curve(c.pts);
      const arc = [0];
      for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const reach = c.w / 2 + FOOT + 10;
      /** The point `off` metres beside the curve where it passes x (high side positive). */
      const beside = (x: number, off: number): V2 => {
        let i = 0;
        while (i < pts.length - 2 && (pts[i + 1].x - x) * Math.sign(pts[pts.length - 1].x - pts[0].x) < 0) i++;
        const a = pts[i], b = pts[i + 1], k = Math.max(0, Math.min(1, (x - a.x) / (b.x - a.x || 1)));
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return { x: a.x + (b.x - a.x) * k - ((b.z - a.z) / l) * off, z: a.z + (b.z - a.z) * k + ((b.x - a.x) / l) * off };
      };
      const ramps = c.ramps.map(([fx, tx]) => ({ a: beside(fx, -RAMP_OFF), b: beside(tx, RAMP_OFF), drop: c.drop, w: RAMP_W }));
      const box = {
        x0: Math.min(...pts.map((p) => p.x)) - reach, x1: Math.max(...pts.map((p) => p.x)) + reach,
        z0: Math.min(...pts.map((p) => p.z)) - reach, z1: Math.max(...pts.map((p) => p.z)) + reach,
      };
      // which pieces of the centre line lie within reach of each cell (a point's nearest piece, if within
      // reach, is among them): the local queries - asked for every texel of the ground's masks - check only those
      const gnx = Math.ceil((box.x1 - box.x0) / GRID), gnz = Math.ceil((box.z1 - box.z0) / GRID);
      const grid: number[][] = Array.from({ length: gnx * gnz }, () => []);
      for (let j = 0; j < gnz; j++) {
        for (let i = 0; i < gnx; i++) {
          const cx = box.x0 + (i + 0.5) * GRID, cz = box.z0 + (j + 0.5) * GRID;
          for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k], b = pts[k + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cz - a.z) * dz) / l2));
            if (Math.hypot(cx - a.x - dx * t, cz - a.z - dz * t) <= reach + GRID * 0.71) grid[i + j * gnx].push(k);
          }
        }
      }
      return { pts, arc, total: arc[arc.length - 1], drop: c.drop, w: c.w, kind: c.kind, seed: 51 + seed, ramps, box, grid, gnx };
    });
  }

  /** All ramps of all walls. */
  get ramps(): Ramp[] {
    return this.list.flatMap((sc) => sc.ramps);
  }

  /**
   * A ramp's share of the ground at a point (1 on its level corridor, falling to 0 over its edge) and how far up it the
   * point is (0 at the foot, 1 on top). The terrain lays the corridor evenly from the ground at its foot to the ground at
   * its top (so the hills it crosses do not make it steeper anywhere).
   */
  static rampAt(rp: Ramp, x: number, z: number): { k: number; u: number } {
    const { d, u } = ScarpSet.onRamp(rp, x, z);
    return { k: d < rp.w / 2 + RAMP_EDGE ? smoothstep(rp.w / 2 + RAMP_EDGE, rp.w / 2, d) : 0, u };
  }

  /** Distance from a ramp's axis and how far up it (0 at the foot, 1 on top) a point is. */
  private static onRamp(rp: Ramp, x: number, z: number): { d: number; u: number } {
    const dx = rp.b.x - rp.a.x, dz = rp.b.z - rp.a.z, l2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - rp.a.x) * dx + (z - rp.a.z) * dz) / l2));
    return { d: Math.hypot(x - rp.a.x - dx * u, z - rp.a.z - dz * u), u };
  }

  /**
   * Where a point lies to a slope; null if it is out of the slope's reach (`local`: only near the slope -
   * the height needs every point, as the high ground goes on far behind the wall).
   */
  private locate(sc: Scarp, x: number, z: number, local = true): ScarpHit | null {
    const b = sc.box;
    if (local && (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1)) return null;
    let best = Infinity, side = 1, t = 0;
    const P = sc.pts;
    const pieces = local ? sc.grid[Math.min(sc.gnx - 1, Math.floor((x - b.x0) / GRID)) + Math.floor((z - b.z0) / GRID) * sc.gnx] : null;
    if (pieces && !pieces.length) return null;
    const n = pieces ? pieces.length : P.length - 1;
    for (let q = 0; q < n; q++) {
      const i = pieces ? pieces[q] : q;
      const a = P[i], c = P[i + 1];
      const dx = c.x - a.x, dz = c.z - a.z, l2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const qx = a.x + dx * k, qz = a.z + dz * k;
      const d = Math.hypot(x - qx, z - qz);
      if (d < best) {
        best = d;
        side = (-dz * (x - qx) + dx * (z - qz)) >= 0 ? 1 : -1;
        t = sc.arc[i] + k * Math.sqrt(l2);
      }
    }
    // the edge of the slope is never straight: a broad swing and a finer ragged one
    const wobble = valueNoise(x * 0.07, z * 0.07, sc.seed) * 1.3 + valueNoise(x * 0.3, z * 0.3, sc.seed + 100) * 0.35;
    return { scarp: sc, s: side * best + wobble, t };
  }

  /** The height the slopes add to the ground at a point (0 on the low side, `drop` on the high side). */
  height(x: number, z: number): number {
    let h = 0;
    for (const sc of this.list) {
      const hit = this.locate(sc, x, z, false)!;
      h += sc.drop * this.fade(sc, hit.t) * smoothstep(-sc.w / 2, sc.w / 2, hit.s);
    }
    return h;
  }

  private fade(sc: Scarp, t: number): number {
    return smoothstep(0, TAPER, t) * smoothstep(0, TAPER, sc.total - t);
  }

  /**
   * Rubble (the slope, its shoulder and the apron at its foot): the signed distance to the edge of that area in metres
   * (negative inside), and how brown the slope is (1 = earth bank, 0 = grey stone). Only worth calling near a slope.
   */
  cover(x: number, z: number): { d: number; brown: number } | null {
    let best: { d: number; brown: number } | null = null;
    for (const sc of this.list) {
      const hit = this.locate(sc, x, z);
      if (!hit) continue;
      const lo = -(sc.w / 2 + FOOT), hi = sc.w / 2 + SHOULDER;
      let d = Math.max(Math.abs(hit.s - (lo + hi) / 2) - (hi - lo) / 2, CAP - hit.t, hit.t - (sc.total - CAP));
      // (no rubble on the ramps)
      for (const rp of sc.ramps) d = Math.max(d, rp.w / 2 - ScarpSet.onRamp(rp, x, z).d);
      if (!best || d < best.d) {
        // (earth banks have stony patches, stone slopes some brown earth between the rocks)
        const patchy = valueNoise(x * 0.12, z * 0.12, sc.seed + 200);
        best = { d, brown: sc.kind === "earth" ? 0.8 + patchy * 0.2 : Math.max(0, patchy) * 0.35 };
      }
    }
    return best;
  }

  /** True if the straight line from a to b runs over a wall anywhere but on a ramp. */
  crosses(a: V2, b: V2): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(len));
    for (let i = 0; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps, z = a.z + ((b.z - a.z) * i) / steps;
      for (const sc of this.list) {
        const hit = this.locate(sc, x, z);
        if (hit && Math.abs(hit.s) < sc.w / 2 + 1.5 && !sc.ramps.some((rp) => ScarpSet.rampAt(rp, x, z).k > 0.5)) return true;
      }
    }
    return false;
  }

  /** True within `pad` of a slope and its rubble (nothing is planted or laid out there). */
  near(x: number, z: number, pad: number): boolean {
    for (const sc of this.list) {
      const hit = this.locate(sc, x, z);
      if (hit && hit.s > -(sc.w / 2 + FOOT + pad) && hit.s < sc.w / 2 + SHOULDER + pad && hit.t > -pad && hit.t < sc.total + pad) return true;
    }
    return false;
  }

  /** Direction (unit) of the nearest slope's centre line at a point within `reach` of it, with the distance; for aligning fields. */
  tangentNear(x: number, z: number, reach: number): { dx: number; dz: number; d: number } | null {
    let best: { dx: number; dz: number; d: number } | null = null;
    for (const sc of this.list) {
      const P = sc.pts;
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i], c = P[i + 1];
        const dx = c.x - a.x, dz = c.z - a.z, l2 = dx * dx + dz * dz || 1;
        const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
        const d = Math.hypot(x - (a.x + dx * k), z - (a.z + dz * k));
        if (d < reach && (!best || d < best.d)) {
          const l = Math.sqrt(l2);
          best = { dx: dx / l, dz: dz / l, d };
        }
      }
    }
    return best;
  }
}
