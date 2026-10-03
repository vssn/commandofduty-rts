import { MeshBuilder, type Mesh, type Scene } from "@babylonjs/core";
import type { OutpostKind } from "../config";
import { rng } from "../util/noise";
import type { RGB } from "./layout";
import { HOSPITAL_TENT, mat, merge, outpostSurface, partBuilder, RADAR_DIM } from "./models";

const SAND: RGB = [0.68, 0.6, 0.43];
const WOOD: RGB = [0.45, 0.32, 0.2];
const DARK_WOOD: RGB = [0.32, 0.23, 0.15];
const CRATE: RGB = [0.5, 0.37, 0.22];
const DARK: RGB = [0.13, 0.12, 0.11];
const STEEL: RGB = [0.3, 0.3, 0.28];
const ROPE: RGB = [0.62, 0.55, 0.4];
const WIRE: RGB = [0.5, 0.5, 0.5];
const WHITE: RGB = [0.94, 0.93, 0.88];
const RED: RGB = [0.78, 0.1, 0.08];
const OLIVE: RGB = [0.32, 0.38, 0.24];

/**
 * The extra detail of the outposts in the realistic graphics mode, laid over the plain model of
 * `createOutpostMesh` (same origin): single sandbags instead of smooth walls, timber framing,
 * ropes and stakes, barbed wire, ammunition crates, roof ribs, cables and fittings. Built only when
 * the realistic mode is first switched on.
 */
