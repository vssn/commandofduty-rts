import { MeshBuilder, MultiMaterial, StandardMaterial, type InstancedMesh, type Mesh } from "@babylonjs/core";
import { COMMANDOS, ENEMY, MAP_HALF, PLAYER, type UnitType } from "../config";
import { COMPOUND } from "../world/fortification";
import { toWorld, type V2 } from "../world/layout";
import { mat } from "../world/models";
import type { Game } from "./game";
import type { Outpost } from "./outpost";
import { Unit } from "./unit";

type ChargeTarget = Unit | Outpost;

interface Charge { target: ChargeTarget; x: number; z: number; fuse: number; mesh: InstancedMesh }
interface Patrol {
  units: Unit[];
  route: V2[];
  next: number;
  wait: number;
  /** Time stamp of the footprint the patrol is following (-1 = not tracking). */
  trackT: number;
  onFoot: boolean;
}
interface Footprint { x: number; z: number; t: number; heading: number }
interface Death { x: number; z: number; t: number; found: boolean }
interface Search { cx: number; cz: number; t0: number; until: number }

/** Footprints stay readable this long (seconds). */
const TRAIL_LIFE = 110;
/** A patrol notices tracks within this distance. */
const TRACK_NOTICE = 6.5;
/** Chance per check (every 1.5 s) that a patrol near fresh tracks picks them up. */
const TRACK_CHANCE = 0.55;
/** Comrades within this distance hear a death; others discover the body when passing within FIND. */
const HEAR = 20;
const FIND = 9;
const SEARCH = { duration: 45, radiusMin: 5, radiusMax: 24, vigilance: 22 };

/**
 * "Commandos" mode: a single special agent behind enemy lines. The enemy holds every outpost,
 * guards them and patrols between them on foot and by jeep; units that spot the agent raise the
 * alarm and nearby troops converge. The agent has three tools: a sniper shot (kills a soldier
 * outright, only damages vehicles), a short cloak (enemies neither see nor target him) and
 * demolition charges that blow up jeeps and outposts. Blow up COMMANDOS.targets outposts to win;
 * if the agent dies the mission fails.
 */
export class CommandosMission {
  agent!: Unit;
  charges = COMMANDOS.charges.count;
  destroyedOutposts = 0;
  readonly planted: Charge[] = [];
  /** Enemy the agent is closing in on to snipe (his standard attack). */
  private hunt: { target: Unit; dest: V2 | null; repath: number } | null = null;
  /** Charge the agent is on his way to plant, with planting progress 0..1. */
  pending: { target: ChargeTarget; dest: V2 | null; progress: number } | null = null;
  private sniperCd = 0;
  private cloakCd = 0;
  private readonly patrols: Patrol[] = [];
  private alertT = 0;
  private spottedCooldown = 0;
  private chargeTpl!: Mesh;
  private agentMaterials: StandardMaterial[] = [];
  /** The agent's footprints, oldest first (none while cloaked). */
  readonly trail: Footprint[] = [];
  /** Mission clock in seconds. */
  time = 0;
  private readonly deaths: Death[] = [];
  private readonly searches = new Map<Unit, Search>();
  /** Post of every guard, to return to after a search. */
  private readonly homes = new Map<Unit, V2>();
  private trackCheckT = 0;
  private findCheckT = 0;
  private searchMsgCooldown = 0;
  private trackMsgCooldown = 0;

  constructor(private readonly game: Game) {}

  get sniperCooldown() { return Math.max(0, this.sniperCd); }
  get cloakCooldown() { return Math.max(0, this.cloakCd); }

  // ---------------------------------------------------------------- setup

