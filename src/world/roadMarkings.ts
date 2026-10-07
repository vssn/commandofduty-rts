import {
  Color3, DynamicTexture, Material, Mesh, MeshBuilder, StandardMaterial, Texture, VertexData, type InstancedMesh, type Scene,
} from "@babylonjs/core";
import type { NavGrid } from "../game/nav";
import { rng, smoothstep } from "../util/noise";
import { glowMaterial } from "./lighting";
import { MAP_HALF } from "../config";
import { segDist, type MapLayout, type V2 } from "./layout";
import type { Terrain } from "./terrain";

/**
 * The city's streets: a speckled, patched asphalt with tyre tracks and oil stains, worn white road paint
 * (centre and edge lines, bus lanes marked "BUS", left- and right-turn lanes with their arrows near the
 * junctions, stop lines and zebra crossings) and flashing amber traffic lights at four junctions.
 *
 * Everything is drawn as flat translucent quads just above the ground, merged into three meshes (road
 * surface, wear, paint); the textures carry the age: the paint has chipped away in patches, it is
 * never fresh.
 */

const SURFACE_Y = 0.03, WEAR_Y = 0.045, PAINT_Y = 0.06;
/** Markings are only drawn this far from the map's centre (the streets leave the map). */
const LIM = MAP_HALF + 8;
/** Texture tile sizes in metres. */
const PAINT_TILE = 6, WEAR_TILE = 6, SURFACE_TILE = 4;
/** Where the approach to a junction ends: stop line, zebra crossing. */
const STOP = 4.6, ZEBRA0 = 0.6, ZEBRA1 = 3.6;
const LINE = 0.13;

interface Road { A: V2; B: V2; d: V2; r: V2; len: number; w: number; vertical: boolean }
interface Junction { x: number; z: number; hw: number; hd: number; roads: Road[] }
/** A stretch of road between two junctions (or the end of the map). */
interface Block { road: Road; t0: number; t1: number; j0: V2 | null; j1: V2 | null }

