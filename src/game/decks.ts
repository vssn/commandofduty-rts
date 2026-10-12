import { MAP_HALF } from "../config";
import { toWorld, type V2 } from "../world/layout";
import { deckHeight, type PowerPlant } from "../world/power";
import { NavGrid } from "./nav";

/** A waypoint; `level` set where a unit changes level on reaching it (onto a stair, or off it). */
export type PathPoint = V2 & { level?: 0 | 1 };

/** Where a stair meets the ground: `bottom` on the ground before it, `foot` on its lowest step, `top` on the walkway. */
export interface StairLink { bottom: V2; foot: V2; top: V2 }

/**
 * The raised level of the power station: walkways, platforms and stairs that units can stand on while
 * others pass underneath. Each unit knows its level (0 ground, 1 raised); the raised level has its own
 * navigation grid (free only on the walkways and stairs), and routes between the levels run over the
 * stairs. On the ground a stair is solid except at its foot; the walkways' supports are obstacles there.
 */
export class Decks {
  readonly nav = new NavGrid();
  readonly links: StairLink[] = [];

  constructor(readonly plant: PowerPlant, ground: NavGrid) {
    // up there: blocked everywhere except on the walkways and stairs (each stair reaching a little into
    // the walkway at its top, so the two join)
    this.nav.blockRect(0, 0, MAP_HALF, MAP_HALF, 0, 0);
    for (const d of plant.decks) this.nav.clearRect(d.x, d.z, d.hw, d.hd, d.rot);
    for (const s of plant.stairs) {
      const c = toWorld(s.x, s.z, s.rot, 0, 0.6);
      this.nav.clearRect(c.x, c.z, s.hw - 0.2, s.hd + 0.6, s.rot);
      // on the ground the stair is solid, its foot free
      const g = toWorld(s.x, s.z, s.rot, 0, 0.9);
      ground.blockRect(g.x, g.z, s.hw, s.hd - 0.9, s.rot, 0.05);
      this.links.push({
        bottom: toWorld(s.x, s.z, s.rot, 0, -s.hd - 1.4),
        foot: toWorld(s.x, s.z, s.rot, 0, -s.hd + 0.5),
        top: toWorld(s.x, s.z, s.rot, 0, s.hd - 0.5),
      });
    }
  }

  /** Height of the raised level at a point, or null where there is none. */
  height(x: number, z: number): number | null {
    return deckHeight(this.plant, x, z);
  }

  /**
   * A route for a unit on foot from `level` at (sx, sz) to (tx, tz) on level `tl`: on one level a plain
   * path; otherwise over the stair that makes the shortest way (the first few tried in order of their
   * straight-line detour, until one gets through).
   */
  route(sx: number, sz: number, level: 0 | 1, tx: number, tz: number, tl: 0 | 1, ground: NavGrid): PathPoint[] {
    const navOf = (l: 0 | 1) => (l === 1 ? this.nav : ground);
    if (level === tl) return navOf(level).findPath(sx, sz, tx, tz, 0);
    const d = (a: V2, bx: number, bz: number) => Math.hypot(a.x - bx, a.z - bz);
    const order = [...this.links].sort((a, b) => {
      const ea = level === 0 ? d(a.bottom, sx, sz) + d(a.top, tx, tz) : d(a.top, sx, sz) + d(a.bottom, tx, tz);
      const eb = level === 0 ? d(b.bottom, sx, sz) + d(b.top, tx, tz) : d(b.top, sx, sz) + d(b.bottom, tx, tz);
      return ea - eb;
    });
    // (the goal itself may lie in an obstacle - a radar dome: a path counts if it gets to the nearest free point)
    const goal = navOf(tl).freePoint(tx, tz, 0);
    const reaches = (p: V2[], x: number, z: number) => {
      const end = x === tx && z === tz ? goal : { x, z };
      return p.length > 0 && d(p[p.length - 1], end.x, end.z) < 2.5;
    };
    for (const s of order.slice(0, 4)) {
      if (level === 0) {
        const a = ground.findPath(sx, sz, s.bottom.x, s.bottom.z, 0);
        const b = this.nav.findPath(s.foot.x, s.foot.z, tx, tz, 0);
        if ((a.length === 0 && d(s.bottom, sx, sz) > 2.5) || (a.length && !reaches(a, s.bottom.x, s.bottom.z)) || !reaches(b, tx, tz)) continue;
        return [...a, { x: s.bottom.x, z: s.bottom.z }, { x: s.foot.x, z: s.foot.z, level: 1 }, ...b];
      }
      const a = this.nav.findPath(sx, sz, s.foot.x, s.foot.z, 0);
      const b = ground.findPath(s.bottom.x, s.bottom.z, tx, tz, 0);
      if ((a.length && !reaches(a, s.foot.x, s.foot.z)) || !reaches(b, tx, tz)) continue;
      // (back on the ground at the lowest step, both ways: the ground before a stair is outside the walkways' grid)
      return [...a, { x: s.foot.x, z: s.foot.z, level: 0 }, { x: s.bottom.x, z: s.bottom.z }, ...b];
    }
    return navOf(level).findPath(sx, sz, tx, tz, 0);
  }
}
