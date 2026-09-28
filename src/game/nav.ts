import { MAP_HALF } from "../config";
import { toLocal, type V2 } from "../world/layout";

const SQRT2 = Math.SQRT2;
/** Slightly greedy A*: paths stay near-optimal but far fewer cells are searched on the fine grid. */
const HEURISTIC_WEIGHT = 1.2;

/** 0 = infantry, 1 = vehicles (obstacles grown by the larger vehicle size). */
export type NavLayer = 0 | 1;
/** How far each layer keeps unit centres away from obstacles. */
const CLEARANCE: Record<NavLayer, number> = { 0: 0.45, 1: 1.9 };

/**
 * Uniform 1-unit grid over the playable area with A* path finding. Obstacles (buildings, tree
 * trunks, hedges) are rasterised once per layer, inflated by that layer's clearance, so a unit
 * whose centre stays on free cells never overlaps an obstacle.
 */
export class NavGrid {
  readonly cs = 1;
  readonly n = Math.round(MAP_HALF * 2);
  private readonly blocked: [Uint8Array, Uint8Array];
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly from: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private search = 0;

  constructor() {
    const size = this.n * this.n;
    this.blocked = [new Uint8Array(size), new Uint8Array(size)];
    this.g = new Float32Array(size);
    this.f = new Float32Array(size);
    this.from = new Int32Array(size);
    this.stamp = new Uint32Array(size);
    this.closed = new Uint32Array(size);
  }

  /** Blocks a rotated rectangle (e.g. a building) plus `pad`, on both layers. */
  blockRect(cx: number, cz: number, hw: number, hd: number, rot: number, pad = 0.25) {
    for (const layer of [0, 1] as NavLayer[]) {
      const p = pad + CLEARANCE[layer];
      this.eachCell(cx, cz, Math.hypot(hw, hd) + p, (x, z, k) => {
        const l = toLocal(cx, cz, rot, x, z);
        if (Math.abs(l.x) < hw + p && Math.abs(l.z) < hd + p) this.blocked[layer][k] = 1;
      });
    }
  }

  /** Blocks a round obstacle such as a tree trunk, on both layers. */
  blockCircle(cx: number, cz: number, r: number) {
    for (const layer of [0, 1] as NavLayer[]) {
      const rr = r + CLEARANCE[layer];
      this.eachCell(cx, cz, rr, (x, z, k) => {
        if ((x - cx) ** 2 + (z - cz) ** 2 < rr * rr) this.blocked[layer][k] = 1;
      });
    }
  }

