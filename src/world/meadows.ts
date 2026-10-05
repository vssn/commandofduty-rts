import { Axis, Color3, Mesh, Matrix, MeshBuilder, Quaternion, StandardMaterial, Vector3, VertexData, type Scene, type ShadowGenerator } from "@babylonjs/core";
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


/**
 * One tussock of tall grass: a bundle of long, narrow blades that arch outwards in every direction,
 * dark at the root and pale straw-green at the tips, a few with a feathery tip. Blades are flat
 * ribbons of three segments, so a tussock reads as a clump from above and from the side. Unit height
 * (the instances scale it); the colours are vertex colours.
 */
export function tussockMesh(scene: Scene, seed: number): Mesh {
  const r = rng(seed);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const blades = 15;
  for (let b = 0; b < blades; b++) {
    const a = r() * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const root = 0.03 + r() * 0.1;
    const bx = ca * root, bz = sa * root;
    const h = 0.6 + r() * 0.4;            // blade height (unit tussock height 1)
    const lean = 0.18 + r() * 0.5;        // how far the tip arches outwards
    const w = 0.035 + r() * 0.025;        // half width at the base
    const px = -sa, pz = ca;              // across the blade
    const SEG = 3;
    let prev: [number, number] | null = null;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const ox = ca * lean * t * t, oz = sa * lean * t * t;
      const y = h * (t - 0.12 * t * t);
      const wt = w * (1 - t) * (1 - 0.15 * t) + 0.002;
      // dark at the root, light and yellowish at the tip
      const k = 0.35 + t * 0.85;
      const c: [number, number, number] = [0.3 + 0.55 * t * t, 0.38 + 0.4 * t, 0.16 + 0.1 * t];
      const v0 = pos.length / 3;
      pos.push(bx + ox - px * wt, y, bz + oz - pz * wt, bx + ox + px * wt, y, bz + oz + pz * wt);
      for (let q = 0; q < 2; q++) {
        nor.push(ca * 0.4, 1, sa * 0.4);
        col.push(c[0] * k, c[1] * k, c[2] * k, 1);
      }
      if (prev) idx.push(prev[0], prev[1], v0, prev[1], v0 + 1, v0);
      prev = [v0, v0 + 1];
    }
    // a feathery tip on some blades: a short pale spike
    if (b % 4 === 0) {
      const t = 1;
      const ox = ca * lean, oz = sa * lean, y = h * (1 - 0.12);
      const base = pos.length / 3;
      pos.push(bx + ox - px * 0.02, y, bz + oz - pz * 0.02, bx + ox + px * 0.02, y, bz + oz + pz * 0.02, bx + ox + ca * 0.1 * t, y + 0.2, bz + oz + sa * 0.1 * t);
      for (let q = 0; q < 3; q++) {
        nor.push(0, 1, 0);
        col.push(0.95, 0.9, 0.62, 1);
      }
      idx.push(base, base + 1, base + 2);
    }
  }
  const m = new Mesh("tussock", scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.colors = col;
  vd.indices = idx;
  vd.applyToMesh(m);
  return m;
}

/** The tussocks bend away from units that pass and spring back slowly. */
export interface TussockField {
  /** Shown in the realistic mode only (hidden in the classic look, and then not even updated). */
  setRealistic(on: boolean): void;
  update(dt: number, units: readonly { x: number; z: number; alive: boolean; vehicle: unknown; isVehicle: boolean; isStructure: boolean; type: string }[]): void;
}

/**
 * Tall grass along the edges of the meadows (like hedgerows along the fields, but nothing like them):
 * loose tussocks of grass up to two metres high, in groups with gaps between. Nobody is held up by
 * them - no obstacle, no cover, nothing that blocks the view. Units that pass bend them aside (and
 * flatten them a little), so the grass never pokes through a jeep; afterwards they straighten up.
 */