/** Periodic value noise (tiles seamlessly): `p` lattice cells per tile. */
function periodic(seed: number, p: number): (x: number, y: number) => number {
  const r = rng(seed);
  const g = Float32Array.from({ length: p * p }, () => r());
  const at = (i: number, j: number) => g[(((j % p) + p) % p) * p + (((i % p) + p) % p)];
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function makeTexture(scene: Scene, name: string, size: number, pixel: (u: number, v: number, x: number, y: number, r: () => number) => [number, number, number, number]): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const r = rng(size * 31 + name.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [R, G, B, A] = pixel(x / size, y / size, x, y, r);
      const i = (y * size + x) * 4;
      img.data[i] = R;
      img.data[i + 1] = G;
      img.data[i + 2] = B;
      img.data[i + 3] = Math.round(Math.max(0, Math.min(1, A)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Road paint, aged: chipped in patches, scuffed, dirty, never solid. */
function paintTexture(scene: Scene): DynamicTexture {
  const coarse = periodic(11, 3), mid = periodic(12, 8), fine = periodic(13, 24);
  return makeTexture(scene, "roadPaint", 256, (u, v, _x, _y, r) => {
    const worn = smoothstep(0.35, 0.8, coarse(u * 3, v * 3)); // regions where the paint is mostly gone
    let a = 0.94 - worn * 0.35;
    a -= smoothstep(0.52 - worn * 0.12, 0.72, mid(u * 8, v * 8)) * 0.65; // chips
    a -= smoothstep(0.55, 0.85, fine(u * 24, v * 24)) * 0.3;
    if (r() < 0.1) a *= 0.35; // fine scuffs
    const dirt = 0.8 + 0.14 * fine(u * 24, v * 24) + 0.05 * r();
    return [226 * dirt, 224 * dirt, 214 * dirt, a];
  });
}

/** Dark wear on the asphalt: soft across (v), patchy along (u) - tyre tracks, oil, patches. */
function wearTexture(scene: Scene): DynamicTexture {
  const mid = periodic(21, 6), fine = periodic(22, 20);
  return makeTexture(scene, "roadWear", 256, (u, v, _x, _y, r) => {
    const across = Math.pow(Math.sin(Math.PI * v), 1.1);
    const along = 0.35 + 0.65 * mid(u * 6, v * 2.5);
    const a = across * along * (0.7 + 0.3 * fine(u * 20, v * 20)) * 0.42 + (r() - 0.5) * 0.04;
    return [28, 28, 31, a];
  });
}

/** The road's own grain: aggregate stones, lighter and darker, and blotches of different age. */
function surfaceTexture(scene: Scene): DynamicTexture {
  const blotch = periodic(31, 5), fine = periodic(32, 32);
  return makeTexture(scene, "roadGrain", 256, (u, v, _x, _y, r) => {
    const b = blotch(u * 5, v * 5);
    if (r() < 0.45) {
      const light = r() < 0.55;
      const k = light ? 150 + r() * 70 : 5 + r() * 25;
      return [k, k, k + 3, 0.1 + r() * 0.16];
    }
    // large areas of slightly lighter / darker asphalt (resurfaced, faded)
    return b > 0.5 ? [200, 200, 205, (b - 0.5) * 0.08 * (0.7 + fine(u * 32, v * 32))] : [12, 12, 14, (0.5 - b) * 0.07];
  });
}

function layerMaterial(scene: Scene, name: string, tex: Texture, zOffset: number): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseTexture = tex;
  m.useAlphaFromDiffuseTexture = true;
  m.diffuseColor = Color3.White();
  m.specularColor = Color3.Black();
  m.backFaceCulling = false;
  m.zOffset = zOffset;
  m.transparencyMode = Material.MATERIAL_ALPHABLEND;
  return m;
}

/** Flat quads collected into one mesh. */
class Layer {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];
  constructor(private readonly terrain: Terrain, private readonly y: number, private readonly tile: number) {}

  /** A quad from four corners (counter-clockwise seen from above) with world-mapped UVs, or with `uvs` given. */
  quad(p: [V2, V2, V2, V2], uvs?: [number, number][]) {
    const base = this.pos.length / 3;
    p.forEach((q, i) => {
      this.pos.push(q.x, this.terrain.heightAt(q.x, q.z) + this.y, q.z);
      const t = uvs ? uvs[i] : [q.x / this.tile, q.z / this.tile];
      this.uv.push(t[0], t[1]);
    });
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  tri(a: V2, b: V2, c: V2) {
    const base = this.pos.length / 3;
    for (const q of [a, b, c]) {
      this.pos.push(q.x, this.terrain.heightAt(q.x, q.z) + this.y, q.z);
      this.uv.push(q.x / this.tile, q.z / this.tile);
    }
    this.idx.push(base, base + 2, base + 1);
  }

  build(scene: Scene, name: string, material: Material, alphaIndex: number): Mesh | null {
    if (!this.pos.length) return null;
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.pos;
    vd.indices = this.idx;
    vd.uvs = this.uv;
    vd.normals = this.pos.map((_, i) => (i % 3 === 1 ? 1 : 0));
    vd.applyToMesh(m);
    m.material = material;
    m.alphaIndex = alphaIndex;
    m.isPickable = false;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    return m;
  }
}

/** The four flashing-amber traffic signals' meshes and their blink. */
interface Signals { dispose(): void }

export function createRoadMarkings(scene: Scene, layout: MapLayout, terrain: Terrain, nav: NavGrid): Signals {
  const rand = rng(77);
  const paintTex = paintTexture(scene), wearTex = wearTexture(scene), surfTex = surfaceTexture(scene);
  const surface = new Layer(terrain, SURFACE_Y, SURFACE_TILE), wear = new Layer(terrain, WEAR_Y, WEAR_TILE), paint = new Layer(terrain, PAINT_Y, PAINT_TILE);

  // ---- the streets
  const roads: Road[] = [];
  for (const rd of layout.roads) {
    if (rd.kind !== "asphalt") continue;
    const vertical = Math.abs(rd.a.x - rd.b.x) < 1e-6;
    if (!vertical && Math.abs(rd.a.z - rd.b.z) > 1e-6) continue;
    const len = Math.hypot(rd.b.x - rd.a.x, rd.b.z - rd.a.z);
    const d = { x: (rd.b.x - rd.a.x) / len, z: (rd.b.z - rd.a.z) / len };
    roads.push({ A: rd.a, B: rd.b, d, r: { x: d.z, z: -d.x }, len, w: rd.w, vertical });
  }
  const within = (q: Road, v: number) => v >= Math.min(...(q.vertical ? [q.A.z, q.B.z] : [q.A.x, q.B.x])) - 0.1 && v <= Math.max(...(q.vertical ? [q.A.z, q.B.z] : [q.A.x, q.B.x])) + 0.1;
  const hasRoad = (x: number, z: number) => roads.some((q) => segDist(x, z, q.A, q.B) < q.w / 2);
  /** World point on a road: t along it, s to the right of its direction. */
  const at = (R: Road, t: number, s: number): V2 => ({ x: R.A.x + R.d.x * t + R.r.x * s, z: R.A.z + R.d.z * t + R.r.z * s });
  /** Coordinate of a point t along the road on its axis (for the map clip). */
  const axis = (R: Road, t: number) => (R.vertical ? R.A.z + R.d.z * t : R.A.x + R.d.x * t);

  // junctions: where a vertical and a horizontal street meet (also at street ends)
  const junctions = new Map<string, Junction>();
  const V = roads.filter((q) => q.vertical), H = roads.filter((q) => !q.vertical);
  for (const v of V) {
    for (const h of H) {
      const x = v.A.x, z = h.A.z;
      if (!within(v, z) || !within(h, x)) continue;
      const key = `${Math.round(x)},${Math.round(z)}`;
      const j = junctions.get(key) ?? { x, z, hw: 0, hd: 0, roads: [] };
      j.hw = Math.max(j.hw, v.w / 2);
      j.hd = Math.max(j.hd, h.w / 2);
      j.roads.push(v, h);
      junctions.set(key, j);
    }
  }
  for (const j of junctions.values()) {
    if (Math.abs(j.x) > LIM || Math.abs(j.z) > LIM) continue;
    surface.quad([{ x: j.x - j.hw, z: j.z - j.hd }, { x: j.x - j.hw, z: j.z + j.hd }, { x: j.x + j.hw, z: j.z + j.hd }, { x: j.x + j.hw, z: j.z - j.hd }]);
  }

  // blocks: the stretches between the junctions
  const blocks: Block[] = [];
  for (const R of roads) {
    const ivs: { lo: number; hi: number; c: number }[] = [];
    for (const j of junctions.values()) {
      if (!j.roads.includes(R)) continue;
      const t = R.vertical ? (j.z - R.A.z) / R.d.z : (j.x - R.A.x) / R.d.x;
      const h = R.vertical ? j.hd : j.hw;
      ivs.push({ lo: t - h, hi: t + h, c: t });
    }
    ivs.sort((a, b) => a.lo - b.lo);
    const merged: { lo: number; hi: number; c: number }[] = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv.lo <= last.hi) {
        last.hi = Math.max(last.hi, iv.hi);
        last.c = (last.c + iv.c) / 2;
      } else merged.push({ ...iv });
    }
    let cursor = 0, from: number | null = null;
    const push = (t0: number, t1: number, c0: number | null, c1: number | null) => {
      // clipped to the part inside the map's surroundings
      let a = t0, b = t1, ja = c0, jb = c1;
      const lo = Math.min(axis(R, a), axis(R, b)), hi = Math.max(axis(R, a), axis(R, b));
      if (hi < -LIM || lo > LIM) return;
      const clip = (t: number, other: number) => {
        // moves t towards `other` until the axis coordinate is inside the limit
        const c = axis(R, t);
        if (Math.abs(c) <= LIM) return t;
        const target = Math.sign(c) * LIM;
        const k = (target - axis(R, t)) / ((axis(R, other) - axis(R, t)) || 1);
        return t + (other - t) * k;
      };
      const na = clip(a, b), nb = clip(b, a);
      if (na !== a) ja = null;
      if (nb !== b) jb = null;
      a = na;
      b = nb;
      if (b - a < 1) return;
      blocks.push({ road: R, t0: a, t1: b, j0: ja === null ? null : at(R, ja, 0), j1: jb === null ? null : at(R, jb, 0) });
    };
    for (const iv of merged) {
      if (iv.lo > cursor + 0.5) push(cursor, iv.lo, from, iv.c);
      cursor = Math.max(cursor, iv.hi);
      from = iv.c;
    }
    if (R.len > cursor + 0.5) push(cursor, R.len, from, null);
  }

  // ---- drawing helpers
  const strip = (R: Road, t0: number, t1: number, s0: number, s1: number, layer: Layer, uvs?: [number, number][]) => {
    if (t1 - t0 < 0.02) return;
    layer.quad([at(R, t0, s0), at(R, t1, s0), at(R, t1, s1), at(R, t0, s1)], uvs);
  };
  /** A line (centred on lateral position s). */
  const line = (R: Road, t0: number, t1: number, s: number, w = LINE) => strip(R, t0, t1, s - w / 2, s + w / 2, paint);
  const dashed = (R: Road, t0: number, t1: number, s: number, dash: number, gap: number, w = LINE) => {
    for (let t = t0; t < t1 - 0.2; t += dash + gap) line(R, t, Math.min(t1, t + dash), s, w);
  };
  /** A band of wear: soft across, with the texture along it starting somewhere else every time. */
  const band = (R: Road, t0: number, t1: number, s0: number, s1: number) => {
    const u0 = rand() * 8;
    strip(R, t0, t1, s0, s1, wear, [[u0, 0], [u0 + (t1 - t0) / WEAR_TILE, 0], [u0 + (t1 - t0) / WEAR_TILE, 1], [u0, 1]]);
  };

  // glyphs: a 3 x 5 grid of cells (row 0 is the far end), drawn on the road as seen by the driver
  const GLYPHS: Record<string, string[]> = {
    B: ["110", "101", "110", "101", "110"],
    U: ["101", "101", "101", "101", "111"],
    S: ["111", "100", "111", "001", "111"],
  };
  /** Frame of a driver's view: a point `ahead` metres forward and `right` metres to the right of `o`, `f` pointing the way he drives. */
  const frame = (o: V2, f: V2) => (ahead: number, right: number): V2 => ({ x: o.x + f.x * ahead + f.z * right, z: o.z + f.z * ahead - f.x * right });

  const arrow = (o: V2, f: V2, kind: "straight" | "left" | "right") => {
    const p = frame(o, f);
    const sw = 0.14; // half width of the shaft
    if (kind === "straight") {
      paint.quad([p(0, -sw), p(1.7, -sw), p(1.7, sw), p(0, sw)]);
      paint.tri(p(1.5, -0.5), p(2.5, 0), p(1.5, 0.5));
      return;
    }
    // a turn: the shaft goes forward, then bends to the side and ends in the arrow head
    const k = kind === "left" ? -1 : 1;
    paint.quad([p(0, -sw), p(1.3, -sw), p(1.3, sw), p(0, sw)]);
    paint.quad([p(1.0, k * -sw), p(1.0, k * 0.95), p(1.3, k * 0.95), p(1.3, k * -sw)] as [V2, V2, V2, V2]);
    paint.tri(p(0.55, k * 0.95), p(1.75, k * 0.95), p(1.15, k * 1.65));
  };
  const word = (o: V2, f: V2, text: string) => {
    const p = frame(o, f);
    const cw = 0.26, ch = 0.34;
    [...text].forEach((c, n) => {
      const g = GLYPHS[c];
      // the first letter is the nearest to the driver
      const near = n * 2.25;
      g.forEach((row, ri) => {
        [...row].forEach((cell, ci) => {
          if (cell !== "1") return;
          const a0 = near + (4 - ri) * ch, a1 = a0 + ch + 0.01, r0 = (ci - 1.5) * cw, r1 = r0 + cw + 0.01;
          paint.quad([p(a0, r0), p(a1, r0), p(a1, r1), p(a0, r1)]);
        });
      });
    });
  };

  // ---- every block
  for (const b of blocks) {
    const R = b.road, L = b.t1 - b.t0, H2 = R.w / 2, boulevard = R.w >= 10;
    // the asphalt itself: grain, worn bands, patches
    strip(R, b.t0, b.t1, -H2, H2, surface);
    const zone = (flag: boolean) => (flag ? Math.min(L * 0.45, boulevard ? 28 : 20) : 0);
    const flagS = b.j0 !== null, flagE = b.j1 !== null;
    const zoneS = zone(flagS), zoneE = zone(flagE);
    const mx = (flag: boolean) => (flag ? STOP : 0.4);
    const travel: [number, number] = [0.3, boulevard ? 3 : H2 - 0.1];

    // centre: solid before the junctions (single), dashed between; boulevards: a double line
    const c0 = b.t0 + mx(flagS), c1 = b.t1 - mx(flagE);
    if (boulevard) {
      line(R, c0, c1, -LINE, LINE);
      line(R, c0, c1, LINE, LINE);
    } else {
      if (zoneS) line(R, c0, b.t0 + zoneS, 0);
      if (zoneE) line(R, b.t1 - zoneE, c1, 0);
      dashed(R, b.t0 + (zoneS || 1), b.t1 - (zoneE || 1), 0, 3, 5);
    }
    // edge lines
    for (const s of [-1, 1]) line(R, c0, c1, s * (H2 - 0.3), 0.12);

    // zebra crossings at the junction ends: stripes along the road across its width
    for (const [flag, end, sign] of [[flagS, b.t0, 1], [flagE, b.t1, -1]] as const) {
      if (!flag) continue;
      const [z0, z1] = sign > 0 ? [end + ZEBRA0, end + ZEBRA1] : [end - ZEBRA1, end - ZEBRA0];
      for (let s = -H2 + 0.7; s < H2 - 0.5; s += 1.15) strip(R, z0, z1, s, s + 0.55, paint);
    }

    // lanes, per direction of travel
    for (const sigma of [1, -1] as const) {
      const flag = sigma > 0 ? flagE : flagS;
      const end = sigma > 0 ? b.t1 : b.t0;
      const jc = sigma > 0 ? b.j1 : b.j0;
      const f = { x: R.d.x * sigma, z: R.d.z * sigma };
      /** Position `dist` before the end, `lat` to the right of the middle of the road (as the driver sees it). */
      const P = (dist: number, lat: number) => at(R, end - sigma * dist, sigma * lat);
      const ts = (d0: number, d1: number): [number, number] => [Math.min(end - sigma * d0, end - sigma * d1), Math.max(end - sigma * d0, end - sigma * d1)];
      const dmax = L - 0.4;
      const zoneLen = sigma > 0 ? zoneE : zoneS;

      // what can be driven at the junction ahead
      let exits = { left: false, straight: false, right: false };
      if (flag && jc) {
        const reach = 6 + (boulevard ? 5 : 3.75);
        exits = {
          straight: hasRoad(jc.x + f.x * reach, jc.z + f.z * reach),
          left: hasRoad(jc.x + f.z * -reach, jc.z + f.x * reach),
          right: hasRoad(jc.x + f.z * reach, jc.z - f.x * reach),
        };
      }
      const turning = exits.left || exits.right;
      const mid = (travel[0] + travel[1]) / 2;
      if (flag && zoneLen > 8) {
        // stop line across all lanes of this side
        const [a0, a1] = ts(STOP - 0.45, STOP);
        strip(R, a0, a1, sigma * 0.35, sigma * (H2 - 0.15), paint);
        if (turning) {
          const split = exits.left && (exits.straight || exits.right);
          const lanes: { lat: number; arrows: ("straight" | "left" | "right")[] }[] = [];
          if (split) {
            // divider between the turning lane and the others: solid near the stop line, dashed beyond
            const [d0, d1] = ts(STOP + 0.6, STOP + 7);
            strip(R, d0, d1, sigma * (mid - LINE / 2), sigma * (mid + LINE / 2), paint);
            const [e0, e1] = ts(STOP + 7, zoneLen);
            for (let t = Math.min(e0, e1); t < Math.max(e0, e1) - 0.2; t += 3) strip(R, t, Math.min(Math.max(e0, e1), t + 1.5), sigma * (mid - LINE / 2), sigma * (mid + LINE / 2), paint);
            lanes.push({ lat: (travel[0] + mid) / 2, arrows: ["left", "left", "left"] });
            lanes.push({ lat: (mid + travel[1]) / 2, arrows: exits.straight ? ["straight", exits.right ? "right" : "straight", "straight"] : ["right", "right", "right"] });
          } else {
            lanes.push({ lat: mid, arrows: exits.left ? ["left", "left", "left"] : exits.straight ? ["straight", "right", "straight"] : ["right", "right", "right"] });
          }
          const spots = boulevard ? [8.5, 17, 25.5] : [8.5, 16.5];
          for (const ln of lanes) {
            spots.forEach((dist, i) => {
              if (dist + 2.8 > zoneLen) return;
              arrow(P(dist + 2.5, ln.lat), f, ln.arrows[i]);
            });
          }
        }
      }
      // the bus lane (boulevards): a solid line, dashed where it may be left near the junction, and "BUS"
      if (boulevard) {
        const sepD = flag ? STOP : 0.4;
        if (zoneLen > 8) {
          const [a0, a1] = ts(sepD, zoneLen);
          for (let t = Math.min(a0, a1); t < Math.max(a0, a1) - 0.2; t += 3) strip(R, t, Math.min(Math.max(a0, a1), t + 1.5), sigma * (3 - LINE / 2), sigma * (3 + LINE / 2), paint);
          const [s0, s1] = ts(zoneLen, dmax);
          strip(R, s0, s1, sigma * (3 - LINE / 2), sigma * (3 + LINE / 2), paint);
        } else {
          const [s0, s1] = ts(sepD, dmax);
          strip(R, s0, s1, sigma * (3 - LINE / 2), sigma * (3 + LINE / 2), paint);
        }
        for (const dist of [11, L * 0.5, L - 14]) {
          if (dist < (flag ? STOP : 0.4) + 3 || dist > dmax - 6 || (dist === L * 0.5 && L < 60)) continue;
          word(P(dist + 3, 4), f, "BUS");
        }
      }

      // wear: tyre tracks along the lanes (heavier where cars wait before the line), oil under the engines
      const lanesAt = boulevard ? [travel[0] + 1.45, 4] : [mid];
      for (const lat of lanesAt) {
        for (const off of [-0.8, 0.8]) {
          const [w0, w1] = ts(flag ? STOP - 0.5 : 0.4, dmax);
          band(R, w0, w1, sigma * (lat + off - 0.28), sigma * (lat + off + 0.28));
        }
        if (flag) {
          const [o0, o1] = ts(STOP + 0.4, STOP + 2.2);
          band(R, o0, o1, sigma * (lat - 0.7), sigma * (lat + 0.7));
        }
      }
    }

    // patches of repaired asphalt and trenches
    const n = Math.floor(L / 22);
    for (let i = 0; i < n; i++) {
      const t = b.t0 + 6 + rand() * Math.max(0.1, L - 12), lat = (rand() * 2 - 1) * (H2 - 1.4);
      const len = 1.6 + rand() * 3.4, wd = 0.9 + rand() * 1.6;
      band(R, t, t + len, lat - wd / 2, lat + wd / 2);
      if (rand() < 0.35) band(R, t - 4 - rand() * 8, t + len + 4 + rand() * 8, lat - 0.2, lat + 0.2); // a trench cut and filled
    }
  }

  const surfaceMesh = surface.build(scene, "roadSurface", layerMaterial(scene, "roadSurfaceMat", surfTex, -1), 1);
  const wearMesh = wear.build(scene, "roadWear", layerMaterial(scene, "roadWearMat", wearTex, -2), 2);
  const paintMesh = paint.build(scene, "roadPaint", layerMaterial(scene, "roadPaintMat", paintTex, -3), 3);

  // ---- flashing amber signals at the four junctions of the boulevards with the avenues
  const lights = signals(scene, terrain, nav, blocks, [...junctions.values()].filter((j) => new Set(j.roads.filter((q) => q.w >= 10)).size >= 2 && Math.abs(j.x) < MAP_HALF && Math.abs(j.z) < MAP_HALF));

  return {
    dispose() {
      lights.dispose();
      for (const m of [surfaceMesh, wearMesh, paintMesh]) {
        m?.material?.dispose();
        m?.dispose();
      }
      for (const t of [paintTex, wearTex, surfTex]) t.dispose();
    },
  };
}

/**
 * A pole with a three-lamp signal head on the right-hand pavement of every approach to the junction,
 * facing the oncoming traffic; only the amber lamp is lit, flashing (about once a second).
 */
function signals(scene: Scene, terrain: Terrain, nav: NavGrid, blocks: Block[], junctions: Junction[]): Signals {
  const grey = new StandardMaterial("signalPole", scene);
  grey.diffuseColor = new Color3(0.3, 0.32, 0.31);
  grey.specularColor = Color3.Black();
  const body = new StandardMaterial("signalBody", scene);
  body.diffuseColor = new Color3(0.07, 0.07, 0.07);
  body.specularColor = Color3.Black();
  const lens = (name: string, c: [number, number, number]) => {
    const m = new StandardMaterial(name, scene);
    m.emissiveColor = new Color3(...c);
    m.disableLighting = true; // (stays as it is in the realistic mode, too)
    return m;
  };
  const red = lens("signalRed", [0.18, 0.02, 0.02]), green = lens("signalGreen", [0.02, 0.15, 0.04]);
  const amber = lens("signalAmber", [1, 0.62, 0.05]);
  const OFF = new Color3(0.2, 0.11, 0.01), ON = new Color3(1, 0.62, 0.05);

  const parts: Mesh[] = [];
  const add = (m: Mesh, material: StandardMaterial, x: number, y: number, z: number) => {
    m.position.set(x, y, z);
    m.material = material;
    parts.push(m);
    return m;
  };
  add(MeshBuilder.CreateCylinder("signalPole", { height: 3.6, diameter: 0.12, tessellation: 8 }, scene), grey, 0, 1.8, 0);
  add(MeshBuilder.CreateBox("signalHead", { width: 0.36, height: 1.0, depth: 0.28 }, scene), body, 0, 3.7, 0);
  add(MeshBuilder.CreateBox("signalHood", { width: 0.42, height: 0.06, depth: 0.45 }, scene), body, 0, 4.22, 0.08);
  for (const [y, m] of [[4.0, red], [3.7, amber], [3.4, green]] as const) {
    const l = MeshBuilder.CreateSphere("signalLens", { diameter: 0.24, segments: 8 }, scene);
    l.scaling.z = 0.4;
    add(l, m, 0, y, 0.15);
  }
  const tpl = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  tpl.name = "trafficSignal";
  tpl.isPickable = false;
  tpl.isVisible = false;

  const haloMat = glowMaterial(scene, "signalHalo", [1, 0.62, 0.1], 0.95);
  const haloTpl = MeshBuilder.CreatePlane("signalHaloTpl", { size: 2.6 }, scene);
  haloTpl.material = haloMat;
  haloTpl.billboardMode = Mesh.BILLBOARDMODE_ALL;
  haloTpl.isPickable = false;
  haloTpl.isVisible = false;

  const insts: InstancedMesh[] = [], halos: InstancedMesh[] = [];
  for (const j of junctions) {
    for (const b of blocks) {
      const R = b.road;
      // an approach: the block ends at this junction (traffic drives towards it on the right-hand side)
      for (const sigma of [1, -1] as const) {
        const jc = sigma > 0 ? b.j1 : b.j0;
        if (!jc || Math.hypot(jc.x - j.x, jc.z - j.z) > 1.5) continue;
        const end = sigma > 0 ? b.t1 : b.t0;
        const lat = R.w / 2 + 1.3, dist = 3;
        const x = R.A.x + R.d.x * (end - sigma * dist) + R.r.x * sigma * lat;
        const z = R.A.z + R.d.z * (end - sigma * dist) + R.r.z * sigma * lat;
        const y = terrain.heightAt(x, z);
        const inst = tpl.createInstance("signal");
        inst.position.set(x, y, z);
        inst.rotation.y = Math.atan2(-R.d.x * sigma, -R.d.z * sigma); // the lamps face the oncoming traffic
        inst.isPickable = false;
        inst.freezeWorldMatrix();
        insts.push(inst);
        nav.blockCircle(x, z, 0.2);
        const halo = haloTpl.createInstance("signalHalo");
        halo.position.set(x - R.d.x * sigma * 0.25, y + 3.7, z - R.d.z * sigma * 0.25);
        halos.push(halo);
      }
    }
  }

  const tick = () => {
    const on = Math.floor(performance.now() / 600) % 2 === 0;
    amber.emissiveColor.copyFrom(on ? ON : OFF);
    for (const h of halos) h.setEnabled(on);
  };
  const obs = scene.onBeforeRenderObservable.add(tick);
  tick();
  return {
    dispose() {
      scene.onBeforeRenderObservable.remove(obs);
      for (const i of [...insts, ...halos]) i.dispose();
      tpl.dispose();
      haloTpl.dispose();
    },
  };
}