export function createOutpostDetail(scene: Scene, kind: OutpostKind, seed: number): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts, outpostSurface);
  const r = rng(seed);
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, rx = 0, rz = 0, tess = 8) => {
    const m = MeshBuilder.CreateCylinder("cyl", { height: h, diameter: d, tessellation: tess }, scene);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.rotation.z = rz;
    m.material = mat(scene, c, { surface: outpostSurface(c) });
    parts.push(m);
    return m;
  };
  /** A beam between two points (thin box turned onto the line). */
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, c: RGB) => {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const m = box(t, t, len, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, c);
    m.rotation.set(-Math.asin(dy / len), Math.atan2(dx, dz), 0);
    return m;
  };
  /** One sandbag, a little irregular. */
  const bag = (x: number, y: number, z: number, ry: number) => {
    box(0.54 * (0.9 + r() * 0.2), 0.2 * (0.9 + r() * 0.25), 0.34 * (0.9 + r() * 0.2), x + (r() - 0.5) * 0.04, y, z + (r() - 0.5) * 0.04, SAND, 0, ry + (r() - 0.5) * 0.14);
  };
  /** Rows of sandbags along a line from (ax, az) to (bx, bz); the first row stands on `y0`. */
  const bagLine = (ax: number, az: number, bx: number, bz: number, y0: number, rows: number) => {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz), n = Math.max(1, Math.round(len / 0.56));
    const ry = Math.atan2(-dz, dx);
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5 + (k % 2) * 0.5) / n;
        if (t > 1) continue;
        bag(ax + dx * t, y0 + k * 0.2, az + dz * t, ry);
      }
    }
  };
  const ammoCrate = (x: number, y: number, z: number, ry: number, c: RGB = CRATE) => {
    box(0.7, 0.4, 0.46, x, y + 0.2, z, c, 0, ry);
    box(0.74, 0.05, 0.5, x, y + 0.42, z, DARK_WOOD, 0, ry);
    box(0.06, 0.4, 0.5, x + Math.cos(ry) * 0.2, y + 0.2, z - Math.sin(ry) * 0.2, DARK_WOOD, 0, ry);
    box(0.06, 0.4, 0.5, x - Math.cos(ry) * 0.2, y + 0.2, z + Math.sin(ry) * 0.2, DARK_WOOD, 0, ry);
  };
  const jerrycan = (x: number, z: number, ry: number) => {
    box(0.34, 0.5, 0.18, x, 0.25, z, OLIVE, 0, ry);
    box(0.12, 0.06, 0.1, x, 0.53, z, DARK, 0, ry);
  };
  /** Barbed wire between two posts: two strands and spiky knots. */
  const wire = (ax: number, az: number, bx: number, bz: number, y: number) => {
    for (const h of [y, y - 0.28]) {
      const len = Math.hypot(bx - ax, bz - az);
      const m = box(0.025, 0.025, len, (ax + bx) / 2, h, (az + bz) / 2, WIRE);
      m.rotation.y = Math.atan2(bx - ax, bz - az);
      const n = Math.floor(len / 0.5);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const k = box(0.12, 0.12, 0.02, ax + (bx - ax) * t, h, az + (bz - az) * t, WIRE, 0, r() * 3);
        k.rotation.z = r() * 3;
      }
    }
  };

  if (kind === "bunker") {
    // single sandbags on the outer faces and along the top of the earth cover
    bagLine(-2.3, -2.62, 2.3, -2.62, 0.1, 6); // back
    bagLine(-2.67, -2.3, -2.67, 2.3, 0.1, 6); // left
    bagLine(2.67, -2.3, 2.67, 2.3, 0.1, 6); // right
    bagLine(-2.4, 2.6, -0.85, 2.6, 0.1, 6); // front left
    bagLine(0.85, 2.6, 2.4, 2.6, 0.1, 6); // front right
    bagLine(-2.3, -2.25, 2.3, -2.25, 1.95, 1);
    bagLine(-2.3, 2.25, -0.9, 2.25, 1.95, 1);
    bagLine(0.9, 2.25, 2.3, 2.25, 1.95, 1);
    bagLine(-2.3, -2.25, -2.3, 2.25, 1.95, 1);
    bagLine(2.3, -2.25, 2.3, 2.25, 1.95, 1);
    // timber door frame, door boards and the loop-hole's lintel
    box(0.2, 1.3, 0.24, -0.98, 0.65, 2.42, WOOD);
    box(0.2, 1.3, 0.24, 0.98, 0.65, 2.42, WOOD);
    box(2.3, 0.22, 0.28, 0, 1.3, 2.42, DARK_WOOD);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) box(0.34, 1.0, 0.04, x, 0.52, 2.34, DARK_WOOD);
    // log ends sticking out of the roof, support beams along the front
    for (let i = 0; i < 6; i++) {
      cyl(0.08, 0.34, -2.72, 1.38, -2.05 + i * 0.82, [0.5, 0.4, 0.26], 0, Math.PI / 2);
      cyl(0.08, 0.34, 2.72, 1.38, -2.05 + i * 0.82, [0.5, 0.4, 0.26], 0, Math.PI / 2);
    }
    // stuff by the entrance: crates, jerrycans, a stack of bags
    ammoCrate(1.6, 0, 3.0, 0.2);
    ammoCrate(1.7, 0.42, 3.05, -0.1, [0.4, 0.43, 0.26]);
    ammoCrate(-1.8, 0, 3.0, -0.25);
    jerrycan(-1.2, 3.1, 0.3);
    jerrycan(-1.0, 3.2, -0.2);
    // stakes and wire in front
    for (const x of [-3.4, -1.1, 1.1, 3.4]) box(0.1, 1.2, 0.1, x, 0.6, 4.4 + (x > 0 ? 0 : 0.2), DARK_WOOD);
    wire(-3.4, 4.6, -1.1, 4.4, 1.0);
    wire(-1.1, 4.4, 1.1, 4.4, 1.0);
    wire(1.1, 4.4, 3.4, 4.4, 1.0);
  } else if (kind === "trench") {
    const segs: [number, number][] = [[-6, 0.5], [-2, -0.5], [2, 0.5], [6, -0.5]];
    for (const [x, ry] of segs) {
      const z = ry > 0 ? 0.9 : -0.9;
      const c = Math.cos(ry), s = Math.sin(ry);
      // four courses of bags on the enemy-facing (+z) side of every parapet segment
      const nx = s * 0.52, nz = c * 0.52;
      bagLine(x - 2.1 * c + nx, z + 2.1 * s + nz, x + 2.1 * c + nx, z - 2.1 * s + nz, 0.12, 4);
      // firing-step planks and a board wall (revetment) behind
      const dz = ry > 0 ? -0.3 : -2.1;
      for (let i = -2; i <= 2; i++) box(0.9, 0.05, 1.1, x + i * 0.9, 0.24, dz, WOOD, 0, ry);
      box(4.2, 0.5, 0.06, x, 0.3, dz + (ry > 0 ? 0.55 : -0.55), DARK_WOOD, 0, ry);
    }
    // barbed wire between the posts on the open side
    for (let i = -3; i < 3; i++) wire(i * 2.6, 3.2 + (i % 2) * 0.3, (i + 1) * 2.6, 3.2 + ((i + 1) % 2) * 0.3, 0.85);
    // sandbag stacks at both ends, ammunition, a signal lantern on the post
    bagLine(-8.4, -0.6, -8.4, 1.2, 0.1, 3);
    bagLine(8.4, -2.2, 8.4, -0.4, 0.1, 3);
    ammoCrate(-4.0, 0, -1.2, 0.1);
    ammoCrate(-3.4, 0, -1.25, -0.2, [0.4, 0.43, 0.26]);
    ammoCrate(4.0, 0, -2.6, 0.2);
    box(0.2, 0.28, 0.2, -7.8, 1.55, 1.4, STEEL);
    box(0.14, 0.18, 0.14, -7.8, 1.55, 1.4, [0.95, 0.75, 0.35]);
  } else if (kind === "tower") {
    // cross bracing on all four sides, diagonal planks and a plank floor
    const legs: [number, number][] = [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
      for (const [y0, y1] of [[0.3, 2.6], [2.6, 4.9]]) {
        beam(ax, y0, az, bx, y1, bz, 0.12, DARK_WOOD);
        beam(bx, y0, bz, ax, y1, az, 0.12, DARK_WOOD);
      }
      box(Math.abs(bx - ax) > 0.1 ? 2.6 : 0.14, 0.12, Math.abs(bz - az) > 0.1 ? 2.6 : 0.14, (ax + bx) / 2, 2.6, (az + bz) / 2, DARK_WOOD);
    }
    for (let i = -4; i <= 4; i++) box(0.38, 0.06, 3.7, i * 0.4, 5.37, 0, WOOD);
    // hand rail, corner posts' caps, rafters under the roof, a hanging lamp
    for (const [x, z] of [[-1.75, -1.75], [1.75, -1.75], [1.75, 1.75], [-1.75, 1.75]]) box(0.2, 0.2, 0.2, x, 6.4, z, DARK_WOOD);
    box(3.7, 0.08, 0.1, 0, 6.35, 1.78, WOOD);
    box(3.7, 0.08, 0.1, 0, 6.35, -1.78, WOOD);
    box(0.1, 0.08, 3.7, 1.78, 6.35, 0, WOOD);
    box(0.1, 0.08, 3.7, -1.78, 6.35, 0, WOOD);
    for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) box(0.12, 0.12, 4.0, x, 6.95, 0, DARK_WOOD);
    cyl(0.5, 0.025, 0, 6.65, 0, STEEL);
    box(0.24, 0.3, 0.24, 0, 6.3, 0, STEEL);
    box(0.16, 0.2, 0.16, 0, 6.3, 0, [0.95, 0.75, 0.35]);
    // ladder rungs
    for (let i = 0; i < 12; i++) {
      const y = 0.5 + i * 0.4;
      box(1.2, 0.07, 0.07, 0, y, 1.9 + (y - 2.4) * 0.255, WOOD);
    }
    // sandbags round the foot, a crate and a barrel
    bagLine(-3.0, -2.25, -1.6, -2.25, 0.1, 3);
    bagLine(-3.0, -0.95, -1.6, -0.95, 0.1, 3);
    bagLine(-3.0, -2.15, -3.0, -1.0, 0.1, 3);
    ammoCrate(-2.2, 1.2, -1.6, 0.2);
    cyl(1.0, 0.6, 2.4, 0.5, -1.8, [0.55, 0.22, 0.14]);
  } else if (kind === "hospital") {
    const T = HOSPITAL_TENT;
    const top = 0.3 + 2.8;
    // ridge pole, tent poles at the gables, guy ropes to stakes
    box(0.12, 0.12, T.hd * 2 + 0.8, T.x, top + 0.04, T.z, WOOD);
    box(0.16, 2.9, 0.16, T.x, 0.3 + 1.45, T.z + T.hd + 0.2, WOOD);
    box(0.16, 2.9, 0.16, T.x, 0.3 + 1.45, T.z - T.hd - 0.2, WOOD);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const sxp = T.x + sx * (T.hw + 1.4), szp = T.z + sz * (T.hd + 0.4);
        beam(T.x + sx * (T.hw * 0.85), 0.3 + 0.55, T.z + sz * T.hd, sxp, 0.1, szp, 0.025, ROPE);
        box(0.08, 0.5, 0.08, sxp, 0.25, szp, WOOD, 0.3);
      }
    }
    // rolled-up wall flaps and the door's tie ropes, tent pegs along the bottom edge
    for (const sx of [-1, 1]) cyl(T.hd * 2 - 0.4, 0.14, T.x + sx * (T.hw - 0.12), 0.45, T.z, [0.78, 0.76, 0.66], Math.PI / 2, 0);
    for (let i = -3; i <= 3; i++) {
      box(0.06, 0.2, 0.06, T.x - T.hw - 0.12, 0.35, T.z + i * 0.55, WOOD, 0, 0);
      box(0.06, 0.2, 0.06, T.x + T.hw + 0.12, 0.35, T.z + i * 0.55, WOOD, 0, 0);
    }
    // a field table with instruments, an IV stand, a lamp, a second row of crates
    box(1.2, 0.06, 0.7, 3.6, 0.85, -2.2, WOOD);
    for (const [x, z] of [[3.1, -2.5], [4.1, -2.5], [3.1, -1.9], [4.1, -1.9]]) box(0.06, 0.55, 0.06, x, 0.58, z, DARK_WOOD);
    box(0.3, 0.05, 0.2, 3.4, 0.91, -2.2, WHITE);
    box(0.18, 0.1, 0.12, 3.8, 0.94, -2.2, STEEL);
    box(0.04, 1.7, 0.04, 2.9, 1.0, 0.9, STEEL);
    box(0.4, 0.04, 0.04, 2.9, 1.82, 0.9, STEEL);
    box(0.1, 0.18, 0.06, 2.72, 1.7, 0.9, WHITE);
    box(0.7, 0.4, 0.5, 0.9, 0.2, 2.9, WHITE);
    box(0.5, 0.03, 0.12, 0.9, 0.42, 2.9, RED);
    box(0.12, 0.03, 0.5, 0.9, 0.42, 2.9, RED);
    ammoCrate(-2.0, 0.0, 2.9, 0.3, [0.4, 0.43, 0.26]);
    // flat pennants on the poles
    box(0.5, 0.3, 0.02, T.x + 0.3, top + 0.5, T.z + T.hd + 0.2, WHITE);
    box(0.28, 0.08, 0.025, T.x + 0.3, top + 0.5, T.z + T.hd + 0.2, RED);
    box(0.08, 0.28, 0.025, T.x + 0.3, top + 0.5, T.z + T.hd + 0.2, RED);
  } else if (kind === "radar") {
    const R = RADAR_DIM;
    // access ladder with cage hoops on the drum, handrail round the ring beam
    for (const x of [-0.3, 0.3]) box(0.06, R.drumH, 0.06, x, 0.2 + R.drumH / 2, R.drumR + 0.12, STEEL);
    for (let i = 0; i < 6; i++) box(0.6, 0.04, 0.04, 0, 0.5 + i * 0.35, R.drumR + 0.12, STEEL);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      box(0.06, 0.5, 0.06, Math.cos(a) * (R.drumR + 0.25), 0.2 + R.drumH + 0.4, Math.sin(a) * (R.drumR + 0.25), STEEL);
    }
    // ribs of the dome: three great-circle bands
    for (const ry of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      const m = MeshBuilder.CreateTorus("rib", { diameter: R.domeR * 2 + 0.06, thickness: 0.07, tessellation: 20 }, scene);
      m.position.y = R.domeY;
      m.rotation.set(Math.PI / 2, ry, 0);
      m.material = mat(scene, [0.82, 0.82, 0.78]);
      parts.push(m);
    }
    // hut: roof vents, a small dish on a mast, a door and a window frame, exhaust pipe of the generator
    box(0.5, 0.2, 0.5, -3.0, 2.28, 2.5, STEEL);
    box(0.4, 0.14, 0.4, -2.2, 2.25, 1.9, STEEL);
    box(0.5, 0.06, 0.06, -2.2, 1.45, 3.04, WIRE);
    box(0.5, 0.06, 0.06, -2.2, 1.12, 3.04, WIRE);
    box(0.06, 0.4, 0.06, -2.45, 1.28, 3.04, WIRE);
    box(0.06, 0.4, 0.06, -1.95, 1.28, 3.04, WIRE);
    box(0.7, 1.4, 0.05, -3.2, 1.0, 3.02, [0.24, 0.24, 0.24]);
    const dish = MeshBuilder.CreateSphere("dish", { diameter: 0.9, segments: 8, slice: 0.5 }, scene);
    dish.position.set(2.9, 4.2, 2.6);
    dish.rotation.set(-1.9, 0.5, 0);
    dish.material = mat(scene, [0.82, 0.82, 0.78]);
    parts.push(dish);
    cyl(1.0, 0.1, 2.6, 1.3, -2.4, STEEL);
    cyl(0.2, 0.18, 2.6, 1.85, -2.4, STEEL);
    // cables from the generator to the hut and the drum, floodlight pole, fence posts with wire
    box(0.06, 0.04, 5.2, 2.2, 0.3, 0.0, DARK);
    box(4.4, 0.04, 0.06, 0.4, 0.3, 2.5, DARK);
    box(0.1, 3.2, 0.1, -3.2, 1.6, -2.6, STEEL);
    box(0.5, 0.25, 0.35, -3.2, 3.3, -2.6, STEEL);
    box(0.4, 0.15, 0.04, -3.2, 3.3, -2.4, [0.95, 0.9, 0.7]);
    for (let i = -4; i <= 4; i++) {
      box(0.08, 1.0, 0.08, i * 1.0, 0.5, -3.7, DARK_WOOD);
      box(0.08, 1.0, 0.08, i * 1.0, 0.5, 3.7, DARK_WOOD);
    }
    wire(-4, -3.7, 4, -3.7, 0.9);
    wire(-4, 3.7, 4, 3.7, 0.9);
    ammoCrate(-3.8, 0, 0.6, 0.4, [0.4, 0.43, 0.26]);
  } else {
    // workshop: corrugated roof ribs, roof vent, windows, door frame, tools and parts
    for (let i = -16; i <= 16; i++) {
      const x = i * 0.24;
      // on both roof slopes (the gable is 7.8 wide and 1.3 high)
      const hw = 3.9;
      const y = 3.85 + 1.3 * (1 - Math.abs(x) / hw);
      if (Math.abs(x) > hw - 0.05) continue;
      const slope = Math.atan2(1.3, hw);
      const s = box(0.05, 0.05, 6.8, x, y + 0.03, 0, [0.5, 0.52, 0.54]);
      s.rotation.z = x > 0 ? -slope : slope;
    }
    box(0.5, 0.35, 6.9, 0, 5.25, 0, [0.4, 0.42, 0.44]); // ridge cap
    cyl(0.6, 0.6, 1.4, 5.3, -1.0, [0.4, 0.42, 0.44]); // roof vent
    cyl(0.15, 0.7, 1.4, 5.65, -1.0, [0.3, 0.3, 0.28]);
    for (const sx of [-1, 1]) {
      // two windows in each side wall, with frames and sills
      for (const z of [-1.2, 1.0]) {
        box(0.06, 0.8, 0.9, sx * 3.52, 2.3, z, [0.2, 0.26, 0.3]);
        box(0.1, 0.06, 1.0, sx * 3.52, 1.9, z, WHITE);
        box(0.1, 0.06, 1.0, sx * 3.52, 2.7, z, WHITE);
        box(0.1, 0.9, 0.06, sx * 3.52, 2.3, z - 0.5, WHITE);
        box(0.1, 0.9, 0.06, sx * 3.52, 2.3, z + 0.5, WHITE);
        box(0.08, 0.8, 0.04, sx * 3.52, 2.3, z, WHITE);
      }
      // gutter along the eaves
      box(0.14, 0.12, 6.6, sx * 3.95, 3.85, 0, STEEL);
    }
    // timber frame of the open front and a roller-door rail, a shelf with tools on the back wall
    box(0.25, 3.5, 0.3, -3.3, 1.9, 2.95, WOOD);
    box(0.25, 3.5, 0.3, 3.3, 1.9, 2.95, WOOD);
    box(6.8, 0.2, 0.2, 0, 3.2, 3.02, STEEL);
    box(2.4, 0.06, 0.4, 1.8, 1.7, -2.65, WOOD);
    for (const x of [0.9, 1.4, 1.9, 2.4]) box(0.05, 0.4, 0.04, x, 1.45, -2.7, STEEL);
    box(0.4, 0.5, 0.35, -1.0, 1.15, -2.2, STEEL); // engine block on the bench
    box(0.3, 0.2, 0.3, -1.0, 1.5, -2.2, [0.4, 0.4, 0.38]);
    // hanging lamps and chains
    for (const x of [-1.8, 1.8]) {
      cyl(0.7, 0.02, x, 4.35, -0.5, STEEL);
      cyl(0.18, 0.4, x, 3.95, -0.5, STEEL, 0, 0, 12);
    }
    // jerrycans, a pile of pipes, an oil stain on the floor
    jerrycan(-3.0, 2.2, 0.3);
    jerrycan(-2.7, 2.3, -0.2);
    jerrycan(-3.2, 1.8, 0.1);
    for (let i = 0; i < 4; i++) cyl(2.0, 0.18, 3.0, 0.15 + (i % 2) * 0.1 + (i > 1 ? 0.15 : 0), 2.6 + (i % 2) * 0.2, STEEL, Math.PI / 2, 0.4);
    box(1.4, 0.01, 1.0, -0.3, 0.29, 0.4, [0.1, 0.1, 0.1]);
    ammoCrate(4.0, 0, 1.6, 0.1);
  }

  const m = merge(`outpost-detail-${kind}`, parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}
