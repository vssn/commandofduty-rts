import { Color3, Matrix, MeshBuilder, Quaternion, StandardMaterial, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { rng } from "../util/noise";
import type { RGB } from "./layout";

/** Barricade wall segment in the barracks' local frame (front / gate facing +z). */
export interface WallSegment { ax: number; az: number; bx: number; bz: number }
export interface Bastion { x: number; z: number; r: number }

/** Perimeter of the barricaded compound around the barracks (local coordinates). */
export const COMPOUND = { hw: 9.8, hd: 7.8, gate: 2.3 };

export const COMPOUND_WALLS: WallSegment[] = [
  { ax: -COMPOUND.hw, az: -COMPOUND.hd, bx: COMPOUND.hw, bz: -COMPOUND.hd },
  { ax: -COMPOUND.hw, az: -COMPOUND.hd, bx: -COMPOUND.hw, bz: COMPOUND.hd },
  { ax: COMPOUND.hw, az: -COMPOUND.hd, bx: COMPOUND.hw, bz: COMPOUND.hd },
  { ax: -COMPOUND.hw, az: COMPOUND.hd, bx: -COMPOUND.gate, bz: COMPOUND.hd },
  { ax: COMPOUND.gate, az: COMPOUND.hd, bx: COMPOUND.hw, bz: COMPOUND.hd },
];

export const COMPOUND_BASTIONS: Bastion[] = [
  { x: -COMPOUND.hw, z: -COMPOUND.hd, r: 1.4 },
  { x: COMPOUND.hw, z: -COMPOUND.hd, r: 1.4 },
  { x: -COMPOUND.hw, z: COMPOUND.hd, r: 1.4 },
  { x: COMPOUND.hw, z: COMPOUND.hd, r: 1.4 },
];

const BAG = { len: 0.9, h: 0.34, depth: 0.52 };
/** The barricade blocks: a few flat shades from black to mid grey (pixel look). */
const BLOCK: RGB[] = [[0.07, 0.07, 0.08], [0.15, 0.15, 0.165], [0.23, 0.23, 0.25], [0.33, 0.33, 0.355]];

/**
 * Fortification of the barracks: perimeter walls in staggered courses (double thickness at the bottom), round
 * bastions at the corners, taller gate posts and barricades in front of the windows, in the barracks' local frame.
 * Black-grey barricades in a pixel look, laid in courses like sandbags: every "bag" two square-cut blocks in flat
 * shades, set straight. One thin-instanced box mesh with per-block colour.
 */
export function createBarricades(scene: Scene, name: string): Mesh {
  const r = rng(name.length * 17 + 5);
  const block = MeshBuilder.CreateBox(name + "Blocks", { size: 1 }, scene);
  const bm = new StandardMaterial(name + "BlockMat", scene);
  bm.diffuseColor = Color3.White();
  bm.specularColor = new Color3(0.08, 0.08, 0.09);
  block.material = bm;
  const blockM: number[] = [], blockC: number[] = [];
  const m = new Matrix();
  const put = (x: number, y: number, z: number, yaw: number) => {
    // two blocks per bag, along it
    const ux = Math.cos(yaw), uz = -Math.sin(yaw), half = BAG.len / 4; // (the bag's length lies along its local x)
    for (const side of [-1, 1]) {
      Matrix.ComposeToRef(
        new Vector3(BAG.len / 2 - 0.02, BAG.h * 0.88, BAG.depth * 0.97),
        Quaternion.RotationYawPitchRoll(yaw, 0, 0),
        new Vector3(x + ux * half * side, y, z + uz * half * side),
        m,
      );
      blockM.push(...m.asArray());
      const b = BLOCK[Math.floor(r() * BLOCK.length)];
      blockC.push(b[0], b[1], b[2], 1);
    }
  };
  const courseY = (c: number) => BAG.h * 0.5 + c * BAG.h * 0.88;

  /** Straight wall along a segment; `courses` high, the lower `double` courses two bags thick. */
  const wall = (s: WallSegment, courses: number, double: number) => {
    const dx = s.bx - s.ax, dz = s.bz - s.az, len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, yaw = Math.atan2(ux, uz) + Math.PI / 2;
    const n = Math.max(1, Math.round(len / BAG.len));
    for (let c = 0; c < courses; c++) {
      const rows = c < double ? [-BAG.depth * 0.5, BAG.depth * 0.5] : [0];
      const shift = c % 2 ? 0.5 : 0;
      for (const off of rows) {
        for (let i = 0; i < n + (shift ? 0 : 1); i++) {
          const t = Math.min(len, (i + shift) * (len / n));
          put(s.ax + ux * t - uz * off, courseY(c), s.az + uz * t + ux * off, yaw);
        }
      }
    }
  };

  /** Ring of bags (corner bastion, gate post). */
  const ring = (b: Bastion, courses: number) => {
    for (let c = 0; c < courses; c++) {
      const n = Math.max(4, Math.round((2 * Math.PI * b.r) / BAG.len));
      for (let i = 0; i < n; i++) {
        const a = ((i + (c % 2 ? 0.5 : 0)) / n) * Math.PI * 2;
        put(b.x + Math.cos(a) * b.r, courseY(c), b.z + Math.sin(a) * b.r, -a - Math.PI / 2); // along the ring
      }
    }
  };

  for (const s of COMPOUND_WALLS) wall(s, 5, 3);
  for (const b of COMPOUND_BASTIONS) {
    ring(b, 6);
    ring({ x: b.x, z: b.z, r: b.r - BAG.depth }, 5);
    ring({ x: b.x, z: b.z, r: Math.max(0.2, b.r - BAG.depth * 2) }, 4);
  }
  // gate posts: short, tall stacks on both sides of the entrance
  for (const x of [-COMPOUND.gate - 0.3, COMPOUND.gate + 0.3]) ring({ x, z: COMPOUND.hd, r: 0.5 }, 7);
  // barricaded windows (front and back of the hall) and a firing position by the door
  for (const z of [4.4, -4.4]) {
    for (const x of [-4.2, 4.2]) wall({ ax: x - 0.9, az: z, bx: x + 0.9, bz: z }, 4, 1);
  }
  wall({ ax: -3.2, az: 5.6, bx: -1.9, bz: 5.6 }, 3, 2);
  wall({ ax: 1.9, az: 5.6, bx: 3.2, bz: 5.6 }, 3, 2);

  block.thinInstanceSetBuffer("matrix", new Float32Array(blockM), 16, true);
  block.thinInstanceSetBuffer("color", new Float32Array(blockC), 4, true);
  block.thinInstanceRefreshBoundingInfo(false);
  block.isPickable = false;
  block.receiveShadows = true;
  return block;
}
