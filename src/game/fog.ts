import { MAP_HALF, PLAYER, SIGHT, type UnitType } from "../config";
import { toLocal } from "../world/layout";
import type { Game } from "./game";
import type { Unit } from "./unit";

/** Cell size of the fog grid in world units. */
const CELL = 2;
/** Brightness levels written to the fog texture. */
const LEVEL = { hidden: 0, explored: 0.45, visible: 1 };
/** Units always see their immediate surroundings, even from inside a wood. */
const NEAR = 2.5;
/** Eye height above the ground (the jeep's gunner stands high on the bed). */
const EYE: Record<UnitType, number> = { rifleman: 2.3, grenadier: 2.3, medic: 2.3, mgnest: 1.9, bollard: 1.2, jeep: 3.2, agent: 2.6 };
/** A cell counts as seen if a point this high above its ground is in view (a soldier's chest). */
const TARGET = 1.4;
/** Small bumps of the terrain don't hide anything. */
const BUMP = 0.35;
/** Extra sight per unit of height above the surroundings, and its cap. */
const HIGH_GROUND = { perUnit: 1.3, max: 12 };

/**
 * Fog of war for the player. Visibility is recomputed a few times per second by casting sight
 * rays from every own unit, the barracks and owned outposts. The rays are height-aware: each keeps
 * the steepest "horizon" seen so far (hill crests, tree tops, roofs) and only what rises above it is
 * visible. So units on high ground look over woods and villages far into the valley, while a crest
 * hides what lies behind it. Hedges, fields and sandbags don't block. Units on high ground also see
 * farther. Cells are hidden (never seen), explored (seen before) or visible (in sight now);
 * `values` holds a smoothed 0..1 brightness per cell for rendering.
 */
export class FogOfWar {
  readonly n = (MAP_HALF * 2) / CELL;
  /** Smoothed brightness per cell (row-major, z rows), read by the renderer and the minimap. */
  readonly values: Float32Array;
  private readonly visible: Uint8Array;
  private readonly explored: Uint8Array;
  /** 1-unit grid: height of sight blockers above the ground (trees, buildings), 0 = none. */
  private readonly blockers: Float32Array;
  /** 1-unit grid of ground heights (cached from the terrain). */
  private readonly ground: Float32Array;
  private readonly bn = MAP_HALF * 2;
  private recalcT = 0;

  constructor(private readonly game: Game) {
    const size = this.n * this.n;
    this.values = new Float32Array(size);
    this.visible = new Uint8Array(size);
    this.explored = new Uint8Array(size);
    this.blockers = new Float32Array(this.bn * this.bn);
    this.ground = new Float32Array(this.bn * this.bn);
    for (let j = 0; j < this.bn; j++) {
      for (let i = 0; i < this.bn; i++) this.ground[i + j * this.bn] = game.terrain.heightAt(i + 0.5 - MAP_HALF, j + 0.5 - MAP_HALF);
    }
  }

  // ---------------------------------------------------------------- blockers

  /** Round blocker (tree) of the given height above the ground. */
  blockCircle(x: number, z: number, r: number, height: number) {
    this.eachBlockerCell(x, z, r, height, (cx, cz) => (cx - x) ** 2 + (cz - z) ** 2 <= r * r);
  }

  /** Rectangular blocker (building) of the given height above the ground. */
  blockRect(x: number, z: number, hw: number, hd: number, rot: number, height: number) {
    this.eachBlockerCell(x, z, Math.hypot(hw, hd), height, (cx, cz) => {
      const l = toLocal(x, z, rot, cx, cz);
      return Math.abs(l.x) <= hw && Math.abs(l.z) <= hd;
    });
  }

