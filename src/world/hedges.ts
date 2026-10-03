import { Axis, Matrix, MeshBuilder, Quaternion, Scene, ShadowGenerator, Vector3 } from "@babylonjs/core";
import { rng } from "../util/noise";
import { toWorld, type MapLayout, type RGB } from "./layout";
import { mat } from "./models";
import type { RealisticHedges } from "./floraPbr";
import type { Terrain } from "./terrain";

const HEDGE: RGB = [0.3, 0.36, 0.16];

export interface HedgePiece { x: number; z: number; rot: number; hw: number; hd: number }

/**
 * Hedgerows along some field edges (roads and fields themselves are painted into the terrain).
 * Returns all hedge pieces (used for cover and as obstacles).
 */
export function createHedges(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, realistic?: RealisticHedges): HedgePiece[] {
  const r = rng(7);
  const hedge = MeshBuilder.CreateBox("hedge", { width: 1, height: 1, depth: 1 }, scene);
  hedge.convertToFlatShadedMesh();
  hedge.material = mat(scene, HEDGE);
  const data: number[] = [];
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
        const m = Matrix.Compose(
          new Vector3(2.8, h, depth),
          Quaternion.RotationAxis(Axis.Y, rot),
          new Vector3(p.x, terrain.heightAt(p.x, p.z) + h / 2 - 0.15, p.z),
        );
        data.push(...m.asArray());
        realistic?.add(m, HEDGE);
        hedgePositions.push({ x: p.x, z: p.z, rot, hw: 1.4, hd: depth / 2 });
      }
    }
  }
  hedge.thinInstanceSetBuffer("matrix", new Float32Array(data), 16, true);
  hedge.thinInstanceRefreshBoundingInfo(false);
  hedge.isPickable = false;
  hedge.receiveShadows = true;
  shadows.addShadowCaster(hedge);
  realistic?.classic.push(hedge);
  return hedgePositions;
}
