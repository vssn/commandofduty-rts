import { Color3, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3, VertexData } from "@babylonjs/core";
import { PLAYER, type OutpostKind, type Team } from "../config";
import type { RGB } from "./layout";
import { brickBox } from "./masonry";

const matCache = new Map<string, StandardMaterial>();

/** Shared flat material (no textures, no specular). */
export function mat(scene: Scene, c: RGB, opts: { emissive?: boolean; twoSided?: boolean } = {}): StandardMaterial {
  // materials belong to a scene, so the cache is per scene (the build-menu portraits use their own)
  const key = scene.uid + ":" + c.map((v) => v.toFixed(3)).join(",") + (opts.emissive ? "e" : "") + (opts.twoSided ? "t" : "");
  let m = matCache.get(key);
  if (!m) {
    m = new StandardMaterial("m" + key, scene);
    m.diffuseColor = new Color3(c[0], c[1], c[2]);
    m.specularColor = Color3.Black();
    if (opts.emissive) {
      m.emissiveColor = new Color3(c[0], c[1], c[2]);
      m.disableLighting = true;
    }
    if (opts.twoSided) m.backFaceCulling = false;
    matCache.set(key, m);
  }
  return m;
}

/** Builds a flat shaded mesh from raw triangles, normals pointing away from `center`. */
function buildFlat(name: string, scene: Scene, tris: number[][], center: Vector3): Mesh {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  tris.forEach((t, i) => {
    const a = new Vector3(t[0], t[1], t[2]), b = new Vector3(t[3], t[4], t[5]), c = new Vector3(t[6], t[7], t[8]);
    const n = Vector3.Cross(b.subtract(a), c.subtract(a)).normalize();
    const mid = a.add(b).add(c).scale(1 / 3);
    if (Vector3.Dot(n, mid.subtract(center)) < 0) n.scaleInPlace(-1);
    positions.push(...t);
    for (let k = 0; k < 3; k++) normals.push(n.x, n.y, n.z);
    indices.push(i * 3, i * 3 + 1, i * 3 + 2);
  });
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = new Array((positions.length / 3) * 2).fill(0); // needed so it can be merged with builder meshes
  vd.indices = indices;
  vd.applyToMesh(mesh);
  return mesh;
}

/** Unit gable roof: base 1x1 at y=0, ridge along z at y=1. Use a two-sided material. */
export function createGable(name: string, scene: Scene): Mesh {
  return buildFlat(name, scene, [
    [-0.5, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5], [-0.5, 0, -0.5, 0, 1, 0.5, -0.5, 0, 0.5],
    [0.5, 0, -0.5, 0.5, 0, 0.5, 0, 1, 0.5], [0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5],
    [-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5],
    [-0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, 0.5],
  ], new Vector3(0, 0.3, 0));
}

export const TEAM_COLOR: Record<Team, RGB> = { 0: [0.22, 0.44, 0.95], 1: [0.9, 0.16, 0.12] };

type PartFn = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, rx?: number, ry?: number) => Mesh;