  setup() {
    const g = this.game;
    g.mode = "commandos";
    for (const u of g.units) {
      u.view.dispose();
      u.ring.dispose();
    }
    g.units.length = 0;
    g.clearSelection();

    // the enemy holds every outpost
    for (const o of g.outposts) o.seize(ENEMY);

    // no own base in this mode: the player's barracks and its sandbag compound are removed
    const own = g.playerBarracks;
    own.alive = false;
    own.selected = false;
    own.production.clear();
    own.mesh.setEnabled(false);
    own.ring.setEnabled(false);
    g.nav.clearRect(own.x, own.z, COMPOUND.hw + 1.5, COMPOUND.hd + 1.5, own.rot);


    // guards at every outpost, looking in different directions
    for (const o of g.outposts) {
      for (let i = 0; i < COMMANDOS.garrison; i++) {
        const a = (i / COMMANDOS.garrison) * Math.PI * 2 + Math.random();
        const p = g.nav.freePoint(o.x + Math.cos(a) * o.radius * 0.45, o.z + Math.sin(a) * o.radius * 0.45);
        const u = g.spawnUnit(i === 0 && o.kind === "depot" ? "grenadier" : "rifleman", ENEMY, p.x, p.z);
        u.heading = a;
        this.homes.set(u, { x: p.x, z: p.z });
      }
    }

    // foot patrols walk loops between outposts, jeeps loop along longer routes
    const posts = g.outposts.map((o) => ({ x: o.x, z: o.z }));
    const route = (start: number, stride: number, len: number) =>
      Array.from({ length: len }, (_, k) => posts[(start + k * stride) % posts.length]);
    for (let i = 0; i < COMMANDOS.patrols; i++) {
      const r = route(i * 2, 3, 4);
      const units = (["rifleman", "rifleman", "grenadier"] as UnitType[]).map((t, k) => {
        const p = g.nav.freePoint(r[0].x + k * 1.5, r[0].z + 3);
        return g.spawnUnit(t, ENEMY, p.x, p.z);
      });
      this.patrols.push({ units, route: r, next: 1, wait: Math.random() * 4, trackT: -1, onFoot: true });
    }
    for (let i = 0; i < COMMANDOS.jeepPatrols; i++) {
      const r = route(i * 5 + 1, 4, 5);
      const p = g.nav.freePoint(r[0].x, r[0].z + 4, 1);
      const jeep = g.spawnUnit("jeep", ENEMY, p.x, p.z);
      const gunner = g.spawnUnit("rifleman", ENEMY, p.x + 2, p.z);
      g.board(gunner, jeep);
      this.patrols.push({ units: [jeep], route: r, next: 1, wait: 2 + i * 3, trackT: -1, onFoot: false });
    }

    // the agent is dropped at a random spot away from outposts, patrols and the enemy base
    const start = this.pickStart();
    this.agent = g.spawnUnit("agent", PLAYER, start.x, start.z);
    // facing the nearest outpost
    const near = g.outposts.reduce((a, o) => (Math.hypot(o.x - start.x, o.z - start.z) < Math.hypot(a.x - start.x, a.z - start.z) ? o : a));
    this.agent.heading = Math.atan2(near.x - start.x, near.z - start.z);
    this.makeAgentMaterialsOwn();

    const tpl = MeshBuilder.CreateBox("charge", { width: 0.45, height: 0.3, depth: 0.3 }, g.scene);
    tpl.material = mat(g.scene, [0.45, 0.2, 0.12]);
    tpl.isVisible = false;
    tpl.isPickable = false;
    this.chargeTpl = tpl;
    g.select([this.agent]);
    g.onKilled = (u) => {
      if (u.team === ENEMY) this.onEnemyKilled(u);
    };
  }

  // ---------------------------------------------------------------- searching & tracking

  /** A soldier died: comrades within earshot start searching at once, others when they find him. */
  private onEnemyKilled(u: Unit) {
    const death: Death = { x: u.x, z: u.z, t: this.time, found: false };
    this.deaths.push(death);
    const heard = this.game.units.filter((o) => o.alive && o.team === ENEMY && !o.vehicle && Math.hypot(o.x - u.x, o.z - u.z) < HEAR);
    if (heard.length) this.discover(death, heard);
  }

  private discover(d: Death, finders: Unit[]) {
    d.found = true;
    // everybody around the finders joins the search of the area around the body
    const team = this.game.units.filter(
      (o) => o.alive && o.team === ENEMY && !o.vehicle && finders.some((f) => Math.hypot(f.x - o.x, f.z - o.z) < HEAR),
    );
    for (const o of team) this.startSearch(o, d.x, d.z);
    if (team.length && this.searchMsgCooldown <= 0) {
      this.game.emit("enemySearching", PLAYER);
      this.searchMsgCooldown = 15;
    }
  }

