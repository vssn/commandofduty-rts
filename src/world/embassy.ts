import { MAP_HALF, TERRAIN_HALF } from "../config";
import { segDist, toWorld, type Field, type HouseSpec, type MapLayout, type OutpostSpec, type RGB, type Road, type V2 } from "./layout";

/**
 * The Botschaftsquartier (embassy district): a city map, point-symmetric like the hill country. Each
 * side's quarter is a grid of wide streets with villa gardens (lawns with hedges, three- and
 * four-storey town villas in them), the base at a metro station's exit, a pharmacy and an
 * underground car park nearby. A park with paths, trees, bushes and ponds runs across the middle
 * of the map and holds the other outposts. Rows of Parisian apartment blocks (zinc mansard roofs,
 * domes, iron balconies) close the map off on all sides; the streets leading out end at road blocks.
 */

/** The ring street round the quarters and the park (x = ±RING, z = ±RING). */
export const RING = 106;
/** The boulevards along the park (z = ±BLVD). */
export const BLVD = 40;
/** Pavement beside a street, measured from the road's edge (the kerb takes its first 0.6 m). */
export const SIDEWALK = 3.2;
/** Depth of the apartment buildings round a block's courtyard. */
const ROW_DEPTH = 12;
/** The outer ring street (beyond the map) between the first and the second ring of blocks. */
const OUTER = RING + 4 + SIDEWALK + 34 + SIDEWALK + 4;
/** Where the second ring of blocks ends (as if another street ran there). */
const OUTER2 = OUTER + 4 + SIDEWALK + 34 + SIDEWALK + 4;
/** Radius of the rounded corner of a corner house. */
const CORNER = 4.5;

interface Street { a: V2; b: V2; w: number }

/** Point reflection through the centre: the enemy's half of the map. */
const mirror = (p: V2): V2 => ({ x: -p.x, z: -p.z });

const LAWN: RGB = [0.4, 0.52, 0.24];
const LAWN_STRIPE: RGB = [0.46, 0.58, 0.28];

