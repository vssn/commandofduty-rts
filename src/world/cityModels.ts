import { MeshBuilder, type Mesh, type Scene } from "@babylonjs/core";
import type { Team } from "../config";
import type { RGB } from "./layout";
import { HOSPITAL_TENT, mat, merge, partBuilder, TEAM_COLOR } from "./models";

/**
 * The city map's versions of the base and two outposts (same footprints as the originals, so the
 * game's obstacles, spawn points and compounds fit): the metro station's exit (the base), a pharmacy
 * (the field hospital) and the exit of an underground car park (the workshop). Local frames like the
 * originals: the front / exit faces +z.
 */

/** Paris metro green (the cast iron of the old entrances). */
const METRO: RGB = [0.18, 0.33, 0.27];
const GLASS: RGB = [0.4, 0.52, 0.56];

/** A pane of glass (glossy, a little reflective). */
function glass(scene: Scene, parts: Mesh[], w: number, h: number, d: number, x: number, y: number, z: number) {
  const m = MeshBuilder.CreateBox("glass", { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.material = mat(scene, GLASS, { rough: 0.08, metal: 0.5 });
  parts.push(m);
}
const GRANITE: RGB = [0.5, 0.5, 0.49];
const DARK: RGB = [0.05, 0.05, 0.06];

/**
 * The base: the entrance hall of a metro station - a glass pavilion in green cast iron on a granite
 * platform, a railed stairwell down into the dark in front of it (the troops come up from there), two
 * metro lanterns with their signs, the team's colour on the fascia and a flag.
 */
export function createSubwayMesh(scene: Scene, team: Team): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const teamC = TEAM_COLOR[team];
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, opts: Parameters<typeof mat>[2] = {}) => {
    const m = MeshBuilder.CreateCylinder("c", { height: h, diameter: d, tessellation: 10 }, scene);
    m.position.set(x, y, z);
    m.material = mat(scene, c, opts);
    parts.push(m);
    return m;
  };
  box(17, 1, 13, 0, 0.1, 0, GRANITE); // platform (as wide as the barracks' pad)
  // the pavilion: glass between cast-iron posts, a deep roof
  glass(scene, parts, 11, 3.6, 6.6, 0, 2.4, -1.4);
  for (const x of [-5.5, -2.75, 0, 2.75, 5.5]) {
    for (const z of [1.9, -4.7]) box(0.32, 3.7, 0.32, x, 2.45, z, METRO);
  }
  for (const z of [-3.3, -1.4, 0.5]) for (const x of [-5.5, 5.5]) box(0.32, 3.7, 0.32, x, 2.45, z, METRO);
  box(11.2, 0.25, 6.8, 0, 1.0, -1.4, METRO); // sill
  box(12.2, 0.5, 8.0, 0, 4.45, -1.4, METRO); // roof slab
  box(12.3, 0.32, 8.1, 0, 4.2, -1.4, teamC); // fascia in the team's colour
  glass(scene, parts, 9.5, 0.7, 4.6, 0, 4.95, -1.4); // skylight
  box(9.7, 0.12, 4.8, 0, 5.32, -1.4, METRO);
  // the doorway, dark inside
  box(3.2, 2.8, 0.2, 0, 2.0, 1.95, DARK);
  // the stairwell in front: a dark opening, steps fading down into it, railings on three sides
  box(4.4, 0.04, 3.4, 0, 0.62, 4.4, DARK);
  for (let k = 0; k < 5; k++) box(4.2, 0.02, 0.18, 0, 0.645, 5.8 - k * 0.42, [0.32 - k * 0.055, 0.32 - k * 0.055, 0.31 - k * 0.055]);
  for (const x of [-2.25, 2.25]) {
    box(0.08, 0.95, 3.4, x, 1.1, 4.4, METRO);
    for (let z = 2.9; z <= 5.9; z += 0.5) box(0.05, 0.9, 0.05, x, 1.05, z, METRO);
  }
  box(4.5, 0.08, 0.08, 0, 1.55, 2.7, METRO);
  // two metro lanterns: a slender post, the sign, an amber globe
  for (const x of [-3.4, 3.4]) {
    cyl(4.6, 0.18, x, 2.9, 6.2, METRO);
    box(1.3, 0.6, 0.12, x, 4.9, 6.2, [0.95, 0.82, 0.3]); // the sign (yellow, "M")
    box(0.18, 0.42, 0.13, x - 0.35, 4.9, 6.2, DARK);
    box(0.18, 0.42, 0.13, x + 0.35, 4.9, 6.2, DARK);
    box(0.5, 0.16, 0.13, x, 5.05, 6.2, DARK);
    const globe = MeshBuilder.CreateSphere("globe", { diameter: 0.5, segments: 8 }, scene);
    globe.position.set(x, 5.55, 6.2);
    globe.material = mat(scene, [1, 0.72, 0.35], { emissive: true });
    parts.push(globe);
  }
  // flag
  cyl(8, 0.16, 7, 4.6, -3.2, [0.7, 0.7, 0.7]);
  box(2.4, 1.4, 0.08, 8.25, 7.8, -3.2, teamC);
  // supplies stacked against the side
  box(1.3, 1.3, 1.3, -7.4, 1.25, -4.4, [0.46, 0.34, 0.2]);
  box(1.1, 1.1, 1.1, -7.3, 1.15, -2.7, [0.36, 0.42, 0.24]);
  box(2.4, 1.0, 1.1, 7.2, 1.1, -5.4, [0.36, 0.42, 0.24]);
  const m = merge(`subway${team}`, parts);
  m.receiveShadows = true;
  return m;
}

