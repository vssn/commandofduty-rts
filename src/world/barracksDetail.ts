import { MeshBuilder, type Mesh, type Scene } from "@babylonjs/core";
import { PLAYER, type Team } from "../config";
import type { RGB } from "./layout";
import { brickBox } from "./masonry";
import { mat, merge, outpostSurface, partBuilder, TEAM_COLOR } from "./models";

const CONCRETE: RGB = [0.58, 0.56, 0.5];
const CONCRETE_DARK: RGB = [0.42, 0.42, 0.4];
const WOOD: RGB = [0.45, 0.32, 0.2];
const DARK_WOOD: RGB = [0.32, 0.23, 0.15];
const STEEL: RGB = [0.3, 0.3, 0.28];
const OLIVE: RGB = [0.32, 0.38, 0.24];
const DRUM: RGB = [0.55, 0.22, 0.14];
const WHITE: RGB = [0.94, 0.93, 0.88];
const LAMP: RGB = [0.95, 0.8, 0.45];
const CRATE: RGB = [0.5, 0.37, 0.22];
const DARK: RGB = [0.13, 0.12, 0.11];

/**
 * The extra detail of a barracks in the realistic graphics mode, laid over `createBarracksMesh`
 * (same origin, front towards +z): plinth, cornice and corner pilasters, framed windows with
 * shutters, a planked double gate with steps and canopy, the team's sign, gutters, chimney and roof
 * ridge, a radio mast with guy wires, a generator, drums, crates and a base for the flag. The caller
 * parents it to the barracks, so it moves (and collapses) with the building.
 */
