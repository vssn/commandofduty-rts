import { ARTILLERY, BUILD, ENEMY, PLAYER, UNITS, type Team } from "../config";
import type { Game } from "./game";
import type { Unit } from "./unit";

/**
 * Small opponent: keeps its barracks busy (riflemen with some grenadiers), takes outposts with
 * two-man squads, builds and mans jeeps once it holds a workshop, trains a few medics once it holds
 * the field hospital (they tag along with the attack waves), fortifies its front outposts with MG
 * nests once it has spare credits, and attacks in growing waves. Normally it plays the enemy; the
 * main menu's background battle runs one for each side.
 */
export class EnemyAI {
  private waveTimer: number;
  private captureTimer = 5;
  private waveSize = 5;
  private artilleryTimer = 20;
  private buildTimer = 90;
  private time = 0;
  /** The units of the attack wave that is under way, the medics that go with it, and the support clock. */
  private attackers: Unit[] = [];
  private escorts: Unit[] = [];
  private supportT = 0;
  /**
   * Units caught in a strike's target area: when they will react (a moment of shock first) and the
   * strike they flee from. While it lasts the AI gives them no other orders.
   */
  private readonly evading = new Map<Unit, { reactAt: number; strike: object; fled: boolean }>();

  /** `firstWave`: seconds before the first attack wave may leave. */
  constructor(private readonly game: Game, private readonly team: Team = ENEMY, firstWave = 150) {
    this.waveTimer = firstWave;
  }

  private get foe(): Team {
    return this.team === PLAYER ? ENEMY : PLAYER;
  }

  update(dt: number) {
    const g = this.game;
    const b = this.team === ENEMY ? g.enemyBarracks : g.playerBarracks;
    if (!b.alive || g.result) return;

    this.time += dt;
    const all = g.units.filter((u) => u.alive && u.team === this.team && !u.vehicle);
    const mine = all.filter((u) => !u.isStructure);
    this.evadeArtillery(mine);
    const guns = all.filter((u) => u.hasMg && u.buildT <= 0);
    const soldiers = mine.filter((u) => !u.isVehicle);
    const jeeps = mine.filter((u) => u.type === "jeep");

    if (b.production.queue.length === 0 && soldiers.length < 16) g.queueUnit(Math.random() < 0.3 ? "grenadier" : "rifleman", this.team);
    const workshop = g.workshopOf(this.team);
    if (workshop && workshop.production!.queue.length === 0 && jeeps.length < 2 && g.credits[this.team] >= UNITS.jeep.cost + 150) {
      g.queueUnit("jeep", this.team);
    }
    const hospital = g.hospitalOf(this.team);
    const medics = mine.filter((u) => u.type === "medic");
    if (hospital && hospital.production!.queue.length === 0 && medics.length < 3 && g.credits[this.team] >= UNITS.medic.cost + 100) {
      g.queueUnit("medic", this.team);
    }

    // soldiers standing in an outpost that is not ours yet are busy taking it
    const capturing = (u: Unit) => g.outposts.some((o) => o.owner !== this.team && Math.hypot(u.x - o.x, u.z - o.z) <= o.radius);
    const available = mine.filter((u) => u.armed && u.path.length === 0 && !u.target && !u.boarding && !capturing(u) && !this.evading.has(u));

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
        .filter((o) => o.owner !== this.team && !claimed(o))
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
    const skirmish = g.mode === "skirmish";
    const foot = idle.filter((u) => !u.isVehicle);
    const waveReady = skirmish ? foot.length >= 5 : idle.length >= this.waveSize;
    if (this.waveTimer <= 0 && waveReady) {
      const t = this.foe === PLAYER ? g.playerBarracks : g.enemyBarracks;
      // skirmish: the infantry marches on the enemy base, the jeeps escort it and hunt what it meets
      // (see supportWave); otherwise everybody goes together
      g.commandMove(skirmish ? foot : idle, { x: t.x, z: t.z }, true, false);
      this.attackers = [...idle];
      // two idle medics join this wave and follow it a little behind, patching up the wounded
      this.escorts = medics.filter((m) => !m.patient && !m.healing).slice(0, 2);
      this.supportT = 0;
      this.waveTimer = 75;
      this.waveSize = Math.min(10, this.waveSize + 1);
    }
    this.supportT -= dt;
    if (this.supportT <= 0) {
      this.supportT = 2.5;
      this.supportWave(b);
    }
  }