/**
 * The field hospital as a pharmacy: a little shop pavilion (where the ward tent stood) with shop
 * windows, a green awning and the glowing green cross on its corner; medical crates, stretchers and
 * sandbags on the square in front.
 */
export function createPharmacyMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const T = HOSPITAL_TENT;
  const stone: RGB = [0.88, 0.85, 0.78];
  const green: RGB = [0.1, 0.5, 0.25];
  box(7.5, 0.3, 6, 0, 0.05, 0, [0.62, 0.6, 0.56]); // paved forecourt
  const w = T.hw * 2, d = T.hd * 2, x = T.x, z = T.z;
  box(w, 3.4, d, x, 1.85, z, stone);
  box(w + 0.3, 0.35, d + 0.3, x, 3.7, z, [0.8, 0.77, 0.7]); // cornice
  // shop windows and door on the front (+z) and the side (+x)
  glass(scene, parts, w - 0.8, 2.0, 0.08, x, 1.6, z + d / 2 + 0.02);
  glass(scene, parts, 0.08, 2.0, d - 0.8, x + w / 2 + 0.02, 1.6, z);
  box(1.0, 2.3, 0.1, x - w / 2 + 0.9, 1.45, z + d / 2 + 0.05, DARK); // door
  // green awnings
  box(w - 0.4, 0.12, 0.9, x, 2.85, z + d / 2 + 0.45, green, -0.35);
  box(0.9, 0.12, d - 0.4, x + w / 2 + 0.45, 2.85, z, green, 0, Math.PI / 2);
  // the pharmacy cross on a bracket at the corner, glowing green
  box(0.12, 0.12, 0.7, x + w / 2 - 0.1, 3.2, z + d / 2 + 0.35, [0.3, 0.3, 0.3]);
  const cross = mat(scene, [0.25, 1, 0.45], { emissive: true });
  for (const [cw, ch] of [[0.9, 0.3], [0.3, 0.9]]) {
    const c = MeshBuilder.CreateBox("cross", { width: cw, height: ch, depth: 0.12 }, scene);
    c.position.set(x + w / 2 - 0.1, 3.2, z + d / 2 + 0.75);
    c.material = cross;
    parts.push(c);
  }
  // on the square: crates, two stretchers, sandbags against the wall
  box(1.0, 0.7, 0.8, 2.6, 0.55, -2.2, [0.9, 0.9, 0.86]);
  box(0.4, 0.2, 0.4, 2.6, 0.95, -2.2, [0.78, 0.1, 0.08]);
  box(0.9, 0.6, 0.7, 2.7, 0.5, -1.1, [0.36, 0.42, 0.24]);
  for (const sx of [2.4, 3.2]) {
    box(0.6, 0.1, 2.0, sx, 0.45, 1.8, [0.5, 0.52, 0.4]);
    box(0.65, 0.05, 0.05, sx, 0.35, 0.8, [0.3, 0.3, 0.3]);
    box(0.65, 0.05, 0.05, sx, 0.35, 2.8, [0.3, 0.3, 0.3]);
  }
  for (let k = 0; k < 5; k++) box(0.9, 0.34, 0.5, x - w / 2 + 0.5 + k * 0.9, 0.38, z - d / 2 - 0.4, [0.68, 0.6, 0.43]);
  const m = merge("outpost-pharmacy", parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}

