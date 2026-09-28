import { Axis, Matrix, MeshBuilder, Quaternion, Scene, StandardMaterial, Color3, Vector3 } from "@babylonjs/core";
import { rng } from "../util/noise";
import { toWorld, type Field, type MapLayout, type RGB } from "./layout";
import type { Terrain } from "./terrain";

/** Distance between crop rows (across the furrows) and between plants along a row. */
const ROW = 0.6;
const STEP = 0.55;

/** Crop height range by how the field looks: ploughed soil gets low clods, green fields tall shoots. */
function cropHeight(f: Field): [number, number] {
  const [r, g, b] = f.base;
  const green = g > r * 1.05;
  const dark = r + g + b < 1.15;
  if (green) return [0.25, 0.6];
  if (dark) return [0.05, 0.16];
  return [0.12, 0.38];
}

/**
 * Covers every field with small square tufts of varying height, laid out in rows along the
 * furrow stripes and tinted like the stripe below. One thin-instanced box with per-instance colour.
 */
export function createCrops(scene: Scene, layout: MapLayout, terrain: Terrain) {
  const r = rng(314);
  const box = MeshBuilder.CreateBox("crop", { size: 1 }, scene);
  box.position.y = 0.5;
  box.bakeCurrentTransformIntoVertices();
  const mat = new StandardMaterial("cropMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  box.material = mat;

  const matrices: number[] = [];
  const colors: number[] = [];
  const m = new Matrix();
  for (const f of layout.fields) {
    const [hMin, hMax] = cropHeight(f);
    const q = Quaternion.RotationAxis(Axis.Y, f.rot);
    // rows run along the local z axis, i.e. along the furrow stripes
    for (let lx = -f.hw + ROW / 2; lx < f.hw; lx += ROW) {
      const stripe = (Math.floor(lx / f.sw) & 1) === 0;
      const c: RGB = stripe ? f.base : f.stripe;
      for (let lz = -f.hd + 0.6; lz < f.hd - 0.4; lz += STEP) {
        if (r() < 0.12) continue; // gaps
        const jx = lx + (r() - 0.5) * 0.18, jz = lz + (r() - 0.5) * 0.3;
        const p = toWorld(f.cx, f.cz, f.rot, jx, jz);
        if (layout.nearestRoad(p.x, p.z).d < 0.6) continue; // nothing grows on the track
        const h = hMin + r() * r() * (hMax - hMin) * 1.4;
        const s = 0.24 + r() * 0.16;
        Matrix.ComposeToRef(new Vector3(s, Math.min(h, hMax), s), q, new Vector3(p.x, terrain.heightAt(p.x, p.z) - 0.03, p.z), m);
        matrices.push(...m.asArray());
        // tufts are a little lighter than the soil stripe, with some variation
        const k = 1.08 + (r() - 0.5) * 0.22;
        colors.push(Math.min(1, c[0] * k), Math.min(1, c[1] * k * 1.02), Math.min(1, c[2] * k * 0.95), 1);
      }
    }
  }

  box.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
  box.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  box.thinInstanceRefreshBoundingInfo(false);
  box.isPickable = false;
  box.receiveShadows = true;
  box.freezeWorldMatrix();
  return matrices.length / 16;
}
