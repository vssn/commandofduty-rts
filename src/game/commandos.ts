import { Color3, Mesh, MeshBuilder, MultiMaterial, StandardMaterial, type InstancedMesh } from "@babylonjs/core";
import { classicMaterial } from "../world/pbr";
import { COMMANDOS, EMBASSY_OPS, ENEMY, MAP_HALF, PLAYER, SIGHT, type UnitType } from "../config";
import { COMPOUND } from "../world/fortification";
import { toWorld, type HouseSpec, type V2 } from "../world/layout";
import { createGlowSpot, Searchlight } from "../world/lighting";
import { MAX_SPOTS, type SpotLight } from "../world/spotPbr";
import { createChargeMesh, mat } from "../world/models";
import { EXTRACT_RADIUS, ExtractionFlare, pickExtractionPoint } from "./extraction";
import type { Game } from "./game";
import type { Outpost } from "./outpost";
import { Unit } from "./unit";

type ChargeTarget = Unit | Outpost;

export interface Charge { target: ChargeTarget; x: number; z: number; fuse: number; mesh: InstancedMesh }
interface Patrol {
  units: Unit[];
  route: V2[];
  next: number;
  wait: number;
  /** Time stamp of the footprint the patrol is following (-1 = not tracking). */
  trackT: number;
  onFoot: boolean;
}
/** `side`: which foot (+1 / -1), fixed when the print is made. */
interface Footprint { x: number; z: number; t: number; heading: number; side: number }
interface Death { x: number; z: number; t: number; found: boolean }
interface Search { cx: number; cz: number; t0: number; until: number }
/** Hidden explosives at the edge of a wood. */
export interface Cache { x: number; z: number; taken: boolean; mesh: Mesh }
interface Beam { light: Searchlight; post: { destroyed: boolean }; base: number; phase: number; lockT: number; alarmT: number }
/** A recon drone, its pilot on the ground and its light. */
interface Drone {
  unit: Unit;
  pilot: Unit;
  light: Searchlight;
  /** Screen glow around the pilot. */
  glow: Mesh;
  mode: "search" | "track";
  /** Seconds the drone keeps following after losing sight of the agent. */
  lockT: number;
  wp: V2;
  alarmT: number;
  lastSeen: V2 | null;
  down: boolean;
}

/**
 * An embassy of the document mission: a town villa along the park. The documents are secured at its
 * front door (`door`); a flag on the roof marks it.
 */
export interface Embassy {
  name: string;
  villa: HouseSpec;
  door: V2;
  /** Documents already secured. */
  taken: boolean;
  /** Securing progress 0..1 while the agent is at the door. */
  progress: number;
  /** The lamp's stand-in post: "destroyed" (lamp off) once the documents are gone. */
  post: { destroyed: boolean };
  flag: Mesh;
  flagMat: StandardMaterial;
}
/** Mission kind: blow up outposts (hill country) or fetch documents from three embassies (Botschaftsquartier). */
export type MissionKind = "sabotage" | "documents";