export function buildEmbassy(L: MapLayout, r: () => number) {
  L.suburbs.length = 0;
  L.forests.length = 0;
  L.park = BLVD - 5 - SIDEWALK;
  const far = TERRAIN_HALF;

  // ---- streets (the player's half; the enemy's half is the point reflection)
  const half: Street[] = [
    // north-south streets of the southern quarter; two lead out of the city to the south
    { a: { x: -66, z: -far }, b: { x: -66, z: -BLVD }, w: 7.5 },
    { a: { x: -40, z: -RING }, b: { x: -40, z: -BLVD }, w: 10 },
    { a: { x: 2, z: -RING }, b: { x: 2, z: -BLVD }, w: 7.5 },
    { a: { x: 46, z: -far }, b: { x: 46, z: -BLVD }, w: 10 },
    // east-west streets: one leads out to the west, the boulevard along the park out to the east
    { a: { x: -far, z: -74 }, b: { x: RING, z: -74 }, w: 7.5 },
    { a: { x: -RING, z: -BLVD }, b: { x: far, z: -BLVD }, w: 10 },
    // the ring: the street along the southern row of houses and the western side
    { a: { x: -RING, z: -RING }, b: { x: RING, z: -RING }, w: 8 },
    { a: { x: -RING, z: -RING }, b: { x: -RING, z: RING }, w: 8 },
    // beyond the map the ring's streets run on outwards (at the corners they leave the map too), and an
    // outer ring street parts the first ring of blocks from the next
    { a: { x: -RING, z: -far }, b: { x: -RING, z: -RING }, w: 8 },
    { a: { x: -RING, z: RING }, b: { x: -RING, z: far }, w: 8 },
    { a: { x: -far, z: -RING }, b: { x: -RING, z: -RING }, w: 8 },
    { a: { x: RING, z: -RING }, b: { x: far, z: -RING }, w: 8 },
    { a: { x: -OUTER, z: -far }, b: { x: -OUTER, z: far }, w: 8 },
    { a: { x: -far, z: -OUTER }, b: { x: far, z: -OUTER }, w: 8 },
  ];
  const streets = [...half, ...half.map((s) => ({ a: mirror(s.a), b: mirror(s.b), w: s.w }))];
  for (const s of streets) L.roads.push({ a: s.a, b: s.b, w: s.w, kind: "asphalt" });
  const roadDist = (x: number, z: number) => Math.min(...streets.map((s) => segDist(x, z, s.a, s.b) - s.w / 2));

  // crossings (for lamps and trees to keep clear of)
  const crossings: V2[] = [];
  for (const s of streets) {
    for (const t of streets) {
      if (s === t) continue;
      const vs = s.a.x === s.b.x, vt = t.a.x === t.b.x;
      if (vs === vt) continue;
      const x = vs ? s.a.x : t.a.x, z = vs ? t.a.z : s.a.z;
      const within = (q: Street) => x >= Math.min(q.a.x, q.b.x) - 0.1 && x <= Math.max(q.a.x, q.b.x) + 0.1 && z >= Math.min(q.a.z, q.b.z) - 0.1 && z <= Math.max(q.a.z, q.b.z) + 0.1;
      if (within(s) && within(t) && !crossings.some((c) => Math.hypot(c.x - x, c.z - z) < 1)) crossings.push({ x, z });
    }
  }

  // ---- the blocks of the southern quarter: the base's square, the pharmacy, the car park, villa gardens
  const xs: [number, number][] = [[-RING, 8], [-66, 7.5], [-40, 10], [2, 7.5], [46, 10], [RING, 8]];
  const zs: [number, number][] = [[-RING, 8], [-74, 7.5], [-BLVD, 10]];
  const outposts: OutpostSpec[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i][0] + xs[i][1] / 2 + SIDEWALK, x1 = xs[i + 1][0] - xs[i + 1][1] / 2 - SIDEWALK;
      const z0 = zs[j][0] + zs[j][1] / 2 + SIDEWALK, z1 = zs[j + 1][0] - zs[j + 1][1] / 2 - SIDEWALK;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const inside = (p: V2) => p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1;
      if (inside(L.playerBase)) continue; // a paved square round the metro station's exit
      if (i === 0 && j === 1) {
        // the pharmacy on its little square, the shop door towards the street to the east
        outposts.push({ kind: "hospital", x: cx, z: cz, rot: Math.PI / 2, look: "pharmacy" });
        continue;
      }
      if (i === 3 && j === 0) {
        // the underground car park: its exit ramp comes up facing the street to the north
        outposts.push({ kind: "workshop", x: cx, z: cz, rot: 0, look: "garage" });
        continue;
      }
      // a villa garden, and its mirror image in the enemy's quarter
      const f0 = L.fields.length, h0 = L.houses.length;
      garden(L, r, x0 + 1.4, x1 - 1.4, z0 + 1.4, z1 - 1.4);
      for (const f of L.fields.slice(f0)) L.fields.push({ ...f, cx: -f.cx, cz: -f.cz });
      for (const h of L.houses.slice(h0)) L.houses.push({ ...h, x: -h.x, z: -h.z, rot: h.rot + Math.PI });
    }
  }

  // ---- the park and its outposts
  const parkPosts: OutpostSpec[] = [
    { kind: "radar", x: -64, z: -18, rot: 0.2 },
    { kind: "bunker", x: 16, z: -20, rot: -0.2 },
    { kind: "bunker", x: -91, z: -22, rot: 0.8 },
    { kind: "trench", x: -88, z: 8, rot: Math.PI / 2 },
    { kind: "tower", x: -30, z: -3, rot: -0.4 },
  ];
  outposts.push(...parkPosts);
  L.outposts.length = 0;
  for (const o of outposts) {
    L.outposts.push(o);
    const m = mirror(o);
    L.outposts.push({ ...o, x: m.x, z: m.z, rot: o.rot + Math.PI });
  }

  L.ponds.push({ x: 0, z: 0, rx: 10, rz: 6.5, rot: 0 });
  for (const p of [{ x: -44, z: 14 }, { x: 44, z: -14 }]) L.ponds.push({ ...p, rx: 11, rz: 7, rot: 0.25 });

  // gravel paths: round the ponds, out to the boulevards and across to the next pond
  const loop = (cx: number, cz: number, rx: number, rz: number, rot: number, n: number) => {
    const pts: V2[] = [];
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push(toWorld(cx, cz, rot, Math.cos(a) * rx, Math.sin(a) * rz));
    }
    return pts;
  };
  const pathLines: V2[][] = [loop(0, 0, 15, 11, 0, 32)];
  const halfPaths: V2[][] = [
    loop(-44, 14, 16, 11.5, 0.25, 28),
    [{ x: 0, z: -11 }, { x: -1.5, z: -22 }, { x: 0, z: -33.5 }], // to the southern boulevard
    [{ x: -10.5, z: -8 }, { x: -24, z: -16 }, { x: -40, z: -24 }, { x: -52, z: -33.5 }],
    [{ x: 10.5, z: -8 }, { x: 22, z: -15 }, { x: 34, z: -25 }, { x: 40, z: -33.5 }],
    [{ x: -14.5, z: 3 }, { x: -23, z: 6.5 }, { x: -29, z: 8 }],
    [{ x: -59.5, z: 17 }, { x: -76, z: 21 }, { x: -101, z: 25 }], // out to the western ring street
    [{ x: -60, z: 9 }, { x: -72, z: -6 }, { x: -80, z: -33.5 }],
  ];
  for (const pl of halfPaths) pathLines.push(pl, pl.map(mirror));
  for (const pl of pathLines) for (let i = 0; i < pl.length - 1; i++) L.paths.push({ a: pl[i], b: pl[i + 1], w: 2.6, kind: "dirt" });

  // ---- trees, bushes and lawns in the park (placed in pairs, mirrored)
  const park = L.park;
  const clearOf = (x: number, z: number, pad: number) =>
    L.inPark(x, z, pad) &&
    !L.outposts.some((o) => Math.hypot(o.x - x, o.z - z) < 9 + pad) &&
    L.pondDepth(x, z) < -0.35 - pad * 0.05 &&
    L.pathDistance(x, z) > pad;
  for (let tries = 0; tries < 600 && L.forests.length < 18; tries++) {
    const x = (r() * 2 - 1) * 96, z = (r() * 2 - 1) * (park - 4);
    const rad = 5 + r() * 5;
    if (!clearOf(x, z, rad * 0.6 + 1.5)) continue;
    if (L.forests.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + rad + 6 || Math.hypot(f.x + x, f.z + z) < f.r + rad + 6)) continue;
    const conifer = r() * 0.25;
    L.forests.push({ x, z, r: rad, conifer }, { x: -x, z: -z, r: rad, conifer });
  }
  for (let tries = 0; tries < 1500 && L.bushes.length < 140; tries++) {
    const x = (r() * 2 - 1) * 98, z = (r() * 2 - 1) * (park - 1);
    const rad = 0.7 + r() * 0.7;
    if (!clearOf(x, z, 1.6)) continue;
    if (L.forests.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 1)) continue;
    // in loose clumps: near another bush, or starting a new clump now and then
    const near = L.bushes.some((b) => Math.hypot(b.x - x, b.z - z) < 4.5);
    if (L.bushes.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + rad + 0.4)) continue;
    if (!near && r() < 0.75) continue;
    L.bushes.push({ x, z, r: rad }, { x: -x, z: -z, r: rad });
  }

  // ---- plane trees along the boulevards, street lamps along all streets
  const planted = (x: number, z: number) => L.plantedTrees.some((t) => Math.hypot(t.x - x, t.z - z) < 5);
  const lamp = (x: number, z: number, rot: number) => {
    if (Math.abs(x) > RING + 6 || Math.abs(z) > RING + 6) return;
    if (crossings.some((c) => Math.hypot(c.x - x, c.z - z) < 9)) return;
    if (L.plantedTrees.some((t) => Math.hypot(t.x - x, t.z - z) < 3)) return;
    L.streetLights.push({ x, z, rot });
  };
  for (const s of streets) {
    const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
    const dx = (s.b.x - s.a.x) / len, dz = (s.b.z - s.a.z) / len;
    const boulevard = s.w >= 10;
    for (let t = 4; t < len - 4; t += boulevard ? 9 : 15) {
      const px = s.a.x + dx * t, pz = s.a.z + dz * t;
      if (Math.abs(px) > RING + 6 || Math.abs(pz) > RING + 6) continue;
      if (crossings.some((c) => Math.hypot(c.x - px, c.z - pz) < 9)) continue;
      for (const side of [1, -1]) {
        const off = s.w / 2 + 1.9;
        const x = px + dz * side * off, z = pz - dx * side * off;
        if (boulevard && !planted(x, z) && roadDist(x, z) > 1.5) L.plantedTrees.push({ x, z });
      }
    }
    for (let t = 7, i = 0; t < len - 4; t += 16, i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const off = s.w / 2 + 0.85;
      const x = s.a.x + dx * t + dz * side * off, z = s.a.z + dz * t - dx * side * off;
      // (the arm reaches over the road)
      lamp(x, z, Math.atan2(-dz * side, dx * side));
    }
  }
  // garden trees: a few in the villa gardens, clear of the villas
  for (const f of L.fields) {
    let n = 0;
    for (let tries = 0; tries < 40 && n < 3; tries++) {
      const lx = (r() * 2 - 1) * (f.hw - 2.5), lz = (r() * 2 - 1) * (f.hd - 2.5);
      const p = toWorld(f.cx, f.cz, f.rot, lx, lz);
      if (L.houseAt(p.x, p.z, 3.5) || planted(p.x, p.z)) continue;
      L.plantedTrees.push(p);
      n++;
    }
  }

  // ---- blocks of apartment buildings round the map: the first ring with courtyards and rounded
  // corner houses (its fronts close the map off), a second ring further out as plain block masses
  const across = (vertical: boolean, at: number) => streets
    .filter((s) => (vertical ? s.a.x === s.b.x && Math.min(s.a.z, s.b.z) <= at && Math.max(s.a.z, s.b.z) >= at : s.a.z === s.b.z && Math.min(s.a.x, s.b.x) <= at && Math.max(s.a.x, s.b.x) >= at))
    .map((s) => ({ c: vertical ? s.a.x : s.a.z, w: s.w }));
  const cells = (cuts: { c: number; w: number }[], keep: (c0: number, c1: number) => boolean) => {
    const sorted = [...cuts].sort((a, b) => a.c - b.c).filter((c, i, all) => i === 0 || c.c - all[i - 1].c > 1);
    const out: [number, number][] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (keep(a.c, b.c)) out.push([a.c + a.w / 2 + SIDEWALK, b.c - b.w / 2 - SIDEWALK]);
    }
    return out;
  };
  for (const [inner, outer, first] of [[RING, OUTER, true], [OUTER, OUTER2, false]] as const) {
    const f0 = inner + 4 + SIDEWALK, f1 = outer - 4 - SIDEWALK, mid = (f0 + f1) / 2;
    const bound = [{ c: -outer, w: 8 }, { c: outer, w: 8 }];
    for (const side of [-1, 1]) {
      // south and north bands (corners included), between the streets crossing them
      for (const [x0, x1] of cells([...across(true, side * mid), ...bound], () => true)) {
        block(L, r, x0, x1, side < 0 ? -f1 : f0, side < 0 ? -f0 : f1, first);
      }
      // west and east bands, between the south and north bands
      for (const [z0, z1] of cells([...across(false, side * mid), ...bound], (a, b) => Math.abs((a + b) / 2) < inner)) {
        block(L, r, side < 0 ? -f1 : f0, side < 0 ? -f0 : f1, z0, z1, first);
      }
    }
  }

  // road blocks where the streets leave the map
  for (const s of streets) {
    const vertical = s.a.x === s.b.x;
    for (const edge of [-1, 1]) {
      const c = 119 * edge;
      const crosses = vertical ? Math.min(s.a.z, s.b.z) < c && Math.max(s.a.z, s.b.z) > c : Math.min(s.a.x, s.b.x) < c && Math.max(s.a.x, s.b.x) > c;
      if (!crosses) continue;
      L.barriers.push({ x: vertical ? s.a.x : c, z: vertical ? c : s.a.z, rot: vertical ? 0 : Math.PI / 2, len: s.w + SIDEWALK * 2 });
    }
  }
}

