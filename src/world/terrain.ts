import { Color3, DynamicTexture, Mesh, Scene, StandardMaterial, Texture, VertexData } from "@babylonjs/core";
import { MAP_HALF, TERRAIN_HALF, TERRAIN_RES } from "../config";
import { fbm, hash01, lerp, smoothstep, valueNoise } from "../util/noise";
import type { MapLayout, RGB } from "./layout";

const GRASS_A: RGB = [0.55, 0.55, 0.26];
/** Cliff faces and the mountain wall. */
const ROCK_DARK: RGB = [0.36, 0.33, 0.29];
/** Colour the bottom of the abyss fades into (cool haze). */
const DEPTH_HAZE: RGB = [0.24, 0.27, 0.31];
const SNOW: RGB = [0.9, 0.91, 0.93];
const GRASS_B: RGB = [0.68, 0.57, 0.28];
const GRASS_LOW: RGB = [0.43, 0.5, 0.23];
const ROCK: RGB = [0.5, 0.44, 0.34];
const LITTER: RGB = [0.46, 0.3, 0.14];
const LAWN: RGB = [0.46, 0.55, 0.26];
const ASPHALT: RGB = [0.28, 0.28, 0.3];
const CURB: RGB = [0.62, 0.6, 0.56];
const DIRT: RGB = [0.55, 0.41, 0.26];
const CONCRETE: RGB = [0.6, 0.58, 0.53];
const GRAVEL: RGB = [0.52, 0.49, 0.42];
const DIRT_CENTRE: RGB = [0.52, 0.45, 0.27];
const VERGE_DIRT: RGB = [0.54, 0.47, 0.28];
const VERGE_TOWN: RGB = [0.5, 0.5, 0.36];
const HEADLAND: RGB = [0.52, 0.48, 0.28];
const TRAMPLED: RGB = [0.52, 0.45, 0.3];
/** Width of the worn strip beside roads, where the surface fades into the grass. */
const VERGE = 1.8;
/** Subdivision (per side) of grid cells that contain surface edges. */
const DETAIL = 3;
/** Fewer samples suffice for the small detail triangles. */
const SUB_SAMPLES: [number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3],
];
/** Sample points per triangle (barycentric) for blending surfaces that cover a triangle partly. */
const SAMPLES: [number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3],
  [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3],
  [1 / 2, 1 / 2, 0], [0, 1 / 2, 1 / 2], [1 / 2, 0, 1 / 2],
];

function mix(out: RGB, a: RGB, b: RGB, t: number): RGB {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
  return out;
}

function set(out: RGB, c: RGB, k = 1): RGB {
  out[0] = c[0] * k; out[1] = c[1] * k; out[2] = c[2] * k;
  return out;
}

/** World units covered by one repeat of the grain texture. */
const GRAIN_TILE = 7;
const GRAIN_COMPENSATION = 1.09;

/**
 * Subtle, seamlessly tiling ground grain (soil, pebbles, grass tufts): multiplies the vertex colours
 * so the flat low-poly ground reads as a textured surface up close and evens out with distance.
 */
function createGrainTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("groundGrain", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  // periodic value noise so the texture tiles without seams
  const period = 16;
  const lattice = new Float32Array(period * period).map(() => Math.random());
  const at = (i: number, j: number) => lattice[((i % period) + period) % period + (((j % period) + period) % period) * period];
  const smooth = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y);
    let fx = x - i, fy = y - j;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    return lerp(lerp(at(i, j), at(i + 1, j), fx), lerp(at(i, j + 1), at(i + 1, j + 1), fx), fy);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const blotch = smooth((x / size) * period, (y / size) * period); // soft patches
      const grain = Math.random(); // fine grit
      const speck = Math.random() < 0.012 ? -0.12 : Math.random() < 0.01 ? 0.08 : 0; // pebbles / light specks
      const v = Math.min(1, 0.9 + (blotch - 0.5) * 0.08 + (grain - 0.5) * 0.09 + speck);
      const i = (x + y * size) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

interface FlatZone { x: number; z: number; r: number; f: number; h: number }

/** Low-poly, flat shaded, vertex-coloured height field. */
export class Terrain {
  readonly n = TERRAIN_RES;
  readonly cell = (TERRAIN_HALF * 2) / TERRAIN_RES;
  readonly heights: Float32Array;
  readonly mesh: Mesh;
  private readonly zones: FlatZone[];
  /** Number of grid cells that were subdivided for extra surface detail (for diagnostics). */
  detailCells = 0;

