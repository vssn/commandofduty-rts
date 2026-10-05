import { Axis, Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { rng } from "../util/noise";
import { toLocal, type MapLayout } from "./layout";
import { tussockMesh } from "./meadows";
import type { Obstacle } from "./props";
import type { Terrain } from "./terrain";

/** Distance from (x, z) to the outline of the nearest house (0 inside), only looking at houses within `max`. */
function houseDistance(layout: MapLayout, x: number, z: number, max: number): number {
  let best = max;
  for (const h of layout.houses) {
    if (Math.abs(x - h.x) > max + 10 || Math.abs(z - h.z) > max + 10) continue;
    const l = toLocal(h.x, h.z, h.rot, x, z);
    const dx = Math.max(Math.abs(l.x) - h.w / 2, 0), dz = Math.max(Math.abs(l.z) - h.d / 2, 0);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/**
 * The villages look as if they had been left in a hurry: here and there rubbish on the streets and
 * in the front gardens (paper, cans, bottles, boxes, bags, planks, an odd tyre), and tufts of grass
 * growing up close at the house walls and corners, at the containers and cabins and at the foot of the
 * street lamps, as if they were growing in - few, as accents.
 * Pure scenery: nothing blocks movement.
 */
export function createVillageDecay(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, obstacles: readonly Obstacle[]) {
  const r = rng(808);
  const white = new StandardMaterial("litterMat", scene);
  white.diffuseColor = Color3.White();
  white.specularColor = Color3.Black();
  white.backFaceCulling = false;

  type Kind = "paper" | "can" | "bottle" | "box" | "bag" | "plank" | "tyre";
  const mk = (kind: Kind): Mesh => {
    let m: Mesh;
    switch (kind) {
      case "paper": m = MeshBuilder.CreatePlane("paper", { width: 0.3, height: 0.21 }, scene); m.rotation.x = Math.PI / 2; break;
      case "can": m = MeshBuilder.CreateCylinder("can", { height: 0.12, diameter: 0.07, tessellation: 8 }, scene); m.rotation.z = Math.PI / 2; break;
      case "bottle": m = MeshBuilder.CreateCylinder("bottle", { height: 0.26, diameter: 0.075, tessellation: 8 }, scene); m.rotation.z = Math.PI / 2; break;
      case "box": m = MeshBuilder.CreateBox("box", { width: 0.4, height: 0.22, depth: 0.3 }, scene); break;
      case "bag": m = MeshBuilder.CreateSphere("bag", { diameter: 0.34, segments: 5 }, scene); m.scaling.y = 0.45; break;
      case "plank": m = MeshBuilder.CreateBox("plank", { width: 1.0, height: 0.04, depth: 0.13 }, scene); break;
      default: m = MeshBuilder.CreateTorus("tyre", { diameter: 0.62, thickness: 0.2, tessellation: 12 }, scene);
    }
    m.bakeCurrentTransformIntoVertices();
    m.convertToFlatShadedMesh();
    m.material = white;
    m.isPickable = false;
    m.receiveShadows = true;
    return m;
  };
  const kinds: [Kind, number, number][] = [["paper", 0.38, 0.015], ["can", 0.12, 0.06], ["bottle", 0.1, 0.04], ["box", 0.12, 0.11], ["bag", 0.1, 0.05], ["plank", 0.12, 0.03], ["tyre", 0.06, 0.1]];
  const meshes = new Map<Kind, Mesh>(kinds.map(([k]) => [k, mk(k)]));
  const data = new Map<Kind, { m: number[]; c: number[] }>(kinds.map(([k]) => [k, { m: [], c: [] }]));
  const colorOf = (k: Kind): [number, number, number] => {
    const j = 0.85 + r() * 0.3;
    switch (k) {
      case "paper": return r() < 0.7 ? [0.9 * j, 0.88 * j, 0.8 * j] : [0.7 * j, 0.78 * j, 0.88 * j];
      case "can": return r() < 0.5 ? [0.7 * j, 0.7 * j, 0.72 * j] : [0.7 * j, 0.14 * j, 0.1 * j];
      case "bottle": return r() < 0.6 ? [0.2 * j, 0.4 * j, 0.2 * j] : [0.4 * j, 0.28 * j, 0.14 * j];
      case "box": return [0.55 * j, 0.42 * j, 0.26 * j];
      case "bag": return r() < 0.5 ? [0.12 * j, 0.12 * j, 0.14 * j] : [0.75 * j, 0.75 * j, 0.7 * j];
      case "plank": return [0.5 * j, 0.36 * j, 0.22 * j];
      default: return [0.1, 0.1, 0.1];
    }
  };
  const put = (kind: Kind, x: number, z: number, yaw: number, scale = 1) => {
    const cfg = kinds.find((k) => k[0] === kind)!;
    const m = Matrix.Compose(
      new Vector3(scale, scale, scale),
      Quaternion.RotationYawPitchRoll(yaw, kind === "box" || kind === "bag" ? (r() - 0.5) * 0.5 : 0, kind === "plank" || kind === "tyre" ? (r() - 0.5) * 0.3 : 0),
      new Vector3(x, terrain.heightAt(x, z) + cfg[2], z),
    );
    const d = data.get(kind)!;
    d.m.push(...m.asArray());
    d.c.push(...colorOf(kind), 1);
  };

  // litter: in the streets and the front gardens, a few pieces together here and there
  const pick = () => {
    let t = r();
    for (const [k, w] of kinds) { if ((t -= w) <= 0) return k; }
    return "paper" as Kind;
  };
  for (const s of layout.suburbs) {
    let placed = 0;
    for (let tries = 0; tries < 260 && placed < 46; tries++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * s.r * 0.95;
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      if (layout.fieldAt(x, z) || layout.houseAt(x, z, 0.4)) continue;
      const rd = layout.nearestRoad(x, z);
      const near = rd.d < 5 || houseDistance(layout, x, z, 4) < 4;
      if (!near) continue;
      const kind = pick();
      const count = kind === "paper" ? 1 + Math.floor(r() * 3) : 1;
      for (let i = 0; i < count; i++) {
        const px = x + (r() - 0.5) * 1.4, pz = z + (r() - 0.5) * 1.4;
        if (layout.houseAt(px, pz, 0.3)) continue;
        put(kind, px, pz, r() * Math.PI * 2, kind === "paper" ? 0.8 + r() * 0.5 : 0.85 + r() * 0.35);
        placed++;
      }
    }
  }
  for (const [kind, mesh] of meshes) {
    const d = data.get(kind)!;
    if (!d.m.length) {
      mesh.dispose();
      continue;
    }
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(d.m), 16, true);
    mesh.thinInstanceSetBuffer("color", new Float32Array(d.c), 4, true);
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.freezeWorldMatrix();
  }

  // tufts of grass: at the house walls, the corners and the lamp posts - low accents, no more
  const variants = [tussockMesh(scene, 61), tussockMesh(scene, 73)];
  const tm = new StandardMaterial("decayTuftMat", scene);
  tm.diffuseColor = Color3.White();
  tm.specularColor = Color3.Black();
  tm.backFaceCulling = false;
  const tdata: number[][] = [[], []];
  const tcols: number[][] = [[], []];
  const tuft = (x: number, z: number, h: number) => {
    if (layout.houseAt(x, z, 0.1) || layout.nearestRoad(x, z).d < 0.7) return;
    const v = Math.floor(r() * variants.length);
    const w = h * (0.7 + r() * 0.3);
    const m = Matrix.Compose(new Vector3(w, h, w), Quaternion.RotationAxis(Axis.Y, r() * Math.PI * 2), new Vector3(x, terrain.heightAt(x, z) - 0.04, z));
    tdata[v].push(...m.asArray());
    const k = 0.8 + r() * 0.3, dry = 0.25 + r() * 0.5;
    tcols[v].push(k * (0.95 + dry * 0.25), k * (1 - dry * 0.06), k * (1 - dry * 0.22), 1);
  };
  for (const h of layout.houses) {
    if (r() > 0.45) continue; // only some houses
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      // a corner (pushed out diagonally) or a spot along one of the walls
      const corner = r() < 0.55;
      let lx: number, lz: number;
      if (corner) {
        lx = (r() < 0.5 ? -1 : 1) * (h.w / 2 + 0.05 + r() * 0.3);
        lz = (r() < 0.5 ? -1 : 1) * (h.d / 2 + 0.05 + r() * 0.3);
      } else if (r() < 0.5) {
        lx = (r() * 2 - 1) * (h.w / 2 - 0.4);
        lz = (r() < 0.5 ? -1 : 1) * (h.d / 2 + 0.08 + r() * 0.25);
      } else {
        lz = (r() * 2 - 1) * (h.d / 2 - 0.4);
        lx = (r() < 0.5 ? -1 : 1) * (h.w / 2 + 0.08 + r() * 0.25);
      }
      const c = Math.cos(h.rot), sn = Math.sin(h.rot);
      tuft(h.x + lx * c + lz * sn, h.z - lx * sn + lz * c, 0.6 + r() * r() * 1.5); // up to about 2 m
    }
  }
  // containers, container houses (cabin camps) and the like: grass grows up against their walls
  for (const o of obstacles) {
    if (o.height < 2.4 || (o.hw < 2.4 && o.hd < 2.4)) continue;
    if (r() > 0.6) continue;
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const corner = r() < 0.5;
      let lx: number, lz: number;
      if (corner) {
        lx = (r() < 0.5 ? -1 : 1) * (o.hw + 0.05 + r() * 0.25);
        lz = (r() < 0.5 ? -1 : 1) * (o.hd + 0.05 + r() * 0.25);
      } else if (o.hw > o.hd) {
        lx = (r() * 2 - 1) * (o.hw - 0.3);
        lz = (r() < 0.5 ? -1 : 1) * (o.hd + 0.06 + r() * 0.22);
      } else {
        lz = (r() * 2 - 1) * (o.hd - 0.3);
        lx = (r() < 0.5 ? -1 : 1) * (o.hw + 0.06 + r() * 0.22);
      }
      const c = Math.cos(o.rot), sn = Math.sin(o.rot);
      tuft(o.x + lx * c + lz * sn, o.z - lx * sn + lz * c, 0.5 + r() * r() * 1.3); // up to about 1.8 m
    }
  }
  for (const l of layout.streetLights) if (r() < 0.25) tuft(l.x + (r() - 0.5) * 0.5, l.z + (r() - 0.5) * 0.5, 0.5 + r() * 0.5);
  variants.forEach((mesh, i) => {
    if (!tdata[i].length) {
      mesh.dispose();
      return;
    }
    mesh.material = tm;
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(tdata[i]), 16, true);
    mesh.thinInstanceSetBuffer("color", new Float32Array(tcols[i]), 4, true);
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    shadows.addShadowCaster(mesh);
  });
}
