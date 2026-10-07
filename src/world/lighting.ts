import {
  Color3, Constants, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, TransformNode, Vector3, VertexData, type InstancedMesh, type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import { smoothstep } from "../util/noise";
import type { NavGrid } from "../game/nav";
import type { MapLayout, RGB } from "./layout";
import { mat } from "./models";
import type { Terrain } from "./terrain";

/*
 * Night lights are faked instead of using real light sources (a material only takes a handful of
 * lights): additive glow textures on patches that follow the terrain, halos around the lamps and
 * translucent beams. Cheap, and it reads well from the RTS camera.
 */

const glowTex = new Map<string, DynamicTexture>();

/** Soft round glow (white, alpha falls off from the centre). */
function glowTexture(scene: Scene): DynamicTexture {
  let t = glowTex.get(scene.uid);
  if (!t) {
    const size = 128;
    t = new DynamicTexture("glow", { width: size, height: size }, scene, true, Texture.BILINEAR_SAMPLINGMODE);
    const ctx = t.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.75)");
    g.addColorStop(0.7, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    t.hasAlpha = true;
    t.update(false);
    glowTex.set(scene.uid, t);
  }
  return t;
}

const ringTex = new Map<string, DynamicTexture>();

/**
 * Lit spot with a crisp rim: a faint, fading fill and a bright, sharp edge at 0.77 of the radius
 * (that is the lamp's `radius` on a patch of `radius * 1.3`), falling off to nothing just outside it.
 */
function ringTexture(scene: Scene): DynamicTexture {
  let t = ringTex.get(scene.uid);
  if (!t) {
    const size = 256;
    t = new DynamicTexture("lightRing", { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const ctx = t.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.10)");
    g.addColorStop(0.6, "rgba(255,255,255,0.18)");
    g.addColorStop(0.73, "rgba(255,255,255,0.45)");
    g.addColorStop(0.765, "rgba(255,255,255,1)"); // the rim
    g.addColorStop(0.79, "rgba(255,255,255,0.35)");
    g.addColorStop(0.83, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    t.hasAlpha = true;
    t.update(false);
    ringTex.set(scene.uid, t);
  }
  return t;
}

/** Additive, unlit material that glows in `color`, shaped by the round glow texture. */
export function glowMaterial(scene: Scene, name: string, color: RGB, alpha: number, shaped: boolean | Texture = true): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = new Color3(color[0], color[1], color[2]);
  if (shaped) m.opacityTexture = shaped === true ? glowTexture(scene) : shaped;
  m.alpha = alpha;
  m.alphaMode = Constants.ALPHA_ADD;
  m.disableDepthWrite = true;
  m.backFaceCulling = false;
  m.fogEnabled = false;
  return m;
}

/** Square patch of `r` around (0, 0) whose vertices can be draped over the terrain. */
function patch(scene: Scene, name: string, r: number): Mesh {
  // fine enough to follow slopes closely
  const m = MeshBuilder.CreateGround(name, { width: r * 2, height: r * 2, subdivisions: 16, updatable: true }, scene);
  m.isPickable = false;
  // light is drawn after the (also see-through) farm tracks, so a track never cuts through it
  m.alphaIndex = 10;
  return m;
}

/** Moves a patch to (x, z) and drapes it over the ground (baked, the mesh itself stays at the origin). */
function drape(m: Mesh, base: Float32Array | number[], terrain: Terrain, x: number, z: number) {
  const pos = Float32Array.from(base);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] += x;
    pos[i + 2] += z;
    pos[i + 1] = terrain.heightAt(pos[i], pos[i + 2]) + 0.2;
  }
  m.updateVerticesData("position", pos);
  m.refreshBoundingInfo(); // otherwise it is culled at its old place
}

/** Stretch of the searchlight's lit spot (in units of its radius): its wide end, its tip (the end towards the lamp) and how narrow that tip is. */
const EGG = { near: 1.3, far: 1.1, tip: 0.42 };
const EGG_SECTORS = 44, EGG_RINGS = 12;
/** How much darker the spot gets towards its wide end (0 = not at all). */
const EGG_DARK = 0.8;
/** Ratio between the texture's edge and the rim of the spot (the ring texture's bright rim lies at 0.77). */
const EGG_REACH = 1 / 0.77;