function partBuilder(scene: Scene, parts: Mesh[]): PartFn {
  return (w, h, d, x, y, z, c, rx = 0, ry = 0) => {
    const m = MeshBuilder.CreateBox("part", { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.material = mat(scene, c);
    parts.push(m);
    return m;
  };
}

function merge(name: string, parts: Mesh[]): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  m.name = name;
  return m;
}

export const SOLDIER_SCALE = 1.45;
/** Hip joint position of the leg templates in unit space (before instancing). */
export const HIP_Y = 0.8 * SOLDIER_SCALE;
export const HIP_X = 0.1 * SOLDIER_SCALE;
const SHOULDER = 1.4;
/** Shoulder joint of the `arms` and `head` templates in unit space; both pivot around it. */
export const SHOULDER_Y = SHOULDER * SOLDIER_SCALE;

/**
 * Low-poly infantry figure, facing +z, as hidden templates for instancing:
 * `body` (torso, backpack), `arms` (arms and weapon) and `head` (both with their origin at the
 * shoulders, so the weapon can be carried, lowered or aimed and the head can look around; together
 * look up while lying prone) and one `leg` whose origin is the hip joint so it can swing.
 */
export interface SoldierTemplates {
  body: Mesh; arms: Mesh; head: Mesh; leg: Mesh; shin: Mesh;
  /** Grenadier only: the right (throwing) arm with the grenade, origin at the right shoulder. */
  throwArm?: Mesh;
}

/** Right shoulder joint (scaled) where the grenadier's throwing arm pivots. */
export const THROW_SHOULDER = { x: 0.26 * SOLDIER_SCALE, y: 1.4 * SOLDIER_SCALE };

/** Knee joint relative to the hip joint (scaled), where the shin hangs from the thigh. */
export const KNEE = { y: -0.4 * SOLDIER_SCALE, z: 0.02 * SOLDIER_SCALE };

export function createSoldierTemplates(scene: Scene, team: Team, grenadier = false): SoldierTemplates {
  const player = team === PLAYER;
  const uni: RGB = player ? [0.24, 0.38, 0.74] : [0.72, 0.2, 0.15];
  const uniDark: RGB = player ? [0.19, 0.3, 0.6] : [0.58, 0.16, 0.12];
  const helmet: RGB = player ? [0.17, 0.27, 0.55] : [0.48, 0.13, 0.1];
  const pants: RGB = player ? [0.17, 0.21, 0.32] : [0.32, 0.15, 0.12];
  const skin: RGB = [0.86, 0.68, 0.54];
  const leather: RGB = [0.27, 0.2, 0.13];
  const webbing: RGB = [0.5, 0.44, 0.3];
  const kit: RGB = [0.35, 0.38, 0.24];
  const wood: RGB = [0.45, 0.3, 0.17];
  const metal: RGB = [0.12, 0.12, 0.13];
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const up = new Vector3(0, 1, 0);

  /** Tapered, slightly flattened round segment from a (radius ra) to b (radius rb). */
  const tube = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number, c: RGB, flat = 1) => {
    const d = new Vector3(bx - ax, by - ay, bz - az);
    const len = d.length();
    const m = MeshBuilder.CreateCylinder("seg", { height: len, diameterBottom: ra * 2, diameterTop: rb * 2, tessellation: 8 }, scene);
    m.scaling.z = flat;
    m.bakeCurrentTransformIntoVertices();
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.rotationQuaternion = Quaternion.Identity();
    Quaternion.FromUnitVectorsToRef(up, d.normalize(), m.rotationQuaternion);
    m.material = mat(scene, c);
    parts.push(m);
    return m;
  };
  const ball = (r: number, x: number, y: number, z: number, c: RGB, sy = 1) => {
    const m = MeshBuilder.CreateSphere("ball", { diameter: r * 2, segments: 6 }, scene);
    m.scaling.y = sy;
    m.position.set(x, y, z);
    m.material = mat(scene, c);
    parts.push(m);
    return m;
  };
  /** Upper arm + forearm + hand through shoulder, elbow and hand positions. */
  const arm = (s: number[], e: number[], h: number[]) => {
    tube(s[0], s[1], s[2], e[0], e[1], e[2], 0.075, 0.062, uni);
    ball(0.062, e[0], e[1], e[2], uni);
    tube(e[0], e[1], e[2], h[0], h[1], h[2], 0.062, 0.05, uni);
    ball(0.058, h[0], h[1], h[2], skin);
  };

  // ---- torso: tapered chest (broad shoulders, narrow waist), pelvis, belt, webbing, kit, pack
  tube(0, 0.86, 0, 0, 1.44, 0, 0.19, 0.25, uni, 0.62);
  ball(0.09, -0.25, 1.4, 0, uni);
  ball(0.09, 0.25, 1.4, 0, uni);
  tube(0, 0.72, 0, 0, 0.88, 0, 0.17, 0.185, pants, 0.7);
  tube(0, 0.82, 0, 0, 0.9, 0, 0.2, 0.2, leather, 0.66);
  box(0.08, 0.06, 0.02, 0, 0.86, 0.14, [0.7, 0.62, 0.35]);
  for (const x of [-0.12, 0.12]) {
    box(0.05, 0.56, 0.02, x, 1.15, 0.145, webbing).rotation.x = 0.1;
    box(0.05, 0.56, 0.02, x, 1.15, -0.145, webbing).rotation.x = -0.1;
  }
  if (!grenadier) for (const x of [-0.13, 0.13]) box(0.11, 0.12, 0.07, x, 0.97, 0.15, kit);
  tube(0.24, 0.72, -0.06, 0.24, 0.92, -0.06, 0.065, 0.065, kit);
  box(0.32, 0.38, 0.15, 0, 1.2, -0.22, [0.38, 0.31, 0.2]);
  box(0.26, 0.1, 0.03, 0, 1.3, -0.3, [0.32, 0.26, 0.17]); // pack flap
  tube(-0.2, 1.46, -0.2, 0.2, 1.46, -0.2, 0.075, 0.075, kit); // bedroll
  tube(0, 1.44, 0, 0, 1.56, 0, 0.1, 0.06, uniDark); // collar
  if (grenadier) {
    box(0.08, 0.72, 0.04, 0, 1.16, 0.15, [0.55, 0.47, 0.3]).rotation.z = 0.6; // bandolier
    for (const x of [-0.12, 0, 0.12]) box(0.1, 0.12, 0.08, x, 0.97, 0.16, kit);
  }
  const body = merge(`soldier${team}`, parts.splice(0));
  body.scaling.setAll(SOLDIER_SCALE);
  body.bakeCurrentTransformIntoVertices();

  // ---- upper body: arms, hands, weapon, neck, head, helmet (pivots at the shoulders)
  if (grenadier) {
    // no rifle: the left arm hangs loosely here; the right arm with the grenade is a separate part
    arm([-0.26, 1.4, 0], [-0.31, 1.12, 0.04], [-0.3, 0.9, 0.14]);
  } else {
    // rifle held at the ready: wooden stock, receiver, magazine, handguard, barrel
    box(0.07, 0.12, 0.38, 0.1, 1.2, 0.14, wood);
    box(0.06, 0.08, 0.34, 0.08, 1.24, 0.5, metal);
    box(0.05, 0.16, 0.07, 0.08, 1.13, 0.5, metal);
    box(0.07, 0.05, 0.28, 0.08, 1.2, 0.62, wood);
    box(0.035, 0.035, 0.45, 0.08, 1.25, 0.9, metal);
    arm([0.26, 1.4, 0], [0.25, 1.12, 0.03], [0.12, 1.17, 0.2]);
    arm([-0.26, 1.4, 0], [-0.2, 1.17, 0.28], [0.05, 1.19, 0.58]);
  }
  const shoulderPart = (name: string) => {
    const m = merge(name, parts.splice(0));
    m.position.y = -SHOULDER;
    m.bakeCurrentTransformIntoVertices();
    m.scaling.setAll(SOLDIER_SCALE);
    m.bakeCurrentTransformIntoVertices();
    return m;
  };
  const arms = shoulderPart(`soldierArms${team}${grenadier ? "g" : ""}`);
  let throwArm: Mesh | undefined;
  if (grenadier) {
    // throwing arm: grenade held loosely at the hip, pivots at the right shoulder so it can wind up
    arm([0.26, 1.4, 0], [0.31, 1.12, 0.06], [0.25, 0.95, 0.2]);
    ball(0.08, 0.25, 0.94, 0.28, [0.3, 0.36, 0.2], 1.25); // grenade
    throwArm = merge(`soldierThrowArm${team}`, parts.splice(0));
    throwArm.position.set(-0.26, -SHOULDER, 0);
    throwArm.bakeCurrentTransformIntoVertices();
    throwArm.scaling.setAll(SOLDIER_SCALE);
    throwArm.bakeCurrentTransformIntoVertices();
  }

  tube(0, 1.5, 0, 0, 1.62, 0.01, 0.055, 0.05, skin); // neck
  ball(0.135, 0, 1.69, 0.01, skin, 1.15); // head
  box(0.05, 0.07, 0.04, 0, 1.66, 0.14, [0.8, 0.62, 0.5]); // nose
  const helm = MeshBuilder.CreateSphere("helm", { diameter: 0.36, segments: 8, slice: 0.5 }, scene);
  helm.position.y = 1.73;
  helm.material = mat(scene, helmet, { twoSided: true });
  const brim = MeshBuilder.CreateCylinder("brim", { diameter: 0.43, height: 0.025, tessellation: 14 }, scene);
  brim.position.y = 1.73;
  brim.material = mat(scene, helmet);
  parts.push(helm, brim);
  if (grenadier) {
    // light band around the helmet makes grenadiers easy to tell apart
    const band = MeshBuilder.CreateCylinder("band", { height: 0.06, diameter: 0.37, tessellation: 12 }, scene);
    band.position.y = 1.77;
    band.material = mat(scene, [0.9, 0.86, 0.7]);
    parts.push(band);
  }

  const head = shoulderPart(`soldierHead${team}${grenadier ? "g" : ""}`);

  // ---- thigh (origin = hip joint) with the knee cap
  tube(0, 0, 0, 0, -0.4, 0.02, 0.095, 0.075, pants);
  ball(0.074, 0, -0.4, 0.02, pants);
  const leg = merge(`soldierThigh${team}`, parts.splice(0));
  leg.scaling.setAll(SOLDIER_SCALE);
  leg.bakeCurrentTransformIntoVertices();

  // ---- shin (origin = knee joint): trouser, canvas gaiter, boot with sole
  tube(0, 0, 0, 0, -0.16, -0.01, 0.072, 0.066, pants);
  tube(0, -0.12, -0.01, 0, -0.28, -0.02, 0.074, 0.07, [0.56, 0.5, 0.38]);
  box(0.13, 0.12, 0.26, 0, -0.33, 0.03, [0.2, 0.16, 0.12]);
  box(0.14, 0.035, 0.28, 0, -0.385, 0.03, [0.1, 0.09, 0.08]);
  const shin = merge(`soldierShin${team}`, parts.splice(0));
  shin.scaling.setAll(SOLDIER_SCALE);
  shin.bakeCurrentTransformIntoVertices();

  for (const m of [body, arms, head, leg, shin, throwArm]) {
    if (!m) continue;
    m.isPickable = false;
    m.isVisible = false;
  }
  return { body, arms, head, leg, shin, throwArm };
}

