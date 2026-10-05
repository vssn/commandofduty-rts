import { Axis, Matrix, Mesh, MeshBuilder, Quaternion, Scene, ShadowGenerator, Vector3 } from "@babylonjs/core";
import { MAP_HALF, TERRAIN_HALF } from "../config";
import type { NavGrid } from "../game/nav";
import { rng, valueNoise } from "../util/noise";
import { HOUSE_BODY, HOUSE_ROOF, toLocal, toWorld, type MapLayout, type RGB } from "./layout";
import { brickBox, brickFaceUV, brickMaterial, createRoofTiles, type RoofSpec } from "./masonry";
import { createGable, mat, ROOF_ROUGH } from "./models";
import type { RealisticTrees } from "./floraPbr";
import type { Terrain } from "./terrain";

export interface TreeInfo { x: number; z: number; conifer: boolean; color: RGB }

const CANOPY: RGB[] = [
  [0.92, 0.5, 0.12], // orange
  [0.78, 0.22, 0.1], // red
  [0.94, 0.75, 0.2], // yellow
  [0.62, 0.36, 0.14], // brown
  [0.46, 0.52, 0.18], // late green
];
const CONIFER: RGB = [0.16, 0.3, 0.17];

/** Collects matrices per template and turns them into thin instances. */
class InstanceBatch {
  private readonly data: number[] = [];
  constructor(readonly mesh: Mesh) {}
  add(m: Matrix) { this.data.push(...m.asArray()); }
  finish(shadows: ShadowGenerator) {
    if (!this.data.length) { this.mesh.dispose(); return; }
    this.mesh.thinInstanceSetBuffer("matrix", new Float32Array(this.data), 16, true);
    this.mesh.thinInstanceRefreshBoundingInfo(false);
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = true;
    this.mesh.freezeWorldMatrix();
    shadows.addShadowCaster(this.mesh);
  }
}