/** A villa garden: a lawn with a hedge round it, one or two town villas on it. */
function garden(L: MapLayout, r: () => number, x0: number, x1: number, z0: number, z1: number) {
  const hw = (x1 - x0) / 2, hd = (z1 - z0) / 2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const f: Field = { cx, cz, hw, hd, rot: 0, base: LAWN, stripe: LAWN_STRIPE, sw: 2.2, garden: true };
  L.fields.push(f);
  const twin = hw > 15;
  const spots = twin ? [cx - hw / 2, cx + hw / 2] : [cx + (r() - 0.5) * (hw - 9)];
  for (const x of spots) {
    // (narrow gardens get a narrower villa)
    const w = Math.min((twin ? hw : hw * 2) - 4.5, 10 + r() * 3.5), d = Math.min(hd * 2 - 6, 9 + r() * 3);
    if (w < 6.5 || d < 6.5) continue;
    const floors = 3 + (r() < 0.5 ? 1 : 0);
    // the villas face the street on the near side of the garden
    const z = cz + (r() - 0.5) * Math.max(0, hd * 2 - d - 8);
    L.houses.push({
      x, z, rot: r() < 0.5 ? 0 : Math.PI, w, d, h: storeyHeight(floors), roofH: 3.2,
      body: Math.floor(r() * 6), roof: 0, style: "villa", floors, dome: r() < 0.15, balconies: true,
    });
  }
}

