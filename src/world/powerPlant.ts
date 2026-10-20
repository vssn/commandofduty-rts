import {
  Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, type Scene, type ShadowGenerator,
} from "@babylonjs/core";
import { MAP_HALF, TERRAIN_HALF } from "../config";
import type { NavGrid } from "../game/nav";
import { toWorld, type MapLayout, type RGB, type V2 } from "./layout";
import { mat } from "./models";
import { createCoal, type CoalHeap } from "./coal";
import { alongNorth, DECK_H, deckHeight, inBox, type Box, type PowerPlant, type Quay } from "./power";
import type { Obstacle } from "./props";
import type { Terrain } from "./terrain";

/**
 * The power station's buildings and works (see power.ts): water in the harbour basins, quay walls
 * along the slanted quays, the raised walkways on their supports (with railings; one walks on them
 * and underneath), the stairs, the machine hall (columns below, the storeys above see-through), the
 * cooling tower with its plume, the chimney, the coal conveyor, the water pipelines, the rail sidings
 * with coal trains and the transformer yard with lines out to high-voltage pylons. The walkways and
 * stairs are pickable (metadata.deck): a click on them means the upper level. Blocks the supports,
 * columns and works on the ground's navigation grid. Returns the solid works (for cover and sight) and
 * the switch for the coal's look (cubes in the classic look, mounds in the realistic one).
 */

const CONCRETE: RGB = [0.66, 0.65, 0.61];
const STEEL: RGB = [0.34, 0.37, 0.4];
const RAIL: RGB = [0.28, 0.42, 0.36];
const DARK: RGB = [0.13, 0.13, 0.14];

/** Rotation (as mesh.rotation.y) of a direction (x, z). */
const yaw = (d: V2) => Math.atan2(-d.z, d.x);

/** Collects parts and merges them. */
class Parts {
  readonly list: Mesh[] = [];
  constructor(private readonly scene: Scene) {}
  /** A box at (x, y, z), turned by `rotY` (as mesh.rotation.y). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, rotY = 0, opts: Parameters<typeof mat>[2] = {}) {
    const m = MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.material = mat(this.scene, c, opts);
    this.list.push(m);
    return m;
  }
  /** A box placed in a rotated frame (centre cx, cz, rotation rot) at local (lx, lz). */
  boxIn(f: Box | { x: number; z: number; rot: number }, w: number, h: number, d: number, lx: number, y: number, lz: number, c: RGB, opts: Parameters<typeof mat>[2] = {}) {
    const p = toWorld(f.x, f.z, f.rot, lx, lz);
    return this.box(w, h, d, p.x, y, p.z, c, f.rot, opts);
  }
  rod(a: Vector3, b: Vector3, r: number, c: RGB, tess = 8, opts: Parameters<typeof mat>[2] = {}) {
    const d = b.subtract(a), len = d.length();
    const m = MeshBuilder.CreateCylinder("rod", { height: len, diameter: r * 2, tessellation: tess }, this.scene);
    m.position.copyFrom(a.add(b).scale(0.5));
    m.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), d.normalize(), new Quaternion());
    m.material = mat(this.scene, c, opts);
    this.list.push(m);
    return m;
  }
  merge(name: string, shadows: ShadowGenerator | null, pickable = false): Mesh | null {
    if (!this.list.length) return null;
    const m = Mesh.MergeMeshes(this.list, true, true, undefined, false, true)!;
    m.name = name;
    m.isPickable = pickable;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    shadows?.addShadowCaster(m);
    return m;
  }
}

/** Where two quay lines meet. */
function meet(a: Quay, b: Quay): V2 {
  const det = a.d.x * -b.d.z - a.d.z * -b.d.x;
  const t = ((b.p.x - a.p.x) * -b.d.z - (b.p.z - a.p.z) * -b.d.x) / det;
  return { x: a.p.x + a.d.x * t, z: a.p.z + a.d.z * t };
}

