import type { V2 } from "./layout";

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