/**
 * The workshop as the exit of an underground car park: a concrete housing with the dark mouth of the
 * ramp, the ramp rising out of it between low walls (yellow stripes), a barrier, a blue "P" sign and
 * a pay machine; tyres and barrels from the repair work left at the side.
 */
export function createGarageExitMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const concrete: RGB = [0.66, 0.65, 0.61];
  box(9, 0.3, 11, 0, 0.05, 0.5, [0.6, 0.59, 0.56]); // apron
  // the housing over the ramp's lower end, open towards +z
  box(7.2, 3.2, 0.4, 0, 1.75, -3.2, concrete); // back
  box(0.5, 3.2, 3.2, -3.35, 1.75, -1.6, concrete);
  box(0.5, 3.2, 3.2, 3.35, 1.75, -1.6, concrete);
  box(7.4, 0.5, 3.6, 0, 3.55, -1.6, concrete); // roof
  box(7.5, 0.2, 3.7, 0, 3.85, -1.6, [0.3, 0.42, 0.24]); // green roof (planted)
  box(6.2, 2.9, 0.1, 0, 1.6, -2.95, DARK); // the dark tunnel
  box(6.2, 0.05, 3.0, 0, 0.22, -1.6, [0.08, 0.08, 0.09]);
  // the ramp coming up between low walls
  box(6.2, 0.05, 4.0, 0, 0.24, 1.9, [0.24, 0.24, 0.26]);
  for (const sx of [-1, 1]) {
    box(0.4, 1.0, 4.0, sx * 3.35, 0.65, 1.9, concrete);
    box(0.25, 0.02, 4.0, sx * 2.7, 0.27, 1.9, [0.92, 0.75, 0.1]); // yellow edge stripes
  }
  // barrier at the mouth: a post and the striped arm
  box(0.35, 1.1, 0.35, -2.8, 0.85, 0.2, [0.9, 0.8, 0.2]);
  for (let k = 0; k < 5; k++) box(1.0, 0.12, 0.12, -2.2 + k, 1.3, 0.2, k % 2 ? [0.92, 0.92, 0.9] : [0.85, 0.12, 0.1]);
  // pay machine and the "P" sign
  box(0.6, 1.5, 0.45, 4.2, 1.0, 1.0, [0.3, 0.32, 0.36]);
  box(0.1, 3.2, 0.1, 4.2, 1.9, 3.3, [0.5, 0.5, 0.52]);
  box(1.0, 1.0, 0.1, 4.2, 3.6, 3.3, [0.1, 0.3, 0.75]);
  // the "P", read from the front (+z): its stem on the viewer's left, i.e. at the larger x
  const white: RGB = [0.95, 0.95, 0.95];
  box(0.14, 0.7, 0.12, 4.42, 3.6, 3.31, white);
  box(0.36, 0.13, 0.12, 4.26, 3.88, 3.31, white);
  box(0.36, 0.13, 0.12, 4.26, 3.6, 3.31, white);
  box(0.13, 0.41, 0.12, 4.08, 3.74, 3.31, white);
  // the repair work: tyres, barrels, a crate
  const cyl = (h: number, dm: number, x: number, y: number, z: number, c: RGB) => {
    const m = MeshBuilder.CreateCylinder("c", { height: h, diameter: dm, tessellation: 10 }, scene);
    m.position.set(x, y, z);
    m.material = mat(scene, c);
    parts.push(m);
  };
  for (const y of [0.45, 0.8, 1.15]) cyl(0.35, 1.0, -4.1, y, 3.2, [0.12, 0.12, 0.12]);
  for (const [x, z] of [[4.0, -3.0], [4.1, -2.2]]) cyl(1.0, 0.6, x, 0.75, z, [0.55, 0.22, 0.14]);
  box(1.2, 0.8, 0.9, -4.1, 0.6, -3.2, [0.5, 0.37, 0.22]);
  const m = merge("outpost-garage", parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}
