import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Texture, Vector3, VertexData } from "@babylonjs/core";
import { PLAYER, type OutpostKind, type Team } from "../config";
import type { RGB } from "./layout";
import { brickBox } from "./masonry";

const matCache = new Map<string, StandardMaterial>();

/** Shared flat material (no textures, no specular). */
/** Real-world material a part is made of: the realistic graphics mode gives it a matching texture. */
/** Roughness of roof tiles / sheeting in the realistic mode (the default is 0.85: matt). */
export const ROOF_ROUGH = 0.42;
export type SurfaceKind = "wood" | "fabric" | "concrete" | "metal" | "earth";
/** Picks the surface kind of a part by its colour (undefined = plain). */
export type SurfaceOf = (c: RGB) => SurfaceKind | undefined;

export function mat(scene: Scene, c: RGB, opts: { emissive?: boolean; twoSided?: boolean; surface?: SurfaceKind; rough?: number } = {}): StandardMaterial {
  // materials belong to a scene, so the cache is per scene (the build-menu portraits use their own)
  const key = scene.uid + ":" + c.map((v) => v.toFixed(3)).join(",") + (opts.emissive ? "e" : "") + (opts.twoSided ? "t" : "") + (opts.surface ? `:${opts.surface}` : "") + (opts.rough !== undefined ? `r${opts.rough}` : "");
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
    // `rough`: roughness of the realistic (PBR) copy; smooth parts such as roofs catch the sun
    if (opts.surface || opts.rough !== undefined) m.metadata = { surface: opts.surface, rough: opts.rough };
    matCache.set(key, m);
  }
  return m;
}

const camoTex = new Map<string, DynamicTexture>();

/**
 * Woodland camouflage cloth: an olive base with overlapping blotches of dark green, brown and
 * pale green. The pattern tiles seamlessly and is shared per scene; `tint` darkens or shifts it.
 */