/** Soft round shadow under a unit: dark disc whose vertex alpha fades to the rim. */
export function createBlobShadow(scene: Scene): Mesh {
  // two rings so the shadow has a solid core and a soft falloff (a single fan fades linearly from the centre)
  const positions = [0, 0, 0];
  const colors = [0, 0, 0, 0.5];
  const seg = 28;
  for (const [r, a] of [[0.6, 0.42], [1, 0]]) {
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      positions.push(Math.cos(t) * r, 0, Math.sin(t) * r);
      colors.push(0, 0, 0, a);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % seg), c = a + seg, d = b + seg;
    indices.push(0, a, b, a, c, d, a, d, b);
  }
  const m = new Mesh("blob", scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
  vd.colors = colors;
  vd.applyToMesh(m);
  m.setVerticesData("color", colors);
  m.hasVertexAlpha = true;
  const mt = new StandardMaterial("blobMat", scene);
  mt.diffuseColor = Color3.Black();
  mt.emissiveColor = Color3.Black();
  mt.specularColor = Color3.Black();
  mt.disableLighting = true;
  mt.disableDepthWrite = true;
  mt.zOffset = -7; // above the painted ground, below selection rings
  mt.backFaceCulling = false; // the disc is seen from above whichever way it was built
  m.material = mt;
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** Barracks, front door facing +z. */
export function createBarracksMesh(scene: Scene, team: Team): Mesh {
  const player = team === PLAYER;
  const teamC = TEAM_COLOR[team];
  const roofC: RGB = player ? [0.42, 0.53, 0.76] : [0.76, 0.32, 0.26];
  const wall: RGB = [0.52, 0.51, 0.39];
  const sand: RGB = [0.68, 0.6, 0.43];
  const crate: RGB = [0.46, 0.34, 0.2];
  const dark: RGB = [0.17, 0.16, 0.15];
  const glass: RGB = [0.2, 0.26, 0.32];
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);

  box(17, 1, 13, 0, 0.1, 0, [0.64, 0.62, 0.57]);
  const hall = brickBox(scene, "hall", 12, 3.8, 8, wall);
  hall.position.y = 2.5;
  parts.push(hall);
  box(12.1, 0.45, 8.1, 0, 4.0, 0, teamC);
  box(2.8, 2.9, 0.3, 0, 2.05, 4.05, dark);
  box(3.4, 0.35, 0.4, 0, 3.6, 4.1, [0.4, 0.4, 0.34]);
  for (const x of [-4.2, 4.2]) {
    box(1.6, 1.0, 0.2, x, 2.8, 4.05, glass);
    box(1.6, 1.0, 0.2, x, 2.8, -4.05, glass);
  }
  box(0.2, 1.0, 1.6, -6.05, 2.8, 0, glass);
  box(0.2, 1.0, 1.6, 6.05, 2.8, 0, glass);


  // crates and supplies
  box(1.3, 1.3, 1.3, -7.4, 1.25, -4.4, crate);
  box(1.1, 1.1, 1.1, -7.3, 1.15, -2.7, [0.36, 0.42, 0.24]);
  box(1.2, 1.2, 1.2, -7.4, 2.5, -4.3, crate, 0, 0.4);
  box(2.4, 1.0, 1.1, 7.2, 1.1, -5.4, [0.36, 0.42, 0.24]);

  // flag
  const pole = MeshBuilder.CreateCylinder("pole", { height: 8, diameter: 0.16, tessellation: 6 }, scene);
  pole.position.set(7, 4.6, -3.2);
  pole.material = mat(scene, [0.7, 0.7, 0.7]);
  parts.push(pole);
  box(2.4, 1.4, 0.08, 8.25, 7.8, -3.2, teamC);

  // antenna
  const ant = MeshBuilder.CreateCylinder("ant", { height: 3.2, diameter: 0.08, tessellation: 4 }, scene);
  ant.position.set(-4, 7.4, 1.2);
  ant.material = mat(scene, dark);
  parts.push(ant);

  const roof = createGable("roof", scene);
  roof.scaling.set(8.9, 2.5, 12.9);
  roof.rotation.y = Math.PI / 2;
  roof.position.y = 4.4;
  roof.material = mat(scene, roofC, { twoSided: true });
  parts.push(roof);

  const m = merge(`barracks${team}`, parts);
  m.receiveShadows = true;
  return m;
}

