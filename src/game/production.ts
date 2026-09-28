import { UNITS, type Team, type UnitType } from "../config";
import type { V2 } from "../world/layout";
import type { Game } from "./game";

/** Build queue of a barracks or workshop. Credits are paid when an order is queued. */
export class Production {
  readonly queue: UnitType[] = [];
  /** 0..1 progress of the unit at the head of the queue. */
  progress = 0;

  constructor(readonly builds: readonly UnitType[]) {}

  count(type: UnitType): number {
    return this.queue.filter((t) => t === type).length;
  }

  /** Progress of `type` if it is being built right now, else 0. */
  progressOf(type: UnitType): number {
    return this.queue[0] === type ? this.progress : 0;
  }

  /** Removes the last queued unit of `type`; returns its refund (0 if none). */
  cancel(type: UnitType): number {
    const i = this.queue.lastIndexOf(type);
    if (i < 0) return 0;
    this.queue.splice(i, 1);
    if (i === 0) this.progress = 0;
    return UNITS[type].cost;
  }

  /** Empties the queue and returns the total refund. */
  clear(): number {
    const refund = this.queue.reduce((s, t) => s + UNITS[t].cost, 0);
    this.queue.length = 0;
    this.progress = 0;
    return refund;
  }

  update(dt: number, g: Game, team: Team, spawn: V2, rally: V2) {
    const type = this.queue[0];
    if (!type) return;
    this.progress += dt / UNITS[type].buildTime;
    if (this.progress < 1) return;
    this.progress = 0;
    this.queue.shift();
    const u = g.spawnUnit(type, team, spawn.x + (Math.random() - 0.5) * 2, spawn.z + (Math.random() - 0.5));
    const spread = UNITS[type].vehicle ? 2 : 5;
    u.orderMove(g.nav.freePoint(rally.x + (Math.random() - 0.5) * spread, rally.z + (Math.random() - 0.5) * spread, u.navLayer), false, g);
    g.emit("unitReady", team);
  }
}