export function createHouses(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid) {
  // unit box with brick UVs sized for an average house (instances are scaled per house)
  const bodyTpl = MeshBuilder.CreateBox("houseBody", { size: 1, faceUV: brickFaceUV(5.2, 3.3, 5.0), wrap: true }, scene);
  bodyTpl.position.y = 0.5;
  bodyTpl.bakeCurrentTransformIntoVertices();
  const roofTpl = createGable("houseRoof", scene);
  const chimTpl = MeshBuilder.CreateBox("chimney", { width: 0.55, height: 1.4, depth: 0.55 }, scene);
  chimTpl.material = brickMaterial(scene, [0.6, 0.32, 0.25]);

  const bodies = HOUSE_BODY.map((c, i) => {
    const m = bodyTpl.clone(`houseBody${i}`);
    m.makeGeometryUnique(); // thin instance buffers live on the geometry
    m.material = brickMaterial(scene, c);
    return new InstanceBatch(m);
  });
  const roofs = HOUSE_ROOF.map((c, i) => {
    const m = roofTpl.clone(`houseRoof${i}`);
    m.makeGeometryUnique();
    m.material = mat(scene, c, { twoSided: true, rough: ROOF_ROUGH });
    return new InstanceBatch(m);
  });
  const chimneys = new InstanceBatch(chimTpl);
  // foundations: a low concrete plinth under every house, a little wider than its walls, from below the
  // lowest corner up to a hand's breadth above the highest - so the house stands on something
  // instead of sitting in the grass, also on a slope
  const plinthTpl = MeshBuilder.CreateBox("houseFoundation", { size: 1 }, scene);
  plinthTpl.position.y = 0.5;
  plinthTpl.bakeCurrentTransformIntoVertices();
  plinthTpl.material = mat(scene, [0.55, 0.53, 0.49], { surface: "concrete" });
  const plinths = new InstanceBatch(plinthTpl);
  const churchParts: Mesh[] = [];
  const tiles: RoofSpec[] = [];

  for (const h of layout.houses) {
    let minY = Infinity, maxY = -Infinity;
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      const p = toWorld(h.x, h.z, h.rot, (lx * h.w) / 2, (lz * h.d) / 2);
      const gy = terrain.heightAt(p.x, p.z);
      minY = Math.min(minY, gy);
      maxY = Math.max(maxY, gy);
    }
    const y = minY - 0.3;
    const q = Quaternion.RotationAxis(Axis.Y, h.rot);
    const plinthBase = minY - 0.5, plinthH = maxY + 0.32 - plinthBase;
    plinths.add(Matrix.Compose(new Vector3(h.w + 0.26, plinthH, h.d + 0.26), q, new Vector3(h.x, plinthBase, h.z)));
    nav.blockRect(h.x, h.z, h.w / 2, h.d / 2, h.rot);

    if (h.church) {
      const body = brickBox(scene, "church", h.w, h.h + 0.3, h.d, [0.8, 0.76, 0.68]);
      body.position.set(h.x, y + (h.h + 0.3) / 2, h.z);
      body.rotation.y = h.rot;
      const roof = createGable("churchRoof", scene);
      roof.scaling.set(h.w * 1.08, h.roofH, h.d * 1.04);
      roof.position.set(h.x, y + h.h + 0.3, h.z);
      roof.rotation.y = h.rot;
      roof.material = mat(scene, [0.3, 0.32, 0.36], { twoSided: true, rough: ROOF_ROUGH });
      tiles.push({ w: h.w * 1.08, h: h.roofH, d: h.d * 1.04, color: [0.32, 0.34, 0.38], transform: Matrix.Compose(Vector3.One(), q, new Vector3(h.x, y + h.h + 0.3, h.z)) });
      const tp = toWorld(h.x, h.z, h.rot, 0, h.d / 2 + 1.6);
      const tower = brickBox(scene, "tower", 3.4, 12, 3.4, [0.8, 0.76, 0.68]);
      tower.position.set(tp.x, y + 6, tp.z);
      tower.rotation.y = h.rot;
      const spire = MeshBuilder.CreateCylinder("spire", { height: 6, diameterTop: 0, diameterBottom: 4.4, tessellation: 4 }, scene);
      spire.position.set(tp.x, y + 15, tp.z);
      spire.rotation.y = h.rot + Math.PI / 4;
      spire.material = mat(scene, [0.24, 0.4, 0.36]);
      plinths.add(Matrix.Compose(new Vector3(3.7, plinthH, 3.7), q, new Vector3(tp.x, plinthBase, tp.z)));
      nav.blockRect(tp.x, tp.z, 1.7, 1.7, h.rot);
      churchParts.push(body, roof, tower, spire);
      continue;
    }

    const wall = h.h;
    bodies[h.body].add(Matrix.Compose(new Vector3(h.w, wall + 0.3, h.d), q, new Vector3(h.x, y, h.z)));
    roofs[h.roof].add(Matrix.Compose(new Vector3(h.w * 1.12, h.roofH, h.d * 1.08), q, new Vector3(h.x, y + wall + 0.3, h.z)));
    tiles.push({ w: h.w * 1.12, h: h.roofH, d: h.d * 1.08, color: HOUSE_ROOF[h.roof], transform: Matrix.Compose(Vector3.One(), q, new Vector3(h.x, y + wall + 0.3, h.z)) });
    const cp = toWorld(h.x, h.z, h.rot, h.w * 0.22, h.d * 0.2);
    chimneys.add(Matrix.Compose(Vector3.One(), q, new Vector3(cp.x, y + wall + 0.3 + h.roofH * 0.55, cp.z)));
  }

  const tileMesh = createRoofTiles(scene, "houseTiles", tiles);
  tileMesh.freezeWorldMatrix();
  shadows.addShadowCaster(tileMesh);
  bodies.forEach((b) => b.finish(shadows));
  roofs.forEach((b) => b.finish(shadows));
  chimneys.finish(shadows);
  plinths.finish(shadows);
  bodyTpl.setEnabled(false);
  roofTpl.setEnabled(false);
  for (const p of churchParts) {
    p.receiveShadows = true;
    p.isPickable = false;
    shadows.addShadowCaster(p);
  }
}