  private eachCell(cx: number, cz: number, ext: number, fn: (x: number, z: number, k: number) => void) {
    const [i0, j0] = this.cellCoords(cx - ext, cz - ext);
    const [i1, j1] = this.cellCoords(cx + ext, cz + ext);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.center(i, j);
        fn(c.x, c.z, i + j * this.n);
      }
    }
  }

  private cellCoords(x: number, z: number): [number, number] {
    const i = Math.floor((x + MAP_HALF) / this.cs), j = Math.floor((z + MAP_HALF) / this.cs);
    return [Math.min(Math.max(i, 0), this.n - 1), Math.min(Math.max(j, 0), this.n - 1)];
  }

  private center(i: number, j: number): V2 {
    return { x: -MAP_HALF + (i + 0.5) * this.cs, z: -MAP_HALF + (j + 0.5) * this.cs };
  }

  isBlocked(x: number, z: number, layer: NavLayer = 0): boolean {
    const [i, j] = this.cellCoords(x, z);
    return this.blocked[layer][i + j * this.n] === 1;
  }

  lineClear(ax: number, az: number, bx: number, bz: number, layer: NavLayer = 0): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / 0.4);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.isBlocked(ax + (bx - ax) * t, az + (bz - az) * t, layer)) return false;
    }
    return true;
  }

  /** Nearest unblocked cell (ring search). */
  private nearestFree(idx: number, layer: NavLayer): number {
    const blocked = this.blocked[layer];
    if (!blocked[idx]) return idx;
    const n = this.n, ci = idx % n, cj = Math.floor(idx / n);
    for (let r = 1; r < 40; r++) {
      let best = -1, bd = Infinity;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          const k = i + j * n;
          if (blocked[k]) continue;
          const d = (i - ci) ** 2 + (j - cj) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
      }
      if (best >= 0) return best;
    }
    return idx;
  }

  /** Nearest walkable point to (x, z). */
  freePoint(x: number, z: number, layer: NavLayer = 0): V2 {
    if (!this.isBlocked(x, z, layer)) return { x, z };
    const [i, j] = this.cellCoords(x, z);
    const k = this.nearestFree(i + j * this.n, layer);
    return this.center(k % this.n, Math.floor(k / this.n));
  }

  /** Returns waypoints (excluding the start) from start to target. */
  findPath(sx: number, sz: number, tx: number, tz: number, layer: NavLayer = 0): V2[] {
    const blocked = this.blocked[layer];
    const lim = MAP_HALF - 1;
    tx = Math.min(Math.max(tx, -lim), lim);
    tz = Math.min(Math.max(tz, -lim), lim);
    if (this.isBlocked(tx, tz, layer)) ({ x: tx, z: tz } = this.freePoint(tx, tz, layer));
    if (this.lineClear(sx, sz, tx, tz, layer)) return [{ x: tx, z: tz }];

    const n = this.n;
    const [si, sj] = this.cellCoords(sx, sz);
    const [ti, tj] = this.cellCoords(tx, tz);
    const start = this.nearestFree(si + sj * n, layer);
    const goal = this.nearestFree(ti + tj * n, layer);
    const gi = goal % n, gj = Math.floor(goal / n);
    const h = (k: number) => {
      const dx = Math.abs((k % n) - gi), dz = Math.abs(Math.floor(k / n) - gj);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * HEURISTIC_WEIGHT;
    };

    const sid = ++this.search;
    const heap: number[] = [];
    const push = (k: number) => {
      heap.push(k);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (this.f[heap[p]] <= this.f[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < heap.length && this.f[heap[l]] < this.f[heap[m]]) m = l;
          if (r < heap.length && this.f[heap[r]] < this.f[heap[m]]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };

    this.stamp[start] = sid;
    this.g[start] = 0;
    this.f[start] = h(start);
    this.from[start] = -1;
    push(start);
    let found = false;
    let closest = start, closestH = Infinity;

    while (heap.length) {
      const cur = pop();
      if (this.closed[cur] === sid) continue;
      this.closed[cur] = sid;
      if (cur === goal) { found = true; break; }
      const hc = h(cur);
      if (hc < closestH) { closestH = hc; closest = cur; }
      const ci = cur % n, cj = Math.floor(cur / n);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const k = ni + nj * n;
          if (blocked[k] || this.closed[k] === sid) continue;
          if (di && dj && (blocked[ci + di + cj * n] || blocked[ci + (cj + dj) * n])) continue;
          const g = this.g[cur] + (di && dj ? SQRT2 : 1);
          if (this.stamp[k] !== sid || g < this.g[k]) {
            this.stamp[k] = sid;
            this.g[k] = g;
            this.f[k] = g + h(k);
            this.from[k] = cur;
            push(k);
          }
        }
      }
    }
    // unreachable (e.g. a jeep ordered into a forest): go as close as the search got
    let end = goal;
    if (!found) {
      if (closest === start) return [];
      end = closest;
      ({ x: tx, z: tz } = this.center(end % n, Math.floor(end / n)));
    }

    const cells: V2[] = [];
    for (let k = end; k !== -1 && k !== start; k = this.from[k]) cells.push(this.center(k % n, Math.floor(k / n)));
    cells.reverse();
    const pts: V2[] = [{ x: sx, z: sz }, ...cells.slice(0, -1), { x: tx, z: tz }];

    // string pulling: keep only the waypoints needed to stay clear of obstacles
    const out: V2[] = [];
    let anchor = 0;
    for (let k = 1; k < pts.length; k++) {
      if (k === pts.length - 1 || !this.lineClear(pts[anchor].x, pts[anchor].z, pts[k + 1].x, pts[k + 1].z, layer)) {
        out.push(pts[k]);
        anchor = k;
      }
    }
    return out;
  }
}
