import type { InstancedMesh } from "@babylonjs/core";
import { COMBAT, GRENADE, JEEP_MG, MEDIC, ROAD, SLOPE, UNITS, type Team, type UnitStats, type UnitType } from "../config";
import type { V2 } from "../world/layout";
import type { Game } from "./game";
import type { NavLayer } from "./nav";
import type { Outpost } from "./outpost";
import type { UnitView } from "./views";

/** Anything that can be shot at. */
export interface Target {
  readonly kind: "unit" | "building";
  team: Team;
  x: number;
  z: number;
  y: number;
  /** Height above ground to aim at. */
  aimY: number;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Unit implements Target {
  private static nextId = 1;
  readonly kind = "unit" as const;
  readonly id = Unit.nextId++;
  readonly stats: UnitStats;
  hp: number;
  maxHp: number;
  alive = true;
  radius: number;
  aimY: number;
  y = 0;
  heading = 0;
  selected = false;
  /** Seconds of cloak left (commandos agent); cloaked units cannot be seen or targeted by the enemy. */
  cloakT = 0;
  get cloaked(): boolean {
    return this.cloakT > 0;
  }
  /** Commandos: what an enemy soldier is doing about the agent (shown as "?" above him). */
  intel: "" | "search" | "track" = "";
  /** Enemy unit currently hidden by the player's fog of war. */
  fogHidden = false;
  /** Set once the death animation has finished and the meshes are gone. */
  removed = false;

  path: V2[] = [];
  dest: V2 | null = null;
  target: Target | null = null;
  explicitTarget = false;
  attackMove = false;

  px = 0;
  pz = 0;
  /** Whether the unit tried to drive/walk this frame. */
  moving = false;
  /** Recoil of the weapon, 1 right after a shot, decays to 0 (used by the views). */
  recoil = 0;
  /** Seconds since the last grenade throw started (grenadiers). */
  throwT = 99;
  /** Combat posture; soldiers under fire alternate between kneeling and lying down. */
  stance: "stand" | "kneel" | "prone" = "stand";
  /** Slope in walking direction (+ uphill, - downhill), for speed and animation. */
  grade = 0;

  // --- jeep
  /** World angle of the machine gun. */
  turret = 0;
  /** Soldier manning the machine gun. Without one the jeep cannot shoot. */
  gunner: Unit | null = null;
  /** True while the jeep is shooting this frame (hull shake). */
  firing = false;
  private burstLeft = JEEP_MG.burst;

  // --- soldier
  /** Jeep this soldier sits in (hidden, cannot leave until the jeep is destroyed). */
  vehicle: Unit | null = null;
  /** Jeep this soldier is walking to in order to climb aboard. */
  boarding: Unit | null = null;
  /** Seconds since this unit last fired or took fire; see `inCombat`. */
  combatT = 99;

  // --- medic
  // --- structure
  /** Seconds of construction left (structures); nothing works until it reaches 0. */
  buildT = 0;
  /** Outpost this structure belongs to: it changes hands with it. Null = at the base. */
  anchor: Outpost | null = null;

  /** Wounded soldier this medic is walking to or treating. */
  patient: Unit | null = null;
  /** True while the medic is treating his patient this frame (kneels, hands forward). */
  healing = false;

  private cooldown = Math.random() * 0.5;
  private scanT = 0;
  private repathT = 0;
  private stuckT = 0;
  /** How often the unit already planned a new route because it got stuck (per order, max 2). */
  private replans = 0;
  /** Vehicles: seconds left backing up out of a corner before trying a new route. */
  private reverseT = 0;
  private stanceT = 0;
  private calmT = 0;
  private deathT = 0;

  constructor(
    readonly type: UnitType,
    /** Only structures change sides (when their outpost is taken). */
    public team: Team,
    public x: number,
    public z: number,
    readonly view: UnitView,
    readonly ring: InstancedMesh,
  ) {
    this.stats = UNITS[type];
    this.hp = this.maxHp = this.stats.hp;
    this.radius = this.stats.radius;
    this.aimY = this.stats.vehicle ? 1.3 : 1.6;
    this.heading = this.turret = team === 0 ? 0 : Math.PI;
  }

  get isVehicle(): boolean {
    return this.stats.vehicle;
  }

  /** Built defence (MG nest, bollards): never moves. */
  get isStructure(): boolean {
    return !!this.stats.structure;
  }

  /** Carries a machine gun that needs a soldier to man it (jeep, MG nest). */
  get hasMg(): boolean {
    return this.type === "jeep" || this.type === "mgnest";
  }

  /** Vehicles plan on the layer with larger obstacle clearance. */
  get navLayer(): NavLayer {
    return this.stats.vehicle ? 1 : 0;
  }

  /** Can currently shoot (a jeep needs a gunner, the medic never can). */
  get armed(): boolean {
    if (this.type === "medic" || this.type === "bollard" || this.buildT > 0) return false;
    return !this.hasMg || !!this.gunner;
  }

  /** Fired or took fire in the last few seconds: a medic cannot treat him now. */
  get inCombat(): boolean {
    return this.combatT < MEDIC.calm;
  }

  /** Medic: walk to `patient` and treat him until he is healed. */
  orderHeal(patient: Unit, g: Game) {
    this.stop();
    this.patient = patient;
    this.path = g.nav.findPath(this.x, this.z, patient.x, patient.z, this.navLayer);
    this.repathT = 0.8;
  }

  orderMove(p: V2, attackMove: boolean, g: Game) {
    this.target = null;
    this.patient = null;
    this.replans = 0;
    this.reverseT = 0;
    this.explicitTarget = false;
    this.boarding = null;
    this.attackMove = attackMove;
    this.dest = { x: p.x, z: p.z };
    this.path = g.nav.findPath(this.x, this.z, p.x, p.z, this.navLayer);
    this.stuckT = 0;
  }

  orderAttack(t: Target) {
    if (!this.armed) return;
    this.replans = 0;
    this.target = t;
    this.explicitTarget = true;
    this.attackMove = false;
    this.boarding = null;
    this.dest = null;
    this.path = [];
    this.repathT = 0;
  }

  /** Walk to `jeep` and climb aboard as its gunner. */
  orderBoard(jeep: Unit, g: Game) {
    this.stop();
    this.boarding = jeep;
    this.path = g.nav.findPath(this.x, this.z, jeep.x, jeep.z, this.navLayer);
    this.repathT = 0.8;
  }

  stop() {
    this.target = null;
    this.patient = null;
    this.replans = 0;
    this.reverseT = 0;
    this.explicitTarget = false;
    this.attackMove = false;
    this.boarding = null;
    this.dest = null;
    this.path = [];
  }

  /** Called when this unit takes fire; idle units shoot back (never at friends). */
  onAttacked(by: Target) {
    if (this.type === "agent") return; // the agent never gives himself away on his own
    if (by.team === this.team || !this.armed) return;
    if (!this.target && this.path.length === 0 && by.alive) this.target = by;
  }

  private faceTowards(tx: number, tz: number, dt: number): number {
    const desired = Math.atan2(tx - this.x, tz - this.z);
    const diff = wrapAngle(desired - this.heading);
    const step = this.stats.turn * dt;
    this.heading = wrapAngle(this.heading + Math.max(-step, Math.min(step, diff)));
    return Math.abs(diff) - Math.min(Math.abs(diff), step);
  }

  private aimTurret(tx: number, tz: number, dt: number): number {
    const desired = Math.atan2(tx - this.x, tz - this.z);
    const diff = wrapAngle(desired - this.turret);
    const step = JEEP_MG.turretTurn * dt;
    this.turret = wrapAngle(this.turret + Math.max(-step, Math.min(step, diff)));
    return Math.abs(diff) - Math.min(Math.abs(diff), step);
  }

  private loseTarget(g: Game) {
    this.target = null;
    this.explicitTarget = false;
    if (this.attackMove && this.dest) this.path = g.nav.findPath(this.x, this.z, this.dest.x, this.dest.z, this.navLayer);
    else if (!this.isVehicle) this.path = [];
  }

  update(dt: number, g: Game) {
    if (!this.alive) {
      this.deathT += dt;
      this.view.animateDeath(this, this.deathT);
      if (this.deathT > 4.5) {
        this.view.dispose();
        this.ring.dispose();
        this.removed = true;
      }
      return;
    }
    if (this.vehicle) return; // riding as gunner: the jeep does everything
    this.px = this.x;
    this.pz = this.z;
    if (this.buildT > 0) {
      this.buildT = Math.max(0, this.buildT - dt);
      this.moving = false;
      return;
    }
    this.cooldown -= dt;
    this.combatT += dt;
    this.throwT += dt;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.firing = false;

    if (this.boarding) {
      this.updateBoarding(dt, g);
      return;
    }
    if (this.type === "medic") {
      this.updateMedic(dt, g);
      return;
    }

    if (this.target && !this.target.alive) this.loseTarget(g);
    // a target that just cloaked is lost from sight
    if (this.target instanceof Unit && this.target.cloaked) this.loseTarget(g);
    this.cloakT = Math.max(0, this.cloakT - dt);
    if (!this.armed) this.target = null;

    if (this.armed && !this.target && (this.path.length === 0 || this.attackMove || this.isVehicle)) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.25 + Math.random() * 0.2;
        this.target = g.findEnemy(this, this.stats.acquire);
      }
    }