/** Units that walk about on orders (pilots stay at their laptop, drones are flown by the mission). */
const grounded = (u: Unit) => u.type !== "drone" && u.type !== "pilot";

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
  /** The agent's own colours (the thermal look darkens them and puts them back). */
  private agentBase = new Map<StandardMaterial, Color3>();
  /** Thermal-camera look on the agent while a drone has him (0..1). */
  private thermal = 0;
  /** How much the agent is lit up by a lamp or searchlight (0..1, eased). */
  private lit = 0;
  /** The agent's footprints, oldest first (none while cloaked). */
  readonly trail: Footprint[] = [];
  private stepSide = 1;
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
  /** Explosive caches the agent has to reach (he starts without charges). */
  readonly caches: Cache[] = [];
  private readonly beams: Beam[] = [];
  /** Lit spots of the street lamps (set by main when the lamps are switched on). */
  streetPools: { x: number; z: number; r: number }[] = [];
  /** The mission failed because the clock ran out. */
  timeUp = false;
  /** More than COMMANDOS.escalation.after outposts are gone: the enemy is on full alert, drones are up. */
  aggressive = false;
  readonly drones: Drone[] = [];
  /** For the high-score table: drones shot down and soldiers taken out. */
  dronesDown = 0;
  soldiersDown = 0;
  private warnedTime = false;

  /** The objective: on the city map the agent fetches documents from embassies instead of blowing up outposts. */
  readonly kind: MissionKind;
  /** Embassies of the document mission (empty otherwise). */
  readonly embassies: Embassy[] = [];
  /** Soldiers freed from the enemy at an outpost: they fight with the agent. */
  readonly freed: Unit[] = [];
  /** Soldiers freed in all (for the high-score table). */
  freedTotal = 0;
  /** Outposts the agent has taken: their soldiers have joined him already. */
  private readonly rewarded = new Set<Outpost>();
  private captiveCheckT = 0;
  private followT = 0;

  constructor(private readonly game: Game) {
    this.kind = game.layout.map === "embassy" ? "documents" : "sabotage";
  }

  /** Embassies whose documents the agent has secured. */
  get documents() { return this.embassies.filter((e) => e.taken).length; }
  /** Whether the main objective is done (the extraction point opens). */
  get objectiveDone() {
    return this.kind === "documents" ? this.documents >= this.embassies.length : this.destroyedOutposts >= COMMANDOS.targets;
  }
  /** Seconds the whole mission may take. */
  get timeLimit() { return this.kind === "documents" ? EMBASSY_OPS.timeLimit : COMMANDOS.timeLimit; }
  /** Enemy forces: guards per outpost, outposts with an MG nest, foot patrols and jeeps. */
  private get forces() {
    return this.kind === "documents"
      ? { garrison: EMBASSY_OPS.garrison, nests: EMBASSY_OPS.nests, patrols: EMBASSY_OPS.patrols, jeepPatrols: EMBASSY_OPS.jeepPatrols }
      : { garrison: COMMANDOS.garrison, nests: COMMANDOS.nests, patrols: COMMANDOS.patrols, jeepPatrols: COMMANDOS.jeepPatrols };
  }

  get sniperCooldown() { return Math.max(0, this.sniperCd); }
  /** Drones still in the air. */
  get dronesActive() { return this.drones.filter((d) => !d.down).length; }
  /** Seconds left on the mission clock. */
  get timeLeft() { return Math.max(0, this.timeLimit - this.time); }
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
    own.removed = true; // simply gone: no demolition (and no explosions to hear)
    own.selected = false;
    own.production.clear();
    own.mesh.setEnabled(false);
    own.ring.setEnabled(false);
    g.nav.clearRect(own.x, own.z, COMPOUND.hw + 1.5, COMPOUND.hd + 1.5, own.rot);


    const F = this.forces;
    // guards at every outpost, looking in different directions
    for (const o of g.outposts) {
      for (let i = 0; i < F.garrison; i++) {
        const a = (i / F.garrison) * Math.PI * 2 + Math.random();
        const p = g.nav.freePoint(o.x + Math.cos(a) * o.radius * 0.45, o.z + Math.sin(a) * o.radius * 0.45);
        const u = g.spawnUnit(i === 0 && o.kind === "hospital" ? "grenadier" : "rifleman", ENEMY, p.x, p.z);
        u.heading = a;
        this.homes.set(u, { x: p.x, z: p.z });
      }
    }

    // some outposts are covered by a manned MG nest on their edge
    const nestPosts = [...g.outposts].sort(() => Math.random() - 0.5).slice(0, F.nests);
    for (const o of nestPosts) {
      for (let tries = 0; tries < 12; tries++) {
        const a = Math.random() * Math.PI * 2, r = o.radius * 0.8;
        const x = o.x + Math.sin(a) * r, z = o.z + Math.cos(a) * r;
        if (!g.nav.areaFree(x, z, 1.3, 1.3, a, 0)) continue;
        const nest = g.spawnStructure("mgnest", ENEMY, x, z, a, o);
        g.board(g.spawnUnit("rifleman", ENEMY, x, z - 2), nest);
        break;
      }
    }

    // a searchlight at every outpost sweeps the approaches
    for (const o of g.outposts) {
      const base = Math.random() * Math.PI * 2;
      const p = g.nav.freePoint(o.x + Math.sin(base) * (o.radius + 1.2), o.z + Math.cos(base) * (o.radius + 1.2));
      const light = new Searchlight(g.scene, g.terrain, g.shadows, p.x, p.z, COMMANDOS.searchlight.poolRadius);
      g.nav.structure(p.x, p.z, 0.4, 0.4, 0, [0, 1], 1); // removable again in dispose()
      this.beams.push({ light, post: o, base, phase: Math.random() * 10, lockT: 0, alarmT: 0 });
    }

    // foot patrols walk loops between outposts, jeeps loop along longer routes
    const posts = g.outposts.map((o) => ({ x: o.x, z: o.z }));
    const route = (start: number, stride: number, len: number) =>
      Array.from({ length: len }, (_, k) => posts[(start + k * stride) % posts.length]);
    for (let i = 0; i < F.patrols; i++) {
      const r = route(i * 2, 3, 4);
      const units = (["rifleman", "rifleman", "grenadier"] as UnitType[]).map((t, k) => {
        const p = g.nav.freePoint(r[0].x + k * 1.5, r[0].z + 3);
        return g.spawnUnit(t, ENEMY, p.x, p.z);
      });
      this.patrols.push({ units, route: r, next: 1, wait: Math.random() * 4, trackT: -1, onFoot: true });
    }
    // jeeps patrol the road network: their waypoints lie on tracks and streets, and vehicle path
    // finding keeps them on the roads in between
    const roadPts: V2[] = [];
    const lim = MAP_HALF - 10;
    for (const rd of g.layout.roads) {
      const len = Math.hypot(rd.b.x - rd.a.x, rd.b.z - rd.a.z);
      for (let s = 0; s <= len; s += 20) {
        const x = rd.a.x + ((rd.b.x - rd.a.x) * s) / len, z = rd.a.z + ((rd.b.z - rd.a.z) * s) / len;
        if (Math.abs(x) < lim && Math.abs(z) < lim && !g.nav.isBlocked(x, z, 1)) roadPts.push({ x, z });
      }
    }
    const roadRoute = (): V2[] => {
      const pts = [...roadPts].sort(() => Math.random() - 0.5);
      const r: V2[] = [];
      for (const p of pts) {
        if (r.length >= 5) break;
        // spread the stops out over the map
        if (r.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 45)) r.push(p);
      }
      return r.length >= 2 ? r : route(1, 4, 5);
    };
    for (let i = 0; i < F.jeepPatrols; i++) {
      const r = roadRoute();
      const p = g.nav.freePoint(r[0].x, r[0].z, 1);
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

    this.placeCaches();
    if (this.kind === "documents") this.setupEmbassies();

    const tpl = createChargeMesh(g.scene);
    tpl.isVisible = false;
    tpl.isPickable = false;
    this.chargeTpl = tpl;
    g.select([this.agent]);
    // night: in the dark the enemy notices the agent late, under a lamp early
    g.spotRange = (viewer, target, range) => {
      if (viewer.team !== ENEMY || target !== this.agent) return range;
      const dark = this.aggressive ? COMMANDOS.escalation.dark : COMMANDOS.night.dark;
      return range * (this.isLit(target.x, target.z) ? COMMANDOS.night.lit : dark) * (this.inCover() ? COMMANDOS.cover.range : 1);
    };
    g.spotGate = (viewer, target) => this.makesOut(viewer, target);
    g.onKilled = (u) => {
      if (u.team === ENEMY && ["rifleman", "grenadier", "medic", "pilot"].includes(u.type)) this.soldiersDown++;
      if (u.team === ENEMY) this.onEnemyKilled(u);
    };
  }

  /**
   * Hides the explosive caches at the edge of different woods, well away from the outposts and
   * from each other (and not right next to the agent).
   */
  private placeCaches() {
    const g = this.game, a = this.agent;
    const forests = [...g.layout.forests].sort(() => Math.random() - 0.5);
    const lim = MAP_HALF - 6;
    for (const f of forests) {
      if (this.caches.length >= COMMANDOS.caches.count) break;
      for (let tries = 0; tries < 30; tries++) {
        const ang = Math.random() * Math.PI * 2, d = f.r + 1.5 + Math.random() * 3;
        const x = f.x + Math.cos(ang) * d, z = f.z + Math.sin(ang) * d;
        if (Math.abs(x) > lim || Math.abs(z) > lim || g.nav.isBlocked(x, z)) continue;
        if (g.outposts.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + 10)) continue;
        if (this.caches.some((c) => Math.hypot(c.x - x, c.z - z) < 25) || Math.hypot(a.x - x, a.z - z) < 12) continue;
        this.caches.push({ x, z, taken: false, mesh: this.cacheMesh(x, z) });
        break;
      }
    }
  }

  /** A crate under a camouflage tarp with a couple of ammunition boxes. */
  private cacheMesh(x: number, z: number): Mesh {
    const g = this.game, sc = g.scene;
    const parts: Mesh[] = [];
    const box = (w: number, h: number, d: number, px: number, py: number, pz: number, c: [number, number, number], ry = 0) => {
      const m = MeshBuilder.CreateBox("cache", { width: w, height: h, depth: d }, sc);
      m.position.set(px, py, pz);
      m.rotation.y = ry;
      m.material = mat(sc, c);
      parts.push(m);
    };
    box(1.0, 0.6, 0.7, 0, 0.3, 0, [0.42, 0.31, 0.18]);
    box(1.1, 0.08, 0.8, 0, 0.64, 0, [0.28, 0.33, 0.2], 0.1); // tarp
    box(0.5, 0.3, 0.3, 0.75, 0.15, 0.3, [0.3, 0.36, 0.2], 0.5);
    box(0.5, 0.3, 0.3, -0.7, 0.15, -0.25, [0.3, 0.36, 0.2], -0.3);
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
    merged.isPickable = false;
    merged.position.set(x, g.terrain.heightAt(x, z), z);
    merged.rotation.y = Math.random() * Math.PI;
    g.shadows.addShadowCaster(merged);
    return merged;
  }

  /** Removes everything the mission added to the scene (back to the main menu). */
  dispose() {
    const g = this.game;
    this.flare?.dispose();
    this.flare = null;
    for (const b of this.beams) {
      b.light.dispose();
      g.nav.structure(b.light.x, b.light.z, 0.4, 0.4, 0, [0, 1], -1);
    }
    this.beams.length = 0;
    for (const d of this.drones) {
      d.light.dispose();
      d.glow.dispose();
    }
    this.drones.length = 0;
    for (const c of this.caches) if (!c.taken) c.mesh.dispose();
    this.caches.length = 0;
    for (const e of this.embassies) {
      e.flag.dispose();
      e.flagMat.dispose();
    }
    this.embassies.length = 0;
    for (const c of this.planted) c.mesh.dispose();
    this.planted.length = 0;
    this.chargeTpl?.dispose();
    // the agent's templates keep their own materials; leave them fully opaque
    for (const m of this.agentMaterials) {
      m.alpha = 1;
      m.emissiveColor.set(0, 0, 0);
      const c = this.agentBase.get(m);
      if (c) m.diffuseColor.copyFrom(c);
    }
    g.spotRange = null;
    g.spotGate = null;
    g.onKilled = null;
  }

  // ---------------------------------------------------------------- cover & detection

  /** Seconds each soldier has been looking at the agent in cover (and when he last did). */
  private readonly suspicion = new Map<Unit, { t: number; seen: number }>();

  /** The agent stands in cover (trees, hedges, bushes, a building's flank) and not in the light of a lamp or searchlight. */
  inCover(): boolean {
    const a = this.agent;
    return a.alive && !!this.game.cover?.at(a.x, a.z) && !this.isLit(a.x, a.z);
  }

  /**
   * Called when `viewer` has the agent within sight range: in the open he is noticed at once, in cover only after
   * COMMANDOS.cover.delay seconds of looking (the "?" fills up), unless he is practically in front of the viewer.
   */
  private makesOut(viewer: Unit, target: Unit): boolean {
    if (viewer.team !== ENEMY || target !== this.agent || !this.inCover()) return true;
    const C = COMMANDOS.cover;
    if (Math.hypot(viewer.x - target.x, viewer.z - target.z) < C.close) return true;
    let s = this.suspicion.get(viewer);
    if (!s || this.time - s.seen > 0.9) {
      s = { t: 0, seen: this.time };
      this.suspicion.set(viewer, s);
    }
    s.t += this.time - s.seen;
    s.seen = this.time;
    if (s.t < C.delay) return false;
    this.suspicion.delete(viewer);
    return true;
  }

  /** How far a soldier is from raising the alarm (0..1): the "?" over his head fills up while he makes the agent out. */
  suspicionOf(u: Unit): number {
    const s = this.suspicion.get(u);
    if (!s || !u.alive || this.time - s.seen > 0.9 || u.target === this.agent) return 0;
    return Math.min(1, s.t / COMMANDOS.cover.delay);
  }

  // ---------------------------------------------------------------- searching & tracking

  /** A soldier died: comrades within earshot start searching at once, others when they find him. */
  private onEnemyKilled(u: Unit) {
    const death: Death = { x: u.x, z: u.z, t: this.time, found: false };
    this.deaths.push(death);
    const heard = this.game.units.filter((o) => o.alive && o.team === ENEMY && !o.vehicle && grounded(o) && Math.hypot(o.x - u.x, o.z - u.z) < HEAR);
    if (heard.length) this.discover(death, heard);
  }

  private discover(d: Death, finders: Unit[]) {
    d.found = true;
    // everybody around the finders joins the search of the area around the body
    const team = this.game.units.filter(
      (o) => o.alive && o.team === ENEMY && !o.vehicle && grounded(o) && finders.some((f) => Math.hypot(f.x - o.x, f.z - o.z) < HEAR),
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
      if (a.alive && !a.cloaked && !u.target && Math.hypot(a.x - u.x, a.z - u.z) < SEARCH.vigilance && this.makesOut(u, a)) u.target = a;
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
      const finders = g.units.filter((o) => o.alive && o.team === ENEMY && !o.vehicle && grounded(o) && Math.hypot(o.x - d.x, o.z - d.z) < FIND);
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
    this.stepSide = -this.stepSide;
    this.trail.push({ x: a.x, z: a.z, t: now, heading: a.heading, side: this.stepSide });
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
      // (the rigged figure's meshes are no instances: they own their materials directly)
      const src = (m as InstancedMesh).sourceMesh ?? (m instanceof Mesh ? m : null);
      if (!src || done.has(src)) continue;
      done.add(src);
      const own = (x: StandardMaterial) => {
        const c = x.clone(`${x.name}-agent`);
        c.metadata = { ...(x.metadata ?? {}), mirrorDiffuse: true }; // the PBR copy follows the colour changes of the thermal look
        this.agentBase.set(c, c.diffuseColor.clone());
        this.agentMaterials.push(c);
        return c;
      };
      // (with PBR graphics the classic materials are cloned; the PBR mode converts the clones)
      const mat = src.material && classicMaterial(src.material);
      if (mat instanceof MultiMaterial) {
        const mm = mat.clone(`${mat.name}-agent`) as MultiMaterial;
        mm.subMaterials = mat.subMaterials.map((s) => (s && classicMaterial(s) instanceof StandardMaterial ? own(classicMaterial(s) as StandardMaterial) : s));
        src.material = mm;
      } else if (mat instanceof StandardMaterial) {
        src.material = own(mat);
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
    if (target.type === "drone") {
      // a small, fast target: rarely hit - but the shot always draws the drone onto him
      const hit = Math.random() < COMMANDOS.drones.hitChance;
      g.addTracer(a, target, hit, "sniper");
      const d = this.drones.find((dr) => dr.unit === target);
      if (d) {
        d.mode = "track";
        d.lockT = COMMANDOS.drones.lose;
        d.lastSeen = { x: a.x, z: a.z };
      }
      if (hit) {
        g.damage(target, 9999, a);
        g.emit("targetEliminated", PLAYER);
      }
      return true;
    }
    g.addTracer(a, target, true, "sniper");
    g.damage(target, target.isVehicle ? COMMANDOS.sniper.vehicleDamage : 9999, a);
    if (!target.alive) g.emit("targetEliminated", PLAYER);
    // comrades near the victim hear the shot and go looking at the victim's position
    for (const u of g.units) {
      if (u.alive && u.team === ENEMY && !u.vehicle && grounded(u) && !u.target && Math.hypot(u.x - target.x, u.z - target.z) < 18) {
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
    this.updateThermal(dt);

    this.updateHunt(dt);
    this.updatePlanting(dt);
    this.updateCharges(dt);
    this.updatePatrols(dt);
    this.updateBeams(dt);
    if (!this.aggressive && (this.destroyedOutposts > COMMANDOS.escalation.after || (this.kind === "documents" && this.documents >= EMBASSY_OPS.escalateAfter))) this.escalate();
    this.updateDrones(dt);
    this.updateAlert(dt);
    this.updateCaches();
    if (this.kind === "documents") {
      this.updateEmbassies(dt);
      this.updateCaptives(dt);
    }

    if (!this.warnedTime && this.timeLeft <= 60) {
      this.warnedTime = true;
      g.emit("timeWarning", PLAYER);
    }
    if (this.timeLeft <= 0 && a.alive) {
      this.timeUp = true;
      g.result = "lose";
      g.emit("lose", PLAYER);
    } else if (!a.alive) {
      g.result = "lose";
      g.emit("lose", PLAYER);
    } else if (this.objectiveDone) {
      // last objective: get out alive - reach the extraction point
      if (!this.extraction) this.startExtraction();
      else if (!this.extracting && Math.hypot(a.x - this.extraction.x, a.z - this.extraction.z) <= EXTRACT_RADIUS) {
        this.extracting = true;
        if (this.onExtraction) this.onExtraction(this.extraction);
        else this.complete();
      }
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
      c.mesh.position.set(c.x, g.terrain.heightAt(c.x, c.z) + (onJeep ? 1.05 : 0.02), c.z);
      // the charge that blows up the second outpost: a cutscene takes over (and sets it off itself)
      if (this.onSecondBlast && !this.aggressive && !(c.target instanceof Unit) && !c.target.destroyed && this.destroyedOutposts + 1 > COMMANDOS.escalation.after && c.fuse <= 2.2) {
        const start = this.onSecondBlast;
        this.onSecondBlast = null;
        start(c);
        return;
      }
      c.fuse -= dt;
      if (c.fuse > 0) continue;
      this.detonate(c);
    }
  }

  /** Called with the charge that is about to destroy the second outpost (see updateCharges). */
  onSecondBlast: ((c: Charge) => void) | null = null;

  /** The last objective, once every target is down: the extraction point the agent must reach. */
  extraction: { x: number; z: number } | null = null;
  private flare: ExtractionFlare | null = null;
  /** The agent has reached the extraction point (the cutscene takes over). */
  extracting = false;
  /** Called when the agent reaches the extraction point; the mission is won once it calls `complete()`. */
  onExtraction: ((at: { x: number; z: number }) => void) | null = null;

  /** All targets down: a blue smoke flare marks a remote extraction point. */
  private startExtraction() {
    const a = this.agent;
    this.extraction = pickExtractionPoint(this.game, a);
    this.flare = new ExtractionFlare(this.game.scene, this.game.terrain, this.extraction.x, this.extraction.z);
    this.game.emit(this.kind === "documents" ? "documentsAll" : "extraction", PLAYER);
  }

  /** The agent is out: mission accomplished. */
  complete() {
    const g = this.game;
    if (g.result) return;
    g.result = "win";
    g.emit("win", PLAYER);
  }

  /** Sets a planted charge off. `sparing`: the agent is out of reach of the blast (for the cutscene, where he could not run). */
  detonate(c: Charge, sparing = false) {
    const g = this.game, a = this.agent;
    const i = this.planted.indexOf(c);
    if (i >= 0) this.planted.splice(i, 1);
    c.mesh.dispose();
    const ax = a.x, az = a.z;
    if (sparing) a.x = a.z = 1e5;
    // an outpost goes up with a much bigger blast: it reaches everyone on guard there, up to its edge
    const outpost = c.target instanceof Unit ? null : c.target;
    const reach = outpost ? Math.max(COMMANDOS.charges.radius, outpost.radius + 2.5) : COMMANDOS.charges.radius;
    g.effects.explode(c.x, c.z, COMMANDOS.charges.damage, reach, null, outpost ? 3.4 : 2.4);
    a.x = ax;
    a.z = az;
    if (c.target instanceof Unit) {
      if (c.target.alive) g.damage(c.target, 9999, null);
    } else if (!c.target.destroyed && Math.hypot(c.x - c.target.x, c.z - c.target.z) <= c.target.radius) {
      c.target.destroy();
      this.destroyedOutposts++;
      g.emit("outpostDestroyed", PLAYER);
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
      // foot patrols wander a little around their waypoint, jeeps stop right on the road
      const j = p.onFoot ? 6 : 0;
      const jitter = { x: wp.x + (Math.random() - 0.5) * j, z: wp.z + (Math.random() - 0.5) * j };
      g.commandMove(alive, g.nav.freePoint(jitter.x, jitter.z, alive[0].navLayer), true, false);
    }
  }

  /**
   * The lights that also light the scenery in the realistic mode (trees, houses, vehicles): the lit spots
   * of the searchlights and the street lamps (a drone's thermal camera casts no visible light), the nearest few to (x, z).
   */
  lightSources(x: number, z: number): SpotLight[] {
    const h = (px: number, pz: number) => this.game.terrain.heightAt(px, pz);
    const all: SpotLight[] = [];
    for (const b of this.beams) {
      if (!b.post.destroyed) all.push({ x: b.light.tx, y: h(b.light.tx, b.light.tz) + 3, z: b.light.tz, radius: b.light.radius * 8, color: [0.75, 0.82, 1], intensity: 3 });
    }
    for (const p of this.streetPools) all.push({ x: p.x, y: h(p.x, p.z) + 4.2, z: p.z, radius: p.r * 5, color: [1, 0.78, 0.45], intensity: 2 });
    all.sort((a, c) => Math.hypot(a.x - x, a.z - z) - Math.hypot(c.x - x, c.z - z));
    return all.slice(0, MAX_SPOTS);
  }

  /** Whether (x, z) lies in the light of a street lamp or a searchlight beam (not a drone's marker: it is a thermal camera). */
  isLit(x: number, z: number): boolean {
    if (this.streetPools.some((p) => Math.hypot(p.x - x, p.z - z) < p.r)) return true;
    return this.beams.some((b) => !b.post.destroyed && b.light.contains(x, z));
  }

  /** The agent walks over a cache and takes the charges in it. */
  private updateCaches() {
    const a = this.agent;
    if (!a.alive) return;
    for (const c of this.caches) {
      if (c.taken || Math.hypot(c.x - a.x, c.z - a.z) > COMMANDOS.caches.pickup) continue;
      c.taken = true;
      c.mesh.dispose();
      this.charges += COMMANDOS.caches.charges;
      this.game.emit("cacheFound", PLAYER);
    }
  }

  /**
   * Searchlights sweep in front of their outpost. When the agent (uncloaked) steps into a beam it
   * locks onto him and follows him for a few seconds, and the troops nearby are sent after him.
   */
  private updateBeams(dt: number) {
    const g = this.game, a = this.agent, L = COMMANDOS.searchlight;
    // a searchlight reaches no farther than a soldier can see
    const reach = SIGHT.rifleman;
    for (const b of this.beams) {
      if (b.post.destroyed) {
        b.light.setEnabled(false);
        continue;
      }
      const inReach = Math.hypot(a.x - b.light.x, a.z - b.light.z) <= reach;
      const lit = a.alive && !a.cloaked && inReach && b.light.contains(a.x, a.z);
      if (lit) b.lockT = L.lock;
      b.lockT -= dt;
      let tx: number, tz: number;
      if (!inReach) b.lockT = 0; // out of reach: the beam loses him
      if (b.lockT > 0 && a.alive && !a.cloaked) {
        tx = a.x;
        tz = a.z;
      } else {
        const ang = b.base + Math.sin(this.time * 0.35 + b.phase) * 1.1;
        const d = L.near + (L.far - L.near) * (0.5 + 0.5 * Math.sin(this.time * 0.23 + b.phase * 1.7));
        tx = b.light.x + Math.sin(ang) * d;
        tz = b.light.z + Math.cos(ang) * d;
      }
      // the beam swings over at a limited speed, so the agent can still dodge out of it
      const dx = tx - b.light.tx, dz = tz - b.light.tz, dist = Math.hypot(dx, dz), step = 11 * dt;
      if (dist > step) {
        tx = b.light.tx + (dx / dist) * step;
        tz = b.light.tz + (dz / dist) * step;
      }
      const out = Math.hypot(tx - b.light.x, tz - b.light.z);
      if (out > reach) {
        tx = b.light.x + ((tx - b.light.x) / out) * reach;
        tz = b.light.z + ((tz - b.light.z) / out) * reach;
      }
      b.light.aim(tx, tz);

      b.alarmT -= dt;
      if (b.lockT > 0 && a.alive && !a.cloaked && b.alarmT <= 0) {
        b.alarmT = 3;
        this.rally(b.light.x, b.light.z, 35);
      }
    }
  }

  /**
   * The agent was caught in a light: troops in range open fire, those within `radius` of the light
   * close in on him.
   */
  private rally(x: number, z: number, radius: number) {
    const g = this.game, a = this.agent;
    for (const u of g.units) {
      if (!u.alive || u.team !== ENEMY || u.vehicle || !u.armed) continue;
      const d = Math.hypot(u.x - a.x, u.z - a.z);
      if (d <= u.stats.acquire + 4) u.target = a; // in range: open fire
      else if (!u.isStructure && grounded(u) && Math.hypot(u.x - x, u.z - z) < radius) {
        u.orderMove(g.nav.freePoint(a.x + (Math.random() - 0.5) * 6, a.z + (Math.random() - 0.5) * 6, u.navLayer), true, g);
      }
    }
  }

  // ---------------------------------------------------------------- embassies (city map)

  /**
   * Draws the three embassies among the villas along the park (spread apart, reachable on foot from the
   * agent's landing place) and puts the guards, a machine-gun nest, a searchlight, a squad on its rounds and a
   * flag on the roof at each.
   */
  private setupEmbassies() {
    const g = this.game, a = this.agent, O = EMBASSY_OPS;
    const cands = g.layout.houses.filter((h) => h.style === "villa" && Math.abs(h.z) < 72 && Math.hypot(h.x - a.x, h.z - a.z) > 35).sort(() => Math.random() - 0.5);
    const doorOf = (h: HouseSpec) => {
      const p = toWorld(h.x, h.z, h.rot, 0, h.d / 2 + 2.2);
      return g.nav.freePoint(p.x, p.z);
    };
    const reachable = (d: V2) => {
      const path = g.nav.findPath(a.x, a.z, d.x, d.z);
      const end = path[path.length - 1];
      return !!end && Math.hypot(end.x - d.x, end.z - d.z) < 2;
    };
    const chosen: HouseSpec[] = [];
    // spread apart and reachable first, then whatever is left
    for (const [spread, need] of [[40, true], [20, true], [0, false]] as const) {
      for (const h of cands) {
        if (chosen.length >= O.documents) break;
        if (chosen.includes(h) || chosen.some((c) => Math.hypot(c.x - h.x, c.z - h.z) < spread)) continue;
        if (need && !reachable(doorOf(h))) continue;
        chosen.push(h);
      }
    }
    const flags: [number, number, number][] = [[0.85, 0.15, 0.15], [0.2, 0.45, 0.9], [0.95, 0.75, 0.15]];
    chosen.forEach((h, i) => {
      const door = doorOf(h);
      const post = { destroyed: false };
      const { flag, flagMat } = this.flagMesh(h, flags[i % flags.length]);
      this.embassies.push({ name: `Botschaft ${i + 1}`, villa: h, door, taken: false, progress: 0, post, flag, flagMat });
      const at = (lx: number, lz: number) => {
        const p = toWorld(h.x, h.z, h.rot, lx, lz);
        return g.nav.freePoint(p.x, p.z);
      };
      // guards: two at the door, one at each side, one at the back and a grenadier at the front
      const hw = h.w / 2 + 2.4, hd = h.d / 2 + 2.4;
      const posts: [number, number, number][] = [
        [-3.2, hd, 0], [3.2, hd, 0], [-hw, 0, -Math.PI / 2], [hw, 0, Math.PI / 2], [0, -hd, Math.PI], [0, hd + 3.5, 0],
      ];
      for (let k = 0; k < Math.min(O.villa.guards, posts.length); k++) {
        const [lx, lz, turn] = posts[k];
        const p = at(lx, lz);
        const u = g.spawnUnit(k === posts.length - 1 ? "grenadier" : "rifleman", ENEMY, p.x, p.z);
        u.heading = h.rot + turn;
        this.homes.set(u, { x: p.x, z: p.z });
      }
      // a searchlight at a back corner sweeps the front of the villa
      const lp = at(-h.w / 2 - 3.5, -h.d / 2 - 3);
      const light = new Searchlight(g.scene, g.terrain, g.shadows, lp.x, lp.z, COMMANDOS.searchlight.poolRadius);
      g.nav.structure(lp.x, lp.z, 0.4, 0.4, 0, [0, 1], 1);
      this.beams.push({ light, post, base: Math.atan2(door.x - lp.x, door.z - lp.z), phase: Math.random() * 10, lockT: 0, alarmT: 0 });
      // an MG nest in front of the door, covering the garden
      if (O.villa.nest) {
        for (const [lx, lz] of [[-5.5, hd + 4.5], [5.5, hd + 4.5], [0, hd + 6.5]]) {
          const p = toWorld(h.x, h.z, h.rot, lx, lz);
          if (!g.nav.areaFree(p.x, p.z, 1.3, 1.3, h.rot, 0)) continue;
          const nest = g.spawnStructure("mgnest", ENEMY, p.x, p.z, h.rot, null);
          g.board(g.spawnUnit("rifleman", ENEMY, p.x, p.z - 2), nest);
          break;
        }
      }
      // a squad that walks rounds about the villa
      for (let n = 0; n < O.villa.patrols; n++) {
        const route = [[hw + 2.5, hd + 2.5], [-hw - 2.5, hd + 2.5], [-hw - 2.5, -hd - 2.5], [hw + 2.5, -hd - 2.5]].map(([lx, lz]) => at(lx, lz));
        const units = (["rifleman", "rifleman", "grenadier"] as UnitType[]).map((t, k) => {
          const p = g.nav.freePoint(route[n % 4].x + k * 1.5, route[n % 4].z + 1.5);
          return g.spawnUnit(t, ENEMY, p.x, p.z);
        });
        this.patrols.push({ units, route, next: (n + 1) % 4, wait: Math.random() * 4, trackT: -1, onFoot: true });
      }
    });
  }

  /** A flag on a pole on the roof (it glows a little, so it can be seen in the dark). */
  private flagMesh(h: HouseSpec, c: [number, number, number]): { flag: Mesh; flagMat: StandardMaterial } {
    const g = this.game, sc = g.scene;
    const top = h.h + h.roofH + (h.dome ? 2.5 : 0);
    const pole = MeshBuilder.CreateCylinder("flagPole", { height: 4.2, diameter: 0.12, tessellation: 6 }, sc);
    pole.position.y = 2.1;
    const flagMat = new StandardMaterial("embassyFlag", sc);
    flagMat.diffuseColor = new Color3(...c);
    flagMat.emissiveColor = new Color3(c[0] * 0.55, c[1] * 0.55, c[2] * 0.55);
    flagMat.specularColor = Color3.Black();
    flagMat.backFaceCulling = false;
    const cloth = MeshBuilder.CreatePlane("flagCloth", { width: 2.1, height: 1.3 }, sc);
    cloth.position.set(1.1, 3.4, 0);
    cloth.material = flagMat;
    const poleMat = new StandardMaterial("flagPoleMat", sc);
    poleMat.diffuseColor = new Color3(0.8, 0.8, 0.78);
    pole.material = poleMat;
    const flag = Mesh.MergeMeshes([pole, cloth], true, true, undefined, false, true)!;
    flag.isPickable = false;
    flag.position.set(h.x, g.terrain.heightAt(h.x, h.z) + top, h.z);
    flag.rotation.y = Math.random() * Math.PI * 2;
    return { flag, flagMat };
  }

  /** The agent stands at an embassy's front door: after a few seconds the documents are his. */
  private updateEmbassies(dt: number) {
    const g = this.game, a = this.agent, D = EMBASSY_OPS.door;
    for (const e of this.embassies) {
      if (e.taken) continue;
      const near = a.alive && Math.hypot(a.x - e.door.x, a.z - e.door.z) <= D.reach;
      if (near) {
        e.progress = Math.min(1, e.progress + dt / D.time);
        if (!a.path.length && !a.dest) {
          a.stance = "kneel";
          a.heading = Math.atan2(e.villa.x - a.x, e.villa.z - a.z);
        }
      } else {
        e.progress = Math.max(0, e.progress - dt / (D.time * 2));
      }
      if (e.progress < 1) continue;
      e.taken = true;
      e.post.destroyed = true; // its searchlight goes out
      e.flagMat.diffuseColor.set(0.25, 0.7, 0.3);
      e.flagMat.emissiveColor.set(0.1, 0.4, 0.15);
      // (the last one is announced with the extraction point)
      if (this.documents < this.embassies.length) g.emit("documentsSecured", PLAYER);
    }
  }

  /**
   * The agent takes an outpost by holding it (no enemy soldier inside, the usual capture time): the soldiers held there
   * join him, fire at the enemy and follow him.
   */
  private updateCaptives(dt: number) {
    const g = this.game, a = this.agent, C = EMBASSY_OPS.captives;
    this.captiveCheckT -= dt;
    if (this.captiveCheckT <= 0) {
      this.captiveCheckT = 0.5;
      for (const o of g.outposts) {
        if (o.owner !== PLAYER || this.rewarded.has(o)) continue;
        this.rewarded.add(o);
        for (let i = 0; i < C.count; i++) {
          const ang = (i / C.count) * Math.PI * 2 + Math.random();
          const p = g.nav.freePoint(o.x + Math.cos(ang) * 2.2, o.z + Math.sin(ang) * 2.2);
          const u = g.spawnUnit(i === C.count - 1 ? "grenadier" : "rifleman", PLAYER, p.x, p.z);
          u.heading = ang;
          this.freed.push(u);
          this.freedTotal++;
        }
        g.emit("captivesFreed", PLAYER);
      }
    }
    // the freed soldiers stay with the agent
    this.followT -= dt;
    if (this.followT > 0 || !a.alive) return;
    this.followT = 1;
    for (let i = this.freed.length - 1; i >= 0; i--) {
      const u = this.freed[i];
      if (!u.alive) {
        this.freed.splice(i, 1);
        continue;
      }
      if (u.target || u.path.length || u.boarding) continue;
      const d = Math.hypot(u.x - a.x, u.z - a.z);
      if (d > 7) {
        const ang = Math.random() * Math.PI * 2;
        u.orderMove(g.nav.freePoint(a.x + Math.cos(ang) * 3.5, a.z + Math.sin(ang) * 3.5), false, g);
      }
    }
  }

  // ---------------------------------------------------------------- drones

  /** More than two outposts lost: the enemy goes on full alert and launches its recon drones. */
  escalate(first?: { pilot: Unit; drone: Unit }) {
    const g = this.game, D = COMMANDOS.drones;
    this.aggressive = true;
    const posts = g.outposts.filter((o) => !o.destroyed).sort(() => Math.random() - 0.5);
    if (!posts.length) return;
    for (let i = 0; i < D.count; i++) {
      // each drone's pilot kneels at his laptop at a random outpost (the first one may be given: the cutscene's)
      const given = i === 0 ? first : undefined;
      const o = posts[i % posts.length];
      const ang = Math.random() * Math.PI * 2;
      const p = given ? { x: given.pilot.x, z: given.pilot.z } : g.nav.freePoint(o.x + Math.cos(ang) * o.radius * 0.5, o.z + Math.sin(ang) * o.radius * 0.5);
      const pilot = given?.pilot ?? g.spawnUnit("pilot", ENEMY, p.x, p.z);
      if (!given) pilot.heading = Math.random() * Math.PI * 2;
      pilot.stance = "kneel";
      // his screen and headset light up the ground around him a little
      const glow = createGlowSpot(g.scene, g.terrain, p.x + Math.sin(pilot.heading) * 0.7, p.z + Math.cos(pilot.heading) * 0.7, 2.2, [0.45, 0.75, 1], 0.45);
      const unit = given?.drone ?? g.spawnUnit("drone", ENEMY, p.x, p.z);
      unit.altitude = D.altitude;
      unit.aimY = D.altitude;
      // a dimmer, violet light (infrared-ish)
      const light = new Searchlight(g.scene, g.terrain, g.shadows, p.x, p.z, D.poolRadius, true, {
        beam: [0.5, 0.28, 0.85], beamAlpha: 0.07, pool: [0.55, 0.3, 0.95], poolAlpha: 0.55,
      });
      this.drones.push({ unit, pilot, light, glow, mode: "search", lockT: 0, wp: this.droneWaypoint(), alarmT: 0, lastSeen: null, down: false });
    }
    g.emit("dronesLaunched", PLAYER);
  }

  /**
   * While a drone has the agent in sight he is shown as through its thermal camera: his body glows
   * orange-red, the warm skin almost white-yellow, with a slight flicker.
   */
  private updateThermal(dt: number) {
    const a = this.agent;
    const seen = a.alive && !a.cloaked && this.drones.some((d) => !d.down && d.mode === "track" && d.lockT >= COMMANDOS.drones.lose - 0.05);
    this.thermal += ((seen ? 1 : 0) - this.thermal) * Math.min(1, dt * 5);
    const k = this.thermal * (0.9 + Math.sin(this.time * 23) * 0.1);
    // in the light of a lamp or searchlight the agent is lit up: his own colours glow a little, so he
    // stands out of the dark (the thermal look below is added on top)
    const lit = a.alive && !a.cloaked && this.isLit(a.x, a.z);
    this.lit += ((lit ? 1 : 0) - this.lit) * Math.min(1, dt * 6);
    const L = this.lit * 1.1;
    const th = this.thermal;
    for (const m of this.agentMaterials) {
      const c = this.agentBase.get(m) ?? m.diffuseColor;
      // thermal image: the bare skin (face, neck, hands) is the hottest - a bright orange to yellow;
      // the clothes are cooler - a dark, deep red (their own colour is darkened for it)
      const skin = c.r > 0.7 && c.g > 0.5 && c.b > 0.38 && c.r > c.g && c.g > c.b;
      const dark = th * (skin ? 0.35 : 0.8);
      m.diffuseColor.set(c.r * (1 - dark), c.g * (1 - dark), c.b * (1 - dark));
      m.emissiveColor.set(
        Math.min(1, k * (skin ? 1.0 : 0.55) + c.r * L),
        Math.min(1, k * (skin ? 0.74 + 0.1 * Math.sin(this.time * 9) : 0.05) + c.g * L * 0.95),
        Math.min(1, k * (skin ? 0.2 : 0.03) + c.b * L * 0.8),
      );
    }
  }

  /** How strongly the agent is shown as in a drone's thermal camera (0..1, eased). */
  get thermalLevel() {
    return this.thermal;
  }

  /** Where a searching drone looks next: half the time near the agent's freshest tracks, else anywhere. */
  private droneWaypoint(near?: V2): V2 {
    const lim = MAP_HALF - 12;
    const trail = this.trail[this.trail.length - 1];
    const c = near ?? (trail && Math.random() < 0.5 ? trail : null);
    if (c) return { x: Math.max(-lim, Math.min(lim, c.x + (Math.random() - 0.5) * 40)), z: Math.max(-lim, Math.min(lim, c.z + (Math.random() - 0.5) * 40)) };
    return { x: (Math.random() * 2 - 1) * lim, z: (Math.random() * 2 - 1) * lim };
  }

  /**
   * Drones sweep the map with their light. One that sees the (uncloaked) agent keeps him in its
   * beam and calls in the troops; it loses him after a few seconds out of view. If its pilot dies
   * the link is lost and the drone falls out of the sky.
   */
  private updateDrones(dt: number) {
    const g = this.game, a = this.agent, D = COMMANDOS.drones;
    for (const d of this.drones) {
      const u = d.unit;
      if (d.down) continue;
      if (!d.pilot.alive && u.alive) g.damage(u, 9999, null); // link lost
      if (!d.pilot.alive) d.glow.setEnabled(false);
      if (!u.alive) {
        d.down = true;
        d.light.setEnabled(false);
        this.dronesDown++;
        g.emit("droneDown", PLAYER);
        continue;
      }
      const dist = Math.hypot(a.x - u.x, a.z - u.z);
      // searching, it only finds him in its light (or right below it); once on him it holds on longer
      const inLight = d.light.contains(a.x, a.z);
      const sees = a.alive && !a.cloaked && (d.mode === "track" ? dist < D.trackSight : inLight || dist < D.sight);
      if (sees) {
        d.mode = "track";
        d.lockT = D.lose;
        d.lastSeen = { x: a.x, z: a.z };
      } else if (d.mode === "track") {
        d.lockT -= dt;
        if (d.lockT <= 0) {
          d.mode = "search";
          d.wp = this.droneWaypoint(d.lastSeen ?? undefined);
        }
      }
      // fly: hang back a few metres from the agent while tracking, otherwise towards the waypoint
      let tx: number, tz: number, speed: number;
      if (d.mode === "track" && d.lastSeen) {
        const back = Math.hypot(u.x - d.lastSeen.x, u.z - d.lastSeen.z) || 1;
        tx = d.lastSeen.x + ((u.x - d.lastSeen.x) / back) * 4;
        tz = d.lastSeen.z + ((u.z - d.lastSeen.z) / back) * 4;
        speed = D.chase;
      } else {
        if (Math.hypot(d.wp.x - u.x, d.wp.z - u.z) < 3) d.wp = this.droneWaypoint();
        tx = d.wp.x;
        tz = d.wp.z;
        speed = D.speed;
      }
      const dx = tx - u.x, dz = tz - u.z, len = Math.hypot(dx, dz);
      if (len > 0.05) {
        const step = Math.min(len, speed * dt);
        u.x += (dx / len) * step;
        u.z += (dz / len) * step;
        const want = Math.atan2(dx, dz);
        let turn = want - u.heading;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        u.heading += Math.max(-dt * 3, Math.min(dt * 3, turn));
      }
      // the light: on the agent while tracking, otherwise sweeping the ground ahead of the drone
      const ground = g.terrain.heightAt(u.x, u.z);
      d.light.moveTo(u.x, ground + D.altitude - 0.2, u.z);
      if (d.mode === "track" && d.lastSeen) {
        d.light.aim(sees ? a.x : d.lastSeen.x, sees ? a.z : d.lastSeen.z);
      } else {
        const t = this.time * 1.3 + u.id;
        d.light.aim(u.x + Math.sin(u.heading) * 5 + Math.cos(t) * 2.5, u.z + Math.cos(u.heading) * 5 + Math.sin(t) * 2.5);
      }
      d.alarmT -= dt;
      if (d.mode === "track" && sees && d.alarmT <= 0) {
        d.alarmT = 3;
        if (this.spottedCooldown <= 0) {
          g.emit("spotted", PLAYER);
          this.spottedCooldown = 12;
        }
        this.rally(u.x, u.z, 45);
      }
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
    // on full alert the call reaches further
    const radius = COMMANDOS.alertRadius * (this.aggressive ? COMMANDOS.escalation.alertScale : 1);
    for (const u of g.units) {
      if (!u.alive || u.team !== ENEMY || u.vehicle || u.target || !grounded(u)) continue;
      if (Math.hypot(u.x - spotter.x, u.z - spotter.z) > radius) continue;
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
    const city = g.layout.map === "embassy";
    for (const [fromPost, fromEnemy] of [[34, 30], [28, 24], [22, 18], [16, 12]]) {
      for (let tries = 0; tries < 400; tries++) {
        const x = (Math.random() * 2 - 1) * lim, z = (Math.random() * 2 - 1) * lim;
        if (g.nav.isBlocked(x, z)) continue;
        // in the city he comes down in the open: in the park or on a street (not in a walled garden), with room for the canopy
        if (city && !((g.layout.inPark(x, z, 3) || g.layout.nearestRoad(x, z).d < 1) && g.nav.areaFree(x, z, 3, 3, 0, 0))) continue;
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
