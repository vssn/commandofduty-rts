import {
  Color3, Constants, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, TransformNode, Vector3, type InstancedMesh, type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
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

/** Additive, unlit material that glows in `color`, shaped by the round glow texture. */
function glowMaterial(scene: Scene, name: string, color: RGB, alpha: number, shaped = true): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = new Color3(color[0], color[1], color[2]);
  if (shaped) m.opacityTexture = glowTexture(scene);
  m.alpha = alpha;
  m.alphaMode = Constants.ALPHA_ADD;
  m.disableDepthWrite = true;
  m.backFaceCulling = false;
  m.fogEnabled = false;
  return m;
}

/** Square patch of `r` around (0, 0) whose vertices can be draped over the terrain. */
function patch(scene: Scene, name: string, r: number): Mesh {
  const m = MeshBuilder.CreateGround(name, { width: r * 2, height: r * 2, subdivisions: 10, updatable: true }, scene);
  m.isPickable = false;
  return m;
}

/** Moves a patch to (x, z) and drapes it over the ground (baked, the mesh itself stays at the origin). */
function drape(m: Mesh, base: Float32Array | number[], terrain: Terrain, x: number, z: number) {
  const pos = Float32Array.from(base);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] += x;
    pos[i + 2] += z;
    pos[i + 1] = terrain.heightAt(pos[i], pos[i + 2]) + 0.12;
  }
  m.updateVerticesData("position", pos);
  m.refreshBoundingInfo(); // otherwise it is culled at its old place
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
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** Ground point the beam currently falls on. */
  tx = 0;
  tz = 0;
  private readonly lamp: TransformNode;
  private readonly stand: TransformNode;
  private readonly beam: Mesh;
  private readonly pool: Mesh;
  private readonly poolBase: Float32Array;
  private readonly target = new Vector3();
  private static readonly HEAD = 2.3;

  constructor(scene: Scene, private readonly terrain: Terrain, shadows: ShadowGenerator, x: number, z: number, readonly radius: number) {
    this.x = x;
    this.z = z;
    this.y = terrain.heightAt(x, z);
    const metal: RGB = [0.2, 0.21, 0.2];
    const stand = new TransformNode("searchlight", scene);
    this.stand = stand;
    stand.position.set(x, this.y, z);
    for (const a of [0, 2.1, -2.1]) {
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
    const glass = MeshBuilder.CreateDisc("slGlass", { radius: 0.35, tessellation: 14 }, scene);
    glass.position.z = 0.41;
    glass.rotation.y = Math.PI;
    const gm = new StandardMaterial("slGlassMat", scene);
    gm.emissiveColor = new Color3(0.95, 0.97, 1);
    gm.disableLighting = true;
    glass.material = gm;
    glass.parent = this.lamp;

    // beam: cone from the lamp (narrow end at the origin) along +z, length scaled per frame
    this.beam = MeshBuilder.CreateCylinder("slBeam", { height: 1, diameterTop: 0.6, diameterBottom: radius * 1.7, tessellation: 18, cap: Mesh.NO_CAP }, scene);
    this.beam.position.y = -0.5;
    this.beam.bakeCurrentTransformIntoVertices();
    this.beam.rotation.x = -Math.PI / 2;
    this.beam.bakeCurrentTransformIntoVertices();
    this.beam.material = glowMaterial(scene, "slBeamMat", [0.75, 0.82, 1], 0.1, false);
    this.beam.parent = this.lamp;
    this.beam.isPickable = false;
    for (const m of [housing, glass]) m.isPickable = false;

    this.pool = patch(scene, "slPool", radius * 1.3);
    this.pool.material = glowMaterial(scene, "slPoolMat", [0.85, 0.9, 1], 0.85);
    this.poolBase = Float32Array.from(this.pool.getVerticesData("position")!);
  }

  dispose() {
    this.stand.dispose();
    this.lamp.dispose();
    this.pool.dispose();
  }

  /** Switched off (its outpost was blown up): the lamp stays, beam and light go. */
  setEnabled(on: boolean) {
    this.beam.setEnabled(on);
    this.pool.setEnabled(on);
  }

  aim(tx: number, tz: number) {
    this.tx = tx;
    this.tz = tz;
    const ty = this.terrain.heightAt(tx, tz);
    this.target.set(tx, ty, tz);
    this.lamp.lookAt(this.target);
    const len = Math.hypot(tx - this.x, ty - (this.y + Searchlight.HEAD), tz - this.z);
    this.beam.scaling.set(1, 1, len);
    drape(this.pool, this.poolBase, this.terrain, tx, tz);
  }
}