  /**
   * While a wave is under way: the medics keep a few metres behind its infantry (they heal on their
   * own whenever they stand and someone near is hurt), and in a skirmish the jeeps work with it -
   * they hunt the nearest enemy close to the infantry, otherwise stay a little ahead of it, and once
   * the infantry is gone make a last dash at the enemy base.
   */
  private supportWave(base: { x: number; z: number }) {
    const g = this.game;
    this.attackers = this.attackers.filter((u) => u.alive);
    this.escorts = this.escorts.filter((m) => m.alive);
    const foot = this.attackers.filter((u) => !u.isVehicle);
    const foeBase = this.foe === PLAYER ? g.playerBarracks : g.enemyBarracks;
    let cx = 0, cz = 0;
    for (const u of foot) { cx += u.x; cz += u.z; }
    if (foot.length) {
      cx /= foot.length;
      cz /= foot.length;
      // medics: five metres behind the infantry, towards our own base
      const bx = base.x - cx, bz = base.z - cz, bl = Math.hypot(bx, bz) || 1;
      const px = cx + (bx / bl) * 5, pz = cz + (bz / bl) * 5;
      const loose = this.escorts.filter((m) => !m.patient && !m.healing && Math.hypot(m.x - px, m.z - pz) > 7);
      if (loose.length) g.commandMove(loose, g.nav.freePoint(px, pz), false, false);
    }
    if (g.mode !== "skirmish") return;
    for (const j of this.attackers) {
      if (j.type !== "jeep" || (j.target && j.target.alive)) continue;
      if (!foot.length) {
        if (j.path.length === 0) g.commandMove([j], { x: foeBase.x, z: foeBase.z }, true, false);
        continue;
      }
      let best: Unit | null = null, bd = 30;
      for (const e of g.units) {
        if (!e.alive || e.team === this.team || e.vehicle || e.isStructure || e.type === "drone") continue;
        const d = Math.hypot(e.x - cx, e.z - cz);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        g.commandAttack([j], best);
        continue;
      }
      // nothing near: roll along a little ahead of the infantry
      const fx = foeBase.x - cx, fz = foeBase.z - cz, fl = Math.hypot(fx, fz) || 1;
      const ex = cx + (fx / fl) * 7, ez = cz + (fz / fl) * 7;
      if (Math.hypot(j.x - ex, j.z - ez) > 9) g.commandMove([j], g.nav.freePoint(ex, ez, 1), true, false);
    }
  }

  /**
   * Gets units out of the target area of any artillery strike on its way (also their own side's):
   * after a short moment of shock each one runs straight out, the shortest way, whether that means
   * falling back or running towards the enemy, and does not stop to fight on the way. The AI leaves
   * them alone until the salvo is over.
   */
  private evadeArtillery(mine: Unit[]) {
    const g = this.game;
    const strikes = g.artillery.active;
    // forget units whose strike is over (or who died)
    for (const [u, e] of this.evading) if (!u.alive || !strikes.includes(e.strike as (typeof strikes)[number])) this.evading.delete(u);
    if (!strikes.length) return;
    const danger = ARTILLERY.spread + ARTILLERY.blastRadius + 1;
    for (const u of mine) {
      if (u.boarding) continue;
      const st = strikes.find((s) => Math.hypot(u.x - s.x, u.z - s.z) < danger);
      if (!st) continue;
      let e = this.evading.get(u);
      if (!e || e.strike !== st) {
        e = { reactAt: this.time + 0.6 + Math.random() * 1.0, strike: st, fled: false };
        this.evading.set(u, e);
      }
      if (e.fled || this.time < e.reactAt) continue;
      // straight away from the impact point (a random way if right on it), well outside the area
      let dx = u.x - st.x, dz = u.z - st.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dz = Math.sin(a);
      } else {
        dx /= d;
        dz /= d;
      }
      const out = danger + 2.5 + Math.random() * 2;
      const p = g.nav.freePoint(st.x + dx * out, st.z + dz * out);
      g.commandMove([u], p, false, false);
      e.fled = true;
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
    if (all.filter((u) => u.type === "mgnest").length >= 2 || g.credits[this.team] < UNITS.mgnest.cost + 500) return;
    const foe = this.foe === PLAYER ? g.playerBarracks : g.enemyBarracks;
    const posts = g.outposts
      .filter((o) => o.owner === this.team && !all.some((u) => u.type === "mgnest" && u.anchor === o))
      .sort((a, b) => Math.hypot(a.x - foe.x, a.z - foe.z) - Math.hypot(b.x - foe.x, b.z - foe.z));
    const o = posts[0];
    if (!o) return;
    const toward = Math.atan2(foe.x - o.x, foe.z - o.z);
    for (let i = 0; i < 8; i++) {
      const a = toward + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.35;
      const r = o.radius + BUILD.outpostReach * 0.5;
      if (g.placeStructure("mgnest", this.team, o.x + Math.sin(a) * r, o.z + Math.cos(a) * r)) return;
    }
  }

  /**
   * Skirmish: shells the densest group of player units that its own troops can see (within 20 of
   * an enemy unit), never when its own soldiers are close to the impact area.
   */
  private useArtillery(dt: number, mine: Unit[]) {
    const g = this.game;
    this.artilleryTimer -= dt;
    if (this.artilleryTimer > 0 || !g.artillery.canOrder(this.team)) return;
    this.artilleryTimer = 4;
    const foes = g.units.filter((u) => u.alive && u.team !== this.team && !u.vehicle);
    let best: Unit | null = null, bestCount = 2;
    for (const f of foes) {
      if (!mine.some((m) => Math.hypot(m.x - f.x, m.z - f.z) < 20)) continue;
      const count = foes.filter((o) => Math.hypot(o.x - f.x, o.z - f.z) < ARTILLERY.spread).length;
      if (count > bestCount) { bestCount = count; best = f; }
    }
    if (!best) return;
    if (mine.some((m) => Math.hypot(m.x - best!.x, m.z - best!.z) < ARTILLERY.spread + ARTILLERY.blastRadius + 2)) return;
    g.orderArtillery(this.team, best.x, best.z);
    this.artilleryTimer = 8;
  }
}
