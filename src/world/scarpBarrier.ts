import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, VertexData, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import type { NavGrid } from "../game/nav";
import { rng } from "../util/noise";
import type { MapLayout } from "./layout";
import { ScarpSet } from "./scarps";
import type { Terrain } from "./terrain";

/**
 * The steep part of an escarpment cannot be climbed: its cells are blocked on the navigation grid (the
 * slopes fade out at their ends, so one walks round them there), and boulders lie over the blocked band
 * and along its foot as a barrier one can see - big, angular stones piled against the bank, a row of
 * them standing in front of it. Steepness is measured on the ground itself (gradient over a metre).
 */

/** Gradient (rise per metre run) from which a slope is too steep to walk or drive. */
const STEEP = 0.4;
/**
 * Rise per metre southwards from which a wall's flank is closed as well: the camera looks north, a unit climbing
 * towards it would seem to stand still (the ramps climb slantwise, mostly east or west).
 */
const SOUTHWARD = 0.2;
/** How far beside a wall (and its rubble) the ground is checked: the cut banks beside the ramps reach out that far. */
const NEAR = 10;

export function createScarpBarrier(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid): void {
  if (!layout.scarps.list.length) return;
  const sc = layout.scarps;
  const n = Math.round(MAP_HALF * 2);
  const steep = new Uint8Array(n * n);
  const grad = (x: number, z: number) => Math.hypot(terrain.heightAt(x + 0.5, z) - terrain.heightAt(x - 0.5, z), terrain.heightAt(x, z + 0.5) - terrain.heightAt(x, z - 0.5));
  const north = (x: number, z: number) => terrain.heightAt(x, z + 0.5) - terrain.heightAt(x, z - 0.5);
  // (on a ramp only its steepness counts: the rise southwards stays small there, the ramps climb slantwise)
  const onRamp = (x: number, z: number) => sc.ramps.some((rp) => ScarpSet.rampAt(rp, x, z).k > 0.3);
  // (nor on and beside the tracks: they must stay open, on both sides alike)
  const onTrack = (x: number, z: number) => layout.nearestRoad(x, z).d < 2.5;
  for (let j = 0; j < n; j++) {
    const z = -MAP_HALF + (j + 0.5);
    for (let i = 0; i < n; i++) {
      const x = -MAP_HALF + (i + 0.5);
      if (sc.near(x, z, NEAR) && (grad(x, z) > STEEP || (north(x, z) < -SOUTHWARD && !onRamp(x, z) && !onTrack(x, z)))) steep[i + j * n] = 1;
    }
  }
  // blocked: the steep cells and a ring of one cell round them (no slipping through between two cells)
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && steep[i + j * n] === 1;
  const ring: [number, number][] = [], core: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (at(i, j)) { core.push([i, j]); continue; }
      let next = false;
      for (let dj = -1; dj <= 1 && !next; dj++) for (let di = -1; di <= 1; di++) if (at(i + di, j + dj)) { next = true; break; }
      if (next && !onTrack(-MAP_HALF + i + 0.5, -MAP_HALF + j + 0.5)) ring.push([i, j]);
    }
  }
  const centre = (i: number, j: number) => ({ x: -MAP_HALF + (i + 0.5), z: -MAP_HALF + (j + 0.5) });
  for (const [i, j] of [...core, ...ring]) {
    const c = centre(i, j);
    nav.blockCell(c.x, c.z);
  }

  // ---- the boulders: three lumpy shapes, thin instances
  const r = rng(6161);
  const shapes: Mesh[] = [0, 1, 2].map((v) => {
    const m = MeshBuilder.CreateIcoSphere(`barrierRock${v}`, { radius: 0.5, subdivisions: 1, flat: true }, scene);
    const pos = m.getVerticesData("position")!;
    const seen = new Map<string, number>();
    for (let k = 0; k < pos.length; k += 3) {
      const key = `${pos[k].toFixed(3)},${pos[k + 1].toFixed(3)},${pos[k + 2].toFixed(3)}`;
      let f = seen.get(key);
      if (f === undefined) { f = 0.7 + r() * 0.55; seen.set(key, f); }
      pos[k] *= f * (1.05 + v * 0.1);
      pos[k + 1] *= f * (0.8 + v * 0.08);
      pos[k + 2] *= f;
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = m.getIndices()!;
    const nor: number[] = [];
    VertexData.ComputeNormals(pos, vd.indices, nor);
    vd.normals = nor;
    vd.applyToMesh(m);
    m.convertToFlatShadedMesh();
    return m;
  });
  const mat = new StandardMaterial("barrierRockMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.metadata = { rough: 0.92 };
  const data: number[][] = [[], [], []], cols: number[][] = [[], [], []];
  const put = (x: number, z: number, size: number) => {
    const v = Math.floor(r() * 3);
    const q = Quaternion.FromEulerAngles((r() - 0.5) * 0.8, r() * Math.PI * 2, (r() - 0.5) * 0.8);
    const s = new Vector3(size * (0.85 + r() * 0.4), size * (0.7 + r() * 0.4), size * (0.85 + r() * 0.4));
    // sunk into the ground by about a third
    data[v].push(...Matrix.Compose(s, q, new Vector3(x, terrain.heightAt(x, z) + size * 0.14, z)).asArray());
    const g = 0.42 + r() * 0.2, warm = (r() - 0.5) * 0.06 + 0.03;
    cols[v].push(g + warm * 1.4, g + warm * 0.5, g - warm, 1);
  };
  // on the slope itself: stones of all sizes, packed (about every other cell)
  for (const [i, j] of core) {
    if (r() > 0.55) continue;
    const c = centre(i, j);
    put(c.x + (r() - 0.5) * 0.9, c.z + (r() - 0.5) * 0.9, 0.7 + Math.pow(r(), 1.6) * 1.1);
  }
  // round it: big stones standing in a rough row (the wall the eye reads)
  for (const [i, j] of ring) {
    if (r() > 0.6) continue;
    const c = centre(i, j);
    put(c.x + (r() - 0.5) * 0.8, c.z + (r() - 0.5) * 0.8, 1.1 + r() * 0.9);
  }
  shapes.forEach((m, i) => {
    if (!data[i].length) { m.dispose(); return; }
    m.material = mat;
    m.thinInstanceSetBuffer("matrix", new Float32Array(data[i]), 16, true);
    m.thinInstanceSetBuffer("color", new Float32Array(cols[i]), 4, true);
    m.thinInstanceRefreshBoundingInfo(false);
    m.isPickable = false;
    m.receiveShadows = true;
    m.alwaysSelectAsActiveMesh = true;
    shadows.addShadowCaster(m);
  });
}