export function createRing(scene: Scene, name: string, diameter: number, thickness: number, c: RGB): Mesh {
  const ring = MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation: 32 }, scene);
  ring.scaling.y = 0.25;
  ring.bakeCurrentTransformIntoVertices();
  const m = mat(scene, c, { emissive: true });
  m.zOffset = -8; // stay on top of the draped road/field meshes (zOffset -1..-3)
  ring.material = m;
  ring.isPickable = false;
  return ring;
}

/** Neutral model of a capturable outpost (no team colours; the flag is separate). */
export function createOutpostMesh(scene: Scene, kind: OutpostKind): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const sand: RGB = [0.68, 0.6, 0.43];
  const wood: RGB = [0.45, 0.32, 0.2];
  const darkWood: RGB = [0.32, 0.23, 0.15];
  const olive: RGB = [0.4, 0.43, 0.26];
  const crate: RGB = [0.5, 0.37, 0.22];
  const dark: RGB = [0.13, 0.12, 0.11];
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, rz = 0) => {
    const m = MeshBuilder.CreateCylinder("cyl", { height: h, diameter: d, tessellation: 8 }, scene);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.material = mat(scene, c);
    parts.push(m);
  };

  if (kind === "depot") {
    box(7, 0.4, 5.5, 0, 0.1, 0, [0.58, 0.56, 0.5]);
    // supply tent
    const tent = createGable("tent", scene);
    tent.scaling.set(3.6, 2.2, 3.2);
    tent.position.set(-1.4, 0.3, -0.8);
    tent.material = mat(scene, olive, { twoSided: true });
    parts.push(tent);
    // crates
    box(1.1, 1.1, 1.1, 1.4, 0.85, -1.3, crate);
    box(1.1, 1.1, 1.1, 2.6, 0.85, -1.3, crate, 0, 0.2);
    box(1.1, 1.1, 1.1, 2.0, 1.95, -1.3, crate, 0, -0.3);
    box(1.6, 0.8, 1.0, 2.1, 0.7, 0.3, [0.36, 0.42, 0.24]);
    // fuel drums
    for (const [x, z] of [[-2.6, 1.6], [-1.8, 1.8], [-2.2, 2.5], [-1.4, 2.6]]) cyl(1.0, 0.6, x, 0.8, z, [0.28, 0.36, 0.22]);
    box(0.9, 0.9, 0.9, 1.0, 0.75, 1.9, crate, 0, 0.5);
  } else if (kind === "bunker") {
    // dugout: sandbag walls, log roof, dark entrance
    box(5, 1.2, 0.9, 0, 0.6, -2, sand);
    box(0.9, 1.2, 4.9, -2.05, 0.6, 0, sand);
    box(0.9, 1.2, 4.9, 2.05, 0.6, 0, sand);
    box(1.6, 1.2, 0.9, -1.7, 0.6, 2, sand);
    box(1.6, 1.2, 0.9, 1.7, 0.6, 2, sand);
    for (let i = 0; i < 6; i++) cyl(5.4, 0.36, 0, 1.38, -2.05 + i * 0.82, darkWood, Math.PI / 2);
    box(4.6, 0.3, 4.6, 0, 1.7, 0, [0.44, 0.4, 0.26]); // earth cover
    box(1.7, 1.0, 0.2, 0, 0.55, 2.2, dark);
  } else if (kind === "trench") {
    // zig-zag sandbag parapet with a firing step
    const segs: [number, number, number][] = [[-6, 0, 0.5], [-2, 0, -0.5], [2, 0, 0.5], [6, 0, -0.5]];
    for (const [x, , ry] of segs) {
      box(4.4, 0.8, 0.9, x, 0.4, ry > 0 ? 0.9 : -0.9, sand, 0, ry);
      box(4.4, 0.35, 1.2, x, 0.05, ry > 0 ? -0.3 : -2.1, [0.36, 0.27, 0.18], 0, ry); // dug earth
    }
    box(0.4, 1.4, 0.4, -7.8, 0.7, 1.4, wood);
    box(0.4, 1.4, 0.4, 7.8, 0.7, -1.4, wood);
    // barbed wire posts
    for (let i = -3; i <= 3; i++) box(0.12, 1.0, 0.12, i * 2.6, 0.5, 3.2 + (i % 2) * 0.3, darkWood);
    box(16, 0.05, 0.05, 0, 0.8, 3.3, [0.5, 0.5, 0.5]);
    box(16, 0.05, 0.05, 0, 0.45, 3.3, [0.5, 0.5, 0.5]);
  } else if (kind === "workshop") {
    // vehicle workshop: open-fronted hall with a corrugated roof, crane, barrels and spare parts
    const wall: RGB = [0.56, 0.54, 0.46];
    box(9, 0.3, 11, 0, 0.1, 0.5, [0.55, 0.53, 0.48]); // concrete apron
    const brickWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = brickBox(scene, "wall", w, h, d, wall);
      m.position.set(x, y, z);
      parts.push(m);
    };
    brickWall(7, 3.6, 0.3, 0, 2.05, -2.85); // back wall
    brickWall(0.3, 3.6, 5.7, -3.35, 2.05, 0);
    brickWall(0.3, 3.6, 5.7, 3.35, 2.05, 0);
    brickWall(7, 0.6, 0.3, 0, 3.55, 2.85); // lintel over the open front
    box(6.4, 0.05, 5.4, 0, 0.26, 0, [0.2, 0.19, 0.17]); // oily floor
    const roof = createGable("workshopRoof", scene);
    roof.scaling.set(7.8, 1.3, 6.6);
    roof.position.y = 3.85;
    roof.material = mat(scene, [0.46, 0.48, 0.5], { twoSided: true });
    parts.push(roof);
    // gantry crane over the bay
    box(0.2, 3.2, 0.2, -2.6, 1.85, 2.2, [0.8, 0.6, 0.15]);
    box(0.2, 3.2, 0.2, 2.6, 1.85, 2.2, [0.8, 0.6, 0.15]);
    box(5.4, 0.25, 0.25, 0, 3.4, 2.2, [0.8, 0.6, 0.15]);
    box(0.05, 1.2, 0.05, 0.8, 2.7, 2.2, dark);
    // workbench, tyres, barrels
    box(2.4, 0.9, 0.7, -1.6, 0.7, -2.2, wood);
    const tyre = (x: number, y: number, z: number) => cyl(0.35, 1.0, x, y, z, dark);
    tyre(2.6, 0.45, -1.8);
    tyre(2.6, 0.8, -1.8);
    tyre(2.6, 1.15, -1.8);
    for (const [x, z] of [[4.0, 3.2], [4.1, 4.0], [3.4, 3.7]]) cyl(1.0, 0.6, x, 0.75, z, [0.55, 0.22, 0.14]);
    box(1.2, 0.8, 0.9, -4.0, 0.65, 3.6, crate);
  } else {
    // wooden watchtower
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]]) box(0.3, 6, 0.3, x, 3, z, wood);
    box(3.6, 0.3, 3.6, 0, 5.2, 0, darkWood);
    box(3.6, 1.0, 0.15, 0, 5.85, 1.75, wood);
    box(3.6, 1.0, 0.15, 0, 5.85, -1.75, wood);
    box(0.15, 1.0, 3.6, 1.75, 5.85, 0, wood);
    box(0.15, 1.0, 3.6, -1.75, 5.85, 0, wood);
    for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) box(0.15, 1.6, 0.15, x, 6.8, z, wood);
    const roof = createGable("towerRoof", scene);
    roof.scaling.set(4.2, 1.4, 4.2);
    roof.position.y = 7.6;
    roof.material = mat(scene, [0.4, 0.3, 0.22], { twoSided: true });
    parts.push(roof);
    box(0.2, 5, 0.2, 0.6, 2.4, 1.9, darkWood, 0.25); // ladder rails
    box(0.2, 5, 0.2, -0.6, 2.4, 1.9, darkWood, 0.25);
    box(1.6, 1.2, 1.2, -2.2, 0.6, -1.6, sand);
  }

  const m = merge(`outpost-${kind}`, parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}

