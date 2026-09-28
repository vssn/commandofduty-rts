import { MAP_HALF } from "../config";
import { toLocal, type MapLayout, type V2 } from "../world/layout";

export type CoverKind = 0 | 1 | 2 | 3; // none, vegetation (trees), hedge, building

const COVER_NAMES = ["", "Bäume", "Hecke", "Gebäude"] as const;

/** Grid over the playable area telling whether a spot is next to trees, hedges or buildings. */
export class CoverMap {
  private readonly cs = 1;
  private readonly n = MAP_HALF * 2;
  private readonly grid: Uint8Array;

  constructor(layout: MapLayout, trees: V2[], hedges: V2[], buildings: { x: number; z: number; hw: number; hd: number; rot: number }[]) {
    this.grid = new Uint8Array(this.n * this.n);
    for (const t of trees) this.stamp(t.x, t.z, 2.6, 1);
    for (const h of hedges) this.stamp(h.x, h.z, 2.4, 2);
    const rects = [
      ...layout.houses.map((h) => ({ x: h.x, z: h.z, hw: h.w / 2, hd: h.d / 2, rot: h.rot })),
      ...buildings,
    ];
    for (const r of rects) {
      const pad = 2.5, ext = Math.hypot(r.hw, r.hd) + pad;
      this.each(r.x, r.z, ext, (cx, cz, k) => {
        const l = toLocal(r.x, r.z, r.rot, cx, cz);
        if (Math.abs(l.x) < r.hw + pad && Math.abs(l.z) < r.hd + pad) this.grid[k] = 3;
      });
    }
  }

  private each(x: number, z: number, r: number, fn: (cx: number, cz: number, k: number) => void) {
    const i0 = Math.max(0, Math.floor((x - r + MAP_HALF) / this.cs)), i1 = Math.min(this.n - 1, Math.floor((x + r + MAP_HALF) / this.cs));
    const j0 = Math.max(0, Math.floor((z - r + MAP_HALF) / this.cs)), j1 = Math.min(this.n - 1, Math.floor((z + r + MAP_HALF) / this.cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) fn(-MAP_HALF + (i + 0.5) * this.cs, -MAP_HALF + (j + 0.5) * this.cs, i + j * this.n);
    }
  }

  private stamp(x: number, z: number, r: number, kind: CoverKind) {
    this.each(x, z, r, (cx, cz, k) => {
      if (Math.hypot(cx - x, cz - z) <= r && this.grid[k] < kind) this.grid[k] = kind;
    });
  }

  at(x: number, z: number): CoverKind {
    const i = Math.floor((x + MAP_HALF) / this.cs), j = Math.floor((z + MAP_HALF) / this.cs);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return 0;
    return this.grid[i + j * this.n] as CoverKind;
  }

  static label(kind: CoverKind): string {
    return COVER_NAMES[kind];
  }
}
