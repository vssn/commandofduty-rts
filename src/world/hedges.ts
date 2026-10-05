import { Axis, Color3, Matrix, Mesh, MeshBuilder, Quaternion, Scene, ShadowGenerator, StandardMaterial, Vector3, VertexData } from "@babylonjs/core";
import { rng } from "../util/noise";
import { toWorld, type MapLayout, type RGB } from "./layout";
import { mat as flatMat } from "./models";
import type { Terrain } from "./terrain";

const HEDGE: RGB = [0.3, 0.36, 0.16];

export interface HedgePiece { x: number; z: number; rot: number; hw: number; hd: number }

/** Size of one hedge piece (metres): length, typical height, depth. Instances only stretch the height and depth a little. */
const LEN = 2.8, HGT = 1.15, DEP = 1.1;

/**
 * One piece of hedge as a dense shrub: a few hundred small leaves (two-triangle diamonds, turned every
 * way) packed into a rounded block, darker and woody low and inside, lighter and fresher on the outside
 * and the top, with a few autumn-yellow ones. Origin at the centre of the block; vertex colours.
 * Normals point out from the centre, so the whole piece is shaded like a bush, not like single leaves.
 */
function shrubMesh(scene: Scene, seed: number): Mesh {
  const r = rng(seed);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const leaves = 620;
  for (let i = 0; i < leaves; i++) {
    // a point in the rounded block: mostly near its surface (that is what is seen)
    let dx = r() * 2 - 1, dy = r() * 2 - 1, dz = r() * 2 - 1;
    const len = Math.hypot(dx, dy, dz) || 1;
    const radius = r() < 0.75 ? 0.72 + r() * 0.28 : r() * 0.7;
    // a squarish cross-section: pushed out towards a box, flatter at the sides (the dome of a hedge)
    const sq = 1.25;
    dx = (dx / len) * radius * sq; dy = (dy / len) * radius; dz = (dz / len) * radius * sq;
    const x = Math.max(-1, Math.min(1, dx)) * LEN / 2;
    const z = Math.max(-1, Math.min(1, dz)) * DEP / 2;
    // dome: the top is lower towards the sides
    const topK = 1 - 0.35 * Math.pow(Math.abs(z) / (DEP / 2), 2);
    const y = dy > 0 ? dy * (HGT / 2) * topK : dy * (HGT / 2);
    const out = Math.min(1, radius / 0.9);
    // leaf: a diamond across a random direction
    const s = 0.075 + r() * 0.07;
    const a = r() * Math.PI * 2, b = (r() - 0.5) * 1.6;
    const ux = Math.cos(a) * Math.cos(b), uy = Math.sin(b), uz = Math.sin(a) * Math.cos(b);
    const vx = -Math.sin(a), vz = Math.cos(a);
    const v0 = pos.length / 3;
    pos.push(
      x + ux * s, y + uy * s, z + uz * s,
      x - ux * s, y - uy * s, z - uz * s,
      x + vx * s * 0.6, y, z + vz * s * 0.6,
      x - vx * s * 0.6, y, z - vz * s * 0.6,
    );
    // shading: out from the centre of the piece (a bush), up on top
    let nx = x / (LEN / 2), ny = y / (HGT / 2) + 0.3, nz = z / (DEP / 2);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // colour: woody and dark low and inside, fresh green outside and above, the odd yellow leaf
    const low = Math.max(0, 0.15 - (y / HGT + 0.5)) * 4; // 0..0.6 near the bottom
    const base = 0.55 + 0.45 * out + 0.25 * Math.max(0, y / HGT);
    let cr = (0.13 + 0.2 * out) * base * (0.85 + r() * 0.3), cg = (0.2 + 0.26 * out) * base * (0.85 + r() * 0.3), cb = 0.07 * base;
    if (r() < 0.05) { cr = 0.5 + r() * 0.25; cg = 0.42 + r() * 0.15; cb = 0.1; } // an autumn leaf
    if (low > 0) { cr = cr * (1 - low) + 0.2 * low; cg = cg * (1 - low) + 0.14 * low; cb = cb * (1 - low) + 0.07 * low; }
    for (let q = 0; q < 4; q++) {
      nor.push(nx, ny, nz);
      col.push(cr, cg, cb, 1);
    }
    idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2, v0 + 1, v0 + 2, v0 + 3);
  }
  const m = new Mesh("shrub", scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.colors = col;
  vd.indices = idx;
  vd.applyToMesh(m);
  return m;
}