export function createPowerPlant(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid): { obstacles: Obstacle[]; setRealistic(on: boolean): void } {
  const P = layout.plant!;
  const obstacles: Obstacle[] = [];
  const parts = new Parts(scene);
  const inMap = (x: number, z: number) => Math.abs(x) < MAP_HALF + 4 && Math.abs(z) < MAP_HALF + 4;
  const solid = (x: number, z: number, hw: number, hd: number, rot: number, height: number) => {
    obstacles.push({ x, z, hw, hd, rot, height });
    if (inMap(x, z)) nav.blockRect(x, z, hw, hd, rot, 0.1);
  };
  const post = (x: number, z: number, r = 0.4) => { if (inMap(x, z)) nav.blockRect(x, z, r, r, 0, 0.05); };
  const gy = (x: number, z: number) => terrain.heightAt(x, z);
  const onDeck = (x: number, z: number) => deckHeight(P, x, z) !== null;

  // ---- water: one sheet over everything, below the land (it shows only in the basins)
  const water = MeshBuilder.CreateGround("harbourWater", { width: TERRAIN_HALF * 2.4, height: TERRAIN_HALF * 2.4, subdivisions: 2 }, scene);
  water.position.y = -2.6;
  const wm = new StandardMaterial("harbourWaterMat", scene);
  wm.diffuseColor = new Color3(0.1, 0.19, 0.25);
  wm.specularColor = new Color3(0.35, 0.4, 0.44);
  wm.specularPower = 120;
  wm.metadata = { rough: 0.14 };
  water.material = wm;
  water.isPickable = false;
  water.receiveShadows = true;
  water.freezeWorldMatrix();

  // ---- quay walls (thick enough to cover the ground's stepped edge) and bollards
  const Q = P.quays, SW = meet(Q.south, Q.west), NW = meet(Q.west, Q.north);
  const quayWall = (q: Quay, a: V2, b: V2) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const c = { x: (a.x + b.x) / 2 - q.n.x * 1.2, z: (a.z + b.z) / 2 - q.n.z * 1.2 };
    parts.box(len + 2.6, 9.4, 2.8, c.x, -4.6, c.z, [0.55, 0.54, 0.5], yaw(q.d), { surface: "concrete" });
    for (let t = 5; t < len; t += 14) {
      const x = a.x + ((b.x - a.x) * t) / len + q.n.x * 0.7, z = a.z + ((b.z - a.z) * t) / len + q.n.z * 0.7;
      if (inMap(x, z)) parts.box(0.45, 0.6, 0.45, x, 0.3, z, DARK);
    }
  };
  const far = TERRAIN_HALF + 30;
  const eastOf = (q: Quay) => ({ x: q.p.x + q.d.x * (far - q.p.x) / q.d.x, z: q.p.z + q.d.z * (far - q.p.x) / q.d.x });
  quayWall(Q.south, SW, eastOf(Q.south));
  quayWall(Q.west, { x: SW.x - Q.west.d.x * 30, z: SW.z - Q.west.d.z * 30 }, NW);
  quayWall(Q.north, { x: NW.x - Q.north.d.x * 30, z: NW.z - Q.north.d.z * 30 }, eastOf(Q.north));

  // ---- the walkways: floor slabs on supports, railings on their open edges
  const deck = new Parts(scene), rails = new Parts(scene);
  const hall = P.hall;
  for (const d of P.decks) {
    deck.box(d.hw * 2, 0.6, d.hd * 2, d.x, DECK_H - 0.3, d.z, [0.6, 0.6, 0.57], d.rot, { surface: "concrete" });
    // supports: along the long axis every ~9 m (on the outer edge of a gallery along the hall)
    const long = d.hw >= d.hd, L = long ? d.hw : d.hd, S = long ? d.hd : d.hw;
    const n = Math.max(1, Math.round((L * 2) / 9));
    for (let k = 0; k <= n; k++) {
      const a = -L + 1 + ((L * 2 - 2) * k) / n;
      for (const b of S > 3.5 ? [-S + 1.2, S - 1.2] : [0]) {
        const p = toWorld(d.x, d.z, d.rot, long ? a : b, long ? b : a);
        if (inBox(hall, p.x, p.z, 0.6)) continue;
        parts.box(0.7, DECK_H - 0.6, 0.7, p.x, (DECK_H - 0.6) / 2, p.z, CONCRETE, d.rot, { surface: "concrete" });
        post(p.x, p.z, 0.45);
      }
    }
    // railings: along each edge, wherever the walkway does not go on (another walkway, a stair, the hall's wall)
    const edges: [number, number, number, number, number, number][] = [
      [-d.hw, d.hd, d.hw, d.hd, 0, 1], [-d.hw, -d.hd, d.hw, -d.hd, 0, -1], [-d.hw, -d.hd, -d.hw, d.hd, -1, 0], [d.hw, -d.hd, d.hw, d.hd, 1, 0],
    ];
    for (const [ax, az, bx, bz, ox, oz] of edges) {
      const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.round(len / 1));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const lx = ax + (bx - ax) * t, lz = az + (bz - az) * t;
        const out = toWorld(d.x, d.z, d.rot, lx + ox * 0.5, lz + oz * 0.5);
        if (onDeck(out.x, out.z) || inBox(hall, out.x, out.z, 0.2)) continue;
        const p = toWorld(d.x, d.z, d.rot, lx - ox * 0.08, lz - oz * 0.08);
        const r = d.rot + (ox !== 0 ? Math.PI / 2 : 0);
        rails.box(len / steps + 0.02, 0.07, 0.07, p.x, DECK_H + 1.05, p.z, RAIL, r, { metal: 0.5, rough: 0.4 });
        rails.box(len / steps + 0.02, 0.05, 0.05, p.x, DECK_H + 0.55, p.z, RAIL, r, { metal: 0.5, rough: 0.4 });
        rails.box(len / steps + 0.02, 0.18, 0.04, p.x, DECK_H + 0.09, p.z, RAIL, r);
        if (k % 2 === 0) rails.box(0.07, 1.05, 0.07, p.x, DECK_H + 0.52, p.z, RAIL, r);
      }
    }
  }
  // stairs: steps from the ground up to the walkway, solid stringers with a handrail on both sides
  for (const s of P.stairs) {
    const steps = Math.round((s.hd * 2) / 0.4);
    for (let k = 0; k < steps; k++) {
      const z0 = -s.hd + (k * s.hd * 2) / steps, z1 = -s.hd + ((k + 1) * s.hd * 2) / steps;
      const top = (DECK_H * (k + 1)) / steps;
      const p = toWorld(s.x, s.z, s.rot, 0, (z0 + z1) / 2);
      deck.box(s.hw * 2, 0.22, z1 - z0 + 0.02, p.x, top - 0.11, p.z, [0.58, 0.58, 0.55], s.rot, { surface: "concrete" });
      for (const sx of [-1, 1]) {
        const q = toWorld(s.x, s.z, s.rot, sx * (s.hw + 0.1), (z0 + z1) / 2);
        rails.box(0.2, Math.max(0.3, top), z1 - z0 + 0.02, q.x, top / 2, q.z, STEEL, s.rot);
        rails.box(0.06, 0.06, z1 - z0 + 0.02, q.x, top + 1.0, q.z, RAIL, s.rot);
      }
    }
  }
  const deckMesh = deck.merge("walkways", shadows, true);
  if (deckMesh) deckMesh.metadata = { deck: true };
  rails.merge("walkwayRails", shadows);

  // ---- the machine hall: columns on the ground floor (open to walk through), the storeys above
  // and the boiler house see-through over a steel frame
  const frame: RGB = [0.24, 0.3, 0.34], FLOOR = DECK_H;
  const glass = new StandardMaterial("hallGlass", scene);
  glass.diffuseColor = new Color3(0.62, 0.7, 0.76);
  glass.specularColor = new Color3(0.3, 0.3, 0.32);
  glass.alpha = 0.24;
  glass.backFaceCulling = false;
  glass.metadata = { rough: 0.2 };
  const glassParts: Mesh[] = [];
  const glassBoxIn = (w: number, h: number, d: number, lx: number, y: number, lz: number) => {
    const m = MeshBuilder.CreateBox("hallGlass", { width: w, height: h, depth: d }, scene);
    const p = toWorld(hall.x, hall.z, hall.rot, lx, lz);
    m.position.set(p.x, y, p.z);
    m.rotation.y = hall.rot;
    glassParts.push(m);
  };
  for (let k = 0; k <= 10; k++) {
    const lx = -hall.hw + (k * hall.hw * 2) / 10;
    for (const lz of [-hall.hd, hall.hd, 0]) {
      const end = k === 0 || k === 10;
      if (lz === 0 && (end || Math.abs(lx) < 8)) continue; // (the doors at the ends, the bunker in the middle)
      const top = lx >= hall.boilerX ? hall.boilerHeight : hall.height;
      parts.boxIn(hall, 0.8, top, 0.8, lx, top / 2, lz, frame);
      const p = toWorld(hall.x, hall.z, hall.rot, lx, lz);
      post(p.x, p.z, 0.45);
    }
  }
  for (const [x0, x1, top] of [[-hall.hw, hall.boilerX, hall.height], [hall.boilerX, hall.hw, hall.boilerHeight]] as const) {
    const w = x1 - x0, d = hall.hd * 2, cx = (x0 + x1) / 2;
    for (const y of [FLOOR, top]) {
      parts.boxIn(hall, w, 0.5, 0.5, cx, y, -hall.hd, frame);
      parts.boxIn(hall, w, 0.5, 0.5, cx, y, hall.hd, frame);
      parts.boxIn(hall, 0.5, 0.5, d, x0, y, 0, frame);
      parts.boxIn(hall, 0.5, 0.5, d, x1, y, 0, frame);
    }
    glassBoxIn(w, top - FLOOR, d, cx, (FLOOR + top) / 2, 0);
  }
  for (const lx of [-20, -6]) {
    const t = MeshBuilder.CreateCylinder("turbine", { height: 9, diameter: 3.6, tessellation: 16 }, scene);
    t.rotation.set(0, hall.rot, Math.PI / 2);
    const p = toWorld(hall.x, hall.z, hall.rot, lx, 0);
    t.position.set(p.x, FLOOR + 2.2, p.z);
    glassParts.push(t);
  }
  const drum = MeshBuilder.CreateCylinder("boiler", { height: 18, diameter: 7, tessellation: 16 }, scene);
  const dp = toWorld(hall.x, hall.z, hall.rot, (hall.boilerX + hall.hw) / 2, 0);
  drum.position.set(dp.x, FLOOR + 10, dp.z);
  glassParts.push(drum);
  const hallGlass = Mesh.MergeMeshes(glassParts, true, true)!;
  hallGlass.name = "hallGlass";
  hallGlass.material = glass;
  hallGlass.isPickable = false;
  hallGlass.freezeWorldMatrix();

  // ---- cooling tower: a concrete hyperboloid on a ring of legs; a plume of vapour over it
  const T = P.tower;
  const shape: Vector3[] = [];
  for (let k = 0; k <= 16; k++) {
    const y = (k / 16) * T.height, waist = 0.68 * T.height;
    const r = T.r * 0.62 + (T.r - T.r * 0.62) * Math.pow((y - waist) / waist, 2) * (y < waist ? 1 : 1.8);
    shape.push(new Vector3(r, y + 3, 0));
  }
  // (see-through: it is tall and wide, and stands in the camera's way - the units behind it stay in sight)
  const shell = MeshBuilder.CreateLathe("coolingTower", { shape, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE }, scene);
  shell.position.set(T.x, gy(T.x, T.z), T.z);
  const shellMat = new StandardMaterial("coolingTowerMat", scene);
  shellMat.diffuseColor = new Color3(0.78, 0.77, 0.74);
  shellMat.specularColor = Color3.Black();
  shellMat.alpha = 0.4;
  shellMat.backFaceCulling = false;
  shellMat.metadata = { rough: 0.9 };
  // (drawn after a depth-only pass: its near and far side sort right, no flicker where they overlap)
  shellMat.needDepthPrePass = true;
  shell.material = shellMat;
  shell.isPickable = false;
  shell.freezeWorldMatrix();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    parts.box(0.6, 3.2, 0.6, T.x + Math.cos(a) * T.r * 0.99, gy(T.x, T.z) + 1.5, T.z + Math.sin(a) * T.r * 0.99, [0.5, 0.49, 0.46], -a);
  }
  nav.blockCircle(T.x, T.z, T.r + 0.6);
  obstacles.push({ x: T.x, z: T.z, hw: T.r * 0.75, hd: T.r * 0.75, rot: 0, height: T.height });
  const vapour = new StandardMaterial("vapour", scene);
  vapour.diffuseColor = new Color3(0.95, 0.95, 0.96);
  vapour.emissiveColor = new Color3(0.35, 0.35, 0.36);
  vapour.specularColor = Color3.Black();
  vapour.alpha = 0.32;
  vapour.metadata = { rough: 1 };
  const puffs: Mesh[] = [];
  for (let k = 0; k < 7; k++) {
    const p = MeshBuilder.CreateSphere("vapour", { diameter: T.r * (1.4 + k * 0.25), segments: 8 }, scene);
    p.scaling.y = 0.6;
    p.position.set(T.x + k * 2.5, T.height + 6 + k * 5, T.z - k * 1.5);
    puffs.push(p);
  }
  const plume = Mesh.MergeMeshes(puffs, true, true)!;
  plume.name = "coolingPlume";
  plume.material = vapour;
  plume.isPickable = false;

  // ---- chimney: tapering concrete, red and white bands at the top
  const C = P.chimney;
  const stack = MeshBuilder.CreateCylinder("chimney", { height: C.height, diameterBottom: C.r * 2, diameterTop: C.r * 1.4, tessellation: 20 }, scene);
  stack.position.set(C.x, C.height / 2, C.z);
  stack.material = mat(scene, [0.7, 0.69, 0.66], { surface: "concrete" });
  parts.list.push(stack);
  for (const [y, red] of [[C.height - 2, true], [C.height - 6, false], [C.height - 10, true]] as const) {
    const band = MeshBuilder.CreateCylinder("band", { height: 4, diameter: C.r * 1.48, tessellation: 20 }, scene);
    band.position.set(C.x, y, C.z);
    band.material = mat(scene, red ? [0.75, 0.16, 0.12] : [0.92, 0.92, 0.9]);
    parts.list.push(band);
  }
  nav.blockCircle(C.x, C.z, C.r + 0.3);
  obstacles.push({ x: C.x, z: C.z, hw: C.r, hd: C.r, rot: 0, height: C.height });

  // ---- coal bunker by the sidings: a steel bin on concrete legs with a hopper below and coal heaped on top
  const BK = P.bunker, coalHeaps: CoalHeap[] = [];
  const BIN = 6.4, BIN_TOP = BIN + 5;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.boxIn(BK, 0.8, BIN, 0.8, sx * (BK.hw - 0.5), BIN / 2, sz * (BK.hd - 0.5), CONCRETE, { surface: "concrete" });
  for (const sz of [-1, 1]) parts.boxIn(BK, BK.hw * 2, 0.5, 0.5, 0, BIN - 0.25, sz * (BK.hd - 0.5), CONCRETE, { surface: "concrete" });
  parts.boxIn(BK, BK.hw * 2, 5, BK.hd * 2, 0, BIN + 2.5, 0, [0.4, 0.37, 0.33], { surface: "metal" });
  // stiffeners round the bin, a rim and a railing on top
  for (let k = -2; k <= 2; k++) {
    for (const sz of [-1, 1]) {
      parts.boxIn(BK, 0.22, 5.1, 0.12, k * BK.hw * 0.42, BIN + 2.5, sz * (BK.hd + 0.06), [0.3, 0.28, 0.26]);
      parts.boxIn(BK, 0.12, 5.1, 0.22, sz * (BK.hw + 0.06), BIN + 2.5, k * BK.hd * 0.42, [0.3, 0.28, 0.26]);
    }
  }
  for (const y of [BIN + 1.6, BIN + 3.4]) {
    parts.boxIn(BK, BK.hw * 2 + 0.3, 0.18, BK.hd * 2 + 0.3, 0, y, 0, [0.3, 0.28, 0.26]);
  }
  for (const sz of [-1, 1]) {
    parts.boxIn(BK, BK.hw * 2, 0.06, 0.06, 0, BIN_TOP + 1.05, sz * (BK.hd - 0.05), [0.85, 0.7, 0.1]);
    parts.boxIn(BK, 0.06, 0.06, BK.hd * 2, sz * (BK.hw - 0.05), BIN_TOP + 1.05, 0, [0.85, 0.7, 0.1]);
    for (const k of [-1, 0, 1]) {
      parts.boxIn(BK, 0.06, 1.05, 0.06, k * (BK.hw - 0.05), BIN_TOP + 0.52, sz * (BK.hd - 0.05), [0.85, 0.7, 0.1]);
      parts.boxIn(BK, 0.06, 1.05, 0.06, sz * (BK.hw - 0.05), BIN_TOP + 0.52, k * (BK.hd - 0.05), [0.85, 0.7, 0.1]);
    }
  }
  const hopper = MeshBuilder.CreateCylinder("hopper", { height: 3.4, diameterTop: BK.hw * 2 * Math.SQRT2, diameterBottom: 1.3, tessellation: 4 }, scene);
  hopper.position.set(BK.x, BIN - 1.7, BK.z);
  hopper.rotation.y = BK.rot + Math.PI / 4;
  hopper.material = mat(scene, [0.36, 0.33, 0.3], { surface: "metal" });
  parts.list.push(hopper);
  // the outlet gate and its chute down onto the belt
  parts.boxIn(BK, 1.2, 0.6, 1.2, 0, BIN - 3.6, 0, DARK);
  parts.boxIn(BK, 0.9, 0.5, 0.9, 0, BIN - 4.1, 0, [0.85, 0.7, 0.1]);
  // a ladder up one leg
  {
    const a = toWorld(BK.x, BK.z, BK.rot, -BK.hw - 0.45, -BK.hd + 0.5);
    for (const o of [-0.25, 0.25]) {
      const p = toWorld(BK.x, BK.z, BK.rot, -BK.hw - 0.45, -BK.hd + 0.5 + o);
      parts.rod(new Vector3(p.x, 0, p.z), new Vector3(p.x, BIN_TOP + 1, p.z), 0.04, STEEL, 6);
    }
    for (let y = 0.4; y < BIN_TOP + 0.8; y += 0.4) parts.boxIn(BK, 0.05, 0.05, 0.5, -BK.hw - 0.45, y, -BK.hd + 0.5, STEEL);
    post(a.x, a.z, 0.3);
  }
  coalHeaps.push({ x: BK.x, z: BK.z, base: BIN_TOP - 0.05, yaw: BK.rot, len: BK.hw * 2 - 0.3, wid: BK.hd * 2 - 0.3, peak: 1.5 });
  solid(BK.x, BK.z, BK.hw, BK.hd, BK.rot, BIN_TOP);

  // ---- coal conveyor: from under the bunker up to the boiler house - a steel gallery, open at first
  // (the belt on its idlers and the coal on it in sight), then clad with a band of windows; on A-frame trestles
  const cv = P.conveyor;
  const A = new Vector3(cv.a.x, 2.4, cv.a.z), B = new Vector3(cv.b.x, cv.top, cv.b.z);
  const gal = B.subtract(A), L = gal.length();
  const flat = Math.hypot(gal.x, gal.z), cyaw = yaw({ x: gal.x, z: gal.z });
  // the gallery's frame: +x up the slope, +z across, +y its floor's normal
  let pitch = Math.atan2(gal.y, flat);
  if (Vector3.TransformCoordinates(new Vector3(1, 0, 0), Matrix.RotationYawPitchRoll(cyaw, 0, pitch)).y < 0) pitch = -pitch;
  const gframe = Matrix.RotationYawPitchRoll(cyaw, 0, pitch).multiply(Matrix.Translation(A.x, A.y, A.z));
  const cq = Quaternion.RotationYawPitchRoll(cyaw, 0, pitch);
  const cvp = new Parts(scene);
  const lbox = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, opts: Parameters<typeof mat>[2] = {}) => {
    const m = cvp.box(w, h, d, 0, 0, 0, c, 0, opts);
    m.position.copyFrom(Vector3.TransformCoordinates(new Vector3(x, y, z), gframe));
    m.rotationQuaternion = cq.clone();
  };
  const lpt = (x: number, y: number, z: number) => Vector3.TransformCoordinates(new Vector3(x, y, z), gframe);
  const OPEN = 16;
  // floor, belt (carrying and return run), stringers and idlers
  lbox(L, 0.18, 3.0, L / 2, 0, 0, [0.3, 0.31, 0.32], { surface: "metal" });
  for (const z of [-0.68, 0.68]) lbox(L, 0.24, 0.1, L / 2, 0.52, z, [0.85, 0.7, 0.1]);
  lbox(L, 0.05, 1.15, L / 2, 0.8, 0, [0.07, 0.07, 0.07], { rough: 0.8 });
  lbox(L, 0.04, 1.0, L / 2, 0.32, 0, [0.07, 0.07, 0.07], { rough: 0.8 });
  for (let x = 0.6; x < L; x += 1.3) {
    cvp.rod(lpt(x, 0.7, -0.6), lpt(x, 0.7, 0.6), 0.07, [0.5, 0.52, 0.54], 6);
    for (const z of [-0.68, 0.68]) lbox(0.08, 0.5, 0.08, x, 0.35, z, [0.85, 0.7, 0.1]);
  }
  // the tail drum under the bunker, in a housing
  cvp.rod(lpt(0.2, 0.62, -0.75), lpt(0.2, 0.62, 0.75), 0.32, DARK, 12);
  lbox(1.6, 1.2, 2.0, -0.4, 0.6, 0, [0.85, 0.7, 0.1]);
  // walkway grating beside the belt with a handrail
  for (const z of [-1.45, 1.45]) {
    // side trusses: chords, posts, diagonals
    lbox(L, 0.16, 0.16, L / 2, 0.1, z, STEEL);
    lbox(L, 0.16, 0.16, L / 2, 2.75, z, STEEL);
    let flip = false;
    for (let x = 0; x < L - 0.1; x += 3) {
      lbox(0.14, 2.65, 0.14, x, 1.42, z, STEEL);
      const x2 = Math.min(L, x + 3);
      cvp.rod(lpt(x, flip ? 2.75 : 0.1, z), lpt(x2, flip ? 0.1 : 2.75, z), 0.05, STEEL, 5);
      flip = !flip;
    }
    // past the open stretch: cladding below and above a band of windows
    lbox(L - OPEN, 1.05, 0.06, OPEN + (L - OPEN) / 2, 0.7, z * 1.03, [0.6, 0.64, 0.67], { surface: "metal" });
    lbox(L - OPEN, 0.85, 0.06, OPEN + (L - OPEN) / 2, 2.3, z * 1.03, [0.6, 0.64, 0.67], { surface: "metal" });
    lbox(L - OPEN, 0.62, 0.03, OPEN + (L - OPEN) / 2, 1.55, z * 1.02, [0.2, 0.26, 0.3], { rough: 0.15, metal: 0.3 });
  }
  // roof: over the whole gallery, a lighter cover over the clad part
  lbox(L, 0.1, 3.3, L / 2, 2.9, 0, [0.5, 0.53, 0.56], { surface: "metal" });
  lbox(L - OPEN, 0.18, 3.5, OPEN + (L - OPEN) / 2, 3.02, 0, [0.6, 0.64, 0.67], { surface: "metal" });
  // trestles: two legs, a cross beam under the floor, cross braces when tall
  const sx = -gal.z / flat, sz = gal.x / flat;
  for (let t = 9; t < L - 6; t += 11) {
    const c = lpt(t, 0, 0);
    if (onDeck(c.x, c.z) || inBox(hall, c.x, c.z, 1) || P.decks.some((d) => inBox(d, c.x, c.z, 1.5)) || inBox(BK, c.x, c.z, 1)) continue;
    // (not in an outpost's circle)
    if (layout.outposts.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 8.5)) continue;
    const top = c.y - 0.15;
    const legs = [-1.7, 1.7].map((o) => ({ x: c.x + sx * o, z: c.z + sz * o }));
    for (const l of legs) {
      parts.box(0.36, top, 0.36, l.x, top / 2, l.z, STEEL, cyaw, { surface: "metal" });
      post(l.x, l.z, 0.35);
    }
    parts.rod(new Vector3(legs[0].x, top, legs[0].z), new Vector3(legs[1].x, top, legs[1].z), 0.16, STEEL, 6);
    for (let y = 0.6; y + 3 < top; y += 3.2) {
      parts.rod(new Vector3(legs[0].x, y, legs[0].z), new Vector3(legs[1].x, y + 3, legs[1].z), 0.06, STEEL, 5);
      parts.rod(new Vector3(legs[1].x, y, legs[1].z), new Vector3(legs[0].x, y + 3, legs[0].z), 0.06, STEEL, 5);
      parts.rod(new Vector3(legs[0].x, y + 3, legs[0].z), new Vector3(legs[1].x, y + 3, legs[1].z), 0.06, STEEL, 5);
    }
  }
  cvp.merge("coalConveyor", shadows);
  // coal riding up the belt
  coalHeaps.push({ x: 0, z: 0, base: 0, yaw: 0, len: L - 1.5, wid: 0.95, peak: 0.24, frame: Matrix.Translation((L - 1.5) / 2 + 0.6, 0.83, 0).multiply(gframe) });

  // ---- water pipelines from the northern quay to the cooling tower, on supports (one walks underneath)
  for (const line of P.pipes) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      parts.rod(new Vector3(a.x, 3.6, a.z), new Vector3(b.x, 3.6, b.z), 0.55, [0.42, 0.5, 0.42], 10, { metal: 0.4, rough: 0.45 });
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let t = 2; t < len; t += 9) {
        const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
        parts.box(0.3, 3.0, 0.3, x, 1.5, z, STEEL);
        post(x, z, 0.25);
      }
    }
  }

  // ---- rail sidings along the northern quay: rails and sleepers; coal trains
  const N = Q.north, railYaw = yaw(N.d);
  const railParts = new Parts(scene);
  const sleeperData: number[] = [];
  const q = Quaternion.RotationAxis(Vector3.Up(), railYaw);
  for (const off of P.tracks.offsets) {
    const a = alongNorth(P, P.tracks.x0, off), b = alongNorth(P, far, off);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (const s of [-0.75, 0.75]) {
      const c = { x: (a.x + b.x) / 2 - N.n.x * s, z: (a.z + b.z) / 2 - N.n.z * s };
      railParts.box(len, 0.16, 0.1, c.x, 0.16, c.z, [0.42, 0.4, 0.38], railYaw, { metal: 0.6, rough: 0.35 });
    }
    for (let t = 0; t < len; t += 0.75) {
      const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
      sleeperData.push(...Matrix.Compose(new Vector3(0.24, 0.12, 2.5), q, new Vector3(x, 0.06, z)).asArray());
    }
  }
  railParts.merge("rails", shadows);
  const sleeper = MeshBuilder.CreateBox("sleeper", { size: 1 }, scene);
  sleeper.material = mat(scene, [0.3, 0.24, 0.18], { surface: "wood" });
  sleeper.thinInstanceSetBuffer("matrix", new Float32Array(sleeperData), 16, true);
  sleeper.isPickable = false;
  sleeper.receiveShadows = true;
  const wp = new Parts(scene);
  wp.box(12, 2.6, 3, 0, 2.3, 0, [0.38, 0.22, 0.16], 0, { surface: "metal" });
  wp.box(12.4, 0.35, 2.4, 0, 0.95, 0, DARK);
  for (const x of [-4.6, -3.2, 3.2, 4.6]) for (const z of [-0.75, 0.75]) wp.rod(new Vector3(x, 0.45, z - 0.06), new Vector3(x, 0.45, z + 0.06), 0.45, DARK, 10);
  for (const x of [-3.9, 3.9]) wp.box(1.6, 1.2, 2.0, x, 1.0, 0, [0.3, 0.18, 0.13]);
  const wagon = wp.merge("coalWagon", shadows)!;
  wagon.isVisible = false;
  const lp = new Parts(scene);
  lp.box(15, 3.4, 3, 0, 2.6, 0, [0.2, 0.42, 0.3], 0, { surface: "metal" });
  lp.box(3.4, 1.1, 3.05, 4.5, 4.6, 0, [0.2, 0.42, 0.3]);
  lp.box(15.4, 0.4, 2.4, 0, 0.95, 0, DARK);
  const loco = lp.merge("locomotive", shadows)!;
  loco.isVisible = false;
  const heads = new Set<number>();
  for (const w of P.wagons) {
    const off = P.tracks.offsets[w.track];
    if (!heads.has(w.track) && w.track === 0) {
      const p = alongNorth(P, w.x - 14, off);
      const l = loco.createInstance("loco");
      l.position.set(p.x, 0, p.z);
      l.rotation.y = railYaw;
      l.isPickable = false;
      shadows.addShadowCaster(l);
      solid(p.x, p.z, 7.7, 1.6, railYaw, 4.2);
    }
    heads.add(w.track);
    const p = alongNorth(P, w.x, off);
    const m = wagon.createInstance("wagon");
    m.position.set(p.x, 0, p.z);
    m.rotation.y = railYaw;
    m.isPickable = false;
    m.freezeWorldMatrix();
    coalHeaps.push({ x: p.x, z: p.z, base: 3.5, yaw: railYaw, len: 11.4, wid: 2.7, peak: 1.05 });
    shadows.addShadowCaster(m);
    solid(p.x, p.z, 6.2, 1.6, railYaw, 4);
  }

  // ---- transformer yard (turned like the southern quay): transformers, a gantry, lines to the pylons
  const TY = P.transformer, lines: [Vector3, Vector3][] = [];
  const Y = (lx: number, lz: number) => toWorld(TY.x, TY.z, TY.rot, lx, lz);
  const gantryX = TY.hw - 4;
  for (const [i, lx] of [-12, 0, 12].entries()) {
    const lz = -2;
    parts.boxIn(TY, 5, 3.6, 3.6, lx, 1.8, lz, [0.42, 0.47, 0.42], { surface: "metal" });
    for (let k = -2; k <= 2; k++) parts.boxIn(TY, 0.12, 2.8, 4.6, lx + k * 0.8, 1.7, lz, [0.38, 0.43, 0.38]);
    for (const dx of [-1.4, 0, 1.4]) {
      const b = Y(lx + dx, lz);
      parts.rod(new Vector3(b.x, 3.6, b.z), new Vector3(b.x, 5.8, b.z), 0.18, [0.62, 0.5, 0.36], 8, { rough: 0.3 });
      const gp = Y(gantryX, 6 + i * 0.7 + dx);
      lines.push([new Vector3(b.x, 5.8, b.z), new Vector3(gp.x, 11 + (dx + 1.4) * 0.3, gp.z)]);
    }
    const c = Y(lx, lz);
    solid(c.x, c.z, 2.6, 2.4, TY.rot, 3.6);
  }
  for (const lz of [2, 10]) {
    const p = Y(gantryX, lz);
    parts.box(0.5, 12, 0.5, p.x, 6, p.z, STEEL, TY.rot);
    post(p.x, p.z, 0.35);
  }
  parts.boxIn(TY, 0.5, 0.6, 9, gantryX, 12, 6, STEEL);
  const pylon = (x: number, z: number) => {
    const h = 30, base = gy(x, z);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.rod(new Vector3(x + sx * 2.4, base, z + sz * 2.4), new Vector3(x + sx * 0.6, base + h, z + sz * 0.6), 0.12, STEEL, 4);
    for (const y of [8, 16, 24]) for (const [a, b] of [[[-1, -1], [1, 1]], [[1, -1], [-1, 1]]]) {
      const k = 1 - (y / h) * 0.75;
      parts.rod(new Vector3(x + a[0] * 2.4 * k, base + y, z + a[1] * 2.4 * k), new Vector3(x + b[0] * 2.4 * k, base + y + 4, z + b[1] * 2.4 * k), 0.07, STEEL, 4);
    }
    for (const y of [20, 25]) parts.box(0.35, 0.35, 12 - (y - 20), x, base + y, z, STEEL);
    if (inMap(x, z)) solid(x, z, 2.5, 2.5, 0, h);
    return (k: number) => new Vector3(x, base + (k === 1 ? 25 : 20) - 1.6, z + [-5.5, 0, 5.5][k] * (k === 1 ? 0.6 : 1));
  };
  const towers = P.pylons.map((p) => pylon(p.x, p.z));
  for (let k = 0; k < 3; k++) {
    const gp = Y(gantryX, 2 + k * 4);
    lines.push([new Vector3(gp.x, 11.5, gp.z), towers[0](k)]);
  }
  for (let i = 0; i < towers.length - 1; i++) for (let k = 0; k < 3; k++) lines.push([towers[i](k), towers[i + 1](k)]);
  const wire = new Parts(scene);
  for (const [a, b] of lines) {
    const n = 8, sag = Vector3.Distance(a, b) * 0.035;
    let prev = a;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = Vector3.Lerp(a, b, t);
      p.y -= Math.sin(t * Math.PI) * sag;
      wire.rod(prev, p, 0.05, [0.12, 0.12, 0.12], 4);
      prev = p;
    }
  }
  wire.merge("powerLines", shadows);
  parts.merge("powerPlant", shadows);

  // ---- no one walks into the water
  for (let z = -MAP_HALF + 0.5; z < MAP_HALF; z += 1) {
    for (let x = -MAP_HALF + 0.5; x < MAP_HALF; x += 1) if (gy(x, z) < -0.5) nav.blockRect(x, z, 0.5, 0.5, 0, 0);
  }
  const coal = createCoal(scene, coalHeaps, shadows);
  return { obstacles, setRealistic: (on) => coal.setRealistic(on) };
}
