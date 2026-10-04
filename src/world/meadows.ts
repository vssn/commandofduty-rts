import { Axis, Color3, Matrix, MeshBuilder, Quaternion, StandardMaterial, Vector3, type Scene } from "@babylonjs/core";
import { rng, valueNoise } from "../util/noise";
import { toWorld, type MapLayout, type MeadowKind, type RGB } from "./layout";
import type { CropKind, RealisticCrops } from "./floraPbr";
import type { Terrain } from "./terrain";

/** Per kind: spacing of the tufts, their height range (metres), the plant model of the realistic mode and the base colour. */
const KINDS: Record<Exclude<MeadowKind, "mown">, { step: number; h: [number, number]; plant: CropKind; width: [number, number]; color: RGB }> = {
  hay: { step: 0.62, h: [0.5, 1.0], plant: "cereal", width: [0.22, 0.34], color: [0.74, 0.68, 0.36] },
  wild: { step: 0.7, h: [0.35, 0.85], plant: "shoots", width: [0.26, 0.42], color: [0.52, 0.56, 0.3] },
  pasture: { step: 0.95, h: [0.12, 0.32], plant: "shoots", width: [0.26, 0.4], color: [0.45, 0.52, 0.29] },
};

/**
 * Tufts of grass on the meadows (not on the mown ones): tall and golden on the hay meadows, mixed
 * and flowery on the wild ones, short and patchy on the pastures. Like the field crops: one
 * thin-instanced box for the classic look, and the plant models of the realistic mode, placed alike.
 */
export function createMeadowGrass(scene: Scene, layout: MapLayout, terrain: Terrain, realistic?: RealisticCrops) {
  const r = rng(2718);
  const box = MeshBuilder.CreateBox("meadowGrass", { size: 1 }, scene);
  box.position.y = 0.5;
  box.bakeCurrentTransformIntoVertices();
  const mat = new StandardMaterial("meadowGrassMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  box.material = mat;

  const matrices: number[] = [];
  const colors: number[] = [];
  const m4 = new Matrix();
  for (const m of layout.meadows) {
    if (m.kind === "mown") continue;
    const cfg = KINDS[m.kind];
    for (let lx = -m.hw; lx < m.hw; lx += cfg.step) {
      for (let lz = -m.hd; lz < m.hd; lz += cfg.step) {
        const jx = lx + (r() - 0.5) * cfg.step, jz = lz + (r() - 0.5) * cfg.step;
        const p = toWorld(m.cx, m.cz, m.rot, jx, jz);
        const at = layout.meadowAt(p.x, p.z);
        if (!at || at.m !== m) continue;
        // thinner towards the ragged edge; the pastures are grazed bare in patches
        const patch = valueNoise(p.x * 0.35, p.z * 0.35, 91);
        if (r() > Math.pow(at.cover, 1.6) * (m.kind === "pasture" ? (patch > 0.45 ? 0.9 : 0.25) : 0.55 + patch * 0.5)) continue;
        if (layout.nearestRoad(p.x, p.z).d < 0.8) continue;
        // tall in the middle of a patch of growth, lower at its fringe
        const h = (cfg.h[0] + r() * r() * (cfg.h[1] - cfg.h[0]) * 1.5) * (0.7 + 0.3 * at.cover) * (0.85 + 0.3 * patch);
        const w = cfg.width[0] + r() * (cfg.width[1] - cfg.width[0]);
        Matrix.ComposeToRef(
          new Vector3(w, Math.min(h, cfg.h[1]), w),
          Quaternion.RotationAxis(Axis.Y, r() * Math.PI * 2),
          new Vector3(p.x, terrain.heightAt(p.x, p.z) - 0.03, p.z),
          m4,
        );
        matrices.push(...m4.asArray());
        // tone: dry meadows gold, lush ones green; every tuft a little different
        const dry = 1 - m.tone, k = 0.85 + r() * 0.3;
        const col: [number, number, number, number] = [
          Math.min(1, cfg.color[0] * k * (1 + dry * 0.18)),
          Math.min(1, cfg.color[1] * k * (1 - dry * 0.04)),
          Math.min(1, cfg.color[2] * k * (1 - dry * 0.15)),
          1,
        ];
        colors.push(...col);
        realistic?.add(cfg.plant, m4, col);
      }
    }
  }
  if (!matrices.length) {
    box.dispose();
    return 0;
  }
  box.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
  box.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  box.thinInstanceRefreshBoundingInfo(false);
  box.isPickable = false;
  box.receiveShadows = true;
  box.freezeWorldMatrix();
  realistic?.classic.push(box);
  return matrices.length / 16;
}