// ------------------------------------------------------------------ jeep

/** Jeep dimensions shared by model and animation. */
export const JEEP_DIM = {
  wheelR: 0.5,
  wheelX: 1.05,
  wheelZ: 1.5,
  bedY: 0.95,
  /** Pivot of the machine gun on top of its post. */
  turret: { y: 2.15, z: -1.25 },
  driver: { x: -0.5, z: 0.05 },
};

/** Jeep hull (front +z) without wheels and gun; team colours on bonnet and sides. */
export function createJeepBody(scene: Scene, team: Team): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const olive: RGB = team === PLAYER ? [0.35, 0.41, 0.28] : [0.42, 0.37, 0.27];
  const dark: RGB = [0.14, 0.13, 0.12];
  const seat: RGB = [0.3, 0.22, 0.14];
  const teamC = TEAM_COLOR[team];

  box(2.1, 0.35, 4.4, 0, 0.75, 0, dark); // chassis
  box(2.0, 0.12, 2.9, 0, 0.95, -0.6, olive); // floor
  box(0.12, 0.6, 2.9, -1.0, 1.25, -0.6, olive);
  box(0.12, 0.6, 2.9, 1.0, 1.25, -0.6, olive);
  box(2.1, 0.6, 0.12, 0, 1.25, -2.05, olive);
  box(1.95, 0.5, 1.5, 0, 1.18, 1.4, olive); // bonnet
  box(1.8, 0.55, 0.1, 0, 1.08, 2.17, dark); // grille
  box(2.3, 0.18, 0.2, 0, 0.72, 2.3, dark); // bumper
  for (const z of [1.5, -1.5]) {
    box(0.5, 0.1, 1.1, -1.08, 1.08, z, olive);
    box(0.5, 0.1, 1.1, 1.08, 1.08, z, olive);
  }
  box(1.95, 0.8, 0.05, 0, 1.82, 0.62, [0.42, 0.52, 0.58], -0.18); // windscreen
  box(2.0, 0.08, 0.1, 0, 2.2, 0.55, dark, -0.18);
  box(0.62, 0.35, 0.6, -0.5, 1.2, -0.05, seat);
  box(0.62, 0.35, 0.6, 0.5, 1.2, -0.05, seat);
  box(0.62, 0.6, 0.12, -0.5, 1.55, -0.38, seat);
  box(0.62, 0.6, 0.12, 0.5, 1.55, -0.38, seat);
  box(0.14, 1.2, 0.14, 0, 1.55, JEEP_DIM.turret.z, [0.35, 0.35, 0.35]); // MG post
  box(0.4, 0.5, 0.3, 0.7, 1.25, -1.8, [0.3, 0.36, 0.2]); // jerry can
  box(0.7, 0.03, 0.7, 0, 1.44, 1.35, teamC); // bonnet marking
  box(0.02, 0.2, 1.2, -1.07, 1.3, -0.8, teamC);
  box(0.02, 0.2, 1.2, 1.07, 1.3, -0.8, teamC);
  const spare = MeshBuilder.CreateCylinder("spare", { height: 0.3, diameter: 0.95, tessellation: 12 }, scene);
  spare.rotation.x = Math.PI / 2;
  spare.position.set(0, 1.25, -2.28);
  spare.material = mat(scene, dark);
  const steer = MeshBuilder.CreateTorus("steer", { diameter: 0.45, thickness: 0.05, tessellation: 12 }, scene);
  steer.rotation.x = -1.1;
  steer.position.set(-0.5, 1.65, 0.3);
  steer.material = mat(scene, dark);
  parts.push(spare, steer);

  const m = merge(`jeep${team}`, parts);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

