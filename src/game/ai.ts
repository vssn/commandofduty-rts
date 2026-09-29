import { ARTILLERY, BUILD, ENEMY, UNITS } from "../config";
import type { Game } from "./game";
import type { Unit } from "./unit";

/**
 * Small opponent: keeps its barracks busy (riflemen with some grenadiers), takes outposts with
 * two-man squads, builds and mans jeeps once it holds a workshop, trains a few medics once it holds
 * the field hospital (they tag along with the attack waves), fortifies its front outposts with MG
 * nests once it has spare credits, and attacks in growing waves.
 */
export class EnemyAI {
  private waveTimer = 150;
  private captureTimer = 5;
  private waveSize = 5;
  private artilleryTimer = 20;
  private buildTimer = 90;

  constructor(private readonly game: Game) {}

  update(dt: number) {
    const g = this.game;
    const b = g.enemyBarracks;
    if (!b.alive || g.result) return;

    const all = g.units.filter((u) => u.alive && u.team === ENEMY && !u.vehicle);
    const mine = all.filter((u) => !u.isStructure);
    const guns = all.filter((u) => u.hasMg && u.buildT <= 0);
    const soldiers = mine.filter((u) => !u.isVehicle);
    const jeeps = mine.filter((u) => u.type === "jeep");

    if (b.production.queue.length === 0 && soldiers.length < 16) g.queueUnit(Math.random() < 0.3 ? "grenadier" : "rifleman", ENEMY);
    const workshop = g.workshopOf(ENEMY);
    if (workshop && workshop.production!.queue.length === 0 && jeeps.length < 2 && g.credits[ENEMY] >= UNITS.jeep.cost + 150) {
      g.queueUnit("jeep", ENEMY);
    }
    const hospital = g.hospitalOf(ENEMY);
    const medics = mine.filter((u) => u.type === "medic");
    if (hospital && hospital.production!.queue.length === 0 && medics.length < 3 && g.credits[ENEMY] >= UNITS.medic.cost + 100) {
      g.queueUnit("medic", ENEMY);
    }

    // soldiers standing in an outpost that is not ours yet are busy taking it
    const capturing = (u: Unit) => g.outposts.some((o) => o.owner !== ENEMY && Math.hypot(u.x - o.x, u.z - o.z) <= o.radius);
    const available = mine.filter((u) => u.armed && u.path.length === 0 && !u.target && !u.boarding && !capturing(u));

    // man empty jeeps and MG nests with the nearest idle soldier
    for (const j of guns) {
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

    if (g.mode === "skirmish") this.useArtillery(dt, mine);
    if (g.mode === "base") this.fortify(dt, all);

    this.waveTimer -= dt;
    const idle = available.filter((u) => u.armed && u.path.length === 0);
    const waveReady = g.mode === "skirmish" ? idle.length >= 6 : idle.length >= this.waveSize;
    if (this.waveTimer <= 0 && waveReady) {
      const t = g.playerBarracks;
      g.commandMove(idle, { x: t.x, z: t.z }, true, false);
      // idle medics follow the wave a little behind it and patch up the wounded on the way
      const followers = medics.filter((m) => !m.patient && m.path.length === 0).slice(0, 2);
      if (followers.length) g.commandMove(followers, { x: (t.x + idle[0].x) / 2, z: (t.z + idle[0].z) / 2 }, false, false);
      this.waveTimer = 75;
      this.waveSize = Math.min(10, this.waveSize + 1);
    }
  }

  /**
   * Places an MG nest at the owned outpost closest to the player's base, on the side facing it
   * (at most two nests, only with credits to spare for troops).
   */
  private fortify(dt: number, all: Unit[]) {
    const g = this.game;
    this.buildTimer -= dt;
    if (this.buildTimer > 0) return;
    this.buildTimer = 20;
    if (all.filter((u) => u.type === "mgnest").length >= 2 || g.credits[ENEMY] < UNITS.mgnest.cost + 500) return;
    const foe = g.playerBarracks;
    const posts = g.outposts
      .filter((o) => o.owner === ENEMY && !all.some((u) => u.type === "mgnest" && u.anchor === o))
      .sort((a, b) => Math.hypot(a.x - foe.x, a.z - foe.z) - Math.hypot(b.x - foe.x, b.z - foe.z));
    const o = posts[0];
    if (!o) return;
    const toward = Math.atan2(foe.x - o.x, foe.z - o.z);
    for (let i = 0; i < 8; i++) {
      const a = toward + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.35;
      const r = o.radius + BUILD.outpostReach * 0.5;
      if (g.placeStructure("mgnest", ENEMY, o.x + Math.sin(a) * r, o.z + Math.cos(a) * r)) return;
    }
  }

  /**
   * Skirmish: shells the densest group of player units that its own troops can see (within 20 of
   * an enemy unit), never when its own soldiers are close to the impact area.
   */
  private useArtillery(dt: number, mine: Unit[]) {
    const g = this.game;
    this.artilleryTimer -= dt;
    if (this.artilleryTimer > 0 || !g.artillery.canOrder(ENEMY)) return;
    this.artilleryTimer = 4;
    const foes = g.units.filter((u) => u.alive && u.team !== ENEMY && !u.vehicle);
    let best: Unit | null = null, bestCount = 2;
    for (const f of foes) {
      if (!mine.some((m) => Math.hypot(m.x - f.x, m.z - f.z) < 20)) continue;
      const count = foes.filter((o) => Math.hypot(o.x - f.x, o.z - f.z) < ARTILLERY.spread).length;
      if (count > bestCount) { bestCount = count; best = f; }
    }
    if (!best) return;
    if (mine.some((m) => Math.hypot(m.x - best!.x, m.z - best!.z) < ARTILLERY.spread + ARTILLERY.blastRadius + 2)) return;
    g.orderArtillery(ENEMY, best.x, best.z);
    this.artilleryTimer = 8;
  }
}