  private startSearch(u: Unit, cx: number, cz: number) {
    this.searches.set(u, { cx, cz, t0: this.time, until: this.time + SEARCH.duration * (0.8 + Math.random() * 0.4) });
    u.intel = "search";
    u.path = []; // pick the first search point right away
  }

  /** Searchers comb the area in growing circles and are extra watchful; then they go back. */
  private updateSearches() {
    const g = this.game, a = this.agent;
    for (const [u, s] of this.searches) {
      if (!u.alive) {
        this.searches.delete(u);
        continue;
      }
      if (this.time > s.until) {
        this.searches.delete(u);
        u.intel = "";
        const home = this.homes.get(u);
        if (home) u.orderMove(home, false, g); // guards return to their post, patrols resume their route
        continue;
      }
      // heightened vigilance: they spot the agent from farther away than usual
      if (a.alive && !a.cloaked && !u.target && Math.hypot(a.x - u.x, a.z - u.z) < SEARCH.vigilance) u.target = a;
      if (u.target || u.path.length) continue;
      const k = Math.min(1, (this.time - s.t0) / (s.until - s.t0));
      const r = SEARCH.radiusMin + (SEARCH.radiusMax - SEARCH.radiusMin) * k * (0.6 + Math.random() * 0.4);
      const ang = Math.random() * Math.PI * 2;
      u.orderMove(g.nav.freePoint(s.cx + Math.cos(ang) * r, s.cz + Math.sin(ang) * r, u.navLayer), true, g);
    }
  }

  /** Bodies that nobody heard fall are discovered by whoever walks past. */
  private findBodies() {
    const g = this.game;
    for (const d of this.deaths) {
      if (d.found || this.time - d.t > 90) continue;
      const finders = g.units.filter((o) => o.alive && o.team === ENEMY && !o.vehicle && Math.hypot(o.x - d.x, o.z - d.z) < FIND);
      if (finders.length) this.discover(d, finders);
    }
  }

