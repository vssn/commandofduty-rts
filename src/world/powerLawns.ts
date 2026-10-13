import { MAP_HALF } from "../config";
import { rng } from "../util/noise";
import type { Meadow, MapLayout, V2 } from "./layout";
import { toLocal, toWorld } from "./layout";
import type { PowerPlant, Quay } from "./power";
import { inBox, quayDistance } from "./power";

/**
 * Variety for the power station's big lawns, which would otherwise read as one repeated texture: mown panels with
 * their stripes and mowing edges, a verge of long grass along paving and quays (the uncut border), dry patches
 * and bare earth. The grass is laid out with `meadows` (the realistic ground and the classic one both read those: stripes,
 * blade length, tone, flowers) and the bare earth as ellipses (`PowerPlant.earth`, painted as trodden soil).
 */

/** Where the ground is paved (as the terrain paints it: the quays, rails, yard, the hall and tower, the compound). */
export function onPaving(P: PowerPlant, x: number, z: number, pad = 0): boolean {
  const Q = P.quays;
  if (Math.min(quayDistance(Q.south, x, z), quayDistance(Q.west, x, z), quayDistance(Q.north, x, z)) < 8 + pad) return true;
  const o = quayDistance(Q.north, x, z), T = P.tracks;
  if (x > T.x0 - 4 - pad && o > T.offsets[0] - 2.6 - pad && o < T.offsets[T.offsets.length - 1] + 2.6 + pad) return true;
  if (inBox(P.transformer, x, z, pad) || inBox(P.hall, x, z, 5 + pad) || inBox(P.bunker, x, z, 2 + pad)) return true;
  if (Math.hypot(x - P.tower.x, z - P.tower.z) < P.tower.r + 5 + pad) return true;
  const l = toLocal(P.centre.x, P.centre.z, P.rot, x, z), c = P.compound;
  return l.x > c.x0 - 1 - pad && l.x < c.x1 + 1 + pad && l.z > c.z0 - 1 - pad && l.z < c.z1 + 1 + pad;
}

const rotOf = (d: V2) => Math.atan2(-d.z, d.x);

export function buildPowerLawns(L: MapLayout, P: PowerPlant) {
  const r = rng(4242);
  const lim = MAP_HALF - 5;
  const inMap = (x: number, z: number) => Math.abs(x) < lim && Math.abs(z) < lim;
  const nearPost = (x: number, z: number, pad: number) => L.outposts.some((o) => Math.hypot(o.x - x, o.z - z) < 9 + pad) || L.nearBase(x, z, 14 + pad);
  /** Whether a rotated rectangle lies on green (centre, corners and edge middles). */
  const green = (cx: number, cz: number, hw: number, hd: number, rot: number, pad: number) =>
    [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].every(([sx, sz]) => {
      const p = toWorld(cx, cz, rot, sx * hw, sz * hd);
      return inMap(p.x, p.z) && !onPaving(P, p.x, p.z, pad);
    });

  // ---- bare earth: worn and bald patches in the lawn, more of them near the posts and walkways
  P.earth.length = 0;
  for (let tries = 0; tries < 400 && P.earth.length < 14; tries++) {
    const x = (r() * 2 - 1) * lim, z = (r() * 2 - 1) * lim, rx = 2.5 + r() * 5, rz = 1.8 + r() * 3.2, rot = r() * Math.PI;
    if (!green(x, z, rx, rz, rot, 1.5) || P.earth.some((e) => Math.hypot(e.x - x, e.z - z) < 14)) continue;
    P.earth.push({ x, z, rx, rz, rot });
  }

  // ---- dry patches: sun-baked, yellowish, thin grass
  const dry: Meadow[] = [];
  for (let tries = 0; tries < 500 && dry.length < 9; tries++) {
    const hw = 5 + r() * 7, hd = 4 + r() * 5, x = (r() * 2 - 1) * lim, z = (r() * 2 - 1) * lim, rot = r() * Math.PI;
    if (!green(x, z, hw, hd, rot, 1) || dry.some((m) => Math.hypot(m.cx - x, m.cz - z) < 16)) continue;
    dry.push({ cx: x, cz: z, hw, hd, rot, kind: "dry", height: 0.25, tone: 0.05 + r() * 0.15 });
  }

  // ---- the uncut verge: strips of long, flowery grass along the quays and the sides of the paved compound and the sidings
  const strips: Meadow[] = [];
  const along = (origin: V2, d: V2, n: V2, o: number, t0: number, t1: number) => {
    const rot = rotOf(d);
    for (let t = t0; t < t1; t += 12) {
      const cx = origin.x + d.x * t + n.x * o, cz = origin.z + d.z * t + n.z * o;
      if (!green(cx, cz, 6.5, 1.7, rot, 0.3)) continue;
      strips.push({ cx, cz, hw: 6.5 + r() * 1.5, hd: 1.7 + r() * 0.7, rot, kind: r() < 0.6 ? "wild" : "hay", height: 0.5 + r() * 0.3, tone: 0.5 + r() * 0.4, strip: true });
    }
  };
  for (const q of [P.quays.south, P.quays.west, P.quays.north] as Quay[]) {
    for (const o of [10.6, 17.8]) along(q.p, q.d, q.n, o, -150, 150);
  }
  // round the compound (in the plant's frame)
  const c = P.compound, pr = P.rot, ax = { x: Math.cos(pr), z: -Math.sin(pr) }, az = { x: Math.sin(pr), z: Math.cos(pr) };
  for (const [lz, dir] of [[c.z0 - 2.4, ax], [c.z1 + 2.4, ax]] as const) along(toWorld(P.centre.x, P.centre.z, pr, 0, lz), dir, az, 0, -64, 64);
  for (const [lx] of [[c.x0 - 2.4], [c.x1 + 2.4]]) along(toWorld(P.centre.x, P.centre.z, pr, lx, 0), az, ax, 0, -38, 38);

  // ---- mown panels (stripes, a mowing edge where the next panel or the rough grass begins) and rough grass between them
  const panels: Meadow[] = [];
  const rects = (n: number, kinds: Meadow["kind"][], size: [number, number, number, number], tone: [number, number]) => {
    for (let tries = 0; tries < 900 && n > 0; tries++) {
      const hw = size[0] + r() * size[1], hd = size[2] + r() * size[3], x = (r() * 2 - 1) * lim, z = (r() * 2 - 1) * lim;
      const rot = P.rot + (r() < 0.35 ? Math.PI / 2 : 0) + (r() - 0.5) * 0.1;
      if (!green(x, z, hw, hd, rot, 1.5) || nearPost(x, z, hw * 0.3)) continue;
      const cand = { cx: x, cz: z, hw, hd, rot };
      if (panels.some((m) => Math.hypot(m.cx - x, m.cz - z) < (m.hw + hw) * 0.8) || dry.some((m) => Math.hypot(m.cx - x, m.cz - z) < m.hw + hw * 0.6)) continue;
      const kind = kinds[panels.length % kinds.length];
      panels.push({ ...cand, kind, height: kind === "mown" ? 0.06 : kind === "pasture" ? 0.4 : 0.8, tone: tone[0] + r() * (tone[1] - tone[0]) });
      n--;
    }
  };
  rects(7, ["mown"], [11, 8, 8, 6], [0.8, 0.98]);
  rects(5, ["pasture", "hay", "wild"], [8, 6, 6, 5], [0.45, 0.85]);

  // (the list is read front to back: the small, specific things first, the big panels last)
  L.meadows.push(...dry, ...strips, ...panels);
}