/** Wall height of a city building: a tall ground floor, then 3 m per storey. */
export function storeyHeight(floors: number): number {
  return 4.2 + (floors - 1) * 3;
}

/** Does an axis-aligned rectangle reach into the map (with a margin)? */
const reaches = (cx: number, cz: number, ex: number, ez: number, margin: number) =>
  Math.max(0, Math.abs(cx) - ex) < MAP_HALF + margin && Math.max(0, Math.abs(cz) - ez) < MAP_HALF + margin;

/**
 * A city block between x0..x1, z0..z1. The first ring: apartment buildings round a courtyard - a
 * corner house with a rounded corner (often crowned by a dome) on each corner, rows of houses of
 * 9-16 m between them, all fronts to the street. Blocks too small for a courtyard, and all of the
 * second ring, are one block mass with rounded corners. Whatever reaches into the map is an obstacle
 * (`houses`), the rest scenery (`outerHouses`, without balconies and dormers further out).
 */
function block(L: MapLayout, r: () => number, x0: number, x1: number, z0: number, z1: number, first: boolean) {
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (W < 8 || D < 8) return;
  const put = (h: HouseSpec, ex: number, ez: number) => {
    const inMap = reaches(h.x, h.z, ex, ez, 0);
    h.plain = !reaches(h.x, h.z, ex, ez, 10);
    (inMap ? L.houses : L.outerHouses).push(h);
  };
  const floors = () => 4 + Math.floor(r() * 3);
  const d = ROW_DEPTH;
  if (!first || W < d * 2 + 6 || D < d * 2 + 6) {
    const f = first ? floors() : 5 + Math.floor(r() * 2);
    put({
      x: cx, z: cz, rot: 0, w: W, d: D, h: storeyHeight(f), roofH: 3.4, body: Math.floor(r() * 6), roof: 0,
      style: "paris", floors: f, round: [CORNER, CORNER, CORNER, CORNER], mass: true, balconies: first, dome: first && r() < 0.5,
    }, W / 2, D / 2);
    return;
  }
  // the corner houses: rot 0 puts the rounded corner at +x+z (north-east); each quarter turn moves it on
  for (const [sx, sz, rot] of [[1, 1, 0], [1, -1, Math.PI / 2], [-1, -1, Math.PI], [-1, 1, -Math.PI / 2]] as const) {
    const f = floors() + 1;
    put({
      x: cx + sx * (W / 2 - d / 2), z: cz + sz * (D / 2 - d / 2), rot, w: d, d, h: storeyHeight(f), roofH: 3.6,
      body: Math.floor(r() * 6), roof: 0, style: "paris", floors: f, round: [CORNER, 0, 0, 0], balconies: true, dome: r() < 0.55,
    }, d / 2, d / 2);
  }
  // rows along the four sides between the corners, fronts outwards
  const rowAlong = (len: number, at: (u: number) => V2, rot: number, alongX: boolean) => {
    if (len < 5) return;
    const n = Math.max(1, Math.round(len / (10 + r() * 4)));
    const lot = len / n;
    for (let i = 0; i < n; i++) {
      const p = at(-len / 2 + (i + 0.5) * lot);
      const f = floors();
      put({
        x: p.x, z: p.z, rot, w: lot - 0.02, d, h: storeyHeight(f), roofH: 3.4, body: Math.floor(r() * 6), roof: 0,
        style: "paris", floors: f, balconies: r() < 0.85, dome: r() < 0.04,
      }, alongX ? lot / 2 : d / 2, alongX ? d / 2 : lot / 2);
    }
  };
  const lx = W - 2 * d, lz = D - 2 * d;
  rowAlong(lx, (u) => ({ x: cx + u, z: z1 - d / 2 }), 0, true);
  rowAlong(lx, (u) => ({ x: cx - u, z: z0 + d / 2 }), Math.PI, true);
  rowAlong(lz, (u) => ({ x: x1 - d / 2, z: cz - u }), Math.PI / 2, false);
  rowAlong(lz, (u) => ({ x: x0 + d / 2, z: cz + u }), -Math.PI / 2, false);
}