export function createJeepWheel(scene: Scene): Mesh {
  const tyre = MeshBuilder.CreateCylinder("tyre", { height: 0.42, diameter: JEEP_DIM.wheelR * 2, tessellation: 10 }, scene);
  tyre.material = mat(scene, [0.1, 0.1, 0.1]);
  const hub = MeshBuilder.CreateCylinder("hub", { height: 0.44, diameter: 0.5, tessellation: 6 }, scene);
  hub.material = mat(scene, [0.33, 0.37, 0.26]);
  const m = merge("jeepWheel", [tyre, hub]);
  m.rotation.z = Math.PI / 2;
  m.bakeCurrentTransformIntoVertices();
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** Machine gun on its swivel, origin at the pivot, barrel along +z. */
export function createJeepGun(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const metal: RGB = [0.16, 0.16, 0.17];
  box(0.26, 0.26, 0.7, 0, 0, 0.1, metal);
  box(0.09, 0.09, 1.2, 0, 0.03, 1.0, metal);
  box(0.16, 0.16, 0.2, 0, 0.03, 1.55, metal); // muzzle
  box(0.28, 0.3, 0.32, 0.25, -0.08, 0.05, [0.3, 0.36, 0.2]); // ammo box
  box(0.06, 0.2, 0.06, -0.12, -0.12, -0.3, metal);
  box(0.06, 0.2, 0.06, 0.12, -0.12, -0.3, metal);
  box(0.5, 0.35, 0.05, 0, 0.12, 0.55, [0.3, 0.33, 0.25]); // gun shield
  const m = merge("jeepGun", parts);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

// ------------------------------------------------------------------ explosions

export function createGrenadeTemplate(scene: Scene): Mesh {
  const m = MeshBuilder.CreateSphere("grenade", { diameter: 0.34, segments: 4 }, scene);
  m.scaling.y = 1.3;
  m.bakeCurrentTransformIntoVertices();
  m.material = mat(scene, [0.22, 0.28, 0.16]);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

export function createExplosionTemplates(scene: Scene): { flash: Mesh; smoke: Mesh; scorch: Mesh } {
  const flash = MeshBuilder.CreateIcoSphere("flash", { radius: 1, subdivisions: 1, flat: true }, scene);
  flash.material = mat(scene, [1, 0.62, 0.2], { emissive: true });
  const smoke = MeshBuilder.CreateIcoSphere("smoke", { radius: 1, subdivisions: 1, flat: true }, scene);
  smoke.material = mat(scene, [0.62, 0.58, 0.52]);
  const scorch = MeshBuilder.CreateDisc("scorch", { radius: 1, tessellation: 10 }, scene);
  scorch.rotation.x = Math.PI / 2;
  scorch.bakeCurrentTransformIntoVertices();
  const sm = new StandardMaterial("scorchMat", scene);
  sm.diffuseColor = new Color3(0.27, 0.22, 0.17);
  sm.specularColor = Color3.Black();
  sm.zOffset = -6;
  scorch.material = sm;
  for (const m of [flash, smoke, scorch]) {
    m.isPickable = false;
    m.isVisible = false;
  }
  return { flash, smoke, scorch };
}

// ------------------------------------------------------------------ bonus aura

/**
 * Faint golden light column around a unit that enjoys a combat bonus. Vertex alpha fades it out
 * upwards; `strength` (material alpha) grows with the number of bonuses.
 */
export function createAuraTemplate(scene: Scene, name: string, strength: number): Mesh {
  const m = MeshBuilder.CreateCylinder(name, { height: 2.8, diameterTop: 2.3, diameterBottom: 1.5, tessellation: 24, cap: Mesh.NO_CAP }, scene);
  m.position.y = 1.4;
  m.bakeCurrentTransformIntoVertices();
  const pos = m.getVerticesData("position")!;
  const colors: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const a = Math.pow(1 - Math.min(1, pos[i + 1] / 2.8), 1.3) * 0.85;
    colors.push(1, 1, 1, a);
  }
  m.setVerticesData("color", colors);
  m.hasVertexAlpha = true;
  const mt = new StandardMaterial(name + "Mat", scene);
  mt.emissiveColor = new Color3(1, 0.84, 0.42);
  mt.diffuseColor = Color3.Black();
  mt.specularColor = Color3.Black();
  mt.disableLighting = true;
  mt.backFaceCulling = false;
  mt.disableDepthWrite = true;
  mt.alpha = strength;
  m.material = mt;
  m.isPickable = false;
  m.isVisible = false;
  return m;
}