/** Lateral scale of the lit spot at distance u (in radii) along its axis: wide near the lamp, narrowing to a tip. */
function eggWidth(u: number, round = false): number {
  if (round) return 1;
  // (the power makes the sides bulge: the full width is reached early, then it rounds off into the tip)
  return EGG.tip + (1 - EGG.tip) * Math.pow(smoothstep(-1.1, 0.45, u), 0.62);
}

/**
 * Where a point (u, v) - along and across the axis from the spot's centre towards the lamp, in radii -
 * lies in the spot: 1 is its edge, less is inside. Drawn and detection use the same shape.
 */
function eggRho(u: number, v: number, round = false): number {
  const a = round ? u : u / (u > 0 ? EGG.near : EGG.far);
  const b = v / eggWidth(u, round);
  return Math.hypot(a, b);
}

/**
 * A polar mesh (centre, rings, sectors) with radial texture coordinates: the radial glow and rim textures
 * then follow the shape of the spot, which is not a circle. Its vertices are placed by `placeEgg`.
 */
function eggMesh(scene: Scene, name: string): Mesh {
  const pos: number[] = [0, 0, 0], uv: number[] = [0.5, 0.5], idx: number[] = [];
  for (let i = 1; i <= EGG_RINGS; i++) {
    for (let j = 0; j < EGG_SECTORS; j++) {
      const th = (j / EGG_SECTORS) * Math.PI * 2, f = i / EGG_RINGS;
      pos.push(0, 0, 0);
      uv.push(0.5 + 0.5 * f * Math.cos(th), 0.5 + 0.5 * f * Math.sin(th));
    }
  }
  const at = (i: number, j: number) => 1 + (i - 1) * EGG_SECTORS + (j % EGG_SECTORS);
  for (let j = 0; j < EGG_SECTORS; j++) idx.push(0, at(1, j + 1), at(1, j));
  for (let i = 1; i < EGG_RINGS; i++) {
    for (let j = 0; j < EGG_SECTORS; j++) idx.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
  }
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.uvs = uv;
  vd.indices = idx;
  vd.normals = pos.map((_, k) => (k % 3 === 1 ? 1 : 0));
  vd.colors = new Array((pos.length / 3) * 4).fill(1);
  vd.applyToMesh(m, true);
  m.hasVertexAlpha = true; // (the spot is a little darker towards its wide end, see placeEgg)
  m.isPickable = false;
  m.alphaIndex = 10;
  return m;
}

/** Lays the spot at (cx, cz) over the ground: its wide end towards (dirX, dirZ), the direction away from the lamp. */
function placeEgg(m: Mesh, terrain: Terrain, cx: number, cz: number, dirX: number, dirZ: number, radius: number, round = false) {
  const pos = m.getVerticesData("position")!;
  const col = m.getVerticesData("color")!;
  const px = -dirZ, pz = dirX;
  let k = 3;
  let c = 4;
  for (let i = 1; i <= EGG_RINGS; i++) {
    const rho = (i / EGG_RINGS) * EGG_REACH;
    for (let j = 0; j < EGG_SECTORS; j++) {
      const th = (j / EGG_SECTORS) * Math.PI * 2;
      const a = rho * Math.cos(th), b = rho * Math.sin(th);
      const u = round ? a : a * (a > 0 ? EGG.near : EGG.far);
      const v = b * eggWidth(u, round);
      const x = cx + (dirX * u + px * v) * radius, z = cz + (dirZ * u + pz * v) * radius;
      pos[k] = x;
      pos[k + 1] = terrain.heightAt(x, z) + 0.2;
      pos[k + 2] = z;
      k += 3;
      // brightest at the tip (towards the lamp), a little darker out to the wide end
      col[c + 3] = round ? 1 : 1 - EGG_DARK * smoothstep(-0.9, 1.2, u);
      c += 4;
    }
  }
  pos[0] = cx; pos[1] = terrain.heightAt(cx, cz) + 0.2; pos[2] = cz;
  col[3] = round ? 1 : 1 - EGG_DARK * smoothstep(-0.9, 1.2, 0);
  m.updateVerticesData("position", pos);
  m.updateVerticesData("color", col);
  m.refreshBoundingInfo();
}