export function createMeadowTussocks(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator): TussockField {
  const r = rng(5150);
  const variants = [tussockMesh(scene, 11), tussockMesh(scene, 29), tussockMesh(scene, 47)];
  const mat = new StandardMaterial("tussockMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false;
  /** One tussock: where it stands, its size and turn, which variant mesh and slot it is. */
  const inst: { x: number; y: number; z: number; w: number; h: number; yaw: number; v: number; slot: number; bend: number; dx: number; dz: number }[] = [];
  const counts = [0, 0, 0];
  const cols: number[][] = [[], [], []];
  for (const m of layout.meadows) {
    const rays = 56;
    for (let k = 0; k < rays; k++) {
      if (r() < 0.3) continue; // gaps
      const a = (k / rays) * Math.PI * 2 + (r() - 0.5) * 0.08;
      const dx = Math.cos(a), dz = Math.sin(a);
      // walk out from the centre to where the meadow's (ragged) edge is
      let reach = 0;
      for (let t = 2; t < Math.hypot(m.hw, m.hd) * 1.3; t += 0.5) {
        const p = toWorld(m.cx, m.cz, m.rot, dx * t, dz * t);
        const at = layout.meadowAt(p.x, p.z);
        if (!at || at.m !== m || at.cover < 0.55) break;
        reach = t;
      }
      if (reach < 4) continue;
      // a cluster of one to three tussocks just inside the edge
      const count = 1 + Math.floor(r() * 3);
      for (let c = 0; c < count; c++) {
        const tt = reach - 0.3 - r() * 1.4;
        const lp = toWorld(m.cx, m.cz, m.rot, dx * tt + (r() - 0.5) * 1.3, dz * tt + (r() - 0.5) * 1.3);
        if (layout.nearestRoad(lp.x, lp.z).d < 1.2 || layout.fieldAt(lp.x, lp.z) || layout.houseAt(lp.x, lp.z, 1)) continue;
        const h = 1.2 + r() * r() * 1.1;                  // up to about 2.3 m
        const w = h * (0.55 + r() * 0.35);                // wide in proportion
        const v = Math.floor(r() * variants.length);
        inst.push({ x: lp.x, y: terrain.heightAt(lp.x, lp.z) - 0.05, z: lp.z, w, h, yaw: r() * Math.PI * 2, v, slot: counts[v]++, bend: 0, dx: 0, dz: 1 });
        // dry meadows give golden tussocks, lush ones greener; every one a little different
        const dry = 1 - m.tone, tint = 0.85 + r() * 0.3;
        cols[v].push(Math.min(1.2, tint * (0.95 + dry * 0.25)), Math.min(1.2, tint * (1 - dry * 0.05)), tint * (1 - dry * 0.2), 1);
      }
    }
  }

  const buffers = counts.map((n) => new Float32Array(n * 16));
  const m4 = new Matrix();
  const writeMatrix = (t: (typeof inst)[number]) => {
    // bent: tilted away from the unit (about the horizontal axis across the push) and squashed a little
    const yaw = Quaternion.RotationAxis(Axis.Y, t.yaw);
    const q = t.bend > 0.002 ? Quaternion.RotationAxis(new Vector3(t.dz, 0, -t.dx), 1.2 * t.bend).multiply(yaw) : yaw;
    Matrix.ComposeToRef(new Vector3(t.w, t.h * (1 - 0.5 * t.bend), t.w), q, new Vector3(t.x, t.y, t.z), m4);
    m4.copyToArray(buffers[t.v], t.slot * 16);
  };
  inst.forEach(writeMatrix);
  variants.forEach((mesh, i) => {
    if (!counts[i]) {
      mesh.dispose();
      return;
    }
    mesh.material = mat;
    mesh.setEnabled(false); // (the realistic mode shows them)
    mesh.thinInstanceSetBuffer("matrix", buffers[i], 16, false); // (updatable: the grass moves)
    mesh.thinInstanceSetBuffer("color", new Float32Array(cols[i]), 4, true);
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    shadows.addShadowCaster(mesh);
  });

  // spatial grid, to find the tussocks near a unit quickly
  const CELL = 6;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 4096 + cz;
  inst.forEach((t, id) => {
    const k = key(Math.floor(t.x / CELL), Math.floor(t.z / CELL));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
  });
  const active = new Set<number>(); // tussocks that are bent (or being pushed)
  let visible = false;

  return {
    setRealistic(on) {
      visible = on;
      for (const m of variants) if (!m.isDisposed()) m.setEnabled(on);
    },
    update(dt, units) {
      if (!visible) return;
      // how hard each tussock near a unit is pushed (0..1) and the way
      const push = new Map<number, { p: number; dx: number; dz: number }>();
      for (const u of units) {
        if (!u.alive || u.vehicle || u.isStructure || u.type === "drone") continue;
        const R = u.isVehicle ? 3.4 : 1.25;
        for (let cx = Math.floor((u.x - R) / CELL); cx <= Math.floor((u.x + R) / CELL); cx++) {
          for (let cz = Math.floor((u.z - R) / CELL); cz <= Math.floor((u.z + R) / CELL); cz++) {
            const ids = grid.get(key(cx, cz));
            if (!ids) continue;
            for (const id of ids) {
              const t = inst[id];
              const ddx = t.x - u.x, ddz = t.z - u.z, d = Math.hypot(ddx, ddz);
              if (d >= R) continue;
              const p = Math.min(1, (1 - d / R) * 1.6);
              const prev = push.get(id);
              if (!prev || p > prev.p) push.set(id, { p, dx: d > 0.01 ? ddx / d : 0, dz: d > 0.01 ? ddz / d : 1 });
            }
          }
        }
      }
      for (const id of push.keys()) active.add(id);
      const dirty = new Set<number>();
      for (const id of active) {
        const t = inst[id];
        const pu = push.get(id);
        const target = pu ? pu.p : 0;
        if (pu) {
          t.dx = pu.dx;
          t.dz = pu.dz;
        }
        // bends quickly when something comes through, straightens up slowly
        t.bend += (target - t.bend) * Math.min(1, dt * (target > t.bend ? 9 : 1.1));
        if (t.bend < 0.003 && !pu) {
          t.bend = 0;
          active.delete(id);
        }
        writeMatrix(t);
        dirty.add(t.v);
      }
      for (const v of dirty) variants[v].thinInstanceBufferUpdated("matrix");
    },
  };
}