export function createVegetation(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, realistic?: RealisticTrees): TreeInfo[] {
  const r = rng(99);
  const trunkTpl = MeshBuilder.CreateCylinder("trunk", { height: 2.4, diameterTop: 0.22, diameterBottom: 0.38, tessellation: 5 }, scene);
  trunkTpl.position.y = 1.2;
  trunkTpl.bakeCurrentTransformIntoVertices();
  trunkTpl.material = mat(scene, [0.33, 0.24, 0.16]);
  const trunks = new InstanceBatch(trunkTpl);

  const canopies = CANOPY.map((c, i) => {
    const m = MeshBuilder.CreateIcoSphere(`canopy${i}`, { radius: 1.7, subdivisions: 1, flat: true }, scene);
    m.scaling.set(1, 1.15, 1);
    m.position.y = 3.5;
    m.bakeCurrentTransformIntoVertices();
    m.material = mat(scene, c);
    return new InstanceBatch(m);
  });

  const cone1 = MeshBuilder.CreateCylinder("c1", { height: 4.4, diameterTop: 0, diameterBottom: 3.2, tessellation: 6 }, scene);
  cone1.position.y = 3.4;
  const cone2 = MeshBuilder.CreateCylinder("c2", { height: 3.2, diameterTop: 0, diameterBottom: 2.3, tessellation: 6 }, scene);
  cone2.position.y = 5.6;
  const coniferMesh = Mesh.MergeMeshes([cone1, cone2], true)!;
  coniferMesh.convertToFlatShadedMesh();
  coniferMesh.material = mat(scene, CONIFER);
  const conifers = new InstanceBatch(coniferMesh);

  const trees: TreeInfo[] = [];
  const free = (x: number, z: number, housePad = 1.8) =>
    !layout.fieldAt(x, z) &&
    layout.nearestRoad(x, z).d > 1.6 &&
    !layout.nearBase(x, z, 24) &&
    !layout.nearOutpost(x, z, 1.5) &&
    !layout.houseAt(x, z, housePad);

  const place = (x: number, z: number, conifer: boolean) => {
    const s = 0.8 + r() * 0.5;
    const q = Quaternion.RotationAxis(Axis.Y, r() * Math.PI * 2);
    const m = Matrix.Compose(new Vector3(s, s * (0.9 + r() * 0.25), s), q, new Vector3(x, terrain.heightAt(x, z) - 0.15, z));
    trunks.add(m);
    if (conifer) {
      conifers.add(m);
      trees.push({ x, z, conifer, color: CONIFER });
      realistic?.add(m, true, CONIFER);
    } else {
      const ci = Math.floor(r() * CANOPY.length);
      canopies[ci].add(m);
      trees.push({ x, z, conifer, color: CANOPY[ci] });
      realistic?.add(m, false, CANOPY[ci]);
    }
  };

  for (const f of layout.forests) {
    const count = Math.round(f.r * f.r * 0.34);
    for (let k = 0; k < count; k++) {
      const a = r() * Math.PI * 2, d = f.r * Math.sqrt(r());
      const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
      if (free(x, z)) place(x, z, r() < f.conifer);
    }
  }

  // lone trees and small copses in the open country
  for (let k = 0; k < 140; k++) {
    const x = (r() * 2 - 1) * (MAP_HALF - 4), z = (r() * 2 - 1) * (MAP_HALF - 4);
    if (layout.suburbs.some((s) => Math.hypot(x - s.x, z - s.z) < s.r - 6)) continue;
    if (free(x, z)) place(x, z, r() < 0.2);
  }

  // garden trees in the suburbs
  for (const s of layout.suburbs) {
    for (let k = 0; k < 40; k++) {
      const a = r() * Math.PI * 2, d = (s.r - 4) * Math.sqrt(r());
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      if (free(x, z, 2.2) && layout.nearestRoad(x, z).d > 2.2) place(x, z, r() < 0.15);
    }
  }

  // single trees in the gaps between the houses: well clear of the walls (the crown is wide), the streets
  // and each other - an accent, not a wood
  const wallDistance = (x: number, z: number) => {
    let best = Infinity;
    for (const h of layout.houses) {
      if (Math.abs(x - h.x) > 14 || Math.abs(z - h.z) > 14) continue;
      const l = toLocal(h.x, h.z, h.rot, x, z);
      best = Math.min(best, Math.hypot(Math.max(Math.abs(l.x) - h.w / 2, 0), Math.max(Math.abs(l.z) - h.d / 2, 0)));
    }
    return best;
  };
  for (const s of layout.suburbs) {
    let added = 0;
    for (let k = 0; k < 400 && added < 9; k++) {
      const a = r() * Math.PI * 2, d = (s.r - 5) * Math.sqrt(r());
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      const gap = wallDistance(x, z);
      if (gap < 3.4 || gap > 9) continue;
      if (!free(x, z, 3.4) || layout.nearestRoad(x, z).d < 3) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 7)) continue;
      place(x, z, r() < 0.08);
      added++;
    }
  }

  // beyond the map: firs on the lower mountain slopes and scattered deep down in the abyss
  // (they show how far it goes down); nothing on the sheer faces
  for (let k = 0; k < 2600; k++) {
    const x = (r() * 2 - 1) * (TERRAIN_HALF - 3), z = (r() * 2 - 1) * (TERRAIN_HALF - 3);
    const e = Math.max(Math.abs(x), Math.abs(z));
    if (e < MAP_HALF + 3) continue;
    const h = terrain.heightAt(x, z);
    const slope = Math.hypot(terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;
    if (slope > 0.55 || (h > 34 && z > MAP_HALF)) continue; // not on the snowy mountain tops
    if (valueNoise(x * 0.04, z * 0.04, 21) < (h < -30 ? 0.2 : -0.15)) continue;
    place(x, z, true);
  }

  trunks.finish(shadows);
  canopies.forEach((c) => c.finish(shadows));
  conifers.finish(shadows);
  realistic?.classic.push(trunks.mesh, ...canopies.map((c) => c.mesh), conifers.mesh);
  return trees;
}
