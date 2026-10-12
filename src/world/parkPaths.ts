import { Color3, DynamicTexture, Mesh, StandardMaterial, Texture, VertexData, type Scene } from "@babylonjs/core";
import { rng } from "../util/noise";
import { RING, SIDEWALK } from "./embassy";
import type { MapLayout } from "./layout";
import type { Terrain } from "./terrain";

/**
 * The park's gravel paths (Botschaftsquartier) as a surface of their own just over the ground, with
 * smooth edges: painted into the ground alone they would follow its triangles (classic look) or the
 * texels of its masks (realistic look) and show a stepped edge. Each straight piece is a strip following
 * the rolling lawn, each bend a round patch, all with the same ground-aligned texture, so where they
 * overlap nothing shows. Where they meet a pavement they end flush with its concrete edge. (The ground
 * keeps a narrower painted path underneath, for the minimap.)
 */

/** Metres per repeat of the gravel texture. */
const TILE = 2.4;
/** Height over the ground. */
const LIFT = 0.05;

/** Fine gravel: light and dark grains on a sandy ground, a few larger stones. */
function gravelTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const t = new DynamicTexture("parkGravel", { width: S, height: S }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  const img = g.createImageData(S, S);
  const r = rng(515);
  for (let i = 0; i < S * S; i++) {
    const n = r();
    let v = 200 + (n - 0.5) * 44;
    if (n > 0.97) v += 30;
    else if (n < 0.05) v -= 55;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v * 0.97;
    img.data[i * 4 + 2] = v * 0.9;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 70; k++) {
    const x = r() * S, y = r() * S, rad = 1.5 + r() * 2.5, c = Math.round(150 + r() * 90);
    g.fillStyle = `rgb(${c},${Math.round(c * 0.96)},${Math.round(c * 0.9)})`;
    g.beginPath();
    g.ellipse(x, y, rad, rad * (0.6 + r() * 0.4), r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 8;
  return t;
}

export function createParkPaths(scene: Scene, layout: MapLayout, terrain: Terrain): Mesh | null {
  if (!layout.paths.length) return null;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  /** A vertex on the ground (with the ground's slope as its normal). */
  // the park ends at the concrete edge of the pavements: the paths stop there, flush with it
  const limX = RING - 4 - SIDEWALK, limZ = layout.park;
  const vert = (px: number, pz: number) => {
    const x = Math.max(-limX, Math.min(limX, px)), z = Math.max(-limZ, Math.min(limZ, pz));
    const h = terrain.heightAt(x, z);
    const dx = terrain.heightAt(x + 0.5, z) - terrain.heightAt(x - 0.5, z), dz = terrain.heightAt(x, z + 0.5) - terrain.heightAt(x, z - 0.5);
    const l = Math.hypot(dx, 1, dz);
    pos.push(x, h + LIFT, z);
    nor.push(-dx / l, 1 / l, -dz / l);
    uv.push(x / TILE, z / TILE);
    return pos.length / 3 - 1;
  };
  const joints = new Map<string, { x: number; z: number; r: number }>();
  for (const p of layout.paths) {
    const dx = p.b.x - p.a.x, dz = p.b.z - p.a.z, len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len, sx = -uz, sz = ux, hw = p.w / 2;
    // a grid over the strip: about every metre along, four bands across (it bends with the lawn)
    const nl = Math.max(1, Math.ceil(len / 1)), nw = 4;
    const base = pos.length / 3;
    for (let i = 0; i <= nl; i++) {
      for (let j = 0; j <= nw; j++) {
        const t = (i / nl) * len, s = -hw + (j / nw) * 2 * hw;
        vert(p.a.x + ux * t + sx * s, p.a.z + uz * t + sz * s);
      }
    }
    for (let i = 0; i < nl; i++) {
      for (let j = 0; j < nw; j++) {
        const a = base + i * (nw + 1) + j, b = a + 1, c = a + nw + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    for (const q of [p.a, p.b]) joints.set(`${q.x.toFixed(2)},${q.z.toFixed(2)}`, { x: q.x, z: q.z, r: hw });
  }
  // round patches at the joints and ends: the bends close without a notch
  for (const j of joints.values()) {
    const seg = 16, rings = 2;
    const centre = vert(j.x, j.z);
    const ring: number[][] = [];
    for (let k = 1; k <= rings; k++) {
      const row: number[] = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2, rr = (j.r * k) / rings;
        row.push(vert(j.x + Math.cos(a) * rr, j.z + Math.sin(a) * rr));
      }
      ring.push(row);
    }
    for (let s = 0; s < seg; s++) {
      const n = (s + 1) % seg;
      idx.push(centre, ring[0][n], ring[0][s]);
      for (let k = 0; k < rings - 1; k++) idx.push(ring[k][s], ring[k][n], ring[k + 1][s], ring[k][n], ring[k + 1][n], ring[k + 1][s]);
    }
  }
  const m = new Mesh("parkPaths", scene);
  const vd = new VertexData();
  vd.positions = new Float32Array(pos);
  vd.normals = new Float32Array(nor);
  vd.uvs = new Float32Array(uv);
  vd.indices = new Uint32Array(idx);
  vd.applyToMesh(m);
  const mat = new StandardMaterial("parkPathMat", scene);
  mat.diffuseTexture = gravelTexture(scene);
  mat.diffuseColor = new Color3(0.86, 0.79, 0.64);
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false; // (flat on the ground: whichever way round)
  mat.zOffset = -1;
  mat.metadata = { rough: 0.92 };
  m.material = mat;
  m.isPickable = false;
  m.receiveShadows = true;
  m.freezeWorldMatrix();
  return m;
}