/** A soft glow on the ground at (x, z) (e.g. the screen light around a drone pilot). */
export function createGlowSpot(scene: Scene, terrain: Terrain, x: number, z: number, r: number, color: RGB, alpha: number): Mesh {
  const m = patch(scene, "glowSpot", r);
  drape(m, m.getVerticesData("position")!, terrain, x, z);
  m.material = glowMaterial(scene, "glowSpotMat", color, alpha);
  return m;
}

export interface StreetLights {
  /** Lit spots on the ground (the agent is easy to see in them). */
  readonly pools: { x: number; z: number; r: number }[];
  setOn(on: boolean): void;
}

/** Lamp posts along the village streets; dark by day, switched on for the night mission. */
export function createStreetLights(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid): StreetLights {
  const parts: Mesh[] = [];
  const iron: RGB = [0.16, 0.19, 0.17];
  const pole = MeshBuilder.CreateCylinder("lampPole", { height: 4.6, diameterTop: 0.1, diameterBottom: 0.18, tessellation: 8 }, scene);
  pole.position.y = 2.3;
  pole.material = mat(scene, iron);
  const foot = MeshBuilder.CreateCylinder("lampFoot", { height: 0.5, diameter: 0.3, tessellation: 8 }, scene);
  foot.position.y = 0.25;
  foot.material = mat(scene, iron);
  const arm = MeshBuilder.CreateBox("lampArm", { width: 0.07, height: 0.07, depth: 1.5 }, scene);
  arm.position.set(0, 4.5, 0.72);
  arm.material = mat(scene, iron);
  const head = MeshBuilder.CreateCylinder("lampHead", { height: 0.25, diameterTop: 0.12, diameterBottom: 0.6, tessellation: 10 }, scene);
  head.position.set(0, 4.42, 1.45);
  head.material = mat(scene, iron);
  const glassMat = new StandardMaterial("lampGlass", scene);
  glassMat.diffuseColor = new Color3(0.55, 0.52, 0.42);
  glassMat.specularColor = Color3.Black();
  const glass = MeshBuilder.CreateCylinder("lampGlass", { height: 0.12, diameter: 0.46, tessellation: 10 }, scene);
  glass.position.set(0, 4.26, 1.45);
  glass.material = glassMat;
  parts.push(pole, foot, arm, head, glass);
  const tpl = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  tpl.name = "streetLamp";
  tpl.isPickable = false;
  tpl.isVisible = false;
  shadows.addShadowCaster(tpl);

  const haloMat = glowMaterial(scene, "lampHalo", [1, 0.8, 0.5], 0.9);
  const haloTpl = MeshBuilder.CreatePlane("lampHaloTpl", { size: 2.2 }, scene);
  haloTpl.material = haloMat;
  haloTpl.billboardMode = Mesh.BILLBOARDMODE_ALL;
  haloTpl.isPickable = false;
  haloTpl.isVisible = false;

  const pools: { x: number; z: number; r: number }[] = [];
  const poolMeshes: Mesh[] = [];
  const halos: InstancedMesh[] = [];
  for (const l of layout.streetLights) {
    const y = terrain.heightAt(l.x, l.z);
    const inst = tpl.createInstance("lamp");
    inst.position.set(l.x, y, l.z);
    inst.rotation.y = l.rot;
    inst.isPickable = false;
    inst.freezeWorldMatrix();
    nav.blockCircle(l.x, l.z, 0.15);
    const hx = l.x + Math.sin(l.rot) * 1.45, hz = l.z + Math.cos(l.rot) * 1.45;
    const halo = haloTpl.createInstance("halo");
    halo.position.set(hx, y + 4.15, hz);
    halo.setEnabled(false);
    halos.push(halo);
    const r = 6;
    const p = patch(scene, "lampPool", r);
    drape(p, p.getVerticesData("position")!, terrain, hx, hz);
    poolMeshes.push(p);
    pools.push({ x: hx, z: hz, r: r * 0.75 });
  }
  const poolMesh = poolMeshes.length ? Mesh.MergeMeshes(poolMeshes, true, true)! : null;
  if (poolMesh) {
    poolMesh.name = "lampPools";
    poolMesh.material = glowMaterial(scene, "lampPool", [1, 0.78, 0.45], 0.42);
    poolMesh.isPickable = false;
    poolMesh.alphaIndex = 10;
    poolMesh.setEnabled(false);
  }

  return {
    pools,
    setOn(on: boolean) {
      glassMat.emissiveColor = on ? new Color3(1, 0.86, 0.55) : Color3.Black();
      poolMesh?.setEnabled(on);
      for (const h of halos) h.setEnabled(on);
    },
  };
}

