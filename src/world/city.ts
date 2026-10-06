import {
  Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, VertexData, type Scene, type ShadowGenerator,
} from "@babylonjs/core";
import type { NavGrid } from "../game/nav";
import { rng } from "../util/noise";
import { toWorld, type HouseSpec, type MapLayout, type RGB } from "./layout";
import { mat } from "./models";
import { POND_LEVEL, type Terrain } from "./terrain";

/**
 * The city map's buildings (Botschaftsquartier): Parisian apartment blocks in rows and free-standing
 * town villas - pale limestone fronts with tall French windows, a rusticated ground floor with
 * shop windows on the blocks, a cornice, iron balconies, a grey zinc mansard roof with dormers and
 * chimney stacks, here and there a dome. Every building is solid (an obstacle like a wood).
 *
 * All buildings are merged into a few meshes (one per material) with UVs in metres, so the facade
 * textures keep their size on any building: one texture repeat is one window bay of one storey.
 */

/** Width of one window bay (m) and the storey height above the ground floor. */
const BAY = 3;
const STOREY = 3;
const GROUND = 4.2;
/** Facade tints: limestone, from warm cream to a cooler grey. */
const STONE: RGB[] = [[0.93, 0.88, 0.78], [0.9, 0.86, 0.77], [0.88, 0.85, 0.8], [0.94, 0.9, 0.82], [0.85, 0.81, 0.73], [0.91, 0.89, 0.85]];
const ZINC: RGB = [0.47, 0.5, 0.54];

/** Growing vertex buffers of one merged mesh. */
class Geo {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  /** A quad a-b-c-d (counter-clockwise seen from outside) with its own normal and UVs. */
  quad(p: number[][], uv: number[][], c: RGB) {
    const [a, b, , d] = p;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(nx, ny, nz);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(c[0], c[1], c[2], 1);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  /** An axis-aligned box in a building's frame (`w` along local x, `d` along z), turned and placed by `at`. */
  box(at: (lx: number, ly: number, lz: number) => number[], cx: number, y0: number, cz: number, w: number, h: number, d: number, c: RGB, tile = 1) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
    const P = (x: number, y: number, z: number) => at(x, y, z);
    const uvw = (a: number, b: number) => [[0, 0], [a / tile, 0], [a / tile, b / tile], [0, b / tile]];
    this.quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], uvw(w, h), c); // front (+z)
    this.quad([P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)], uvw(w, h), c); // back
    this.quad([P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)], uvw(d, h), c); // right (+x)
    this.quad([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], uvw(d, h), c); // left
    this.quad([P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)], uvw(w, d), c); // top
  }
  /** A convex, flat polygon (the points in the same order as round a footprint), as a fan. */
  fan(p: number[][], uv: number[][], c: RGB) {
    const base = this.pos.length / 3;
    const [a, b] = [p[0], p[1]], d = p[p.length - 1];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let i = 0; i < p.length; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(nx, ny, nz);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(c[0], c[1], c[2], 1);
    }
    for (let i = 1; i < p.length - 1; i++) this.idx.push(base, base + i + 1, base + i);
  }
  mesh(name: string, scene: Scene, material: StandardMaterial, shadows: ShadowGenerator): Mesh | null {
    if (!this.idx.length) return null;
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(this.pos);
    vd.normals = new Float32Array(this.nor);
    vd.uvs = new Float32Array(this.uv);
    vd.colors = new Float32Array(this.col);
    vd.indices = new Uint32Array(this.idx);
    vd.applyToMesh(m);
    m.material = material;
    m.isPickable = false;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    shadows.addShadowCaster(m);
    return m;
  }
}

/** A wall of a footprint: from a to b (local x, z), its outward normal, straight or part of a rounded corner. */
interface Edge { a: number[]; b: number[]; len: number; nx: number; nz: number; straight: boolean }

/**
 * A building's footprint (local x, z) going round from the front left corner over the front: a
 * rectangle whose corners may be rounded (radius per corner: +x+z, -x+z, -x-z, +x-z), the curve as
 * short straight pieces.
 */