  constructor(scene: Scene, readonly layout: MapLayout) {
    const L = layout;
    this.zones = [
      ...[L.playerBase, L.enemyBase].map((b) => ({ x: b.x, z: b.z, r: 22, f: 18, h: 0 })),
      ...L.suburbs.map((s) => ({ x: s.x, z: s.z, r: s.r - 4, f: 20, h: 0 })),
      ...L.outposts.map((o) => ({ x: o.x, z: o.z, r: 9, f: 10, h: 0 })),
    ];
    for (const zn of this.zones) zn.h = this.baseHeight(zn.x, zn.z);

    const n1 = this.n + 1;
    this.heights = new Float32Array(n1 * n1);
    for (let j = 0; j <= this.n; j++) {
      for (let i = 0; i <= this.n; i++) {
        this.heights[i + j * n1] = this.heightFn(-TERRAIN_HALF + i * this.cell, -TERRAIN_HALF + j * this.cell);
      }
    }
    this.mesh = this.buildMesh(scene);
  }

  private baseHeight(x: number, z: number): number {
    let h = fbm(x * 0.0105 + 5.3, z * 0.0105 - 2.1, 4, 3) * 15;
    h += Math.sin(x * 0.021 + 0.6) * Math.cos(z * 0.018 - 0.4) * 2.5;
    return h + this.border(x, z);
  }

  /**
   * Beyond the playable area: to the south, west and east the ground breaks off into a deep gorge
   * (ragged cliff, spurs and ledges, a hazy floor) whose far side rises again as a high wall, so the
   * view never runs past the terrain; to the north a mountain wall rises, wrapping around the corners.
   */
  private border(x: number, z: number): number {
    const wobble = valueNoise(x * 0.06, z * 0.06, 31) * 3.5 + valueNoise(x * 0.2, z * 0.2, 32) * 1.2;
    // the rim swings in and out in broad bays and headlands, never closer than ~2 m to the playable area
    const bays = valueNoise(x * 0.022 + 3.1, z * 0.022 - 1.7, 37) * 9 + valueNoise(x * 0.07, z * 0.07, 38) * 3;
    // distance outside the playable square (south, west, east and the corners)
    const out = Math.max(-z - MAP_HALF, Math.abs(x) - MAP_HALF, z - MAP_HALF);
    // 0 in the south, 1 at the north edge: the gorge turns into the mountain wall around the corners
    const north = smoothstep(MAP_HALF - 30, MAP_HALF + 4, z);
    const gorge = north < 1 ? this.gorge(x, z, Math.max(-z - MAP_HALF, Math.abs(x) - MAP_HALF), Math.max(2, 9 + bays + wobble * 0.6)) : 0;
    const mountain = north > 0 ? this.mountain(x, z, out, Math.max(2, 6.5 + wobble + bays * 0.5)) : 0;
    return lerp(gorge, mountain, north);
  }

  /**
   * Gorge profile at `side` metres outside the playable area: the ground breaks away in steps (a
   * sheer face, then spurs and ledges running on downwards), a hazy floor far below, and the far
   * side rising again as a high wall to a wooded plateau.
   */
  private gorge(x: number, z: number, side: number, edge: number): number {
    if (side <= edge - 1) return 0;
    const spur = Math.max(0, valueNoise(x * 0.045 - 4, z * 0.045 + 2, 39)) * 16 + 4;
    const ledge = 20 + valueNoise(x * 0.06, z * 0.06, 40) * 10;
    const first = smoothstep(edge, edge + 5, side);
    const slope = smoothstep(edge + 4, edge + spur, side); // the spur's sloping back
    const last = smoothstep(edge + spur, edge + spur + 7, side);
    let h = -(first * ledge + slope * 8 + last * (44 + valueNoise(x * 0.05, z * 0.05, 33) * 8));
    // rubble and jagged faces
    h += first * valueNoise(x * 0.25, z * 0.25, 34) * 3 + slope * valueNoise(x * 0.12, z * 0.12, 41) * 4;
    // the far side: a broken slope, then the high wall
    const far = 48 + valueNoise(x * 0.03 + 9, z * 0.03, 42) * 6;
    h += smoothstep(far - 10, far, side) * 24 + smoothstep(far, far + 14, side) * (124 + valueNoise(x * 0.04, z * 0.04, 43) * 12);
    h += smoothstep(far - 10, far + 12, side) * valueNoise(x * 0.18, z * 0.18, 44) * 5;
    return h;
  }