/**
 * Standing searchlight on a tripod. `aim` turns the lamp and its beam onto a ground point; the lit
 * spot follows the ground there.
 */
export class Searchlight {
  /** Ground position of the lamp (a drone's light moves along, see moveTo). */
  x: number;
  z: number;
  y: number;
  /** Ground point the beam currently falls on. */
  tx = 0;
  tz = 0;
  private readonly lamp: TransformNode;
  private readonly stand: TransformNode;
  private readonly beam: Mesh;
  private readonly pool: Mesh;
  /** Unit vector from the lamp across the lit spot (its wide end points that way, its tip towards the lamp). */
  private dirX = 1;
  private dirZ = 0;
  private readonly edge: Mesh;
  private readonly target = new Vector3();
  private static readonly HEAD = 2.3;

  /**
   * `mounted`: no tripod and no housing (the light hangs under a drone, which brings its own lamp).
   * `tint`: colours and strengths of beam and lit spot (default: a cold white searchlight).
   */
  constructor(
    scene: Scene,
    private readonly terrain: Terrain,
    shadows: ShadowGenerator,
    x: number,
    z: number,
    readonly radius: number,
    private readonly mounted = false,
    tint: { beam: RGB; beamAlpha: number; pool: RGB; poolAlpha: number } = { beam: [0.75, 0.82, 1], beamAlpha: 0.1, pool: [0.85, 0.9, 1], poolAlpha: 0.85 },
  ) {
    this.x = x;
    this.z = z;
    this.y = terrain.heightAt(x, z);
    const metal: RGB = [0.2, 0.21, 0.2];
    const stand = new TransformNode("searchlight", scene);
    this.stand = stand;
    stand.position.set(x, this.y, z);
    for (const a of mounted ? [] : [0, 2.1, -2.1]) {
      const leg = MeshBuilder.CreateBox("slLeg", { width: 0.08, height: 2.3, depth: 0.08 }, scene);
      leg.position.set(Math.sin(a) * 0.45, 1.1, Math.cos(a) * 0.45);
      leg.rotation.set(-Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2);
      leg.material = mat(scene, metal);
      leg.parent = stand;
      shadows.addShadowCaster(leg);
    }
    this.lamp = new TransformNode("slLamp", scene);
    this.lamp.position.set(x, this.y + Searchlight.HEAD, z);
    const housing = MeshBuilder.CreateCylinder("slHousing", { height: 0.8, diameterTop: 0.75, diameterBottom: 0.6, tessellation: 14 }, scene);
    housing.rotation.x = Math.PI / 2;
    housing.material = mat(scene, [0.3, 0.33, 0.28]);
    housing.parent = this.lamp;
    shadows.addShadowCaster(housing);
    housing.setEnabled(!mounted);
    const glass = MeshBuilder.CreateDisc("slGlass", { radius: 0.35, tessellation: 14 }, scene);
    glass.position.z = 0.41;
    glass.rotation.y = Math.PI;
    const gm = new StandardMaterial("slGlassMat", scene);
    gm.emissiveColor = new Color3(0.95, 0.97, 1);
    gm.disableLighting = true;
    glass.material = gm;
    glass.parent = this.lamp;
    glass.setEnabled(!mounted);

    // beam: cone from the lamp (narrow end at the origin) along +z, length scaled per frame
    this.beam = MeshBuilder.CreateCylinder("slBeam", { height: 1, diameterTop: 0.6, diameterBottom: radius * 1.7, tessellation: 18, cap: Mesh.NO_CAP, subdivisions: 8 }, scene);
    this.beam.position.y = -0.5;
    this.beam.bakeCurrentTransformIntoVertices();
    this.beam.rotation.x = -Math.PI / 2;
    this.beam.bakeCurrentTransformIntoVertices();
    // the beam fades out towards its far end (z = 0 at the lamp, 1 at the ground)
    const bp = this.beam.getVerticesData("position")!;
    const bc: number[] = [];
    for (let i = 0; i < bp.length; i += 3) {
      const k = Math.min(1, Math.max(0, bp[i + 2]));
      bc.push(1, 1, 1, Math.pow(1 - k, 1.4));
    }
    this.beam.setVerticesData("color", bc);
    this.beam.hasVertexAlpha = true;
    this.beam.material = glowMaterial(scene, "slBeamMat", tint.beam, tint.beamAlpha, false);
    this.beam.alphaIndex = 11;
    this.beam.parent = this.lamp;
    this.beam.isPickable = false;
    for (const m of [housing, glass]) m.isPickable = false;

    // the lit spot is not round: a cone-shaped egg, wide towards the lamp and running out into a tip
    // (the soft glow fades out to its edge), with the bright rim along its outline
    this.pool = eggMesh(scene, "slPool");
    this.pool.material = glowMaterial(scene, "slPoolMat", tint.pool, tint.poolAlpha);
    // the crisp rim of the lit spot, projected onto the ground
    this.edge = eggMesh(scene, "slEdge");
    this.edge.material = glowMaterial(scene, "slEdgeMat", tint.pool, Math.min(1, tint.poolAlpha + 0.1), ringTexture(scene));
    this.edge.alphaIndex = 11;
  }