function footprint(hw: number, hd: number, round: readonly number[]): number[][] {
  const pts: number[][] = [];
  // corners in order: front left (-x+z), front right (+x+z), back right (+x-z), back left (-x-z)
  const corners: [number, number, number, number][] = [[-hw, hd, round[1], Math.PI], [hw, hd, round[0], Math.PI / 2], [hw, -hd, round[3], 0], [-hw, -hd, round[2], -Math.PI / 2]];
  for (const [x, z, rad, a0] of corners) {
    if (rad <= 0) {
      pts.push([x, z]);
      continue;
    }
    // the arc's centre lies inside the corner; it runs a quarter turn clockwise (seen from above)
    const cx = x - Math.sign(x) * rad, cz = z - Math.sign(z) * rad;
    const steps = 5;
    for (let k = 0; k <= steps; k++) {
      const a = a0 - (k / steps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rad, cz + Math.sin(a) * rad]);
    }
  }
  return pts;
}

function edgesOf(foot: number[][]): Edge[] {
  return foot.map((a, i) => {
    const b = foot[(i + 1) % foot.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    return { a, b, len, nx, nz, straight: Math.abs(nx) > 0.999 || Math.abs(nz) > 0.999 };
  });
}

/** The footprint moved in by `d` (out for negative d): each wall shifted along its normal, the corners where they meet. */
function offset(foot: number[][], d: number): number[][] {
  const e = edgesOf(foot);
  const n = foot.length;
  return foot.map((p, i) => {
    const e0 = e[(i - 1 + n) % n], e1 = e[i];
    const sx = e0.nx + e1.nx, sz = e0.nz + e1.nz, k = 1 + e0.nx * e1.nx + e0.nz * e1.nz;
    return [p[0] - (sx / k) * d, p[1] - (sz / k) * d];
  });
}

/** A band round the building (string course, cornice): the footprint's walls from y up h, with a top. */
function prism(g: Geo, at: (x: number, y: number, z: number) => number[], foot: number[][], y: number, h: number, c: RGB) {
  for (const e of edgesOf(foot)) g.quad([at(e.a[0], y, e.a[1]), at(e.b[0], y, e.b[1]), at(e.b[0], y + h, e.b[1]), at(e.a[0], y + h, e.a[1])], [[0, 0], [1, 0], [1, 1], [0, 1]], c);
  g.fan(foot.map((p) => at(p[0], y + h, p[1])), foot.map(() => [0, 0]), c);
}

/** A frame along a wall: x along it from its start, z out of it (y unchanged), for boxes placed against the wall. */
function edgeFrame(at: (x: number, y: number, z: number) => number[], e: Edge) {
  const dx = (e.b[0] - e.a[0]) / e.len, dz = (e.b[1] - e.a[1]) / e.len;
  return (lx: number, ly: number, lz: number) => at(e.a[0] + dx * lx + e.nx * lz, ly, e.a[1] + dz * lx + e.nz * lz);
}

/** Upper storeys: ashlar courses, a tall French window with frame, sill and a little iron rail. */
function facadeTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const t = new DynamicTexture("parisFacade", { width: S, height: S }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  g.fillStyle = "#ececec";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#d9d9d9";
  for (let y = 26; y < S; y += 42) g.fillRect(0, y, S, 3); // stone courses
  // window: frame, glass with cross bars, lintel and sill
  const wx = 76, ww = 104, wy = 36, wh = 176;
  g.fillStyle = "#f8f8f8";
  g.fillRect(wx - 12, wy - 22, ww + 24, 18); // lintel
  g.fillRect(wx - 10, wy + wh, ww + 20, 10); // sill
  g.fillStyle = "#c8c8c8";
  g.fillRect(wx - 6, wy - 4, ww + 12, wh + 6); // reveal
  g.fillStyle = "#3a4450";
  g.fillRect(wx, wy, ww, wh);
  g.fillStyle = "#56616c";
  g.fillRect(wx + 4, wy + 4, ww / 2 - 8, wh * 0.45); // reflections
  g.fillStyle = "#e6e6e6";
  g.fillRect(wx + ww / 2 - 3, wy, 6, wh); // the two casements
  for (let k = 1; k < 4; k++) g.fillRect(wx, wy + (wh * k) / 4 - 2, ww, 4);
  // a little wrought-iron rail across the lower part
  g.fillStyle = "#1d1f22";
  g.fillRect(wx - 4, wy + wh - 50, ww + 8, 5);
  for (let x = wx; x < wx + ww; x += 9) g.fillRect(x, wy + wh - 50, 3, 46);
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

/** Ground floor of the apartment blocks: rusticated stone, an arched shop window or doorway per bay. */
function shopTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const t = new DynamicTexture("parisShops", { width: S, height: S }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  g.fillStyle = "#e2e2e2";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#c4c4c4";
  for (let y = 18; y < S; y += 30) g.fillRect(0, y, S, 4); // deep rustication grooves
  // arched opening
  const ax = 46, aw = 164, top = 54;
  g.fillStyle = "#f4f4f4";
  g.beginPath();
  g.arc(ax + aw / 2, top + aw / 2, aw / 2 + 10, Math.PI, 0);
  g.lineTo(ax + aw + 10, S);
  g.lineTo(ax - 10, S);
  g.fill();
  g.fillStyle = "#2c3238";
  g.beginPath();
  g.arc(ax + aw / 2, top + aw / 2, aw / 2, Math.PI, 0);
  g.lineTo(ax + aw, S - 16);
  g.lineTo(ax, S - 16);
  g.fill();
  g.fillStyle = "#4b555f";
  g.fillRect(ax + 10, top + aw / 2, aw / 2 - 18, 90);
  g.fillStyle = "#1a1d20";
  g.fillRect(ax, top + aw / 2 - 6, aw, 8); // transom
  g.fillRect(ax + aw / 2 - 3, top + aw / 2, 6, S - top - aw / 2 - 16);
  g.fillStyle = "#9a9a9a";
  g.fillRect(ax - 10, S - 16, aw + 20, 16); // step
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

/** Zinc roofing: standing seams. */
function zincTexture(scene: Scene): DynamicTexture {
  const S = 128;
  const t = new DynamicTexture("zinc", { width: S, height: S }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  g.fillStyle = "#d8d8d8";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#b4b4b4";
  for (let x = 0; x < S; x += 32) g.fillRect(x, 0, 4, S);
  g.fillStyle = "#e8e8e8";
  for (let x = 4; x < S; x += 32) g.fillRect(x, 0, 2, S);
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

export function createCity(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid) {
  const r = rng(2024);
  const walls = new Geo(), shops = new Geo(), stone = new Geo(), roof = new Geo(), iron = new Geo();
  const domes: Mesh[] = [];

  const build = (h: HouseSpec, inMap: boolean) => {
    const floors = h.floors ?? 5;
    const hw = h.w / 2, hd = h.d / 2;
    let minY = Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      const p = toWorld(h.x, h.z, h.rot, sx * hw, sz * hd);
      minY = Math.min(minY, terrain.heightAt(p.x, p.z));
    }
    const yb = minY - 0.3, y0 = minY;
    const at = (lx: number, ly: number, lz: number) => {
      const p = toWorld(h.x, h.z, h.rot, lx, lz);
      return [p.x, ly, p.z];
    };
    const tint = STONE[h.body % STONE.length];
    const cream: RGB = [tint[0] * 1.02, tint[1] * 1.02, tint[2] * 1.02];
    const villa = h.style === "villa";
    const corner = !!h.round && !h.mass;
    const plain = !!h.plain;
    const yTop = y0 + h.h, yG = y0 + GROUND;
    const foot = footprint(hw, hd, h.round ?? [0, 0, 0, 0]);
    const n = foot.length;
    // what each wall is: a party wall to a neighbour (hidden: plain, no windows needed) or a street front
    const party = (e: Edge) => !villa && !h.mass && ((e.nx < -0.99) || (corner ? e.nz < -0.99 : e.nx > 0.99));
    const front = (e: Edge) => e.straight && (h.mass ? Math.abs(e.nx) > 0.99 || Math.abs(e.nz) > 0.99 : corner ? e.nx > 0.99 || e.nz > 0.99 : e.nz > 0.99);
    const edges = edgesOf(foot);
    // walls, the ground floor of the blocks with shop fronts; u runs on round the building
    let u = 0;
    for (const e of edges) {
      const A = (y: number) => at(e.a[0], y, e.a[1]), B = (y: number) => at(e.b[0], y, e.b[1]);
      const u0 = u / BAY, u1 = (u + e.len) / BAY;
      if (villa) {
        const v = (y: number) => (y - y0 - 1.2) / STOREY;
        walls.quad([A(yb), B(yb), B(yTop), A(yTop)], [[u0, v(yb)], [u1, v(yb)], [u1, v(yTop)], [u0, v(yTop)]], tint);
      } else {
        const s0 = u / 3.5, s1 = (u + e.len) / 3.5;
        shops.quad([A(yb), B(yb), B(yG), A(yG)], [[s0, (yb - y0) / GROUND], [s1, (yb - y0) / GROUND], [s1, 1], [s0, 1]], tint);
        const v = (y: number) => (y - yG) / STOREY;
        walls.quad([A(yG), B(yG), B(yTop), A(yTop)], [[u0, 0], [u1, 0], [u1, v(yTop)], [u0, v(yTop)]], tint);
      }
      u += e.len;
    }
    // string course over the ground floor, the cornice under the roof
    prism(stone, at, offset(foot, -0.12), yG - 0.12, 0.24, cream);
    prism(stone, at, offset(foot, -0.3), yTop, 0.45, cream);
    // the mansard: steep zinc slopes from the cornice in to a flatter top
    const rb = yTop + 0.45, rt = rb + h.roofH * 0.78, inset = 1.5;
    const base = offset(foot, -0.1), top = offset(foot, inset);
    const slope = Math.hypot(inset, rt - rb);
    for (let k = 0; k < n; k++) {
      const a = base[k], b = base[(k + 1) % n], c = top[(k + 1) % n], d = top[k];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      roof.quad([at(a[0], rb, a[1]), at(b[0], rb, b[1]), at(c[0], rt, c[1]), at(d[0], rt, d[1])], [[0, 0], [len / 2, 0], [len / 2, slope / 2], [0, slope / 2]], ZINC);
    }
    roof.fan(top.map((p) => at(p[0], rt, p[1])), top.map((p) => [p[0] / 2, p[1] / 2]), [ZINC[0] * 0.92, ZINC[1] * 0.92, ZINC[2] * 0.92]);
    // dormers in the slopes of the street fronts (and of the courtyard side), one per bay
    if (!plain) {
      for (const e of edges) {
        if (party(e) || !e.straight || e.len < 4) continue;
        const bays = Math.max(1, Math.floor((e.len - 2) / BAY));
        const frame = edgeFrame(at, e);
        for (let k = 0; k < bays; k++) {
          const s = e.len / 2 - ((bays - 1) * BAY) / 2 + k * BAY;
          roof.box(frame, s, rb + 0.35, -0.75, 1.1, 1.45, 1.2, ZINC);
          iron.quad([frame(s - 0.36, rb + 0.55, -0.14), frame(s + 0.36, rb + 0.55, -0.14), frame(s + 0.36, rb + 1.5, -0.14), frame(s - 0.36, rb + 1.5, -0.14)], [[0, 0], [1, 0], [1, 1], [0, 1]], [0.2, 0.24, 0.28]);
        }
      }
    }
    // chimney stacks: on the party walls, otherwise on two corners of the roof's top
    const stacks: number[][] = [];
    for (const e of edges) {
      if (!party(e)) continue;
      stacks.push([(e.a[0] + e.b[0]) / 2 - e.nx * 0.5, (e.a[1] + e.b[1]) / 2 - e.nz * 0.5]);
    }
    if (h.mass) {
      // a whole block: rows of stacks over its roof, as over the party walls of the houses it is made of
      for (let x = -hw + 6; x <= hw - 6; x += 11) for (let z = -hd + 6; z <= hd - 6; z += 8) stacks.push([x + (r() - 0.5) * 2, z]);
    } else if (!stacks.length) {
      for (const k of [0, Math.floor(n / 2)]) stacks.push(offset(foot, inset + 0.6)[k]);
    }
    for (const [cx, cz] of stacks) {
      stone.box(at, cx, rt - 0.4, cz, 0.9, 1.9, 0.9, [0.74, 0.5, 0.4]);
      if (!plain) iron.box(at, cx, rt + 1.5, cz, 0.18, 0.4, 0.18, [0.55, 0.32, 0.24]);
    }
    // iron balconies on the street fronts: the third and the top storey of a block, the first floor of a villa
    if (h.balconies && inMap && !plain) {
      const levels = villa ? [yG] : [yG + STOREY, ...(floors >= 5 ? [yTop - STOREY] : [])];
      for (const e of edges) {
        if (!front(e) || e.len < 4) continue;
        const frame = edgeFrame(at, e), m = e.len / 2;
        for (const y of levels) {
          stone.box(frame, m, y - 0.15, 0.35, e.len - 0.6, 0.15, 0.7, cream);
          iron.box(frame, m, y, 0.68, e.len - 0.6, 0.95, 0.05, [0.08, 0.09, 0.1]);
          for (const sx of [0.32, e.len - 0.32]) iron.box(frame, sx, y, 0.35, 0.05, 0.95, 0.7, [0.08, 0.09, 0.1]);
        }
      }
    }
    // a dome: over the rounded corner of a corner house (or of a block), in the middle of a villa,
    // somewhere along a row
    if (h.dome) {
      const rr = h.round?.[0] ?? 0;
      const [lx, lz] = rr > 0 ? [hw - rr, hd - rr] : villa ? [0, 0] : [(r() < 0.5 ? -1 : 1) * Math.max(0, hw - 3.2), 0];
      const rad = villa ? 2 : rr > 0 ? Math.min(3, rr * 0.8) : Math.min(2.8, hw - 0.4);
      const p = toWorld(h.x, h.z, h.rot, lx, lz);
      const drum = MeshBuilder.CreateCylinder("domeDrum", { height: 1.8, diameter: rad * 2, tessellation: 16 }, scene);
      drum.position.set(p.x, rt + 0.9, p.z);
      const cap = MeshBuilder.CreateSphere("domeCap", { diameter: rad * 2.1, segments: 10, slice: 0.5 }, scene);
      cap.scaling.y = 1.35;
      cap.position.set(p.x, rt + 1.8, p.z);
      const lantern = MeshBuilder.CreateCylinder("domeLantern", { height: 1.1, diameter: rad * 0.5, tessellation: 8 }, scene);
      lantern.position.set(p.x, rt + 1.8 + rad * 1.4 + 0.4, p.z);
      const spike = MeshBuilder.CreateCylinder("domeSpike", { height: 1.2, diameterTop: 0, diameterBottom: rad * 0.55, tessellation: 8 }, scene);
      spike.position.set(p.x, rt + 1.8 + rad * 1.4 + 1.5, p.z);
      domes.push(drum, cap, lantern, spike);
    }
    if (inMap) nav.blockRect(h.x, h.z, hw, hd, h.rot);
  };

  for (const h of layout.houses) if (h.style) build(h, true);
  for (const h of layout.outerHouses) build(h, false);

  const facade = new StandardMaterial("parisFacadeMat", scene);
  facade.diffuseTexture = facadeTexture(scene);
  facade.specularColor = Color3.Black();
  facade.metadata = { rough: 0.8 };
  const shop = new StandardMaterial("parisShopMat", scene);
  shop.diffuseTexture = shopTexture(scene);
  shop.specularColor = Color3.Black();
  shop.metadata = { rough: 0.75 };
  const plain = new StandardMaterial("parisStoneMat", scene);
  plain.specularColor = Color3.Black();
  plain.metadata = { rough: 0.8 };
  const zinc = new StandardMaterial("parisZincMat", scene);
  zinc.diffuseTexture = zincTexture(scene);
  zinc.specularColor = new Color3(0.12, 0.12, 0.13);
  zinc.metadata = { rough: 0.38, metal: 0.55 };
  const ironMat = new StandardMaterial("parisIronMat", scene);
  ironMat.specularColor = new Color3(0.08, 0.08, 0.08);
  ironMat.metadata = { rough: 0.45, metal: 0.4 };
  walls.mesh("parisWalls", scene, facade, shadows);
  shops.mesh("parisShops", scene, shop, shadows);
  stone.mesh("parisStone", scene, plain, shadows);
  roof.mesh("parisRoofs", scene, zinc, shadows);
  iron.mesh("parisIron", scene, ironMat, shadows);
  if (domes.length) {
    const d = Mesh.MergeMeshes(domes, true, true)!;
    d.name = "parisDomes";
    d.material = mat(scene, [0.4, 0.45, 0.5], { rough: 0.35, metal: 0.6 });
    d.isPickable = false;
    d.receiveShadows = true;
    d.freezeWorldMatrix();
    shadows.addShadowCaster(d);
  }

  // ---- the park's ponds: still, dark water
  const water = new StandardMaterial("pondWater", scene);
  water.diffuseColor = new Color3(0.24, 0.34, 0.36);
  water.specularColor = new Color3(0.55, 0.6, 0.62);
  water.specularPower = 90;
  water.metadata = { rough: 0.16 };
  for (const p of layout.ponds) {
    const disc = MeshBuilder.CreateDisc("pond", { radius: 1, tessellation: 40 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.bakeCurrentTransformIntoVertices();
    disc.scaling.set(p.rx * 1.08, 1, p.rz * 1.08);
    disc.rotation.y = p.rot;
    disc.position.set(p.x, POND_LEVEL, p.z);
    disc.material = water;
    disc.isPickable = false;
    disc.receiveShadows = true;
    disc.freezeWorldMatrix();
    // nobody wades through: the water is an obstacle (the shore is not) - filled with circles along its long axis
    const n = Math.ceil(Math.max(p.rx, p.rz) / 2);
    for (let k = -n; k <= n; k++) {
      const t = k / n;
      const along = p.rx >= p.rz ? p.rx : p.rz;
      const cross = (p.rx >= p.rz ? p.rz : p.rx) * Math.sqrt(Math.max(0, 1 - t * t));
      if (cross < 0.8) continue;
      const c = toWorld(p.x, p.z, p.rot, p.rx >= p.rz ? t * along * 0.92 : 0, p.rx >= p.rz ? 0 : t * along * 0.92);
      nav.blockCircle(c.x, c.z, cross * 0.85);
    }
  }

  // ---- road blocks where the streets leave the map: concrete barriers, a striped plank across
  const barrier = new Geo();
  for (const b of layout.barriers) {
    const at = (lx: number, ly: number, lz: number) => {
      const p = toWorld(b.x, b.z, b.rot, lx, lz);
      return [p.x, ly + terrain.heightAt(b.x, b.z), p.z];
    };
    const n = Math.floor(b.len / 2.1);
    for (let k = 0; k < n; k++) {
      const lx = -b.len / 2 + 1.05 + k * (b.len / n);
      barrier.box(at, lx, 0, 0, 1.9, 0.82, 0.6, [0.72, 0.7, 0.66]);
      barrier.box(at, lx, 0.82, 0, 1.9, 0.12, 0.35, k % 2 ? [0.85, 0.15, 0.12] : [0.92, 0.92, 0.9]);
    }
  }
  const bm = new StandardMaterial("barrierMat", scene);
  bm.specularColor = Color3.Black();
  bm.metadata = { surface: "concrete", rough: 0.85 };
  barrier.mesh("roadBlocks", scene, bm, shadows);
}
