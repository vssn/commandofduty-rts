import { Color3, Mesh, MeshBuilder, Matrix, Quaternion, StandardMaterial, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { rng } from "../util/noise";
import type { MapLayout } from "./layout";
import type { Terrain } from "./terrain";

/**
 * The classic look of the escarpments: the slopes and the rubble at their foot are strewn with low-poly stones - grey
 * rocks of all sizes, thin instances (one draw call per shape), sunk a little into the ground. The realistic mode
 * shows no stones: its ground carries the rock texture instead (see terrainPbr.ts).
 */
export function createScarpRocks(scene: Scene, layout: MapLayout, terrain: Terrain): { setRealistic(on: boolean): void } {
  const r = rng(909);
  const shapes: Mesh[] = [0, 1, 2].map((i) => {
    const m = MeshBuilder.CreateIcoSphere(`scarpRock${i}`, { radius: 0.5, subdivisions: 1, flat: true }, scene);
    // a lumpy, angular stone: every corner pushed in or out, the whole flattened a little
    const pos = m.getVerticesData("position")!;
    const seen = new Map<string, number>();
    for (let k = 0; k < pos.length; k += 3) {
      const key = `${pos[k].toFixed(3)},${pos[k + 1].toFixed(3)},${pos[k + 2].toFixed(3)}`;
      let f = seen.get(key);
      if (f === undefined) {
        f = 0.72 + r() * 0.5;
        seen.set(key, f);
      }
      pos[k] *= f * (1.1 + i * 0.12);
      pos[k + 1] *= f * (0.62 + i * 0.1);
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
  const mat = new StandardMaterial("scarpRockMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  const data: number[][] = [[], [], []], cols: number[][] = [[], [], []];

  for (const sc of layout.scarps.list) {
    const lo = -(sc.w / 2 + 3.2), hi = sc.w / 2 + 0.6;
    const area = (sc.total - 10) * (hi - lo);
    // stone slopes are littered with rocks, earth banks hold only a few
    const count = Math.round(area / (sc.kind === "stone" ? 0.55 : 2.4));
    for (let n = 0; n < count; n++) {
      const t = 5 + r() * (sc.total - 10), s = lo + r() * (hi - lo);
      let i = 1;
      while (i < sc.arc.length - 1 && sc.arc[i] < t) i++;
      const a = sc.pts[i - 1], b = sc.pts[i];
      const seg = Math.hypot(b.x - a.x, b.z - a.z) || 1, k = (t - sc.arc[i - 1]) / seg;
      const x = a.x + (b.x - a.x) * k - ((b.z - a.z) / seg) * s, z = a.z + (b.z - a.z) * k + ((b.x - a.x) / seg) * s;
      const cov = layout.scarps.cover(x, z);
      if (!cov || cov.d > -0.3) continue; // (inside the area, whose edge is ragged)
      // bigger rocks lie at the foot, smaller ones up the slope
      const foot = Math.max(0, Math.min(1, (hi - s) / (hi - lo)));
      const size = (0.22 + Math.pow(r(), 2.2) * 0.95) * (0.75 + foot * 0.5);
      const q = Quaternion.FromEulerAngles((r() - 0.5) * 0.7, r() * Math.PI * 2, (r() - 0.5) * 0.7);
      const v = Math.floor(r() * 3);
      data[v].push(...Matrix.Compose(new Vector3(size * (0.8 + r() * 0.5), size * (0.8 + r() * 0.5), size * (0.8 + r() * 0.5)), q, new Vector3(x, terrain.heightAt(x, z) + size * 0.08, z)).asArray());
      // grey, some warm, some dark; the earth banks' stones a little browner
      const g = 0.4 + r() * 0.26, warm = cov.brown * 0.1 + (r() - 0.5) * 0.06;
      cols[v].push(g + warm * 1.4, g + warm * 0.4, g - warm, 1);
    }
  }
  shapes.forEach((m, i) => {
    if (!data[i].length) {
      m.dispose();
      return;
    }
    m.material = mat;
    m.thinInstanceSetBuffer("matrix", new Float32Array(data[i]), 16, true);
    m.thinInstanceSetBuffer("color", new Float32Array(cols[i]), 4, true);
    m.thinInstanceRefreshBoundingInfo(false);
    m.isPickable = false;
    m.receiveShadows = true;
    m.alwaysSelectAsActiveMesh = true;
  });
  return {
    setRealistic(on: boolean) {
      for (const m of shapes) if (!m.isDisposed()) m.setEnabled(!on);
    },
  };
}