  /** Removes sight blockers in a rotated rectangle. */
  clearRect(x: number, z: number, hw: number, hd: number, rot: number) {
    const i0 = Math.max(0, Math.floor(x - Math.hypot(hw, hd) + MAP_HALF)), i1 = Math.min(this.bn - 1, Math.floor(x + Math.hypot(hw, hd) + MAP_HALF));
    const j0 = Math.max(0, Math.floor(z - Math.hypot(hw, hd) + MAP_HALF)), j1 = Math.min(this.bn - 1, Math.floor(z + Math.hypot(hw, hd) + MAP_HALF));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const l = toLocal(x, z, rot, i + 0.5 - MAP_HALF, j + 0.5 - MAP_HALF);
        if (Math.abs(l.x) <= hw && Math.abs(l.z) <= hd) this.blockers[i + j * this.bn] = 0;
      }
    }
  }

  private eachBlockerCell(x: number, z: number, ext: number, height: number, inside: (cx: number, cz: number) => boolean) {
    const i0 = Math.max(0, Math.floor(x - ext + MAP_HALF)), i1 = Math.min(this.bn - 1, Math.floor(x + ext + MAP_HALF));
    const j0 = Math.max(0, Math.floor(z - ext + MAP_HALF)), j1 = Math.min(this.bn - 1, Math.floor(z + ext + MAP_HALF));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = i + j * this.bn;
        if (inside(i + 0.5 - MAP_HALF, j + 0.5 - MAP_HALF)) this.blockers[k] = Math.max(this.blockers[k], height);
      }
    }
  }

  private groundAt(x: number, z: number): number {
    const i = Math.min(this.bn - 1, Math.max(0, Math.floor(x + MAP_HALF)));
    const j = Math.min(this.bn - 1, Math.max(0, Math.floor(z + MAP_HALF)));
    return this.ground[i + j * this.bn];
  }

  private blockerAt(x: number, z: number): number {
    const i = Math.floor(x + MAP_HALF), j = Math.floor(z + MAP_HALF);
    return i >= 0 && j >= 0 && i < this.bn && j < this.bn ? this.blockers[i + j * this.bn] : 0;
  }

  /** Extra sight range from standing above the surrounding terrain. */
  sightBonus(u: Unit): number {
    const base = SIGHT[u.type];
    const h = this.groundAt(u.x, u.z);
    let around = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      around += this.groundAt(u.x + Math.cos(a) * base, u.z + Math.sin(a) * base);
    }
    const adv = h - around / 8;
    return Math.min(HIGH_GROUND.max, Math.max(0, adv * HIGH_GROUND.perUnit));
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

  /**
   * Casts sight rays from (ox, oz) with the eye `eye` units above the ground. `occlusion` = false
   * gives unobstructed all-round vision (barracks, outposts).
   */
  private reveal(ox: number, oz: number, radius: number, eye: number, occlusion = true) {
    const rays = Math.ceil(radius * 6.5);
    const step = 0.7;
    const eyeY = this.groundAt(ox, oz) + eye;
    for (let r = 0; r < rays; r++) {
      const a = (r / rays) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      let horizon = -Infinity; // steepest slope of anything seen so far along this ray
      for (let d = step; d <= radius; d += step) {
        const x = ox + dx * d, z = oz + dz * d;
        const k = this.cellIndex(x, z);
        if (k < 0) break;
        if (!occlusion || d <= NEAR) {
          this.visible[k] = 1;
          continue;
        }
        const g = this.groundAt(x, z);
        if ((g + TARGET - eyeY) / d >= horizon) this.visible[k] = 1;
        // crests, tree tops and roofs raise the horizon; the blocker itself is still seen
        const block = this.blockerAt(x, z);
        const top = block > 0 ? g + block : g - BUMP;
        horizon = Math.max(horizon, (top - eyeY) / d);
      }
    }
  }

  private recompute() {
    const g = this.game;
    this.visible.fill(0);
    for (const u of g.units) {
      if (!u.alive || u.team !== PLAYER || u.vehicle) continue;
      this.reveal(u.x, u.z, SIGHT[u.type] + this.sightBonus(u), EYE[u.type]);
    }
    // the barracks and captured outposts have all-round vision: nothing blocks their view
    for (const b of g.buildings) if (b.alive && b.team === PLAYER) this.reveal(b.x, b.z, SIGHT.barracks, 8, false);
    for (const o of g.outposts) if (o.owner === PLAYER) this.reveal(o.x, o.z, SIGHT.outpost, 6, false);
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
