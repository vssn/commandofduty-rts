import { toLocal, type MapLayout, type V2 } from "./layout";

/** A footpath as laid out by the dirt tracks: a polyline with its width and tapering ends. */
export interface PathLine { pts: V2[]; width: number; taperStart?: boolean; taperEnd?: boolean }

/** Metres either side of a path's edge that the baked map resolves. */
export const PATH_RANGE = 2.5;
/** Metres over which a free end fades out (as for the classic band). */
const FADE = 7;

/**
 * Bakes the footpaths for the realistic ground: r = signed distance to the path's edge (negative on
 * it, `PATH_RANGE` metres either side), g = how strongly the path shows (it fades out at its free
 * end). The shader draws the trampled earth from this with irregular edges.
 */
export function bakePathMap(lines: readonly PathLine[], res: number, half: number): Uint8Array {
  const data = new Uint8Array(res * res * 4);
  const step = (half * 2) / res;
  const enc = (d: number) => Math.round(Math.min(1, Math.max(0, (d / PATH_RANGE) * 0.5 + 0.5)) * 255);
  const best = new Float32Array(res * res).fill(Infinity);
  for (let o = 0; o < data.length; o += 4) data[o] = 255;
  for (const { pts, width, taperStart, taperEnd } of lines) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = cum[cum.length - 1];
    const taper = (s: number) => Math.min(taperStart ? 0.3 + 0.7 * Math.min(1, s / 3.5) : 1, taperEnd ? 0.3 + 0.7 * Math.min(1, (total - s) / 3.5) : 1);
    const fadeOf = (s: number) => {
      const f = Math.min(taperStart ? 1 : s / FADE, taperEnd ? 1 : (total - s) / FADE, 1);
      return f * f * (3 - 2 * f);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1, len = Math.sqrt(l2);
      const m = width / 2 + PATH_RANGE + 0.1;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - m + half) / step)), i1 = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + m + half) / step));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - m + half) / step)), j1 = Math.min(res - 1, Math.ceil((Math.max(a.z, b.z) + m + half) / step));
      for (let j = j0; j <= j1; j++) {
        const z = -half + (j + 0.5) * step;
        for (let k = i0; k <= i1; k++) {
          const x = -half + (k + 0.5) * step;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
          const s = cum[i] + t * len;
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) - (width / 2) * taper(s);
          const idx = k + j * res;
          if (d >= best[idx]) continue;
          best[idx] = d;
          data[idx * 4] = enc(d);
          data[idx * 4 + 1] = Math.round(fadeOf(s) * 255);
        }
      }
    }
  }
  return data;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Bakes a static ambient occlusion of the ground into the blue and alpha channels of the path map:
 * b = under trees and inside forests, a = between houses and inside the villages. The shader darkens
 * and tints the ground by them (cool and green under foliage, warm and grey in the alleys).
 */
export function bakeOcclusion(data: Uint8Array, res: number, half: number, trees: readonly V2[], layout: MapLayout) {
  const step = (half * 2) / res;
  const forest = new Float32Array(res * res), village = new Float32Array(res * res);
  /** Adds weight `w(x, z)` (0..1) to `buf` for all texels within `reach` of (cx, cz): w values combine like independent shadows. */
  const splat = (buf: Float32Array, cx: number, cz: number, reach: number, w: (x: number, z: number) => number) => {
    const i0 = Math.max(0, Math.floor((cx - reach + half) / step)), i1 = Math.min(res - 1, Math.ceil((cx + reach + half) / step));
    const j0 = Math.max(0, Math.floor((cz - reach + half) / step)), j1 = Math.min(res - 1, Math.ceil((cz + reach + half) / step));
    for (let j = j0; j <= j1; j++) {
      const z = -half + (j + 0.5) * step;
      for (let i = i0; i <= i1; i++) {
        const v = w(-half + (i + 0.5) * step, z);
        if (v <= 0) continue;
        const k = i + j * res;
        buf[k] = 1 - (1 - buf[k]) * (1 - v);
      }
    }
  };
  // every tree shades the ground under and around its crown
  for (const t of trees) splat(forest, t.x, t.z, 3.6, (x, z) => 0.55 * smooth(3.6, 0.4, Math.hypot(x - t.x, z - t.z)));
  // forests are darker inside than their individual trees suggest
  for (const f of layout.forests) splat(forest, f.x, f.z, f.r, (x, z) => 0.3 * smooth(f.r, f.r * 0.55, Math.hypot(x - f.x, z - f.z)));
  // alleys between the houses, and a little shade over the whole village
  for (const s of layout.suburbs) splat(village, s.x, s.z, s.r, (x, z) => 0.16 * smooth(s.r, s.r * 0.6, Math.hypot(x - s.x, z - s.z)));
  for (const h of layout.houses) {
    const reach = Math.hypot(h.w, h.d) / 2 + 3.2;
    splat(village, h.x, h.z, reach, (x, z) => {
      const l = toLocal(h.x, h.z, h.rot, x, z);
      const d = Math.hypot(Math.max(Math.abs(l.x) - h.w / 2, 0), Math.max(Math.abs(l.z) - h.d / 2, 0));
      return 0.75 * smooth(3.0, 0, d);
    });
  }
  for (let k = 0; k < res * res; k++) {
    data[k * 4 + 2] = Math.round(forest[k] * 255);
    data[k * 4 + 3] = Math.round(village[k] * 255);
  }
}

/**
 * Bakes the meadows for the realistic ground (r = how fully a meadow covers the texel, g = blade
 * length 0 mown .. 1 tall, b = flowers, a = tone 0 dry .. 1 lush). The shader reads the lawn texture
 * at a coarser or finer scale from it, tints the grass and sprinkles flowers.
 */
export function bakeMeadowMap(layout: MapLayout, res: number, half: number): Uint8Array {
  const data = new Uint8Array(res * res * 4);
  const step = (half * 2) / res;
  const flowers: Record<string, number> = { mown: 0.1, pasture: 0.55, hay: 0.3, wild: 1 };
  for (const m of layout.meadows) {
    const reach = Math.hypot(m.hw, m.hd) + 4;
    const i0 = Math.max(0, Math.floor((m.cx - reach + half) / step)), i1 = Math.min(res - 1, Math.ceil((m.cx + reach + half) / step));
    const j0 = Math.max(0, Math.floor((m.cz - reach + half) / step)), j1 = Math.min(res - 1, Math.ceil((m.cz + reach + half) / step));
    for (let j = j0; j <= j1; j++) {
      const z = -half + (j + 0.5) * step;
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * step;
        const at = layout.meadowAt(x, z);
        if (!at || at.m !== m) continue;
        const o = (i + j * res) * 4;
        data[o] = Math.round(at.cover * 255);
        data[o + 1] = Math.round(m.height * 255);
        data[o + 2] = Math.round(flowers[m.kind] * 255);
        data[o + 3] = Math.round(m.tone * 255);
      }
    }
  }
  return data;
}
