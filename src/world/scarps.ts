import { smoothstep, valueNoise } from "../util/noise";
import type { V2 } from "./layout";

/**
 * Escarpments of the hill country: the edges of terraces and hills, where the ground steps up by a few
 * metres over a few metres of slope. They are laid out first - fields, meadows, trees and tracks keep
 * to them (the tracks run along their foot and their top edge, the fields lie parallel). A slope is
 * either `stone` (grey rubble and rock) or `earth` (a brown bank with a few stones).
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
  /** Bounding box, widened by the reach of the slope and its rubble. */
  box: { x0: number; x1: number; z0: number; z1: number };
  seed: number;
}

/** Where the rubble lies, measured across the slope from its centre line: the foot's apron and the shoulder. */
const FOOT = 3.2, SHOULDER = 0.6;
/** The slope fades out over this length at both ends (m); the rubble stops a little inside. */
const TAPER = 16, CAP = 5;
/** Range (m) of the signed distance baked for the realistic ground. */
export const SCREE_RANGE = 3;

interface Control { pts: [number, number][]; drop: number; w: number; kind: ScarpKind }

/**
 * The slopes: control points of a smooth curve, the high ground on its left. Placed in the open parts of the map,
 * away from the woods and the villages (the ground fades flat towards bases, villages and outposts).
 */
const CONTROLS: Control[] = [
  { pts: [[-122, -66], [-108, -61], [-95, -61]], drop: 4.5, w: 5.5, kind: "earth" },
  { pts: [[56, -71], [72, -66], [90, -69], [112, -73]], drop: 3, w: 7, kind: "earth" },
  { pts: [[26, 63], [44, 69], [62, 69]], drop: 4.5, w: 5.5, kind: "earth" },
  { pts: [[-121, 50], [-106, 57], [-90, 52]], drop: 3, w: 7, kind: "earth" },
  { pts: [[106, -36], [101, -20], [102, -6]], drop: 4.5, w: 5.5, kind: "earth" },
  { pts: [[-121, -14], [-113, -3], [-110, 10]], drop: 3, w: 7, kind: "earth" },
  { pts: [[-52, 113], [-35, 106], [-20, 108]], drop: 4.5, w: 5.5, kind: "earth" },
  { pts: [[-6, -113], [14, -108], [32, -105]], drop: 3, w: 7, kind: "earth" },
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
      return {
        pts, arc, total: arc[arc.length - 1], drop: c.drop, w: c.w, kind: c.kind, seed: 51 + seed,
        box: {
          x0: Math.min(...pts.map((p) => p.x)) - reach, x1: Math.max(...pts.map((p) => p.x)) + reach,
          z0: Math.min(...pts.map((p) => p.z)) - reach, z1: Math.max(...pts.map((p) => p.z)) + reach,
        },
      };
    });
  }

  /** The nearest slope within reach of (x, z) and where the point lies to it; null if there is none. */
  private locate(sc: Scarp, x: number, z: number): ScarpHit | null {
    const b = sc.box;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return null;
    let best = Infinity, side = 1, t = 0;
    const P = sc.pts;
    for (let i = 0; i < P.length - 1; i++) {
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
      const hit = this.locate(sc, x, z);
      if (!hit || Math.abs(hit.s) > sc.w / 2 + 2) {
        if (hit && hit.s > 0) h += sc.drop * this.fade(sc, hit.t);
        continue;
      }
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
      const d = Math.max(Math.abs(hit.s - (lo + hi) / 2) - (hi - lo) / 2, CAP - hit.t, hit.t - (sc.total - CAP));
      if (!best || d < best.d) {
        // (earth banks have stony patches, stone slopes some brown earth between the rocks)
        const patchy = valueNoise(x * 0.12, z * 0.12, sc.seed + 200);
        best = { d, brown: sc.kind === "earth" ? 0.8 + patchy * 0.2 : Math.max(0, patchy) * 0.35 };
      }
    }
    return best;
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

  /**
   * The line a track follows beside a slope: `off` metres from the centre line (positive = high side), over the
   * slope's whole length less the tapering ends.
   */
  offsetLine(sc: Scarp, off: number, from = TAPER * 0.6, to = TAPER * 0.6): V2[] {
    const out: V2[] = [];
    const P = sc.pts;
    for (let i = 0; i < P.length; i++) {
      if (sc.arc[i] < from || sc.arc[i] > sc.total - to) continue;
      const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)];
      const l = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      out.push({ x: P[i].x - ((c.z - a.z) / l) * off, z: P[i].z + ((c.x - a.x) / l) * off });
    }
    return out;
  }

  /** Half width of a slope with its rubble on the low side (where a track at the foot must keep clear). */
  static footReach(sc: Scarp): number {
    return sc.w / 2 + FOOT;
  }
}