  dispose() {
    this.stand.dispose();
    this.lamp.dispose();
    this.pool.dispose();
    this.edge.dispose();
  }

  /** Switched off (its outpost was blown up): the lamp stays, beam and light go. */
  setEnabled(on: boolean) {
    this.beam.setEnabled(on);
    this.pool.setEnabled(on);
    this.edge.setEnabled(on);
  }

  /** Moves a mounted light's source (the lamp itself) to a point in the air. */
  moveTo(x: number, y: number, z: number) {
    this.x = x;
    this.z = z;
    this.y = y - Searchlight.HEAD;
    this.lamp.position.set(x, y, z);
  }

  /** Whether (x, z) is inside the lit spot (the same cone-shaped egg that is drawn). */
  contains(x: number, z: number): boolean {
    const dx = x - this.tx, dz = z - this.tz;
    const u = (dx * this.dirX + dz * this.dirZ) / this.radius;
    const v = (-dx * this.dirZ + dz * this.dirX) / this.radius;
    return eggRho(u, v, this.mounted) < 1;
  }

  aim(tx: number, tz: number) {
    this.tx = tx;
    this.tz = tz;
    const ty = this.terrain.heightAt(tx, tz);
    this.target.set(tx, ty, tz);
    this.lamp.lookAt(this.target);
    const lp = this.lamp.position;
    const len = Math.hypot(tx - lp.x, ty - lp.y, tz - lp.z);
    this.beam.scaling.set(1, 1, len);
    const dx = lp.x - tx, dz = lp.z - tz, dl = Math.hypot(dx, dz);
    if (dl > 0.5) {
      // the wide end faces away from the lamp (it lies far out), the tip runs towards the lamp
      this.dirX = -dx / dl;
      this.dirZ = -dz / dl;
    }
    placeEgg(this.pool, this.terrain, tx, tz, this.dirX, this.dirZ, this.radius, this.mounted);
    placeEgg(this.edge, this.terrain, tx, tz, this.dirX, this.dirZ, this.radius, this.mounted);
  }
}
