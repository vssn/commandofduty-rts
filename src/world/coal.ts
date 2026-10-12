import { Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Texture, Vector3, VertexData, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { rng } from "../util/noise";

/**
 * Heaps of coal (on the wagons, in the bunker): in the classic look a pile of small dark cubes lying on
 * and against each other (like the crops of the classic fields), in the realistic look a lumpy mound
 * whose facets catch the light, with a speckled texture.
 */

/**
 * A heap: centre at (x, base, z) turned by `yaw` (as mesh.rotation.y), `len` along, `wid` across, `peak` high;
 * or, with `frame`, placed by that matrix instead (its centre at the frame's origin: the coal on a sloping belt).
 */
export interface CoalHeap { x: number; z: number; base: number; yaw: number; len: number; wid: number; peak: number; frame?: Matrix }

const placement = (h: CoalHeap) => h.frame ?? Matrix.RotationY(h.yaw).multiply(Matrix.Translation(h.x, h.base, h.z));

/** Height of a heap over its base at (u, v) in -1..1 (along, across): a ridge with a few humps, low at the rim. */
function heapHeight(h: CoalHeap, u: number, v: number, phase: number): number {
  const across = 1 - Math.pow(Math.min(1, Math.abs(v)), 1.7);
  const along = 1 - Math.pow(Math.min(1, Math.abs(u)), h.len > h.wid * 1.5 ? 5 : 1.7);
  // loaded from a chute in a few places: humps along the ridge
  const humps = h.len > h.wid * 1.5 ? 0.78 + 0.22 * Math.cos(u * Math.PI * 2.5 + phase) : 1;
  return 0.06 + h.peak * Math.max(0, across * along * humps);
}

function coalTexture(scene: Scene): DynamicTexture {
  const S = 128, t = new DynamicTexture("coalTex", { width: S, height: S }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  const img = g.createImageData(S, S), r = rng(77);
  for (let i = 0; i < S * S; i++) {
    const n = r();
    // mostly black, glinting grains, a little grey dust
    const v = n > 0.93 ? 190 + r() * 60 : n < 0.25 ? 62 : 85 + r() * 40;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v * 1.05;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

export function createCoal(scene: Scene, heaps: CoalHeap[], shadows: ShadowGenerator): { setRealistic(on: boolean): void } {
  const r = rng(4242);
  const phases = heaps.map(() => r() * Math.PI * 2);

  // ---- classic: cubes, piled to the heap's shape (the top layer plus one beneath to close the gaps)
  const cube = MeshBuilder.CreateBox("coalCubes", { size: 1 }, scene);
  const cm = new StandardMaterial("coalCubeMat", scene);
  cm.diffuseColor = Color3.White();
  cm.specularColor = new Color3(0.3, 0.3, 0.32);
  cm.specularPower = 24;
  cube.material = cm;
  const data: number[] = [], cols: number[] = [];
  for (const [i, h] of heaps.entries()) {
    const M = placement(h), q0 = Quaternion.FromRotationMatrix(M.getRotationMatrix());
    const step = h.wid < 1.5 ? 0.3 : 0.4, nu = Math.round(h.len / step), nv = Math.round(h.wid / step);
    for (let a = 0; a < nu; a++) {
      for (let b = 0; b < nv; b++) {
        const lu = -h.len / 2 + (a + 0.5 + (r() - 0.5) * 0.5) * (h.len / nu);
        const lv = -h.wid / 2 + (b + 0.5 + (r() - 0.5) * 0.5) * (h.wid / nv);
        const top = heapHeight(h, (lu / h.len) * 2, (lv / h.wid) * 2, phases[i]);
        for (const down of top > 0.45 ? [0, 0.32] : [0]) {
          const s = 0.26 + r() * 0.18;
          const p = Vector3.TransformCoordinates(new Vector3(lu, top - s * 0.4 - down, lv), M);
          const q = q0.multiply(Quaternion.FromEulerAngles((r() - 0.5) * 1.4, r() * Math.PI, (r() - 0.5) * 1.4));
          data.push(...Matrix.Compose(new Vector3(s, s * (0.8 + r() * 0.3), s), q, p).asArray());
          const g = 0.16 + r() * 0.2;
          cols.push(g, g, g * 1.08, 1);
        }
      }
    }
  }
  cube.thinInstanceSetBuffer("matrix", new Float32Array(data), 16, true);
  cube.thinInstanceSetBuffer("color", new Float32Array(cols), 4, true);
  cube.thinInstanceRefreshBoundingInfo(false);
  cube.isPickable = false;
  cube.receiveShadows = true;
  cube.alwaysSelectAsActiveMesh = true;
  shadows.addShadowCaster(cube);

  // ---- realistic: one lumpy mound per heap, flat-shaded (the facets glint), merged
  const mounds: Mesh[] = [];
  for (const [i, h] of heaps.entries()) {
    const M = placement(h);
    const nu = Math.max(8, Math.round(h.len / 0.45)), nv = Math.max(6, Math.round(h.wid / 0.45));
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let a = 0; a <= nu; a++) {
      for (let b = 0; b <= nv; b++) {
        const u = (a / nu) * 2 - 1, v = (b / nv) * 2 - 1;
        const edge = a === 0 || b === 0 || a === nu || b === nv;
        // lumps: every inner point jittered (up, down and sideways)
        const jx = edge ? 0 : (r() - 0.5) * 0.25, jz = edge ? 0 : (r() - 0.5) * 0.25;
        const y = edge ? 0.02 : heapHeight(h, u, v, phases[i]) + (r() - 0.5) * 0.14;
        const lx = (u * h.len) / 2 + jx, lz = (v * h.wid) / 2 + jz;
        const w = Vector3.TransformCoordinates(new Vector3(lx, y, lz), M);
        pos.push(w.x, w.y, w.z);
        uv.push(lx / 1.5, lz / 1.5);
      }
    }
    for (let a = 0; a < nu; a++) {
      for (let b = 0; b < nv; b++) {
        const p0 = a * (nv + 1) + b, p1 = p0 + 1, p2 = p0 + nv + 1, p3 = p2 + 1;
        idx.push(p0, p1, p2, p1, p3, p2);
      }
    }
    const m = new Mesh("coalMound", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.uvs = uv;
    const nor: number[] = [];
    VertexData.ComputeNormals(pos, idx, nor);
    vd.normals = nor;
    vd.applyToMesh(m);
    m.convertToFlatShadedMesh();
    mounds.push(m);
  }
  const mound = Mesh.MergeMeshes(mounds, true, true)!;
  mound.name = "coalMounds";
  const mm = new StandardMaterial("coalMoundMat", scene);
  mm.diffuseTexture = coalTexture(scene);
  mm.diffuseColor = new Color3(0.7, 0.7, 0.73);
  mm.specularColor = new Color3(0.2, 0.2, 0.22);
  mm.backFaceCulling = false;
  mm.metadata = { rough: 0.3, metal: 0.12 };
  mound.material = mm;
  mound.isPickable = false;
  mound.receiveShadows = true;
  mound.freezeWorldMatrix();
  shadows.addShadowCaster(mound);
  mound.setEnabled(false);

  return {
    setRealistic(on: boolean) {
      cube.setEnabled(!on);
      mound.setEnabled(on);
    },
  };
}