  /** Mountain wall profile at `d` metres outside the map: a steep wall, then higher jagged peaks. */
  private mountain(x: number, z: number, d: number, foot: number): number {
    if (d <= foot - 2) return 0;
    const k = d - foot;
    const ridge = Math.abs(fbm(x * 0.03 + 7, z * 0.03, 4, 35));
    return smoothstep(0, 9, k) * 26 + smoothstep(6, 45, k) * (24 + ridge * 40) + smoothstep(0, 20, k) * valueNoise(x * 0.2, z * 0.2, 36) * 4;
  }

  private heightFn(x: number, z: number): number {
    let h = this.baseHeight(x, z);
    for (const zn of this.zones) {
      const w = smoothstep(zn.r + zn.f, zn.r, Math.hypot(x - zn.x, z - zn.z));
      h = lerp(h, zn.h, w);
    }
    return h;
  }

  /** Exact height on the rendered triangles (same split as the mesh). */
  heightAt(x: number, z: number): number {
    const n = this.n, n1 = n + 1;
    let gx = (x + TERRAIN_HALF) / this.cell, gz = (z + TERRAIN_HALF) / this.cell;
    gx = Math.min(Math.max(gx, 0), n - 1e-4);
    gz = Math.min(Math.max(gz, 0), n - 1e-4);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const H = this.heights;
    const h00 = H[i + j * n1], h10 = H[i + 1 + j * n1], h01 = H[i + (j + 1) * n1], h11 = H[i + 1 + (j + 1) * n1];
    if (fx > fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h01 - h00) * fz + (h11 - h01) * fx;
  }