    let moving = this.path.length > 0;
    let fighting = false;
    const t = this.target;
    if (t) {
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.kind === "building" ? t.radius : 0);
      if (d <= g.rangeOf(this, t)) {
        fighting = true;
        if (this.isVehicle) {
          // the gunner fires on the move; an explicit attack order makes the driver stop
          if (this.explicitTarget) moving = false;
          const off = this.aimTurret(t.x, t.z, dt);
          if (off < 0.12) this.fireMg(t, g);
        } else {
          moving = false;
          const off = this.faceTowards(t.x, t.z, dt);
          if (this.cooldown <= 0 && off < 0.25) {
            if (this.type === "grenadier") this.throwGrenade(t, g);
            else this.fireRifle(t, g);
          }
        }
      } else if (this.isStructure) {
        this.loseTarget(g); // cannot follow: wait for the next target in range
      } else if (this.explicitTarget || d <= this.stats.acquire + 4) {
        if (!this.isVehicle || this.explicitTarget) {
          this.repathT -= dt;
          if (this.repathT <= 0 || this.path.length === 0) {
            this.repathT = 0.8;
            this.path = g.nav.findPath(this.x, this.z, t.x, t.z, this.navLayer);
          }
          moving = true;
        }
      } else {
        this.loseTarget(g);
        moving = this.path.length > 0;
      }
    }
    if (fighting) this.combatT = 0;
    if (this.isVehicle && !fighting && !this.isStructure) this.aimTurret(this.x + Math.sin(this.heading), this.z + Math.cos(this.heading), dt);

    if (moving && this.path.length) this.followPath(dt, g);
    this.moving = moving && this.path.length > 0;
    if (!this.moving) this.grade = 0;
    if (!this.isVehicle) this.updateStance(dt, fighting, this.moving);
  }

  /** Speed multiplier for slope and ground (roads) in walking direction (dx, dz normalised); also updates `grade`. */
  private slopeFactor(dx: number, dz: number, g: Game): number {
    const look = this.isVehicle ? 1.5 : 0.8;
    const h0 = g.terrain.heightAt(this.x, this.z);
    const h1 = g.terrain.heightAt(this.x + dx * look, this.z + dz * look);
    this.grade = (h1 - h0) / look;
    const k = this.isVehicle ? SLOPE.vehicle : 1;
    const f = this.grade > 0 ? 1 - this.grade * SLOPE.uphill * k : 1 - this.grade * SLOPE.downhill * k;
    const slope = Math.min(SLOPE.max, Math.max(SLOPE.min, f));
    // on roads and dirt tracks level ground is as fast as walking downhill
    return Math.min(ROAD.cap, slope * g.groundSpeed(this.x, this.z));
  }

  private followPath(dt: number, g: Game) {
    const wp = this.path[0];
    const dx = wp.x - this.x, dz = wp.z - this.z;
    const dist = Math.hypot(dx, dz);
    const last = this.path.length === 1;
    const reach = this.isVehicle ? (last ? 1.0 : 2.2) : last ? 0.3 : 0.9;
    if (dist < reach) {
      this.path.shift();
      if (!this.path.length && !this.target) { this.attackMove = false; this.dest = null; }
      return;
    }
    if (this.isVehicle && this.reverseT > 0) {
      // backing out of a corner: straight back, wheels turned away from where it wants to go
      this.reverseT -= dt;
      const want = Math.atan2(wp.x - this.x, wp.z - this.z);
      let diff = want - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading -= Math.sign(diff) * Math.min(Math.abs(diff), this.stats.turn * 0.5 * dt);
      const step = this.stats.speed * 0.35 * dt;
      this.x -= Math.sin(this.heading) * step;
      this.z -= Math.cos(this.heading) * step;
      if (this.reverseT <= 0) this.replan(g); // then a fresh route from here
      return;
    }
    if (this.isVehicle) {
      // cars drive forward along their heading and slow down in tight turns
      const off = this.faceTowards(wp.x, wp.z, dt);
      const slope = this.slopeFactor(Math.sin(this.heading), Math.cos(this.heading), g);
      // and brake ahead of a sharp bend at the coming waypoint
      let brake = 1;
      const next = this.path[1];
      if (next && dist < 8) {
        const a1 = Math.atan2(dx, dz), a2 = Math.atan2(next.x - wp.x, next.z - wp.z);
        let bend = Math.abs(a2 - a1);
        if (bend > Math.PI) bend = Math.PI * 2 - bend;
        brake = 1 - Math.min(0.65, (bend / Math.PI) * 1.3) * (1 - dist / 8);
      }
      const speed = this.stats.speed * slope * brake * Math.max(0.3, Math.cos(Math.min(off, Math.PI / 2)));
      const step = Math.min(dist, speed * dt);
      this.x += Math.sin(this.heading) * step;
      this.z += Math.cos(this.heading) * step;
    } else {
      const step = Math.min(dist, this.stats.speed * this.slopeFactor(dx / dist, dz / dist, g) * dt);
      this.x += (dx / dist) * step;
      this.z += (dz / dist) * step;
      this.faceTowards(wp.x, wp.z, dt);
    }
  }

  /**
   * Medic: walks to his patient and treats him while kneeling beside him, but only while the patient
   * is out of combat. Idle medics look after wounded comrades nearby on their own.
   */
  private updateMedic(dt: number, g: Game) {
    this.healing = false;
    let p = this.patient;
    if (p && (!p.alive || p.vehicle || p.hp >= p.maxHp)) p = this.patient = null;
    if (!p && this.path.length === 0) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.5 + Math.random() * 0.3;
        p = this.patient = g.findPatient(this, MEDIC.search);
      }
    }
    let moving = this.path.length > 0;
    if (p) {
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      if (d > MEDIC.reach + p.radius) {
        this.repathT -= dt;
        if (this.repathT <= 0 || this.path.length === 0) {
          this.repathT = 0.8;
          this.path = g.nav.findPath(this.x, this.z, p.x, p.z, this.navLayer);
        }
        moving = true;
      } else {
        this.path = [];
        moving = false;
        this.faceTowards(p.x, p.z, dt);
        if (!p.inCombat && !p.moving) {
          p.hp = Math.min(p.maxHp, p.hp + MEDIC.rate * dt);
          this.healing = true;
        }
      }
    }
    if (moving && this.path.length) this.followPath(dt, g);
    this.moving = moving && this.path.length > 0;
    if (!this.moving) this.grade = 0;
    if (this.healing) {
      // kneels beside the patient while treating him
      this.stance = "kneel";
      this.calmT = 0;
    } else {
      this.updateStance(dt, false, this.moving);
    }
  }

  /** New route from the current position to the end of the current one (after getting stuck). */
  private replan(g: Game) {
    const goal = this.path[this.path.length - 1] ?? this.dest;
    if (!goal) return;
    const from = g.nav.freePoint(this.x, this.z, this.navLayer);
    this.path = g.nav.findPath(from.x, from.z, goal.x, goal.z, this.navLayer);
    // step onto free ground first if the unit stands in an obstacle's margin
    if (Math.hypot(from.x - this.x, from.z - this.z) > 0.05) this.path.unshift(from);
  }

  private updateBoarding(dt: number, g: Game) {
    const jeep = this.boarding!;
    if (!jeep.alive || jeep.gunner) {
      this.stop();
      this.moving = false;
      return;
    }
    const d = Math.hypot(jeep.x - this.x, jeep.z - this.z);
    if (d <= JEEP_MG.boardDistance) {
      g.board(this, jeep);
      return;
    }
    this.repathT -= dt;
    if (this.repathT <= 0 || this.path.length === 0) {
      this.repathT = 0.8;
      this.path = g.nav.findPath(this.x, this.z, jeep.x, jeep.z, this.navLayer);
    }
    this.followPath(dt, g);
    this.moving = true;
    this.stance = "stand";
  }

  private updateStance(dt: number, fighting: boolean, moving: boolean) {
    if (moving) {
      this.stance = "stand";
      this.calmT = 0;
      return;
    }
    if (fighting) {
      this.calmT = 0;
      this.stanceT -= dt;
      if (this.type === "grenadier") {
        // grenadiers crouch between throws but cannot throw lying down
        this.stance = this.throwT < 0.6 ? "stand" : "kneel";
      } else if (this.stance === "stand" || this.stanceT <= 0) {
        // pick (or change) posture every few seconds so a fire fight looks alive
        const next = this.stance === "kneel" ? (Math.random() < 0.65 ? "prone" : "kneel")
          : this.stance === "prone" ? (Math.random() < 0.65 ? "kneel" : "prone")
          : Math.random() < 0.55 ? "kneel" : "prone";
        this.stance = next;
        this.stanceT = 4 + Math.random() * 5;
      }
    } else if (this.stance !== "stand") {
      this.calmT += dt;
      if (this.calmT > 2.5) this.stance = "stand";
    }
  }

  /** Called by the game after separation / collision resolution. */
  postMove(dt: number, g: Game) {
    if (this.vehicle) return;
    const moved = Math.hypot(this.x - this.px, this.z - this.pz);
    if (this.moving && this.path.length && moved < this.stats.speed * dt * 0.15 && this.reverseT <= 0) {
      this.stuckT += dt;
      if (this.stuckT > 1.5) {
        this.stuckT = 0;
        if (this.replans >= 2) {
          this.path = []; // tried twice already: give up instead of looping
        } else {
          this.replans++;
          // vehicles first back up a little, soldiers plan a new route straight away
          if (this.isVehicle) this.reverseT = 1.3;
          else this.replan(g);
        }
      }
    } else {
      this.stuckT = 0;
    }
    this.y = g.terrain.heightAt(this.x, this.z);
    this.view.sync(this, dt, moved, g.terrain);
    this.ring.position.set(this.x, this.y + 0.3, this.z);
    this.ring.isVisible = this.selected;
  }

  private fireRifle(t: Target, g: Game) {
    this.cloakT = 0; // firing gives the position away
    this.cooldown = this.stats.cooldown * (0.85 + Math.random() * 0.3);
    this.recoil = 1;
    const hit = Math.random() < g.hitChance(this, t);
    g.addTracer(this, t, hit, "rifle");
    const armour = t instanceof Unit && t.isVehicle ? COMBAT.rifleVsVehicle : 1;
    if (hit) g.damage(t, this.stats.damage * armour * (0.8 + Math.random() * 0.4), this);
  }

  private fireMg(t: Target, g: Game) {
    if (this.cooldown > 0) return;
    this.firing = true;
    this.recoil = 1;
    this.burstLeft--;
    if (this.burstLeft <= 0) {
      this.burstLeft = JEEP_MG.burst;
      this.cooldown = JEEP_MG.burstPause * (0.8 + Math.random() * 0.4);
    } else {
      this.cooldown = this.stats.cooldown;
    }
    const hit = Math.random() < g.hitChance(this, t);
    g.addTracer(this, t, hit, "mg");
    if (hit) g.damage(t, this.stats.damage * (0.85 + Math.random() * 0.3), this);
  }

  private throwGrenade(t: Target, g: Game) {
    this.cooldown = this.stats.cooldown * (0.9 + Math.random() * 0.2);
    this.throwT = 0;
    this.stance = "stand";
    // aim at the target, never closer than the safety distance, with distance-dependent scatter
    let dx = t.x - this.x, dz = t.z - this.z;
    let d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    d = Math.max(d, GRENADE.minDistance);
    const scatter = GRENADE.scatterBase + d * GRENADE.scatterPerUnit;
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * scatter;
    g.effects.throwGrenade(this, this.x + dx * d + Math.cos(a) * r, this.z + dz * d + Math.sin(a) * r);
  }

  kill() {
    this.alive = false;
    this.selected = false;
    this.ring.isVisible = false;
    this.path = [];
    this.target = null;
    this.boarding = null;
    this.patient = null;
  }
}