export function createBarracksDetail(scene: Scene, team: Team): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts, outpostSurface);
  const teamC = TEAM_COLOR[team];
  const roofDark: RGB = team === PLAYER ? [0.3, 0.38, 0.56] : [0.56, 0.22, 0.18];
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, rx = 0, rz = 0, tess = 8) => {
    const m = MeshBuilder.CreateCylinder("cyl", { height: h, diameter: d, tessellation: tess }, scene);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.rotation.z = rz;
    m.material = mat(scene, c, { surface: outpostSurface(c) });
    parts.push(m);
    return m;
  };
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, c: RGB) => {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const m = box(t, t, len, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, c);
    m.rotation.set(-Math.asin(dy / len), Math.atan2(dx, dz), 0);
  };

  // plinth, cornice and corner pilasters
  box(12.3, 0.45, 8.3, 0, 0.82, 0, CONCRETE_DARK);
  box(12.5, 0.22, 8.5, 0, 4.3, 0, CONCRETE);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.5, 3.8, 0.5, sx * 6.0, 2.5, sz * 4.0, CONCRETE);
  // curb round the platform
  box(17.2, 0.22, 0.26, 0, 0.7, 6.55, CONCRETE_DARK);
  box(17.2, 0.22, 0.26, 0, 0.7, -6.55, CONCRETE_DARK);
  box(0.26, 0.22, 13.1, 8.6, 0.7, 0, CONCRETE_DARK);
  box(0.26, 0.22, 13.1, -8.6, 0.7, 0, CONCRETE_DARK);

  // windows: frame, sill, mullions and shutters (front and back at x = +-4.2, sides at z = 0)
  const windowAt = (x: number, z: number, nx: number, nz: number) => {
    // (nx, nz): outward normal; frames lie along the wall's tangent (tx, tz)
    const tx = Math.abs(nz), tz = Math.abs(nx);
    const wx = (a: number, b: number) => x + tx * a + nx * b;
    const wz = (a: number, b: number) => z + tz * a + nz * b;
    const frame = (w: number, h: number, a: number, y: number, depth = 0.14) => {
      box(tx ? w : depth, h, tz ? w : depth, wx(a, 0.1), y, wz(a, 0.1), WHITE);
    };
    frame(1.85, 0.12, 0, 3.36); // lintel
    box(tx ? 1.95 : 0.24, 0.1, tz ? 1.95 : 0.24, wx(0, 0.12), 2.24, wz(0, 0.12), CONCRETE); // sill
    frame(0.12, 1.0, -0.86, 2.8);
    frame(0.12, 1.0, 0.86, 2.8);
    frame(0.06, 1.0, 0, 2.8, 0.1); // mullion
    box(tx ? 1.7 : 0.1, 0.06, tz ? 1.7 : 0.1, wx(0, 0.11), 2.8, wz(0, 0.11), WHITE);
    for (const s of [-1, 1]) box(tx ? 0.7 : 0.06, 1.05, tz ? 0.7 : 0.06, wx(s * 1.3, 0.1), 2.8, wz(s * 1.3, 0.1), OLIVE); // shutters
  };
  for (const x of [-4.2, 4.2]) {
    windowAt(x, 4.05, 0, 1);
    windowAt(x, -4.05, 0, -1);
  }
  windowAt(-6.05, 0, -1, 0);
  windowAt(6.05, 0, 1, 0);

  // the gate: posts, planked double door with braces and hinges, steps, canopy, lanterns, sign
  box(0.3, 3.1, 0.3, -1.55, 2.15, 4.25, WOOD);
  box(0.3, 3.1, 0.3, 1.55, 2.15, 4.25, WOOD);
  box(3.4, 0.28, 0.32, 0, 3.7, 4.25, DARK_WOOD);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) box(0.32, 2.8, 0.06, s * (0.2 + i * 0.32 + 0.16), 2.0, 4.22, i % 2 ? DARK_WOOD : WOOD);
    box(1.3, 0.12, 0.05, s * 0.85, 1.1, 4.27, STEEL);
    box(1.3, 0.12, 0.05, s * 0.85, 2.9, 4.27, STEEL);
    beam(s * 0.2, 1.1, 4.3, s * 1.5, 2.9, 4.3, 0.1, DARK_WOOD);
    box(0.1, 0.1, 0.07, s * 0.1, 2.0, 4.28, STEEL); // handles
  }
  box(3.6, 0.2, 1.0, 0, 0.7, 4.7, CONCRETE);
  box(3.2, 0.2, 0.6, 0, 0.9, 4.5, CONCRETE);
  const canopy = box(4.4, 0.12, 1.7, 0, 3.95, 5.05, DARK_WOOD);
  canopy.rotation.x = 0.12;
  box(4.4, 0.05, 1.7, 0, 4.03, 5.05, teamC).rotation.x = 0.12;
  for (const s of [-1, 1]) {
    box(0.16, 3.2, 0.16, s * 2.0, 2.2, 5.8, WOOD);
    box(0.2, 0.3, 0.2, s * 1.75, 3.3, 4.3, STEEL);
    box(0.14, 0.2, 0.14, s * 1.75, 3.3, 4.3, LAMP);
  }
  box(3.0, 0.5, 0.1, 0, 4.0 + 0.45, 4.3, DARK);
  box(2.6, 0.34, 0.06, 0, 4.45, 4.36, teamC);
  for (const x of [-0.9, -0.3, 0.3, 0.9]) box(0.34, 0.08, 0.04, x, 4.45, 4.4, WHITE);

  // gutters and drain pipes, wall lamps and vents on the side walls
  box(13.1, 0.14, 0.18, 0, 4.4, 4.5, STEEL);
  box(13.1, 0.14, 0.18, 0, 4.4, -4.5, STEEL);
  for (const [x, z] of [[-6.5, 4.4], [6.5, -4.4], [-6.5, -4.4]]) cyl(3.8, 0.16, x, 2.5, z, STEEL);
  for (const z of [-2.3, 2.3]) {
    box(0.2, 0.3, 0.22, 6.2, 3.4, z, STEEL);
    box(0.12, 0.2, 0.14, 6.28, 3.4, z, LAMP);
    box(0.2, 0.3, 0.22, -6.2, 3.4, z, STEEL);
    box(0.12, 0.2, 0.14, -6.28, 3.4, z, LAMP);
  }
  for (const z of [-2.6, 2.6]) {
    box(0.08, 0.6, 1.1, 6.07, 1.8, z, DARK);
    for (let i = 0; i < 4; i++) box(0.12, 0.05, 1.0, 6.1, 1.62 + i * 0.12, z, STEEL);
  }

  // roof: ridge cap, chimney, vents
  box(13.1, 0.2, 0.6, 0, 6.95, 0, roofDark);
  box(0.5, 0.5, 8.9, 6.45, 4.6, 0, roofDark).rotation.set(0, 0, 0); // verge boards on the gables' ends
  box(0.5, 0.5, 8.9, -6.45, 4.6, 0, roofDark);
  const chim = brickBox(scene, "chimney", 1.0, 2.4, 1.0, [0.6, 0.32, 0.25]);
  chim.position.set(3.2, 6.4, -1.6);
  parts.push(chim);
  box(1.3, 0.16, 1.3, 3.2, 7.65, -1.6, CONCRETE_DARK);
  cyl(0.5, 0.45, -2.5, 6.55, 1.3, STEEL, 0, 0, 10);
  cyl(0.16, 0.7, -2.5, 6.85, 1.3, STEEL, 0, 0, 10);
  cyl(0.5, 0.45, 1.0, 6.55, -1.3, STEEL, 0, 0, 10);
  cyl(0.16, 0.7, 1.0, 6.85, -1.3, STEEL, 0, 0, 10);

  // radio mast (the existing antenna's neighbours): cross bars and guy wires to the roof
  const top = 9.0;
  for (const [y, w] of [[8.3, 1.1], [8.8, 0.7]] as [number, number][]) box(w, 0.06, 0.06, -4, y, 1.2, STEEL);
  for (const [gx, gz] of [[-5.6, 2.8], [-2.4, 2.8], [-4, -0.4]]) beam(-4, top - 0.2, 1.2, gx, 6.1, gz, 0.025, STEEL);

  // flag base and halyard
  box(0.7, 0.3, 0.7, 7, 0.75, -3.2, CONCRETE);
  cyl(0.3, 0.3, 7, 8.75, -3.2, [0.8, 0.6, 0.15], 0, 0, 10);
  beam(7.1, 8.4, -3.2, 7.1, 1.3, -3.2, 0.02, WHITE);

  // supplies: drums, jerrycans, tyres, crates, a generator with exhaust and cables
  for (const [x, z] of [[7.7, -1.0], [7.7, -0.2], [7.2, -0.6]]) cyl(1.0, 0.6, x, 1.1, z, DRUM);
  cyl(0.06, 0.64, 7.7, 1.62, -1.0, STEEL);
  for (let i = 0; i < 3; i++) cyl(0.3, 0.9, -7.6, 0.75 + i * 0.3, 1.2, DARK);
  for (const z of [0.4, 1.0]) {
    box(0.34, 0.5, 0.18, -7.0, 0.85, z, OLIVE);
    box(0.12, 0.06, 0.1, -7.0, 1.13, z, DARK);
  }
  box(0.9, 0.6, 0.7, -7.5, 0.9, 2.2, CRATE);
  box(0.94, 0.06, 0.74, -7.5, 1.23, 2.2, DARK_WOOD);
  box(1.4, 1.0, 0.9, -7.5, 1.15, 3.6, OLIVE);
  box(1.0, 0.1, 0.7, -7.5, 1.72, 3.6, STEEL);
  cyl(1.4, 0.12, -7.0, 2.1, 3.9, STEEL);
  box(0.06, 0.04, 6.0, -6.4, 0.65, 1.0, DARK); // cable from the generator along the wall
  box(2.6, 0.04, 0.06, -5.2, 0.65, 4.2, DARK);

  const m = merge(`barracks-detail${team}`, parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}