export function camoMaterial(scene: Scene, tint: RGB = [1, 1, 1]): StandardMaterial {
  const key = scene.uid + ":camo:" + tint.map((v) => v.toFixed(3)).join(",");
  let m = matCache.get(key);
  if (m) return m;
  let tex = camoTex.get(scene.uid);
  if (!tex) {
    const size = 128;
    tex = new DynamicTexture("camo", { width: size, height: size }, scene, true, Texture.BILINEAR_SAMPLINGMODE);
    tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.fillStyle = "#5c6b3a";
    ctx.fillRect(0, 0, size, size);
    const blot = (color: string, count: number, r0: number, r1: number) => {
      ctx.fillStyle = color;
      for (let i = 0; i < count; i++) {
        // a blotch is a small cluster of overlapping circles, drawn wrapped so the tile is seamless
        const cx = rnd() * size, cy = rnd() * size, n = 3 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const x = cx + (rnd() - 0.5) * r1 * 2.2, y = cy + (rnd() - 0.5) * r1 * 1.4, r = r0 + rnd() * (r1 - r0);
          for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
            ctx.beginPath();
            ctx.ellipse(x + ox, y + oy, r * 1.3, r * 0.8, rnd() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };
    blot("#7f8a52", 7, 4, 9); // pale green
    blot("#5e4a2e", 8, 4, 9); // brown
    blot("#2f3d22", 9, 4, 10); // dark green
    blot("#1f261a", 6, 2, 4); // black specks
    tex.update(false);
    camoTex.set(scene.uid, tex);
  }
  m = new StandardMaterial("camo" + key, scene);
  m.diffuseTexture = tex;
  m.diffuseColor = new Color3(tint[0], tint[1], tint[2]);
  m.specularColor = Color3.Black();
  matCache.set(key, m);
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

export type PartFn = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, rx?: number, ry?: number) => Mesh;

export function partBuilder(scene: Scene, parts: Mesh[], surfaceOf?: SurfaceOf): PartFn {
  return (w, h, d, x, y, z, c, rx = 0, ry = 0) => {
    const m = MeshBuilder.CreateBox("part", { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.material = mat(scene, c, { surface: surfaceOf?.(c) });
    parts.push(m);
    return m;
  };
}

export function merge(name: string, parts: Mesh[]): Mesh {
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

export type SoldierVariant = "rifleman" | "grenadier" | "agent" | "medic" | "pilot";

export function createSoldierTemplates(scene: Scene, team: Team, variant: SoldierVariant | boolean = "rifleman"): SoldierTemplates {
  const kind: SoldierVariant = variant === true ? "grenadier" : variant === false ? "rifleman" : variant;
  const grenadier = kind === "grenadier";
  const agent = kind === "agent";
  const medic = kind === "medic";
  const pilot = kind === "pilot";
  const player = team === PLAYER;
  const white: RGB = [0.94, 0.93, 0.88];
  const red: RGB = [0.8, 0.1, 0.08];
  // the agent wears a long charcoal coat and a peaked cap instead of the team uniform
  const coat: RGB = [0.24, 0.24, 0.21];
  // both sides wear the same woodland camouflage; helmet, armbands and pack flap carry the team colour
  const CAMO: RGB = [1, 1, 1];
  const CAMO_PANTS: RGB = [0.8, 0.8, 0.78];
  const uni: RGB = agent ? coat : CAMO;
  const uniDark: RGB = agent ? [0.17, 0.17, 0.15] : [0.25, 0.3, 0.18];
  const helmet: RGB = player ? [0.2, 0.36, 0.8] : [0.74, 0.17, 0.12];
  const pants: RGB = agent ? [0.14, 0.14, 0.13] : CAMO_PANTS;
  const teamC: RGB = player ? [0.25, 0.45, 0.95] : [0.9, 0.18, 0.12];
  const skin: RGB = [0.86, 0.68, 0.54];
  const leather: RGB = [0.27, 0.2, 0.13];
  const webbing: RGB = [0.5, 0.44, 0.3];
  const kit: RGB = [0.35, 0.38, 0.24];
  const wood: RGB = [0.45, 0.3, 0.17];
  const metal: RGB = [0.12, 0.12, 0.13];
  const parts: Mesh[] = [];
  /** Camouflage parts get the camo material, with UVs scaled to world size so the blotches stay even. */
  const paint = (m: Mesh, c: RGB, uSize = 1, vSize = 1) => {
    if (c !== CAMO && c !== CAMO_PANTS) {
      m.material = mat(scene, c);
      return;
    }
    m.material = camoMaterial(scene, c);
    const uv = m.getVerticesData("uv");
    if (uv) {
      const ref = 0.9; // cloth size covered by one tile of the pattern
      for (let i = 0; i < uv.length; i += 2) {
        uv[i] *= uSize / ref;
        uv[i + 1] *= vSize / ref;
      }
      m.setVerticesData("uv", uv);
    }
  };
  const rawBox = partBuilder(scene, parts);
  const box: PartFn = (w, h, d, x, y, z, c, rx, ry) => {
    const m = rawBox(w, h, d, x, y, z, c, rx, ry);
    paint(m, c, Math.max(w, d), h);
    return m;
  };
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
    paint(m, c, Math.PI * (ra + rb), len);
    parts.push(m);
    return m;
  };
  const ball = (r: number, x: number, y: number, z: number, c: RGB, sy = 1) => {
    const m = MeshBuilder.CreateSphere("ball", { diameter: r * 2, segments: 6 }, scene);
    m.scaling.y = sy;
    m.position.set(x, y, z);
    paint(m, c, Math.PI * r * 2, Math.PI * r * sy);
    parts.push(m);
    return m;
  };
  /** Upper arm + forearm + hand through shoulder, elbow and hand positions. */
  const arm = (s: number[], e: number[], h: number[]) => {
    tube(s[0], s[1], s[2], e[0], e[1], e[2], 0.075, 0.062, uni);
    if (!agent) {
      // team armband just below the shoulder; the medic wears the red cross on his left arm
      const k0 = 0.22, k1 = 0.42, at = (k: number, i: number) => s[i] + (e[i] - s[i]) * k;
      const redCross = medic && s[0] < 0;
      tube(at(k0, 0), at(k0, 1), at(k0, 2), at(k1, 0), at(k1, 1), at(k1, 2), 0.082, 0.078, redCross ? white : teamC);
      if (redCross) {
        const y = at(0.32, 1), z = at(0.32, 2), x = at(0.32, 0) - 0.08;
        box(0.02, 0.1, 0.03, x, y, z, red);
        box(0.02, 0.03, 0.1, x, y, z, red);
      }
    }
    ball(0.062, e[0], e[1], e[2], uni);
    tube(e[0], e[1], e[2], h[0], h[1], h[2], 0.062, 0.05, uni);
    ball(0.058, h[0], h[1], h[2], skin);
  };


  /** Merges the collected parts into a template whose origin is the shoulder joint. */
  const shoulderPart = (name: string) => {
    const m = merge(name, parts.splice(0));
    m.position.y = -SHOULDER;
    m.bakeCurrentTransformIntoVertices();
    m.scaling.setAll(SOLDIER_SCALE);
    m.bakeCurrentTransformIntoVertices();
    return m;
  };

  /** Agent: scoped rifle, coat sleeves with team armband, peaked cap, dark trousers and tall boots. */
  function agentRest(body: Mesh): SoldierTemplates {
    const metal2: RGB = [0.1, 0.1, 0.11];
    box(0.07, 0.12, 0.4, 0.1, 1.2, 0.12, wood); // stock
    box(0.06, 0.08, 0.3, 0.08, 1.24, 0.46, metal2);
    box(0.07, 0.05, 0.36, 0.08, 1.2, 0.66, wood);
    box(0.03, 0.03, 0.62, 0.08, 1.26, 1.08, metal2); // long barrel
    tube(0.08, 1.33, 0.3, 0.08, 1.33, 0.66, 0.035, 0.03, metal2); // scope
    ball(0.042, 0.08, 1.33, 0.67, [0.35, 0.45, 0.55]); // lens
    box(0.02, 0.05, 0.02, 0.08, 1.29, 0.38, metal2);
    box(0.02, 0.05, 0.02, 0.08, 1.29, 0.58, metal2);
    arm([0.26, 1.4, 0], [0.25, 1.12, 0.03], [0.12, 1.17, 0.2]);
    arm([-0.26, 1.4, 0], [-0.2, 1.17, 0.28], [0.05, 1.19, 0.58]);
    tube(-0.265, 1.31, 0.01, -0.255, 1.22, 0.02, 0.08, 0.075, teamC); // armband
    const arms = shoulderPart(`agentArms${team}`);

    tube(0, 1.5, 0, 0, 1.62, 0.01, 0.055, 0.05, skin);
    ball(0.135, 0, 1.69, 0.01, skin, 1.15);
    box(0.05, 0.07, 0.04, 0, 1.66, 0.14, [0.8, 0.62, 0.5]);
    const capC: RGB = [0.15, 0.15, 0.14];
    tube(0, 1.75, -0.01, 0, 1.86, -0.02, 0.15, 0.17, capC, 0.95); // cap crown, slightly wider on top
    tube(0, 1.74, -0.01, 0, 1.77, -0.01, 0.152, 0.152, [0.08, 0.08, 0.07]); // cap band
    box(0.24, 0.02, 0.12, 0, 1.745, 0.16, [0.08, 0.08, 0.07]).rotation.x = 0.18; // visor
    box(0.05, 0.035, 0.01, 0, 1.8, 0.155, [0.75, 0.68, 0.45]); // badge
    const head = shoulderPart(`agentHead${team}`);

    tube(0, 0, 0, 0, -0.4, 0.02, 0.09, 0.072, pants);
    ball(0.07, 0, -0.4, 0.02, pants);
    const leg = merge(`agentThigh${team}`, parts.splice(0));
    leg.scaling.setAll(SOLDIER_SCALE);
    leg.bakeCurrentTransformIntoVertices();
    tube(0, 0, 0, 0, -0.12, -0.01, 0.07, 0.066, pants);
    tube(0, -0.08, -0.01, 0, -0.3, -0.02, 0.075, 0.072, [0.13, 0.1, 0.08]); // tall boot shaft
    box(0.13, 0.12, 0.27, 0, -0.33, 0.03, [0.13, 0.1, 0.08]);
    box(0.14, 0.035, 0.29, 0, -0.385, 0.03, [0.06, 0.05, 0.05]);
    const shin = merge(`agentShin${team}`, parts.splice(0));
    shin.scaling.setAll(SOLDIER_SCALE);
    shin.bakeCurrentTransformIntoVertices();
    for (const m of [body, arms, head, leg, shin]) {
      m.isPickable = false;
      m.isVisible = false;
    }
    return { body, arms, head, leg, shin };
  }

  if (agent) {
    // ---- agent: long coat flaring over the thighs, belt, lapels, turned-up collar, map case
    tube(0, 0.86, 0, 0, 1.44, 0, 0.19, 0.24, coat, 0.64);
    tube(0, 0.36, 0, 0, 0.9, 0, 0.27, 0.2, coat, 0.72); // coat skirt
    ball(0.085, -0.24, 1.4, 0, coat);
    ball(0.085, 0.24, 1.4, 0, coat);
    tube(0, 0.84, 0, 0, 0.92, 0, 0.205, 0.205, uniDark, 0.66); // coat belt
    box(0.07, 0.06, 0.02, 0, 0.88, 0.14, [0.55, 0.5, 0.4]);
    for (const x of [-0.08, 0.08]) box(0.07, 0.38, 0.02, x, 1.25, 0.15, uniDark).rotation.z = x > 0 ? -0.25 : 0.25; // lapels
    for (const y of [1.05, 0.72, 0.56]) box(0.035, 0.035, 0.02, 0.07, y, y > 0.9 ? 0.155 : 0.19, [0.1, 0.1, 0.09]); // buttons
    tube(0, 1.42, 0, 0, 1.6, 0, 0.12, 0.09, uniDark); // turned-up collar
    box(0.16, 0.2, 0.06, -0.22, 0.84, 0.08, [0.3, 0.22, 0.14]); // map case
    const body = merge(`agent${team}`, parts.splice(0));
    body.scaling.setAll(SOLDIER_SCALE);
    body.bakeCurrentTransformIntoVertices();
    return agentRest(body);
  }

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
  if (!grenadier && !medic && !pilot) for (const x of [-0.13, 0.13]) box(0.11, 0.12, 0.07, x, 0.97, 0.15, kit);
  if (pilot) {
    // laptop on the ground in front of his knees (he kneels: the body sits 0.35 m lower), screen glowing
    const lx = 0, ly = 0.3, lz = 0.62;
    box(0.42, 0.03, 0.3, lx, ly, lz, [0.16, 0.16, 0.17]);
    const lid = box(0.42, 0.3, 0.025, lx, ly + 0.14, lz + 0.16, [0.16, 0.16, 0.17]);
    lid.rotation.x = -0.25;
    const screen = MeshBuilder.CreateBox("screen", { width: 0.37, height: 0.24, depth: 0.01 }, scene);
    screen.position.set(lx, ly + 0.14, lz + 0.145);
    screen.rotation.x = -0.25;
    screen.material = mat(scene, [0.55, 0.85, 1], { emissive: true });
    parts.push(screen);
    box(0.32, 0.02, 0.14, lx, ly + 0.022, lz - 0.05, [0.3, 0.3, 0.32]); // keyboard
    box(0.25, 0.12, 0.18, 0.32, 0.3, 0.5, [0.26, 0.3, 0.2]); // controller case
  }
  tube(0.24, 0.72, -0.06, 0.24, 0.92, -0.06, 0.065, 0.065, kit);
  box(0.32, 0.38, 0.15, 0, 1.2, -0.22, [0.38, 0.31, 0.2]);
  box(0.28, 0.12, 0.03, 0, 1.3, -0.3, helmet); // pack flap in team colour
  tube(-0.2, 1.46, -0.2, 0.2, 1.46, -0.2, 0.075, 0.075, kit); // bedroll
  tube(0, 1.44, 0, 0, 1.56, 0, 0.1, 0.06, uniDark); // collar
  if (grenadier) {
    box(0.08, 0.72, 0.04, 0, 1.16, 0.15, [0.55, 0.47, 0.3]).rotation.z = 0.6; // bandolier
    for (const x of [-0.12, 0, 0.12]) box(0.1, 0.12, 0.08, x, 0.97, 0.16, kit);
  }
  if (medic) {
    // medical satchel on the right hip on a strap across the chest, marked with a red cross
    box(0.06, 0.8, 0.03, 0, 1.12, 0.155, webbing).rotation.z = -0.62;
    box(0.14, 0.24, 0.3, 0.27, 0.86, 0.05, white);
    box(0.02, 0.15, 0.05, 0.345, 0.87, 0.05, red);
    box(0.02, 0.05, 0.15, 0.345, 0.87, 0.05, red);
  }
  const body = merge(`soldier${team}${medic ? "m" : ""}`, parts.splice(0));
  body.scaling.setAll(SOLDIER_SCALE);
  body.bakeCurrentTransformIntoVertices();

  // ---- upper body: arms, hands, weapon, neck, head, helmet (pivots at the shoulders)
  if (grenadier) {
    // no rifle: the left arm hangs loosely here; the right arm with the grenade is a separate part
    arm([-0.26, 1.4, 0], [-0.31, 1.12, 0.04], [-0.3, 0.9, 0.14]);
  } else if (medic || pilot) {
    // unarmed: both arms hang loosely (the view swings them forward to treat a patient / type)
    arm([-0.26, 1.4, 0], [-0.31, 1.12, 0.04], [-0.3, 0.9, 0.12]);
    arm([0.26, 1.4, 0], [0.31, 1.12, 0.04], [0.3, 0.9, 0.12]);
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
  const suffix = grenadier ? "g" : medic ? "m" : pilot ? "p" : "";
  const arms = shoulderPart(`soldierArms${team}${suffix}`);
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
  if (pilot) {
    // no helmet: short hair, a headset with ear cups, a boom microphone and a glowing status LED
    ball(0.14, 0, 1.73, -0.01, [0.2, 0.15, 0.1], 0.85); // hair
    const band = MeshBuilder.CreateTorus("headband", { diameter: 0.31, thickness: 0.035, tessellation: 16 }, scene);
    band.rotation.z = Math.PI / 2;
    band.position.set(0, 1.71, 0);
    band.material = mat(scene, [0.12, 0.12, 0.12]);
    parts.push(band);
    for (const x of [-0.155, 0.155]) {
      const cup = tube(x - Math.sign(x) * 0.01, 1.68, 0.01, x + Math.sign(x) * 0.05, 1.68, 0.01, 0.065, 0.06, [0.14, 0.14, 0.14]);
      cup.rotation.z = Math.PI / 2;
    }
    tube(0.19, 1.66, 0.03, 0.1, 1.6, 0.15, 0.012, 0.012, [0.12, 0.12, 0.12]); // mic boom
    const led = MeshBuilder.CreateSphere("led", { diameter: 0.035, segments: 4 }, scene);
    led.position.set(0.21, 1.69, 0.03);
    led.material = mat(scene, [0.3, 1, 0.5], { emissive: true });
    parts.push(led);
  } else {
    const helm = MeshBuilder.CreateSphere("helm", { diameter: 0.36, segments: 8, slice: 0.5 }, scene);
    helm.position.y = 1.73;
    helm.material = mat(scene, helmet, { twoSided: true });
    const brim = MeshBuilder.CreateCylinder("brim", { diameter: 0.43, height: 0.025, tessellation: 14 }, scene);
    brim.position.y = 1.73;
    brim.material = mat(scene, helmet);
    parts.push(helm, brim);
  }
  if (grenadier) {
    // light band around the helmet makes grenadiers easy to tell apart
    const band = MeshBuilder.CreateCylinder("band", { height: 0.06, diameter: 0.37, tessellation: 12 }, scene);
    band.position.y = 1.77;
    band.material = mat(scene, [0.9, 0.86, 0.7]);
    parts.push(band);
  }
  if (medic) {
    // white patch with a red cross on the front, back and crown of the helmet
    for (const side of [1, -1]) {
      const z = 0.175 * side, y = 1.8, tilt = -0.45 * side;
      box(0.13, 0.13, 0.02, 0, y, z, white).rotation.x = tilt;
      box(0.1, 0.03, 0.03, 0, y, z + 0.004 * side, red).rotation.x = tilt;
      box(0.03, 0.1, 0.03, 0, y, z + 0.004 * side, red).rotation.x = tilt;
    }
    box(0.14, 0.02, 0.14, 0, 1.912, 0, white);
    box(0.11, 0.03, 0.035, 0, 1.915, 0, red);
    box(0.035, 0.03, 0.11, 0, 1.915, 0, red);
  }

  const head = shoulderPart(`soldierHead${team}${suffix}`);

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
  roof.material = mat(scene, roofC, { twoSided: true, rough: ROOF_ROUGH });
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
/** Ward tent of the field hospital (local offset and half size); it blocks movement. */
export const HOSPITAL_TENT = { x: -0.8, z: -0.8, hw: 2.3, hd: 2.1 };

/** Radome dimensions shared by the model and its warning light. */
export const RADAR_DIM = { drumH: 2.4, drumR: 2.2, domeR: 2.9, domeY: 4.5 };

/** What the outposts' parts are made of, by colour (for the textures of the realistic mode). */
const OUTPOST_SURFACES = new Map<string, SurfaceKind>([
  ["0.68,0.6,0.43", "fabric"], // sandbags
  ["0.42,0.44,0.28", "fabric"], // stretcher canvas
  ["0.45,0.32,0.2", "wood"],
  ["0.32,0.23,0.15", "wood"],
  ["0.5,0.37,0.22", "wood"], // crates
  ["0.4,0.3,0.22", "wood"], // tower roof
  ["0.58,0.56,0.5", "concrete"],
  ["0.55,0.53,0.48", "concrete"],
  ["0.6,0.59,0.55", "concrete"],
  ["0.42,0.42,0.4", "concrete"],
  ["0.46,0.48,0.5", "metal"], // workshop roof
  ["0.44,0.47,0.36", "metal"], // radar hut
  ["0.3,0.3,0.28", "metal"],
  ["0.32,0.38,0.24", "metal"], // generator
  ["0.28,0.36,0.22", "metal"], // water drums
  ["0.55,0.22,0.14", "metal"], // oil barrels
  ["0.8,0.6,0.15", "metal"], // crane
  ["0.44,0.4,0.26", "earth"],
  ["0.36,0.27,0.18", "earth"],
]);
export const outpostSurface: SurfaceOf = (c) => OUTPOST_SURFACES.get(c.join(","));

export function createOutpostMesh(scene: Scene, kind: OutpostKind): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts, outpostSurface);
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
    m.material = mat(scene, c, { surface: outpostSurface(c) });
    parts.push(m);
  };

  if (kind === "hospital") {
    // field hospital: ward tent with red crosses, stretchers, medical crates and water drums
    const canvas: RGB = [0.84, 0.82, 0.72];
    const white: RGB = [0.94, 0.93, 0.88];
    const red: RGB = [0.78, 0.1, 0.08];
    const T = HOSPITAL_TENT;
    box(7.5, 0.4, 6, 0, 0.1, 0, [0.58, 0.56, 0.5]);
    const tent = createGable("wardTent", scene);
    tent.scaling.set(T.hw * 2, 2.8, T.hd * 2);
    tent.position.set(T.x, 0.3, T.z);
    tent.material = mat(scene, canvas, { twoSided: true, surface: "fabric" });
    parts.push(tent);
    /** Red cross on a white field; `rz` tilts it onto a roof slope, `ry` turns it to face along x. */
    const redCross = (x: number, y: number, z: number, size: number, rz: number, ry = 0) => {
      const panel = box(size, 0.03, size, x, y, z, white, 0, ry);
      const a = box(size * 0.7, 0.05, size * 0.22, x, y, z, red, 0, ry);
      const b = box(size * 0.22, 0.05, size * 0.7, x, y, z, red, 0, ry);
      for (const m of [panel, a, b]) m.rotation.z = rz;
    };
    // on both roof slopes (outward normal = the box's local y after tilting)
    const slope = Math.atan2(2.8, T.hw);
    const nx = Math.sin(slope), ny = Math.cos(slope);
    redCross(T.x - T.hw / 2 - nx * 0.03, 0.3 + 1.4 + ny * 0.03, T.z, 1.5, slope);
    redCross(T.x + T.hw / 2 + nx * 0.03, 0.3 + 1.4 + ny * 0.03, T.z, 1.5, -slope);
    // front gable: open door flap and a cross above it
    const front = T.z + T.hd + 0.03;
    box(1.0, 1.15, 0.04, T.x, 0.88, front, [0.22, 0.2, 0.16]);
    box(0.5, 1.2, 0.06, T.x - 0.75, 0.9, front + 0.03, canvas, 0, 0.5); // flap tied back
    const cross = (x: number, y: number, z: number, s: number) => {
      box(s, s, 0.03, x, y, z, white);
      box(s * 0.7, s * 0.22, 0.05, x, y, z + 0.01, red);
      box(s * 0.22, s * 0.7, 0.05, x, y, z + 0.01, red);
    };
    cross(T.x, 2.05, front, 0.7);
    // stretchers in a row beside the tent
    for (const [i, z] of [-1.9, -0.6, 0.7].entries()) {
      const x = 2.3 + (i % 2) * 0.15;
      box(0.75, 0.06, 1.95, x, 0.55, z, [0.42, 0.44, 0.28]); // canvas
      for (const sx of [-0.4, 0.4]) box(0.06, 0.06, 2.3, x + sx, 0.55, z, darkWood); // poles
      for (const sx of [-0.4, 0.4]) for (const sz of [-0.8, 0.8]) box(0.06, 0.28, 0.06, x + sx, 0.4, z + sz, darkWood);
      box(0.5, 0.12, 0.3, x, 0.63, z - 0.75, white); // pillow
      if (i === 1) box(0.7, 0.1, 1.2, x, 0.64, z + 0.2, [0.55, 0.5, 0.36]); // blanket
    }
    // medical crates, marked on top
    const medCrate = (x: number, z: number, ry: number) => {
      box(0.9, 0.7, 0.7, x, 0.65, z, white, 0, ry);
      const a = box(0.55, 0.03, 0.16, x, 1.01, z, red, 0, ry);
      const b = box(0.16, 0.03, 0.55, x, 1.01, z, red, 0, ry);
      return [a, b];
    };
    medCrate(2.5, 2.2, 0.15);
    medCrate(1.4, 2.4, -0.2);
    box(1.1, 1.1, 1.1, -3.0, 0.85, 2.0, crate, 0, 0.3);
    // water drums
    for (const [x, z] of [[-3.1, 0.6], [-3.2, -0.2]]) cyl(1.0, 0.6, x, 0.8, z, [0.28, 0.36, 0.22]);
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
  } else if (kind === "radar") {
    // radome station: white geodesic ball on a concrete drum, operators' hut, generator, aerial mast
    const R = RADAR_DIM;
    box(7, 0.3, 7, 0, 0.1, 0, [0.55, 0.53, 0.48]);
    cyl(R.drumH, R.drumR * 2, 0, 0.2 + R.drumH / 2, 0, [0.6, 0.59, 0.55]);
    cyl(0.25, R.drumR * 2 + 0.25, 0, 0.2 + R.drumH, 0, [0.42, 0.42, 0.4]); // ring beam under the dome
    box(0.9, 1.6, 0.06, 0, 1.0, R.drumR - 0.02, [0.24, 0.24, 0.24]); // door
    const dome = MeshBuilder.CreateIcoSphere("radome", { radius: R.domeR, subdivisions: 2, flat: true }, scene);
    dome.position.y = R.domeY;
    dome.material = mat(scene, [0.92, 0.92, 0.88]);
    parts.push(dome);
    // hut with a flat roof and a window
    box(2.2, 1.8, 1.6, -2.6, 1.15, 2.2, [0.44, 0.47, 0.36]);
    box(2.4, 0.15, 1.8, -2.6, 2.1, 2.2, [0.3, 0.3, 0.28]);
    box(0.5, 0.35, 0.05, -2.2, 1.45, 3.02, [0.55, 0.7, 0.75]);
    box(1.2, 0.8, 0.8, 2.6, 0.65, -2.4, [0.32, 0.38, 0.24]); // generator
    box(0.08, 4.5, 0.08, 2.9, 2.45, 2.6, [0.3, 0.3, 0.3]); // aerial mast
    box(0.9, 0.05, 0.05, 2.9, 4.5, 2.6, [0.3, 0.3, 0.3]);
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
    roof.material = mat(scene, [0.46, 0.48, 0.5], { twoSided: true, surface: "metal" });
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
    roof.material = mat(scene, [0.4, 0.3, 0.22], { twoSided: true, surface: "wood" });
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

/**
 * Demolition charge (origin at its underside, ~0.5 wide): a bundle of three dynamite sticks held by
 * tape, a detonator box with a red lamp on top and a short wire.
 */
export function createChargeMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const stick = (y: number, z: number) => {
    const m = MeshBuilder.CreateCylinder("stick", { height: 0.46, diameter: 0.11, tessellation: 8 }, scene);
    m.rotation.z = Math.PI / 2;
    m.position.set(0, y, z);
    m.material = mat(scene, [0.66, 0.2, 0.12]);
    parts.push(m);
  };
  stick(0.055, -0.058);
  stick(0.055, 0.058);
  stick(0.15, 0);
  for (const x of [-0.13, 0.13]) box(0.05, 0.23, 0.25, x, 0.1, 0, [0.16, 0.16, 0.14]); // tape
  box(0.17, 0.08, 0.13, 0, 0.24, 0, [0.14, 0.15, 0.12]); // detonator
  const lamp = MeshBuilder.CreateSphere("lamp", { diameter: 0.045, segments: 4 }, scene);
  lamp.position.set(0.05, 0.29, 0.03);
  lamp.material = mat(scene, [1, 0.15, 0.08], { emissive: true });
  parts.push(lamp);
  box(0.02, 0.02, 0.2, -0.05, 0.29, 0.12, [0.85, 0.75, 0.2], 0.4); // wire
  const m = merge("charge", parts);
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

// ------------------------------------------------------------------ drone

/** FPV drone size (~half a soldier): arm length from the centre to a motor. */
export const DRONE_DIM = { arm: 0.55, rotorY: 0.12 };

/** Drone body (hidden template): X frame, motor pods, battery, camera and navigation lights. */
export function createDroneBody(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const carbon: RGB = [0.13, 0.13, 0.14];
  for (const a of [Math.PI / 4, -Math.PI / 4]) box(DRONE_DIM.arm * 2.1, 0.04, 0.08, 0, 0, 0, carbon, 0, a);
  box(0.26, 0.08, 0.34, 0, 0.03, 0, [0.2, 0.2, 0.22]); // body plate
  box(0.16, 0.08, 0.24, 0, 0.1, -0.02, [0.55, 0.45, 0.15]); // battery
  box(0.1, 0.09, 0.08, 0, 0.0, 0.2, [0.1, 0.1, 0.1]); // camera
  for (const [i, a] of [Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4].entries()) {
    const x = Math.sin(a) * DRONE_DIM.arm, z = Math.cos(a) * DRONE_DIM.arm;
    const motor = MeshBuilder.CreateCylinder("motor", { height: 0.1, diameter: 0.1, tessellation: 8 }, scene);
    motor.position.set(x, 0.05, z);
    motor.material = mat(scene, [0.3, 0.3, 0.32]);
    parts.push(motor);
    // navigation lights: red at the back left, green at the front right style
    const led = MeshBuilder.CreateSphere("navLed", { diameter: 0.05, segments: 4 }, scene);
    led.position.set(x, -0.02, z);
    led.material = mat(scene, i < 2 ? [0.2, 1, 0.3] : [1, 0.15, 0.1], { emissive: true });
    parts.push(led);
  }
  const m = merge("droneBody", parts);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** One propeller disc (hidden template), spun by the view. */
export function createDroneRotor(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  box(0.42, 0.01, 0.04, 0, 0, 0, [0.15, 0.15, 0.16]);
  const blur = MeshBuilder.CreateDisc("blur", { radius: 0.21, tessellation: 16 }, scene);
  blur.rotation.x = Math.PI / 2;
  const bm = new StandardMaterial("rotorBlur", scene);
  bm.diffuseColor = new Color3(0.3, 0.3, 0.32);
  bm.alpha = 0.25;
  bm.backFaceCulling = false;
  blur.material = bm;
  parts.push(blur);
  const m = merge("droneRotor", parts);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

// ------------------------------------------------------------------ built structures

/** MG nest dimensions shared by model and animation. */
export const NEST_DIM = {
  /** Pivot of the machine gun on its tripod. */
  gunY: 1.05,
  /** Outer radius of the sandbag ring. */
  radius: 1.45,
};

/**
 * MG nest (hidden template): a shallow pit ringed by two courses of sandbags, open at the back,
 * with a tripod for the gun in front. The gun and the gunner are separate instances.
 */
export function createMgNestMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const bags: RGB[] = [[0.62, 0.55, 0.4], [0.57, 0.5, 0.36], [0.66, 0.6, 0.44]];
  const pit = MeshBuilder.CreateCylinder("pit", { height: 0.06, diameter: NEST_DIM.radius * 2 - 0.3, tessellation: 16 }, scene);
  pit.position.y = 0.04;
  pit.material = mat(scene, [0.3, 0.24, 0.17]);
  parts.push(pit);
  const r = NEST_DIM.radius - 0.28;
  for (let course = 0; course < 2; course++) {
    const n = 12;
    for (let i = 0; i < n; i++) {
      // gap at the back (angle PI) for getting in and out
      const a = ((i + (course ? 0.5 : 0)) / n) * Math.PI * 2;
      if (Math.abs(Math.PI - a) < 0.5) continue;
      const m = box(0.66, 0.3, 0.42, Math.sin(a) * r, 0.17 + course * 0.29, Math.cos(a) * r, bags[(i + course) % 3], 0, a);
      m.rotation.z = (i % 2 ? 0.04 : -0.04);
    }
  }
  // tripod under the gun
  for (const a of [0, 2.1, -2.1]) {
    box(0.06, 1.05, 0.06, Math.sin(a) * 0.28, 0.52, 0.35 + Math.cos(a) * 0.28, [0.16, 0.16, 0.17]).rotation.set(Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3);
  }
  box(0.4, 0.3, 0.3, -0.75, 0.2, -0.25, [0.3, 0.36, 0.2]); // ammo crates
  box(0.4, 0.3, 0.3, -0.75, 0.2, 0.15, [0.3, 0.36, 0.2]);
  const m = merge("mgNest", parts);
  m.receiveShadows = true;
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** Small team pennant on a thin pole (hidden template, one per team). */
export function createPennant(scene: Scene, team: Team): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  box(0.05, 1.6, 0.05, 0, 0.8, 0, [0.35, 0.3, 0.22]);
  box(0.03, 0.34, 0.55, 0, 1.42, 0.28, TEAM_COLOR[team]);
  const m = merge(`pennant${team}`, parts);
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** Bollards (hidden template): three striped concrete posts in a row along x, ~3.3 wide. */
export function createBollardMesh(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const concrete: RGB = [0.66, 0.65, 0.61];
  for (const x of [-1.15, 0, 1.15]) {
    const post = MeshBuilder.CreateCylinder("post", { height: 1.1, diameterTop: 0.36, diameterBottom: 0.44, tessellation: 10 }, scene);
    post.position.set(x, 0.55, 0);
    post.material = mat(scene, concrete);
    parts.push(post);
    for (const [y, c] of [[0.7, [0.9, 0.72, 0.12]], [0.84, [0.12, 0.12, 0.11]]] as [number, RGB][]) {
      const band = MeshBuilder.CreateCylinder("band", { height: 0.13, diameter: 0.41, tessellation: 10 }, scene);
      band.position.set(x, y, 0);
      band.material = mat(scene, c);
      parts.push(band);
    }
    const cap = MeshBuilder.CreateSphere("cap", { diameter: 0.36, segments: 6, slice: 0.5 }, scene);
    cap.position.set(x, 1.1, 0);
    cap.material = mat(scene, concrete);
    parts.push(cap);
    box(0.62, 0.08, 0.62, x, 0.04, 0, [0.5, 0.49, 0.46]); // footing
  }
  const m = merge("bollards", parts);
  m.receiveShadows = true;
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

export interface ExplosionTemplates {
  flash: Mesh; core: Mesh; smoke: Mesh; darkSmoke: Mesh; dust: Mesh; debris: Mesh; spark: Mesh; ring: Mesh; scorch: Mesh;
}

export function createExplosionTemplates(scene: Scene): ExplosionTemplates {
  const ico = (name: string, c: RGB, emissive = false) => {
    const m = MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 1, flat: true }, scene);
    m.material = mat(scene, c, { emissive });
    return m;
  };
  /** Fading puff: its own blending material; every puff is a copy whose visibility thins it out. */
  const fading = (name: string, c: RGB) => {
    const m = MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 1, flat: true }, scene);
    const mt = new StandardMaterial(`${name}Mat`, scene);
    mt.diffuseColor = new Color3(c[0], c[1], c[2]);
    mt.specularColor = Color3.Black();
    mt.transparencyMode = Material.MATERIAL_ALPHABLEND;
    m.material = mt;
    return m;
  };
  const flash = ico("flash", [1, 0.55, 0.16], true); // orange fireball
  const core = ico("flashCore", [1, 0.93, 0.62], true); // white-hot core
  const smoke = fading("smoke", [0.62, 0.58, 0.52]);
  const darkSmoke = fading("darkSmoke", [0.28, 0.26, 0.24]); // lingering column of dark smoke
  const dust = fading("dust", [0.58, 0.5, 0.38]); // earth thrown up, crawling along the ground
  const debris = MeshBuilder.CreateBox("debris", { width: 0.34, height: 0.2, depth: 0.26 }, scene);
  debris.material = mat(scene, [0.3, 0.23, 0.16]);
  const spark = MeshBuilder.CreateBox("spark", { width: 0.12, height: 0.12, depth: 0.36 }, scene);
  spark.material = mat(scene, [1, 0.72, 0.3], { emissive: true });
  const ring = MeshBuilder.CreateTorus("shockwave", { diameter: 2, thickness: 0.18, tessellation: 28 }, scene);
  ring.scaling.y = 0.3;
  ring.bakeCurrentTransformIntoVertices();
  ring.material = mat(scene, [1, 0.86, 0.6], { emissive: true });
  const scorch = MeshBuilder.CreateDisc("scorch", { radius: 1, tessellation: 10 }, scene);
  scorch.rotation.x = Math.PI / 2;
  scorch.bakeCurrentTransformIntoVertices();
  const sm = new StandardMaterial("scorchMat", scene);
  sm.diffuseColor = new Color3(0.27, 0.22, 0.17);
  sm.specularColor = Color3.Black();
  sm.zOffset = -6;
  // every mark is its own mesh draped over the ground, fading out through its visibility
  sm.transparencyMode = Material.MATERIAL_ALPHABLEND;
  sm.disableDepthWrite = true;
  scorch.material = sm;
  for (const m of [flash, core, smoke, darkSmoke, dust, debris, spark, ring, scorch]) {
    m.isPickable = false;
    m.isVisible = false;
  }
  return { flash, core, smoke, darkSmoke, dust, debris, spark, ring, scorch };
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