/**
 * Hedgerows along some field edges (roads and fields themselves are painted into the terrain): green
 * boxes in the classic look, dense shrubs in the realistic one (`setRealistic`). Both are the same
 * pieces in the same places and solid: the returned pieces are used for cover and as obstacles.
 */
export function createHedges(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator): HedgePiece[] & { setRealistic(on: boolean): void } {
  const r = rng(7);
  const variants = [shrubMesh(scene, 3), shrubMesh(scene, 17), shrubMesh(scene, 41)];
  const mat = new StandardMaterial("shrubMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false;
  // the classic hedge: a plain green box
  const box = MeshBuilder.CreateBox("hedge", { width: 1, height: 1, depth: 1 }, scene);
  box.convertToFlatShadedMesh();
  box.material = flatMat(scene, HEDGE);
  const boxData: number[] = [];
  const data: number[][] = [[], [], []];
  const cols: number[][] = [[], [], []];
  const hedgePositions: HedgePiece[] = [];
  for (const f of layout.fields) {
    const sides: [number, number, number, number][] = [
      [-f.hw, -f.hd - 0.8, f.hw, -f.hd - 0.8], [-f.hw, f.hd + 0.8, f.hw, f.hd + 0.8],
      [-f.hw - 0.8, -f.hd, -f.hw - 0.8, f.hd], [f.hw + 0.8, -f.hd, f.hw + 0.8, f.hd],
    ];
    for (const [ax, az, bx, bz] of sides) {
      if (r() < 0.45) continue;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.ceil(len / 2.4);
      for (let i = 0; i < n; i++) {
        if (r() < 0.08) continue; // gaps
        const t = (i + 0.5) / n;
        const p = toWorld(f.cx, f.cz, f.rot, ax + (bx - ax) * t, az + (bz - az) * t);
        if (layout.nearestRoad(p.x, p.z).d < 1 || layout.fieldAt(p.x, p.z)) continue;
        const along = ax === bx ? Math.PI / 2 : 0;
        const h = 0.9 + r() * 0.5;
        const depth = 1.0 + r() * 0.3;
        const rot = f.rot + along + (r() - 0.5) * 0.1;
        const v = Math.floor(r() * variants.length);
        const m = Matrix.Compose(
          new Vector3(1.02, h / HGT, depth / DEP),
          Quaternion.RotationAxis(Axis.Y, rot + (r() < 0.5 ? 0 : Math.PI)),
          new Vector3(p.x, terrain.heightAt(p.x, p.z) + h / 2 - 0.15, p.z),
        );
        data[v].push(...m.asArray());
        boxData.push(...Matrix.Compose(
          new Vector3(2.8, h, depth),
          Quaternion.RotationAxis(Axis.Y, rot),
          new Vector3(p.x, terrain.heightAt(p.x, p.z) + h / 2 - 0.15, p.z),
        ).asArray());
        const k = 0.88 + r() * 0.24;
        cols[v].push(HEDGE[0] / 0.3 * k, HEDGE[1] / 0.36 * k * (0.96 + r() * 0.1), HEDGE[2] / 0.16 * k, 1);
        hedgePositions.push({ x: p.x, z: p.z, rot, hw: 1.4, hd: depth / 2 });
      }
    }
  }
  box.thinInstanceSetBuffer("matrix", new Float32Array(boxData), 16, true);
  box.thinInstanceRefreshBoundingInfo(false);
  box.isPickable = false;
  box.receiveShadows = true;
  shadows.addShadowCaster(box);
  const shrubs: Mesh[] = [];
  variants.forEach((mesh, i) => {
    if (!data[i].length) {
      mesh.dispose();
      return;
    }
    shrubs.push(mesh);
    mesh.setEnabled(false); // (the realistic mode shows them)
    mesh.material = mat;
    mesh.thinInstanceSetBuffer("matrix", new Float32Array(data[i]), 16, true);
    mesh.thinInstanceSetBuffer("color", new Float32Array(cols[i]), 4, true);
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    shadows.addShadowCaster(mesh);
  });
  return Object.assign(hedgePositions, {
    setRealistic(on: boolean) {
      box.setEnabled(!on);
      for (const m of shrubs) m.setEnabled(on);
    },
  });
}