  private recordTrail() {
    const a = this.agent;
    const now = this.time;
    while (this.trail.length && now - this.trail[0].t > TRAIL_LIFE) this.trail.shift();
    if (!a.alive || a.cloaked) return; // a cloaked agent leaves no readable tracks
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(a.x - last.x, a.z - last.z) < 1.4) return;
    this.trail.push({ x: a.x, z: a.z, t: now, heading: a.heading });
  }

  /** Foot patrols that come across fresh tracks follow them in the direction the agent went. */
  private updateTracking(dt: number) {
    const g = this.game;
    this.trackCheckT -= dt;
    const check = this.trackCheckT <= 0;
    if (check) this.trackCheckT = 1.5;
    for (const p of this.patrols) {
      if (!p.onFoot) continue;
      const alive = p.units.filter((u) => u.alive);
      if (!alive.length) continue;
      const lead = alive[0];
      if (alive.some((u) => this.searches.has(u))) continue;

      if (p.trackT < 0) {
        if (!check || alive.some((u) => u.target)) continue;
        const spot = this.trail.find((f) => this.time - f.t < TRAIL_LIFE * 0.75 && Math.hypot(f.x - lead.x, f.z - lead.z) < TRACK_NOTICE);
        if (!spot || Math.random() > TRACK_CHANCE) continue;
        p.trackT = spot.t;
        for (const u of alive) u.intel = "track";
        if (this.trackMsgCooldown <= 0) {
          g.emit("tracked", PLAYER);
          this.trackMsgCooldown = 20;
        }
      }
      if (alive.some((u) => u.path.length || u.target)) continue;

      // follow a few footprints further along, towards where the agent went
      const i = this.trail.findIndex((f) => f.t >= p.trackT);
      if (i < 0) {
        this.loseTrack(p, alive); // the tracks have faded
        continue;
      }
      if (i >= this.trail.length - 1) {
        // end of the trail: the agent must be close - search the area
        const end = this.trail[this.trail.length - 1];
        for (const u of alive) this.startSearch(u, end.x, end.z);
        this.loseTrack(p, alive, true);
        continue;
      }
      const next = this.trail[Math.min(this.trail.length - 1, i + 5)];
      p.trackT = next.t;
      g.commandMove(alive, g.nav.freePoint(next.x, next.z), true, false);
    }
  }

  private loseTrack(p: Patrol, alive: Unit[], searching = false) {
    p.trackT = -1;
    if (!searching) for (const u of alive) u.intel = "";
  }

  /** The agent's templates are used by him alone, so his materials can fade for the cloak. */
  private makeAgentMaterialsOwn() {
    const done = new Set<Mesh>();
    for (const m of this.agent.view.root.getChildMeshes()) {
      const src = (m as InstancedMesh).sourceMesh;
      if (!src || done.has(src)) continue;
      done.add(src);
      const own = (x: StandardMaterial) => {
        const c = x.clone(`${x.name}-agent`);
        this.agentMaterials.push(c);
        return c;
      };
      if (src.material instanceof MultiMaterial) {
        const mm = src.material.clone(`${src.material.name}-agent`) as MultiMaterial;
        mm.subMaterials = src.material.subMaterials.map((s) => (s instanceof StandardMaterial ? own(s) : s));
        src.material = mm;
      } else if (src.material instanceof StandardMaterial) {
        src.material = own(src.material);
      }
    }
  }

  // ---------------------------------------------------------------- abilities

  /** Scharfschuss: kills a soldier outright, only damages a vehicle. */
  snipe(target: Unit): boolean {
    const g = this.game, a = this.agent;
    if (!a.alive || this.sniperCd > 0) {
      g.emit("notReady", PLAYER);
      return false;
    }
    if (target.team === PLAYER || !target.alive) return false;
    if ((g.canSee && !g.canSee(target.x, target.z)) || Math.hypot(target.x - a.x, target.z - a.z) > COMMANDOS.sniper.range) {
      g.emit("noSight", PLAYER);
      return false;
    }
    this.sniperCd = COMMANDOS.sniper.cooldown;
    a.cloakT = 0; // the shot gives him away... but only to those close to the victim (see below)
    a.stop();
    a.heading = Math.atan2(target.x - a.x, target.z - a.z);
    a.recoil = 1;
    g.addTracer(a, target, true, "sniper");
    g.damage(target, target.isVehicle ? COMMANDOS.sniper.vehicleDamage : 9999, a);
    if (!target.alive) g.emit("targetEliminated", PLAYER);
    // comrades near the victim hear the shot and go looking at the victim's position
    for (const u of g.units) {
      if (u.alive && u.team === ENEMY && !u.vehicle && !u.target && Math.hypot(u.x - target.x, u.z - target.z) < 18) {
        u.orderMove(g.nav.freePoint(target.x + (Math.random() - 0.5) * 4, target.z + (Math.random() - 0.5) * 4, u.navLayer), true, g);
      }
    }
    return true;
  }

  /**
   * Standard attack (right click on an enemy): the agent snipes right away if he can, otherwise he
   * moves closer and fires as soon as the target is in range and in sight and the rifle is reloaded.
   */
  attack(target: Unit) {
    if (!this.agent.alive || !target.alive || target.team === PLAYER) return;
    this.pending = null;
    this.hunt = { target, dest: null, repath: 0 };
    this.agent.stop();
  }

  private updateHunt(dt: number) {
    const h = this.hunt, a = this.agent, g = this.game;
    if (!h) return;
    // gone, or the player gave a different order (new destination)
    if (!h.target.alive || !a.alive || (a.dest !== null && a.dest !== h.dest)) {
      this.hunt = null;
      return;
    }
    const t = h.target;
    const inRange = Math.hypot(t.x - a.x, t.z - a.z) <= COMMANDOS.sniper.range * 0.95;
    const visible = !g.canSee || g.canSee(t.x, t.z);
    if (inRange && visible) {
      a.path = [];
      a.dest = null;
      h.dest = null;
      a.heading = Math.atan2(t.x - a.x, t.z - a.z);
      if (this.sniperCd <= 0) {
        this.snipe(t);
        this.hunt = null;
      }
      return;
    }
    h.repath -= dt;
    if (h.repath <= 0 || !a.path.length) {
      h.repath = 1;
      a.orderMove(g.nav.freePoint(t.x, t.z), false, g);
      h.dest = a.dest;
    }
  }

  /** Tarnen: a few seconds of invisibility. */
  cloak(): boolean {
    const g = this.game;
    if (!this.agent.alive || this.cloakCd > 0) {
      g.emit("notReady", PLAYER);
      return false;
    }
    this.agent.cloakT = COMMANDOS.cloak.duration;
    this.cloakCd = COMMANDOS.cloak.cooldown;
    g.emit("cloaked", PLAYER);
    return true;
  }

  /** Sprengladung: the agent walks to an enemy jeep or outpost and plants a charge there. */
  orderCharge(target: ChargeTarget): boolean {
    const g = this.game;
    if (!this.agent.alive || this.charges <= 0) {
      g.emit("notReady", PLAYER);
      return false;
    }
    if (target instanceof Unit ? !target.alive || !target.isVehicle || target.team === PLAYER : target.destroyed) return false;
    this.hunt = null;
    this.pending = { target, dest: null, progress: 0 };
    this.walkToTarget();
    g.emit("commanded", PLAYER);
    return true;
  }

  private walkToTarget() {
    const p = this.pending!;
    const t = p.target;
    const at = this.game.nav.freePoint(t.x, t.z);
    this.agent.orderMove(at, false, this.game);
    p.dest = this.agent.dest;
  }

  /** Distance within which the agent can plant on the target. */
  private inReach(t: ChargeTarget): boolean {
    const a = this.agent;
    const d = Math.hypot(t.x - a.x, t.z - a.z);
    return t instanceof Unit ? d <= t.radius + COMMANDOS.charges.reach : d <= t.radius * 0.6;
  }

  // ---------------------------------------------------------------- update

  update(dt: number) {
    const g = this.game, a = this.agent;
    if (g.result) return;
    this.time += dt;
    this.sniperCd -= dt;
    this.cloakCd -= dt;
    this.spottedCooldown -= dt;
    this.searchMsgCooldown -= dt;
    this.trackMsgCooldown -= dt;
    this.recordTrail();
    this.findCheckT -= dt;
    if (this.findCheckT <= 0) {
      this.findCheckT = 0.5;
      this.findBodies();
    }
    this.updateSearches();
    this.updateTracking(dt);

    // cloak: the agent fades out while invisible
    const alpha = a.cloaked ? 0.22 : 1;
    for (const m of this.agentMaterials) m.alpha += (alpha - m.alpha) * Math.min(1, dt * 8);

    this.updateHunt(dt);
    this.updatePlanting(dt);
    this.updateCharges(dt);
    this.updatePatrols(dt);
    this.updateAlert(dt);

    if (!a.alive) {
      g.result = "lose";
      g.emit("lose", PLAYER);
    } else if (this.destroyedOutposts >= COMMANDOS.targets) {
      g.result = "win";
      g.emit("win", PLAYER);
    }
  }

  private updatePlanting(dt: number) {
    const p = this.pending;
    if (!p) return;
    const a = this.agent, t = p.target;
    const gone = t instanceof Unit ? !t.alive : t.destroyed;
    // a new order from the player (a new destination) cancels the plan; arriving clears dest
    if (gone || !a.alive || (a.dest !== null && a.dest !== p.dest)) {
      this.pending = null;
      return;
    }
    if (!this.inReach(t)) {
      p.progress = 0;
      // follow a moving jeep
      if (t instanceof Unit && (!a.path.length || Math.random() < dt * 1.5)) this.walkToTarget();
      return;
    }
    a.path = [];
    a.stance = "kneel";
    a.heading = Math.atan2(t.x - a.x, t.z - a.z);
    p.progress += dt / COMMANDOS.charges.plantTime;
    if (p.progress < 1) return;
    // planted
    this.pending = null;
    a.dest = null;
    this.charges--;
    const mesh = this.chargeTpl.createInstance("charge");
    const x = t instanceof Unit ? t.x : a.x, z = t instanceof Unit ? t.z : a.z;
    this.planted.push({ target: t, x, z, fuse: COMMANDOS.charges.fuse, mesh });
    this.game.emit("chargePlanted", PLAYER);
  }

  private updateCharges(dt: number) {
    const g = this.game;
    for (let i = this.planted.length - 1; i >= 0; i--) {
      const c = this.planted[i];
      // a charge on a jeep rides along
      if (c.target instanceof Unit && c.target.alive) {
        c.x = c.target.x;
        c.z = c.target.z;
      }
      const onJeep = c.target instanceof Unit;
      c.mesh.position.set(c.x, g.terrain.heightAt(c.x, c.z) + (onJeep ? 1.3 : 0.2), c.z);
      c.fuse -= dt;
      if (c.fuse > 0) continue;
      c.mesh.dispose();
      this.planted.splice(i, 1);
      g.effects.explode(c.x, c.z, COMMANDOS.charges.damage, COMMANDOS.charges.radius, null, 2.4);
      if (c.target instanceof Unit) {
        if (c.target.alive) g.damage(c.target, 9999, null);
      } else if (!c.target.destroyed && Math.hypot(c.x - c.target.x, c.z - c.target.z) <= c.target.radius) {
        c.target.destroy();
        this.destroyedOutposts++;
        g.emit("outpostDestroyed", PLAYER);
      }
    }
  }

  /** Squads walk their routes, pausing at every post; they fight whatever they meet on the way. */
  private updatePatrols(dt: number) {
    const g = this.game;
    for (const p of this.patrols) {
      const alive = p.units.filter((u) => u.alive);
      if (!alive.length) continue;
      const busy = alive.some((u) => u.path.length > 0 || u.target || this.searches.has(u));
      if (busy || this.alertT > 0 || p.trackT >= 0) continue;
      p.wait -= dt;
      if (p.wait > 0) continue;
      const wp = p.route[p.next];
      p.next = (p.next + 1) % p.route.length;
      p.wait = 3 + Math.random() * 4;
      const jitter = { x: wp.x + (Math.random() - 0.5) * 6, z: wp.z + (Math.random() - 0.5) * 6 };
      g.commandMove(alive, g.nav.freePoint(jitter.x, jitter.z, alive[0].navLayer), true, false);
    }
  }

  /** Whoever sees the agent calls in the troops around him. */
  private updateAlert(dt: number) {
    const g = this.game, a = this.agent;
    this.alertT -= dt;
    if (!a.alive || a.cloaked) return;
    const spotter = g.units.find((u) => u.alive && u.team === ENEMY && u.target === a);
    if (!spotter) return;
    if (this.spottedCooldown <= 0) {
      g.emit("spotted", PLAYER);
      this.spottedCooldown = 12;
    }
    if (this.alertT > 12) return; // re-issue the hunt every few seconds while he is in sight
    this.alertT = 15;
    for (const u of g.units) {
      if (!u.alive || u.team !== ENEMY || u.vehicle || u.target) continue;
      if (Math.hypot(u.x - spotter.x, u.z - spotter.z) > COMMANDOS.alertRadius) continue;
      u.orderMove(g.nav.freePoint(a.x + (Math.random() - 0.5) * 6, a.z + (Math.random() - 0.5) * 6, u.navLayer), true, g);
    }
  }

  /** Where the agent can see this outpost is a valid charge target (for the input layer). */
  outpostAt(x: number, z: number): Outpost | null {
    return this.game.outposts.find((o) => !o.destroyed && o.owner === ENEMY && Math.hypot(o.x - x, o.z - z) <= o.radius) ?? null;
  }

  /**
   * Random start point for the agent: walkable, well away from every outpost, the enemy barracks
   * and all enemy units. The required distances are relaxed step by step if nothing is found.
   */
  private pickStart(): V2 {
    const g = this.game;
    const enemies = g.units.filter((u) => u.team === ENEMY);
    const lim = MAP_HALF - 8;
    for (const [fromPost, fromEnemy] of [[34, 30], [28, 24], [22, 18], [16, 12]]) {
      for (let tries = 0; tries < 400; tries++) {
        const x = (Math.random() * 2 - 1) * lim, z = (Math.random() * 2 - 1) * lim;
        if (g.nav.isBlocked(x, z)) continue;
        if (g.outposts.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + fromPost)) continue;
        if (Math.hypot(g.enemyBarracks.x - x, g.enemyBarracks.z - z) < fromPost + 12) continue;
        if (enemies.some((u) => Math.hypot(u.x - x, u.z - z) < fromEnemy)) continue;
        return { x, z };
      }
    }
    const b = g.playerBarracks;
    return g.nav.freePoint(b.rally.x, b.rally.z);
  }

  /** Point in front of the player's compound (camera start). */
  startView(): V2 {
    const b = this.game.playerBarracks;
    return toWorld(b.x, b.z, b.rot, 0, 22);
  }
}
