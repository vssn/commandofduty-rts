import { ENEMY, UNITS } from "../config";
import type { Game } from "./game";
import type { Unit } from "./unit";

/**
 * Small opponent: keeps its barracks busy (riflemen with some grenadiers), takes outposts with
 * two-man squads, builds and mans jeeps once it holds a workshop, and attacks in growing waves.
 */
export class EnemyAI {
  private waveTimer = 150;
  private captureTimer = 5;
  private waveSize = 5;

  constructor(private readonly game: Game) {}

  update(dt: number) {
    const g = this.game;
    const b = g.enemyBarracks;
    if (!b.alive || g.result) return;

    const mine = g.units.filter((u) => u.alive && u.team === ENEMY && !u.vehicle);
    const soldiers = mine.filter((u) => !u.isVehicle);
    const jeeps = mine.filter((u) => u.type === "jeep");

    if (b.production.queue.length === 0 && soldiers.length < 16) g.queueUnit(Math.random() < 0.3 ? "grenadier" : "rifleman", ENEMY);
    const workshop = g.workshopOf(ENEMY);
    if (workshop && workshop.production!.queue.length === 0 && jeeps.length < 2 && g.credits[ENEMY] >= UNITS.jeep.cost + 150) {
      g.queueUnit("jeep", ENEMY);
    }

    // soldiers standing in an outpost that is not ours yet are busy taking it
    const capturing = (u: Unit) => g.outposts.some((o) => o.owner !== ENEMY && Math.hypot(u.x - o.x, u.z - o.z) <= o.radius);
    const available = mine.filter((u) => u.path.length === 0 && !u.target && !u.boarding && !capturing(u));

    // man empty jeeps with the nearest idle soldier
    for (const j of jeeps) {
      if (j.gunner || soldiers.some((s) => s.boarding === j)) continue;
      if (g.commandBoard(available.filter((u) => !u.isVehicle), j, false)) {
        const i = available.findIndex((u) => u.boarding === j);
        if (i >= 0) available.splice(i, 1);
      }
    }

    // send small squads to outposts the enemy does not own yet (nearest first)
    this.captureTimer -= dt;
    if (this.captureTimer <= 0) {
      this.captureTimer = 6;
      const claimed = (o: (typeof g.outposts)[number]) =>
        mine.some((u) => Math.hypot((u.dest ?? u).x - o.x, (u.dest ?? u).z - o.z) <= o.radius);
      const targets = g.outposts
        .filter((o) => o.owner !== ENEMY && !claimed(o))
        .sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z));
      const squad = available.filter((u) => !u.isVehicle).slice(0, 2);
      if (targets.length && squad.length === 2) {
        const o = targets[0];
        g.commandMove(squad, { x: o.x, z: o.z }, true, false);
      }
    }

    this.waveTimer -= dt;
    const idle = available.filter((u) => u.armed && u.path.length === 0);
    if (this.waveTimer <= 0 && idle.length >= this.waveSize) {
      const t = g.playerBarracks;
      g.commandMove(idle, { x: t.x, z: t.z }, true, false);
      this.waveTimer = 75;
      this.waveSize = Math.min(10, this.waveSize + 1);
    }
  }
}
