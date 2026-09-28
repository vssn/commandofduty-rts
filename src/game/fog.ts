import { MAP_HALF, PLAYER, SIGHT } from "../config";
import { toLocal } from "../world/layout";
import type { Game } from "./game";

/** Cell size of the fog grid in world units. */
const CELL = 2;
/** Brightness levels written to the fog texture. */
const LEVEL = { hidden: 0, explored: 0.45, visible: 1 };
/** Units always see their immediate surroundings, even from inside a wood. */
const NEAR = 2.5;

/**
 * Fog of war for the player. Visibility is recomputed a few times per second by casting sight
 * rays from every own unit, the barracks and owned outposts; trees and buildings stop the rays,
 * hedges, fields and sandbags don't. Cells are hidden (never seen), explored (seen before) or
 * visible (in sight now). `values` holds a smoothed 0..1 brightness per cell for rendering.
 */
export class FogOfWar {
  readonly n = (MAP_HALF * 2) / CELL;
  /** Smoothed brightness per cell (row-major, z rows), read by the renderer and the minimap. */
  readonly values: Float32Array;
  private readonly visible: Uint8Array;
  private readonly explored: Uint8Array;
  /** 1-unit grid of sight blockers (trees, buildings). */
  private readonly blockers: Uint8Array;
  private readonly bn = MAP_HALF * 2;
  private recalcT = 0;

  constructor(private readonly game: Game) {
    const size = this.n * this.n;
    this.values = new Float32Array(size);
    this.visible = new Uint8Array(size);
    this.explored = new Uint8Array(size);
    this.blockers = new Uint8Array(this.bn * this.bn);
  }

  // ---------------------------------------------------------------- blockers

  blockCircle(x: number, z: number, r: number) {
    this.eachBlockerCell(x, z, r, (cx, cz) => (cx - x) ** 2 + (cz - z) ** 2 <= r * r);
  }

  blockRect(x: number, z: number, hw: number, hd: number, rot: number) {
    this.eachBlockerCell(x, z, Math.hypot(hw, hd), (cx, cz) => {
      const l = toLocal(x, z, rot, cx, cz);
      return Math.abs(l.x) <= hw && Math.abs(l.z) <= hd;
    });
  }

  private eachBlockerCell(x: number, z: number, ext: number, inside: (cx: number, cz: number) => boolean) {
    const i0 = Math.max(0, Math.floor(x - ext + MAP_HALF)), i1 = Math.min(this.bn - 1, Math.floor(x + ext + MAP_HALF));
    const j0 = Math.max(0, Math.floor(z - ext + MAP_HALF)), j1 = Math.min(this.bn - 1, Math.floor(z + ext + MAP_HALF));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (inside(i + 0.5 - MAP_HALF, j + 0.5 - MAP_HALF)) this.blockers[i + j * this.bn] = 1;
    }
  }

  private blocked(x: number, z: number): boolean {
    const i = Math.floor(x + MAP_HALF), j = Math.floor(z + MAP_HALF);
    return i >= 0 && j >= 0 && i < this.bn && j < this.bn && this.blockers[i + j * this.bn] === 1;
  }

  // ---------------------------------------------------------------- queries

  private cellIndex(x: number, z: number): number {
    const i = Math.floor((x + MAP_HALF) / CELL), j = Math.floor((z + MAP_HALF) / CELL);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return i + j * this.n;
  }

  /** In sight of the player right now. */
  isVisible(x: number, z: number): boolean {
    const k = this.cellIndex(x, z);
    return k >= 0 && this.visible[k] === 1;
  }

  /** Seen at some point (terrain and buildings are known). */
  isExplored(x: number, z: number): boolean {
    const k = this.cellIndex(x, z);
    return k < 0 || this.explored[k] === 1;
  }

  // ---------------------------------------------------------------- update

  /** `near`: distance within which blockers are ignored (a building must not block its own view). */
  private reveal(ox: number, oz: number, radius: number, near = NEAR) {
    const rays = Math.ceil(radius * 6.5);
    const step = 0.7;
    for (let r = 0; r < rays; r++) {
      const a = (r / rays) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      for (let d = 0; d <= radius; d += step) {
        const x = ox + dx * d, z = oz + dz * d;
        const k = this.cellIndex(x, z);
        if (k < 0) break;
        this.visible[k] = 1;
        // the blocking tree/house itself is seen, what lies behind it is not
        if (d > near && this.blocked(x, z)) break;
      }
    }
  }

  private recompute() {
    const g = this.game;
    this.visible.fill(0);
    for (const u of g.units) {
      if (!u.alive || u.team !== PLAYER || u.vehicle) continue;
      this.reveal(u.x, u.z, SIGHT[u.type]);
    }
    // the barracks and captured outposts have all-round vision: nothing blocks their view
    for (const b of g.buildings) if (b.alive && b.team === PLAYER) this.reveal(b.x, b.z, SIGHT.barracks, Infinity);
    for (const o of g.outposts) if (o.owner === PLAYER) this.reveal(o.x, o.z, SIGHT.outpost, Infinity);
    for (let k = 0; k < this.visible.length; k++) if (this.visible[k]) this.explored[k] = 1;
  }

  update(dt: number) {
    this.recalcT -= dt;
    if (this.recalcT <= 0) {
      this.recalcT = 0.15;
      this.recompute();
    }
    // fade towards the target brightness so revealed / lost areas blend smoothly
    const k = Math.min(1, dt * 5);
    for (let i = 0; i < this.values.length; i++) {
      const target = this.visible[i] ? LEVEL.visible : this.explored[i] ? LEVEL.explored : LEVEL.hidden;
      this.values[i] += (target - this.values[i]) * k;
    }
    this.applyToUnits();
  }

  /** Enemy units outside the player's sight are not drawn. */
  private applyToUnits() {
    for (const u of this.game.units) {
      if (u.team === PLAYER || u.vehicle) continue;
      const show = !u.alive ? !u.fogHidden : this.isVisible(u.x, u.z);
      if (show === u.fogHidden) {
        u.fogHidden = !show;
        u.view.setEnabled(show);
      }
    }
  }
}