  /** Natural ground: autumn grass, greener valleys, drier hill tops, earthy slopes, lawns, forest floor. */
  private groundColor(x: number, z: number, h: number, slope: number, out: RGB): RGB {
    const L = this.layout;
    const nz = valueNoise(x * 0.08, z * 0.08, 5) * 0.6 + valueNoise(x * 0.3, z * 0.3, 9) * 0.4;
    mix(out, GRASS_A, GRASS_B, nz * 0.5 + 0.5);
    const low = smoothstep(2, -6, h);
    if (low > 0) mix(out, out, GRASS_LOW, low * 0.7);
    const k = 1 + Math.max(-0.08, Math.min(0.1, h * 0.006));
    out[0] *= k; out[1] *= k; out[2] *= k;
    const rock = smoothstep(0.18, 0.45, slope);
    if (rock > 0) mix(out, out, ROCK, rock);
    // cliffs and mountain faces: dark rock; snow on the high ground; haze deep in the abyss
    const cliff = smoothstep(0.7, 1.6, slope);
    if (cliff > 0) mix(out, out, ROCK_DARK, cliff * (0.85 + nz * 0.15));
    if (h > 30 && z > MAP_HALF - 10) mix(out, out, SNOW, smoothstep(34, 52, h + nz * 6) * (1 - cliff * 0.6));
    if (h < -6) mix(out, out, DEPTH_HAZE, smoothstep(-6, -55, h) * 0.85);

    for (const s of L.suburbs) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < s.r - 2) return mix(out, out, LAWN, smoothstep(s.r - 2, s.r - 6, d) * 0.85);
    }
    for (const f of L.forests) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.r + 3) return mix(out, out, LITTER, smoothstep(f.r + 3, f.r - 3, d) * (0.75 + nz * 0.2));
    }
    return out;
  }

  /**
   * Man-made surface painted onto the ground at a point: roads with worn verges, fields, base pads
   * and trampled earth around outposts. Writes the colour and returns its opacity (0 = nothing).
   */
  private decalAt(x: number, z: number, out: RGB): number {
    const L = this.layout;
    const nz = valueNoise(x * 0.3, z * 0.3, 9);

    for (const b of [L.playerBase, L.enemyBase]) {
      // gravel pad whose edge frays into the grass
      const edge = Math.max(Math.abs(x - b.x) - 15, Math.abs(z - b.z) - 12) + nz * 1.2;
      if (edge < 2.5) {
        mix(out, CONCRETE, GRAVEL, smoothstep(-6, 1, edge) * 0.8 + nz * 0.2);
        return smoothstep(2.5, -0.5, edge);
      }
    }

    const rd = L.nearestRoad(x, z);
    if (rd.road) {
      const asphalt = rd.road.kind === "asphalt";
      if (rd.d < 0) {
        set(out, asphalt ? ASPHALT : DIRT, 1 + nz * (asphalt ? 0.04 : 0.08));
        if (!asphalt && rd.d < -0.9) set(out, DIRT_CENTRE, 1 + nz * 0.06); // grassy hump between the ruts
        return 1;
      }
      if (asphalt && rd.d < 0.6) { set(out, CURB); return 1; }
      const verge = asphalt ? rd.d - 0.6 : rd.d;
      if (verge < VERGE) {
        set(out, asphalt ? VERGE_TOWN : VERGE_DIRT, 1 + nz * 0.08);
        return smoothstep(VERGE, 0, verge + nz * 0.4) * 0.75;
      }
    }

    const fa = L.fieldAt(x, z);
    if (fa) {
      const f = fa.f;
      const stripe = (Math.floor(fa.lx / f.sw) & 1) === 0;
      set(out, stripe ? f.base : f.stripe, 1 + nz * 0.05);
      // headland: the outermost strip is worn and blends into the surrounding grass
      const edge = Math.min(f.hw - Math.abs(fa.lx), f.hd - Math.abs(fa.lz));
      if (edge < 1.4) mix(out, out, HEADLAND, 0.5);
      return smoothstep(0, 0.8, edge) * 0.35 + 0.65;
    }

    for (const o of L.outposts) {
      const d = Math.hypot(x - o.x, z - o.z);
      if (d < 7) {
        set(out, TRAMPLED, 1 + nz * 0.08);
        return smoothstep(7, 2.5, d + nz * 1.5) * 0.7;
      }
    }
    return 0;
  }

  /**
   * True if the painted surface changes noticeably inside a grid cell (road/field edges, furrow
   * boundaries), i.e. the cell benefits from finer triangles.
   */
  private needsDetail(x0: number, z0: number, cs: number): boolean {
    const d: RGB = [0, 0, 0];
    let minW = Infinity, maxW = -Infinity;
    const lo: RGB = [Infinity, Infinity, Infinity], hi: RGB = [-Infinity, -Infinity, -Infinity];
    for (let b = 0; b < 4; b++) {
      for (let a = 0; a < 4; a++) {
        const w = this.decalAt(x0 + ((a + 0.5) / 4) * cs, z0 + ((b + 0.5) / 4) * cs, d);
        minW = Math.min(minW, w);
        maxW = Math.max(maxW, w);
        if (w > 0.3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[k]); hi[k] = Math.max(hi[k], d[k]); }
      }
    }
    if (maxW - minW > 0.25) return true;
    return maxW > 0.3 && Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > 0.06;
  }

  /** Final ground colour at a point (used by the minimap). `slope` is 0 (flat) .. 1 (vertical). */
  colorAt(x: number, z: number, h: number, slope: number, out: RGB): RGB {
    this.groundColor(x, z, h, slope, out);
    const d: RGB = [0, 0, 0];
    const w = this.decalAt(x, z, d);
    return w > 0 ? mix(out, out, d, w) : out;
  }

  private buildMesh(scene: Scene): Mesh {
    const n = this.n, n1 = n + 1, cs = this.cell, H = this.heights;
    const pos: number[] = [], nor: number[] = [], col: number[] = [];
    const c: RGB = [0, 0, 0];
    const dc: RGB = [0, 0, 0];
    let subdivided = 0;

    /** Blends the painted surfaces sampled inside the triangle over `base` into `c`. */
    const shade = (base: RGB, ax: number, az: number, bx: number, bz: number, cx: number, cz: number, samples: readonly (readonly number[])[]) => {
      c[0] = base[0]; c[1] = base[1]; c[2] = base[2];
      let wr = 0, wg = 0, wb = 0, ws = 0;
      for (const [a, b, cc] of samples) {
        const w = this.decalAt(ax * a + bx * b + cx * cc, az * a + bz * b + cz * cc, dc);
        wr += dc[0] * w; wg += dc[1] * w; wb += dc[2] * w; ws += w;
      }
      if (ws > 0) {
        const k = samples.length, cover = ws / k;
        c[0] = c[0] * (1 - cover) + wr / k;
        c[1] = c[1] * (1 - cover) + wg / k;
        c[2] = c[2] * (1 - cover) + wb / k;
      }
    };

    const emit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, jit: number) => {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nzz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nzz) || 1;
      nx /= len; ny /= len; nzz /= len;
      if (ny < 0) { nx = -nx; ny = -ny; nzz = -nzz; }
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (let k = 0; k < 3; k++) {
        nor.push(nx, ny, nzz);
        col.push(c[0] * jit, c[1] * jit, c[2] * jit, 1);
      }
    };

    /** Ground colour and facet jitter of one grid triangle (shared by its subdivisions). */
    const facet = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, out: RGB): number => {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nzz = ux * vy - uy * vx;
      const slope = 1 - Math.abs(ny) / (Math.hypot(nx, ny, nzz) || 1);
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      this.groundColor(mx, mz, my, slope, out);
      return 0.95 + hash01(mx * 0.731, mz * 0.917) * 0.1;
    };

    const gA: RGB = [0, 0, 0], gB: RGB = [0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = -TERRAIN_HALF + i * cs, z0 = -TERRAIN_HALF + j * cs, x1 = x0 + cs, z1 = z0 + cs;
        const h00 = H[i + j * n1], h10 = H[i + 1 + j * n1], h01 = H[i + (j + 1) * n1], h11 = H[i + 1 + (j + 1) * n1];
        const jitA = facet(x0, h00, z0, x1, h10, z0, x1, h11, z1, gA);
        const jitB = facet(x0, h00, z0, x1, h11, z1, x0, h01, z1, gB);
        const painted = Math.abs(x0) < MAP_HALF + 12 && Math.abs(z0) < MAP_HALF + 12;

        if (painted && this.needsDetail(x0, z0, cs)) {
          // finer triangles where a road or field edge (or a furrow) crosses the cell. They lie in the
          // planes of the two coarse triangles, so the terrain shape and heightAt() stay exactly the same.
          subdivided++;
          const S = DETAIL, st = cs / S;
          for (let b = 0; b < S; b++) {
            for (let a = 0; a < S; a++) {
              const sx0 = x0 + a * st, sz0 = z0 + b * st, sx1 = sx0 + st, sz1 = sz0 + st;
              const y00 = this.heightAt(sx0, sz0), y10 = this.heightAt(sx1, sz0), y01 = this.heightAt(sx0, sz1), y11 = this.heightAt(sx1, sz1);
              // lower-right sub-triangle belongs to coarse triangle A unless it lies above the diagonal
              const lowerInA = a >= b, upperInA = a > b;
              shade(lowerInA ? gA : gB, sx0, sz0, sx1, sz0, sx1, sz1, SUB_SAMPLES);
              emit(sx0, y00, sz0, sx1, y10, sz0, sx1, y11, sz1, lowerInA ? jitA : jitB);
              shade(upperInA ? gA : gB, sx0, sz0, sx1, sz1, sx0, sz1, SUB_SAMPLES);
              emit(sx0, y00, sz0, sx1, y11, sz1, sx0, y01, sz1, upperInA ? jitA : jitB);
            }
          }
          continue;
        }

        if (painted) shade(gA, x0, z0, x1, z0, x1, z1, SAMPLES); else { c[0] = gA[0]; c[1] = gA[1]; c[2] = gA[2]; }
        emit(x0, h00, z0, x1, h10, z0, x1, h11, z1, jitA);
        if (painted) shade(gB, x0, z0, x1, z1, x0, z1, SAMPLES); else { c[0] = gB[0]; c[1] = gB[1]; c[2] = gB[2]; }
        emit(x0, h00, z0, x1, h11, z1, x0, h01, z1, jitB);
      }
    }
    this.detailCells = subdivided;

    const vertCount = pos.length / 3;
    const idx = new Uint32Array(vertCount);
    for (let k = 0; k < vertCount; k++) idx[k] = k;

    const mesh = new Mesh("terrain", scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.normals = new Float32Array(nor);
    // the vertex colours are brightened a little because the grain texture darkens on average
    for (let k = 0; k < col.length; k += 4) {
      col[k] *= GRAIN_COMPENSATION;
      col[k + 1] *= GRAIN_COMPENSATION;
      col[k + 2] *= GRAIN_COMPENSATION;
    }
    vd.colors = new Float32Array(col);
    // planar world-space UVs for the tiling grain texture
    const uvs = new Float32Array((pos.length / 3) * 2);
    for (let k = 0, v = 0; k < pos.length; k += 3, v += 2) {
      uvs[v] = pos[k] / GRAIN_TILE;
      uvs[v + 1] = pos[k + 2] / GRAIN_TILE;
    }
    vd.uvs = uvs;
    vd.indices = idx;
    vd.applyToMesh(mesh);

    const mat = new StandardMaterial("terrainMat", scene);
    mat.diffuseTexture = createGrainTexture(scene);
    mat.diffuseColor = Color3.White();
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}
