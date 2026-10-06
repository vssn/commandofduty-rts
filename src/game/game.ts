import { createBarracksDetail } from "../world/barracksDetail";
import { Axis, Matrix, Quaternion, Vector3, type InstancedMesh, type Mesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { ARTILLERY, BUILD, COMBAT, ENEMY, JEEP_MG, MAP_HALF, ROAD, SKIRMISH, type GameMode, PLAYER, START_CREDITS, type StructureType, UNITS, type Team, type UnitType } from "../config";
import { COMPOUND, COMPOUND_BASTIONS, COMPOUND_WALLS, createSandbags } from "../world/fortification";
import { toWorld, type MapLayout, type V2 } from "../world/layout";
import {
  createAuraTemplate, createBarracksMesh, createBollardMesh, createMgNestMesh, createPennant, HOSPITAL_TENT, createBlobShadow, createJeepBody, createJeepGun,
  createDroneBody, createDroneRotor, createJeepWheel, createRing, createSoldierTemplates, JEEP_DIM, NEST_DIM,
} from "../world/models";
import { createRoofTiles } from "../world/masonry";
import type { Terrain } from "../world/terrain";
import { Artillery } from "./artillery";
import type { CommandosMission } from "./commandos";
import { Barracks } from "./barracks";
import { CoverMap } from "./cover";
import { Effects } from "./effects";
import type { NavGrid } from "./nav";
import { Outpost } from "./outpost";
import type { Production } from "./production";
import { Unit, type Target } from "./unit";
import { agentModelReady } from "../world/agentModel";
import { createSubwayMesh } from "../world/cityModels";
import { AgentView } from "./agentView";
import { BollardView, DroneView, JeepView, NestView, SoldierView, type DroneTemplates, type JeepTemplates, type NestTemplates, type SoldierTemplates, type UnitView } from "./views";

export type WeaponKind = "rifle" | "mg" | "sniper";
export interface Tracer { ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number; hit: boolean; kind: WeaponKind }
interface Marker { outer: InstancedMesh; inner: InstancedMesh; t: number }
/** Short-lived line from a unit to the point (or target) it was just ordered to. */
export interface OrderLine { unit: Unit; x: number; z: number; target: Target | null; t: number }

export type GameEvent =
  | "unitReady" | "unitLost" | "noCredits" | "baseAttacked" | "unitsAttacked" | "win" | "lose"
  | "captured" | "outpostLost" | "selected" | "commanded" | "boarded" | "artillery" | "enemyArtillery" | "noSight"
  | "spotted" | "outpostDestroyed" | "targetEliminated" | "cloaked" | "chargePlanted" | "notReady"
  | "enemySearching" | "tracked" | "built" | "cannotBuild" | "structureLost" | "outpostThreatened" | "cacheFound" | "timeWarning" | "dronesLaunched" | "droneDown" | "extraction" | "documentsSecured" | "documentsAll" | "captivesFreed";
export interface GameEventData { outpost: Outpost; bonus: number; structures?: number }
type Listener = (e: GameEvent, team: Team, data?: GameEventData) => void;

const TRACER_LIFE = 0.09;
const MARKER_LIFE = 0.9;
export const ORDER_LINE_LIFE = 0.7;

export class Game {
  readonly units: Unit[] = [];
  readonly buildings: Barracks[] = [];
  readonly credits: [number, number] = [START_CREDITS, START_CREDITS];
  readonly selection = new Set<Unit>();
  selectedBuilding: Barracks | null = null;
  readonly tracers: Tracer[] = [];
  readonly orderLines: OrderLine[] = [];
  result: "win" | "lose" | null = null;
  readonly outposts: Outpost[];
  readonly playerBarracks: Barracks;
  readonly enemyBarracks: Barracks;
  readonly effects: Effects;
  readonly artillery: Artillery;
  /** Called whenever a unit dies (commandos: comrades react to the death). */
  onKilled: ((u: Unit) => void) | null = null;
  /** Commandos mission state (agent, charges, patrols) when that mode is played. */
  commandos: CommandosMission | null = null;
  /** "base" = classic mode with production, "skirmish" = fixed forces and artillery strikes. */
  mode: GameMode = "base";

  private readonly soldierTpl: Record<Team, Record<"rifleman" | "grenadier" | "agent" | "medic" | "pilot", SoldierTemplates>>;
  private readonly droneTpl: DroneTemplates;
  private readonly jeepTpl: Record<Team, JeepTemplates>;
  private readonly nestTpl: Record<Team, NestTemplates>;
  private readonly bollardTpl: Mesh;
  private readonly ringTpl: Mesh;
  private readonly blobTpl: Mesh;
  /** Aura templates for 1, 2 and 3 simultaneous bonuses. */
  private readonly auraTpl: Mesh[];
  private readonly auras = new Map<Unit, { mesh: InstancedMesh; level: number }>();
  private time = 0;
  /** 1-unit grid over the playable area: 1 where a road or dirt track is. */
  private readonly roadGrid: Uint8Array;
  private readonly moveMarkerTpl: Mesh;
  private readonly attackMarkerTpl: Mesh;
  private readonly markers: Marker[] = [];
  private listeners: Listener[] = [];
  private baseAlertCooldown = 0;
  /** Time since the player's soldiers last took fire; a new engagement is announced after a calm period. */
  private sinceUnitsHit = Infinity;
  /** Extra sight range a unit currently has from high ground (fog of war), for UI display. */
  sightBonusOf: ((u: Unit) => number) | null = null;
  /**
   * Night (commandos): the range at which `viewer` notices `target`, given its normal `range`
   * (null = daylight, the normal range applies).
   */
  spotRange: ((viewer: Unit, target: Unit, range: number) => number) | null = null;
  /** Player's fog of war: whether a point is in sight (null = no fog). */
  canSee: ((x: number, z: number) => boolean) | null = null;
  /** Cover lookup; assigned after the scenery exists. */
  cover: CoverMap | null = null;
  /** Called for every shot fired (used for sound). */
  onShot: ((x: number, z: number, kind: WeaponKind) => void) | null = null;
  /** A shot leaves its muzzle at this world position (for the flash that lights the surroundings). */
  onMuzzle: ((x: number, y: number, z: number, kind: WeaponKind) => void) | null = null;
  /**
   * A bullet arrives at a jeep or a drone (used for sound): `hit` = metal impact, otherwise it
   * whizzes past; `delay` = flight time of the bullet in seconds.
   */
  onArmourShot: ((x: number, z: number, hit: boolean, delay: number) => void) | null = null;
  /** Called when a grenade leaves the hand. */
  onThrow: ((x: number, z: number) => void) | null = null;

  constructor(
    readonly scene: Scene,
    readonly terrain: Terrain,
    readonly nav: NavGrid,
    readonly layout: MapLayout,
    readonly shadows: ShadowGenerator,
  ) {
    const soldiers = (team: Team) => ({
      rifleman: createSoldierTemplates(scene, team),
      grenadier: createSoldierTemplates(scene, team, true),
      agent: createSoldierTemplates(scene, team, "agent"),
      medic: createSoldierTemplates(scene, team, "medic"),
      pilot: createSoldierTemplates(scene, team, "pilot"),
    });
    this.soldierTpl = { 0: soldiers(PLAYER), 1: soldiers(ENEMY) };
    const wheel = createJeepWheel(scene);
    const gun = createJeepGun(scene);
    const jeep = (team: Team): JeepTemplates => ({ body: createJeepBody(scene, team), wheel, gun, crew: this.soldierTpl[team].rifleman });
    this.jeepTpl = { 0: jeep(PLAYER), 1: jeep(ENEMY) };
    for (const team of [PLAYER, ENEMY]) {
      for (const t of Object.values(this.soldierTpl[team])) for (const m of [t.body, t.arms, t.head, t.leg, t.shin, t.throwArm]) if (m) shadows.addShadowCaster(m);
      shadows.addShadowCaster(this.jeepTpl[team].body);
    }
    shadows.addShadowCaster(wheel);
    shadows.addShadowCaster(gun);
    const nest = createMgNestMesh(scene);
    const pennants: [Mesh, Mesh] = [createPennant(scene, PLAYER), createPennant(scene, ENEMY)];
    this.nestTpl = {
      0: { body: nest, gun, crew: this.soldierTpl[PLAYER].rifleman, pennants },
      1: { body: nest, gun, crew: this.soldierTpl[ENEMY].rifleman, pennants },
    };
    this.bollardTpl = createBollardMesh(scene);
    this.droneTpl = { body: createDroneBody(scene), rotor: createDroneRotor(scene) };
    shadows.addShadowCaster(this.droneTpl.body);
    for (const m of [nest, this.bollardTpl, ...pennants]) shadows.addShadowCaster(m);

    this.effects = new Effects(scene, shadows, this);
    this.artillery = new Artillery(scene, this);
    this.blobTpl = createBlobShadow(scene);
    const n = MAP_HALF * 2;
    this.roadGrid = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) if (layout.nearestRoad(-MAP_HALF + i + 0.5, -MAP_HALF + j + 0.5).d < 0.2) this.roadGrid[i + j * n] = 1;
    }
    nav.setRoads(this.roadGrid); // vehicles prefer roads and tracks
    this.outposts = layout.outposts.map((o) => new Outpost(o, scene, terrain, shadows));
    for (const o of layout.outposts) {
      if (o.kind === "tower" || o.kind === "bunker") nav.blockRect(o.x, o.z, 2, 2, o.rot, 0.5);
      if (o.kind === "workshop") nav.blockRect(o.x, o.z, 3.5, 3, o.rot, 0.6);
      if (o.kind === "radar") {
        nav.blockCircle(o.x, o.z, 2.6); // the dome overhangs its drum
        const hut = toWorld(o.x, o.z, o.rot, -2.6, 2.2);
        nav.blockRect(hut.x, hut.z, 1.2, 0.9, o.rot, 0.2);
      }
      if (o.kind === "hospital") {
        // the ward tent is solid; cots and crates around it are not
        const c = toWorld(o.x, o.z, o.rot, HOSPITAL_TENT.x, HOSPITAL_TENT.z);
        nav.blockRect(c.x, c.z, HOSPITAL_TENT.hw, HOSPITAL_TENT.hd, o.rot, 0.2);
      }
    }
    this.auraTpl = [0.45, 0.65, 0.9].map((a, i) => createAuraTemplate(scene, `aura${i + 1}`, a));
    this.ringTpl = createRing(scene, "selRing", 1.9, 0.12, [0.4, 1, 0.45]);
    this.ringTpl.isVisible = false;
    this.moveMarkerTpl = createRing(scene, "moveMarker", 2.2, 0.16, [0.45, 1, 0.5]);
    this.moveMarkerTpl.isVisible = false;
    this.attackMarkerTpl = createRing(scene, "attackMarker", 2.2, 0.16, [1, 0.3, 0.25]);
    this.attackMarkerTpl.isVisible = false;

    this.playerBarracks = this.createBarracks(PLAYER, layout.playerBase, 0);
    this.enemyBarracks = this.createBarracks(ENEMY, layout.enemyBase, Math.PI);

    this.spawnStartingUnits();
  }

  /** A few soldiers and one grenadier to start with on each side. */
  private spawnStartingUnits() {
    for (const b of this.buildings) {
      (["rifleman", "rifleman", "rifleman", "grenadier"] as const).forEach((type, i) => {
        const p = b.rally;
        const u = this.spawnUnit(type, b.team, p.x + (i - 1.5) * 2, p.z + (Math.random() - 0.5));
        u.heading = b.rot;
      });
    }
  }

  /** Shows or hides the detailed base buildings of the realistic graphics mode (built on first use). */
  setBaseDetail(on: boolean) {
    if (this.layout.map === "embassy") return; // (the metro station has no extra detail)
    for (const b of this.buildings) {
      if (on && !b.detail) {
        b.detail = createBarracksDetail(this.scene, b.team);
        b.detail.parent = b.mesh;
        this.shadows.addShadowCaster(b.detail);
      }
      b.detail?.setEnabled(on);
    }
  }

  private createBarracks(team: Team, p: V2, rot: number): Barracks {
    // the city map's base is the exit of a metro station
    const city = this.layout.map === "embassy";
    const mesh = city ? createSubwayMesh(this.scene, team) : createBarracksMesh(this.scene, team);
    if (!city) {
      const tiles = createRoofTiles(this.scene, `barracksTiles${team}`, [{
        w: 8.9, h: 2.5, d: 12.9,
        color: team === PLAYER ? [0.42, 0.53, 0.76] : [0.76, 0.32, 0.26],
        transform: Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Axis.Y, Math.PI / 2), new Vector3(0, 4.4, 0)),
      }], mesh);
      this.shadows.addShadowCaster(tiles);
    }
    // sandbagged compound around the building; the walls are solid, only the gate is open
    const bags = createSandbags(this.scene, `sandbags${team}`);
    bags.parent = mesh;
    this.shadows.addShadowCaster(bags);
    const ring = createRing(this.scene, `bRing${team}`, 21, 0.3, [0.4, 1, 0.45]);
    const b = new Barracks(team, p.x, p.z, rot, mesh, ring, this.terrain.heightAt(p.x, p.z));
    mesh.metadata = { building: b };
    this.shadows.addShadowCaster(mesh);
    this.blockBarracks(b);
    this.buildings.push(b);
    return b;
  }

  /**
   * Back to the opening position of a conquest game (after the main menu's background battle):
   * all units, structures and effects are removed, buildings and outposts restored, credits reset.
   */
  reset() {
    for (const u of this.units) {
      if (u.alive && u.isStructure) this.blockStructure(u, -1);
      u.view.dispose();
      u.ring.dispose();
    }
    this.units.length = 0;
    for (const a of this.auras.values()) a.mesh.dispose();
    this.auras.clear();
    for (const m of this.markers) {
      m.outer.dispose();
      m.inner.dispose();
    }
    this.markers.length = this.tracers.length = this.orderLines.length = 0;
    this.clearSelection();
    this.result = null;
    this.mode = "base";
    this.commandos = null;
    this.onKilled = null;
    this.spotRange = null;
    this.credits[0] = this.credits[1] = START_CREDITS;
    this.time = 0;
    this.sinceUnitsHit = Infinity;
    this.baseAlertCooldown = 0;
    for (const b of this.buildings) {
      b.reset();
      this.blockBarracks(b); // the commandos mode removes the player's compound
    }
    for (const o of this.outposts) o.reset();
    this.effects.clear();
    this.artillery.clear();
    this.spawnStartingUnits();
  }

  /** The barracks and its sandbagged compound are solid; only the gate is open. */
  private blockBarracks(b: Barracks) {
    const { x, z, rot } = b;
    for (const s of COMPOUND_WALLS) {
      const a = toWorld(x, z, rot, s.ax, s.az), c = toWorld(x, z, rot, s.bx, s.bz);
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      this.nav.blockRect((a.x + c.x) / 2, (a.z + c.z) / 2, len / 2, 0.5, rot + (s.ax === s.bx ? Math.PI / 2 : 0), 0.1);
    }
    for (const bs of COMPOUND_BASTIONS) {
      const c = toWorld(x, z, rot, bs.x, bs.z);
      this.nav.blockCircle(c.x, c.z, bs.r + 0.3);
    }
    for (const gx of [-COMPOUND.gate - 0.3, COMPOUND.gate + 0.3]) {
      const c = toWorld(x, z, rot, gx, COMPOUND.hd);
      this.nav.blockCircle(c.x, c.z, 0.7);
    }
    this.nav.blockRect(x, z, 6.5, 4.5, rot, 0.8);
  }

  on(fn: Listener) {
    this.listeners.push(fn);
  }

  emit(e: GameEvent, team: Team, data?: GameEventData) {
    for (const fn of this.listeners) fn(e, team, data);
  }

  /** Credits per second a team currently earns from its outposts. */
  incomeOf(team: Team): number {
    return this.outposts.reduce((s, o) => s + (o.owner === team ? o.income : 0), 0);
  }

  /** The agent's rigged figure (casting shadows like the soldiers). */
  private agentView(name: string): AgentView {
    const v = new AgentView(this.scene, name, this.blobTpl);
    for (const m of v.meshes) this.shadows.addShadowCaster(m);
    return v;
  }

  spawnUnit(type: UnitType, team: Team, x: number, z: number): Unit {
    const name = `${type}-${team}`;
    const view: UnitView = type === "jeep"
      ? new JeepView(this.scene, this.jeepTpl[team], name, this.blobTpl)
      : type === "mgnest"
        ? new NestView(this.scene, this.nestTpl[team], name)
        : type === "bollard"
          ? new BollardView(this.scene, this.bollardTpl, name)
          : type === "drone"
            ? new DroneView(this.scene, this.droneTpl, name, this.blobTpl)
            : type === "agent" && agentModelReady()
              ? this.agentView(name)
              : new SoldierView(this.scene, this.soldierTpl[team][type], name, this.blobTpl);
    const ring = this.ringTpl.createInstance("ring");
    ring.isPickable = false;
    if (type === "jeep") ring.scaling.set(2.6, 1, 2.6);
    if (type === "mgnest" || type === "bollard") ring.scaling.set(1.9, 1, 1.9);
    const u = new Unit(type, team, x, z, view, ring);
    u.px = x;
    u.pz = z;
    u.postMove(0, this);
    this.units.push(u);
    return u;
  }

  // ---------------------------------------------------------------- modes

  /**
   * Switches to skirmish: the starting squads are replaced by the fixed skirmish forces lined up
   * in front of each compound, and both sides get the skirmish credits. No production afterwards.
   */
  setupSkirmish() {
    this.mode = "skirmish";
    for (const u of this.units) {
      u.view.dispose();
      u.ring.dispose();
    }
    this.units.length = 0;
    this.clearSelection();
    // each side starts with the radar tower behind its base
    for (const o of this.outposts) {
      if (o.kind !== "radar") continue;
      const near = this.buildings.reduce((a, b) => (Math.hypot(b.x - o.x, b.z - o.z) < Math.hypot(a.x - o.x, a.z - o.z) ? b : a));
      o.seize(near.team);
    }
    for (const b of this.buildings) {
      this.credits[b.team] = SKIRMISH.credits;
      // rows in front of the gate: medics closest to the base, then riflemen, grenadiers and the
      // jeeps at the head of the column, facing the enemy (5 infantry per row)
      const rows: { type: UnitType; count: number; depth: number; spacing: number }[] = [];
      let depth = 14;
      for (const type of ["medic", "rifleman", "grenadier", "jeep"] as const) {
        const count = SKIRMISH.forces[type];
        const perRow = type === "jeep" ? count : 5;
        if (type === "jeep") depth += 2.5; // room for the longer vehicles
        for (let placed = 0; placed < count; placed += perRow) {
          rows.push({ type, count: Math.min(perRow, count - placed), depth, spacing: type === "jeep" ? 5 : 2 });
          depth += type === "jeep" ? 5 : 2.2;
        }
      }
      for (const r of rows) {
        for (let i = 0; i < r.count; i++) {
          const p = toWorld(b.x, b.z, b.rot, (i - (r.count - 1) / 2) * r.spacing, r.depth);
          const free = this.nav.freePoint(p.x, p.z, r.type === "jeep" ? 1 : 0);
          const u = this.spawnUnit(r.type, b.team, free.x, free.z);
          u.heading = u.turret = b.rot;
          if (r.type === "jeep") {
            // jeeps roll out manned: a rifleman already sits behind the MG
            const g = this.spawnUnit("rifleman", b.team, free.x, free.z);
            g.heading = b.rot;
            g.vehicle = u;
            g.ring.isVisible = false;
            g.view.setEnabled(false);
            u.gunner = g;
          }
        }
      }
    }
  }

  /** Skirmish ends when one side has no fighting units left (or loses its barracks, handled in damage()). */
  private checkSkirmishEnd() {
    // unarmed medics alone cannot hold the field
    const alive = (team: Team) => this.units.some((u) => u.alive && u.team === team && u.type !== "medic");
    if (!alive(PLAYER)) {
      this.result = "lose";
      this.emit("lose", PLAYER);
    } else if (!alive(ENEMY)) {
      this.result = "win";
      this.emit("win", PLAYER);
    }
  }

  /** Orders an artillery strike for `team`; the player may only target what he can see. */
  orderArtillery(team: Team, x: number, z: number): boolean {
    if (team === PLAYER && this.canSee && !this.canSee(x, z)) {
      this.emit("noSight", PLAYER);
      return false;
    }
    if (this.credits[team] < ARTILLERY.cost) {
      if (team === PLAYER) this.emit("noCredits", PLAYER);
      return false;
    }
    if (!this.artillery.order(team, x, z)) return false;
    this.emit(team === PLAYER ? "artillery" : "enemyArtillery", PLAYER);
    return true;
  }

  // ---------------------------------------------------------------- production

  /** Outpost of `kind` owned by `team` (the one closest to its base), if any. */
  private facilityOf(kind: "workshop" | "hospital", team: Team): Outpost | null {
    const base = team === PLAYER ? this.playerBarracks : this.enemyBarracks;
    return this.outposts
      .filter((o) => o.kind === kind && o.owner === team)
      .sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z))[0] ?? null;
  }

  /** Workshop owned by `team` (builds jeeps), if any. */
  workshopOf(team: Team): Outpost | null {
    return this.facilityOf("workshop", team);
  }

  /**
   * Whether `team` has the minimap: by holding a radar tower (conquest, skirmish); the commandos
   * agent always has it.
   */
  hasRadar(team: Team): boolean {
    if (this.mode === "commandos") return true;
    return this.outposts.some((o) => o.kind === "radar" && o.owner === team && !o.destroyed);
  }

  /** Field hospital owned by `team` (trains medics), if any. */
  hospitalOf(team: Team): Outpost | null {
    return this.facilityOf("hospital", team);
  }

  /** Production facility for a unit type, or null if the team has none. */
  producerFor(type: UnitType, team: Team): Production | null {
    if (type === "jeep") return this.workshopOf(team)?.production ?? null;
    if (type === "medic") return this.hospitalOf(team)?.production ?? null;
    const b = team === PLAYER ? this.playerBarracks : this.enemyBarracks;
    return b.alive ? b.production : null;
  }

  queueUnit(type: UnitType, team: Team): boolean {
    if (this.mode === "skirmish") return false; // no reinforcements in a skirmish
    const p = this.producerFor(type, team);
    if (!p || p.queue.length >= 20) return false;
    if (this.credits[team] < UNITS[type].cost) {
      this.emit("noCredits", team);
      return false;
    }
    this.credits[team] -= UNITS[type].cost;
    p.queue.push(type);
    return true;
  }

  cancelUnit(type: UnitType, team: Team) {
    const p = this.producerFor(type, team);
    if (p) this.credits[team] += p.cancel(type);
  }

  // ---------------------------------------------------------------- building

  /**
   * Where `team` may place a structure at (x, z): near an own outpost (the structure then belongs to
   * it) or near the own barracks, on free ground. Bollards are laid across the approach, their row
   * at right angles to the direction from the anchor; MG nests face away from it.
   */
  placement(type: StructureType, team: Team, x: number, z: number): { ok: boolean; anchor: Outpost | null; heading: number } {
    let anchor: Outpost | null = null, center: V2 | null = null, best = Infinity;
    for (const o of this.outposts) {
      if (o.owner !== team || o.destroyed) continue;
      const d = Math.hypot(x - o.x, z - o.z);
      if (d <= o.radius + BUILD.outpostReach && d < best) { best = d; anchor = o; center = o; }
    }
    const base = team === PLAYER ? this.playerBarracks : this.enemyBarracks;
    const db = Math.hypot(x - base.x, z - base.z);
    if (base.alive && db <= BUILD.baseReach && db < best) { anchor = null; center = base; }
    const heading = center ? Math.atan2(x - center.x, z - center.z) : 0;
    if (!center || Math.abs(x) > MAP_HALF - 3 || Math.abs(z) > MAP_HALF - 3) return { ok: false, anchor, heading };
    const f = BUILD.footprint[type];
    let ok = this.nav.areaFree(x, z, f.hw, f.hd, heading, 0) && !this.nav.isBlocked(x, z, 0);
    // never on top of a unit or another structure
    if (ok) ok = !this.units.some((u) => u.alive && !u.vehicle && Math.hypot(u.x - x, u.z - z) < Math.max(f.hw, f.hd) + u.radius);
    return { ok, anchor, heading };
  }

  /** Pays for and places a structure; it is built on the spot over its build time. */
  placeStructure(type: StructureType, team: Team, x: number, z: number): Unit | null {
    if (this.mode !== "base") return null;
    const p = this.placement(type, team, x, z);
    if (!p.ok) {
      if (team === PLAYER) this.emit("cannotBuild", PLAYER);
      return null;
    }
    if (this.credits[team] < UNITS[type].cost) {
      this.emit("noCredits", team);
      return null;
    }
    this.credits[team] -= UNITS[type].cost;
    const u = this.spawnStructure(type, team, x, z, p.heading, p.anchor);
    u.buildT = UNITS[type].buildTime;
    if (team === PLAYER) this.emit("built", PLAYER);
    return u;
  }

  /** Puts a finished structure down (no cost, no placement rules). */
  spawnStructure(type: StructureType, team: Team, x: number, z: number, heading: number, anchor: Outpost | null): Unit {
    const u = this.spawnUnit(type, team, x, z);
    u.heading = u.turret = heading;
    u.anchor = anchor;
    this.blockStructure(u, 1);
    u.postMove(0, this);
    return u;
  }

  private blockStructure(u: Unit, delta: 1 | -1) {
    const f = BUILD.footprint[u.type as StructureType];
    this.nav.structure(u.x, u.z, f.hw, f.hd, u.heading, u.type === "bollard" ? [1] : [0, 1], delta);
  }

  /** Structures of `o` pass to its new owner (called when the outpost is taken). Returns how many. */
  transferStructures(o: Outpost, team: Team): number {
    let n = 0;
    for (const u of this.units) {
      if (!u.alive || u.anchor !== o || u.team === team) continue;
      u.team = team;
      u.stop();
      u.selected = false;
      this.selection.delete(u);
      n++;
    }
    return n;
  }

  /** A manned MG nest of the outpost's owner keeps the outpost from being taken. */
  guardedBy(o: Outpost): Unit | null {
    return this.units.find((u) => u.alive && u.type === "mgnest" && u.anchor === o && u.team === o.owner && u.gunner && u.gunner.alive) ?? null;
  }

  // ---------------------------------------------------------------- selection

  select(units: Iterable<Unit>, additive = false) {
    if (!additive) this.clearSelection();
    let list = [...units];
    // structures only join a selection on their own (a single click), never a group
    if (list.some((u) => !u.isStructure)) list = list.filter((u) => !u.isStructure);
    else if (list.length > 1) list = [];
    for (const u of list) {
      if (!u.alive || u.team !== PLAYER || u.vehicle) continue;
      u.selected = true;
      this.selection.add(u);
    }
    if (this.selection.size) {
      this.selectBuilding(null);
      this.emit("selected", PLAYER);
    }
  }

  toggle(u: Unit) {
    if (this.selection.has(u)) {
      u.selected = false;
      this.selection.delete(u);
    } else {
      this.select([u], true);
    }
  }

  clearSelection() {
    for (const u of this.selection) u.selected = false;
    this.selection.clear();
    this.selectBuilding(null);
  }

  selectBuilding(b: Barracks | null) {
    if (this.selectedBuilding) this.selectedBuilding.selected = false;
    this.selectedBuilding = b;
    if (b) {
      for (const u of this.selection) u.selected = false;
      this.selection.clear();
      b.selected = true;
    }
  }

  // ---------------------------------------------------------------- commands

  commandMove(units: Iterable<Unit>, p: V2, attackMove = false, showMarker = true) {
    const list = [...units].filter((u) => u.alive && !u.vehicle && !u.isStructure);
    if (!list.length) return;
    let cx = 0, cz = 0;
    for (const u of list) { cx += u.x; cz += u.z; }
    cx /= list.length;
    cz /= list.length;
    let dx = p.x - cx, dz = p.z - cz;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
    const rx = dz, rz = -dx;

    const cols = Math.ceil(Math.sqrt(list.length * 1.5));
    const rows = Math.ceil(list.length / cols);
    const sp = list.some((u) => u.isVehicle) ? 3.4 : 1.8;
    const slots: V2[] = [];
    for (let i = 0; i < list.length; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const inRow = row === rows - 1 ? list.length - row * cols : cols;
      const ox = (col - (inRow - 1) / 2) * sp;
      const oz = -(row - (rows - 1) / 2) * sp;
      slots.push(this.nav.freePoint(p.x + rx * ox + dx * oz, p.z + rz * ox + dz * oz));
    }

    // greedy nearest assignment keeps paths from crossing too much
    const free = new Set(list);
    for (const s of slots) {
      let best: Unit | null = null, bd = Infinity;
      for (const u of free) {
        const d = (u.x - s.x) ** 2 + (u.z - s.z) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
      free.delete(best!);
      best!.orderMove(s, attackMove, this);
      if (showMarker) this.addOrderLine(best!, s.x, s.z, null);
    }
    if (showMarker) {
      this.addMarker(p.x, p.z, false);
      this.emit("commanded", PLAYER);
    }
  }

  commandAttack(units: Iterable<Unit>, t: Target) {
    for (const u of units) {
      if (!u.alive || !u.armed) continue;
      if (u.type === "agent" && this.commandos && t instanceof Unit) {
        this.commandos.attack(t); // the agent's standard attack is the sniper shot
        this.addOrderLine(u, t.x, t.z, t);
        continue;
      }
      u.orderAttack(t);
      this.addOrderLine(u, t.x, t.z, t);
    }
    this.addMarker(t.x, t.z, true);
    this.emit("commanded", PLAYER);
  }

  /**
   * Assigns a soldier to an unmanned jeep: the selected soldier closest to it walks over and climbs
   * aboard as the gunner. Returns false if nobody can board.
   */
  commandBoard(units: Iterable<Unit>, jeep: Unit, showMarker = true): boolean {
    if (!jeep.alive || !jeep.hasMg || jeep.gunner || jeep.buildT > 0) return false;
    if (this.units.some((u) => u.boarding === jeep && u.alive)) return false;
    let best: Unit | null = null, bd = Infinity;
    for (const u of units) {
      if (!u.alive || u.isVehicle || u.vehicle || !u.armed || u.team !== jeep.team) continue;
      const d = Math.hypot(u.x - jeep.x, u.z - jeep.z);
      if (d < bd) { bd = d; best = u; }
    }
    if (!best) return false;
    best.orderBoard(jeep, this);
    if (showMarker) {
      this.addOrderLine(best, jeep.x, jeep.z, jeep);
      this.addMarker(jeep.x, jeep.z, false);
      this.emit("commanded", PLAYER);
    }
    return true;
  }

  /** The soldier climbs aboard: it disappears into the jeep and mans the machine gun for good. */
  board(soldier: Unit, jeep: Unit) {
    soldier.stop();
    soldier.vehicle = jeep;
    soldier.selected = false;
    soldier.ring.isVisible = false;
    soldier.view.setEnabled(false);
    this.selection.delete(soldier);
    jeep.gunner = soldier;
    this.emit("boarded", jeep.team);
  }

  /** Jeep destroyed: the gunner jumps off next to the wreck and is a normal soldier again. */
  private releaseGunner(jeep: Unit) {
    const s = jeep.gunner;
    jeep.gunner = null;
    if (!s || !s.alive) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    const p = this.nav.freePoint(jeep.x + Math.cos(jeep.heading) * 2.5 * side, jeep.z - Math.sin(jeep.heading) * 2.5 * side, 0);
    s.vehicle = null;
    s.x = s.px = p.x;
    s.z = s.pz = p.z;
    s.heading = jeep.heading;
    s.view.setEnabled(true);
    s.postMove(0, this);
  }

  /** Sends the medics among `units` to treat `patient`; false if there is nothing to do. */
  commandHeal(units: Iterable<Unit>, patient: Unit): boolean {
    if (!patient.alive || patient.isVehicle || patient.vehicle || patient.hp >= patient.maxHp) return false;
    const medics = [...units].filter((u) => u.alive && u.type === "medic" && u !== patient && u.team === patient.team);
    if (!medics.length) return false;
    for (const m of medics) {
      m.orderHeal(patient, this);
      this.addOrderLine(m, patient.x, patient.z, patient);
    }
    this.addMarker(patient.x, patient.z, false);
    this.emit("commanded", PLAYER);
    return true;
  }

  /**
   * Wounded comrade within `range` of the medic who is out of combat, preferring the badly hurt
   * and those nobody else is treating yet.
   */
  findPatient(medic: Unit, range: number): Unit | null {
    let best: Unit | null = null, bestScore = Infinity;
    for (const u of this.units) {
      if (u === medic || !u.alive || u.team !== medic.team || u.isVehicle || u.vehicle || u.hp >= u.maxHp || u.inCombat) continue;
      const d = Math.hypot(u.x - medic.x, u.z - medic.z);
      if (d > range) continue;
      const taken = this.units.some((o) => o !== medic && o.alive && o.patient === u);
      const score = d + (u.hp / u.maxHp) * 10 + (taken ? 30 : 0);
      if (score < bestScore) { bestScore = score; best = u; }
    }
    return best;
  }

  commandStop(units: Iterable<Unit>) {
    for (const u of units) u.stop();
  }

  private addOrderLine(unit: Unit, x: number, z: number, target: Target | null) {
    // a new order replaces the unit's previous line
    const i = this.orderLines.findIndex((l) => l.unit === unit);
    if (i >= 0) this.orderLines.splice(i, 1);
    this.orderLines.push({ unit, x, z, target, t: 0 });
  }

  private addMarker(x: number, z: number, attack: boolean) {
    const tpl = attack ? this.attackMarkerTpl : this.moveMarkerTpl;
    const y = this.terrain.heightAt(x, z) + 0.3;
    const outer = tpl.createInstance("marker");
    const inner = tpl.createInstance("markerCore");
    outer.position.set(x, y, z);
    inner.position.set(x, y + 0.02, z);
    inner.scaling.set(0.35, 1, 0.35);
    this.markers.push({ outer, inner, t: 0 });
  }

  // ---------------------------------------------------------------- combat

  findEnemy(u: Unit, range: number): Target | null {
    let best: Target | null = null, bd = range;
    // the player's units only engage what they can actually see
    const sees = u.team === PLAYER ? this.canSee : null;
    for (const o of this.units) {
      // bollards are only attacked on explicit orders
      if (!o.alive || o.vehicle || o.team === u.team || o.cloaked || o.type === "bollard") continue;
      if (sees && !sees(o.x, o.z)) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z) - (o.isVehicle ? o.radius * 0.5 : 0);
      if (this.spotRange && d >= this.spotRange(u, o, range)) continue;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) return best;
    for (const b of this.buildings) {
      if (!b.alive || b.team === u.team) continue;
      const d = Math.hypot(b.x - u.x, b.z - u.z) - b.radius;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  onRoad(x: number, z: number): boolean {
    const n = MAP_HALF * 2, i = Math.floor(x + MAP_HALF), j = Math.floor(z + MAP_HALF);
    return i >= 0 && j >= 0 && i < n && j < n && this.roadGrid[i + j * n] === 1;
  }

  /** Movement speed multiplier from the ground: roads are faster. */
  groundSpeed(x: number, z: number): number {
    return this.onRoad(x, z) ? ROAD.speed : 1;
  }

  outpostAt(x: number, z: number): Outpost | null {
    return this.outposts.find((o) => Math.hypot(x - o.x, z - o.z) <= o.radius) ?? null;
  }

  /** Height advantage of `u` over `t` in world units (negative when shooting uphill). */
  heightAdvantage(u: Unit, t: Target): number {
    return u.y - t.y;
  }

  /** Weapon range of `u` against `t`, extended when firing from higher ground. */
  rangeOf(u: Unit, t: Target): number {
    const adv = this.heightAdvantage(u, t) - COMBAT.elevationMin;
    return u.stats.range + Math.min(COMBAT.elevationRangeMax, Math.max(0, adv * COMBAT.elevationRangePerUnit));
  }

  /** Bonuses a unit currently enjoys, for UI display and the aura. */
  bonusesOf(u: Unit): { cover: string; outpost: boolean; elevated: boolean; stance: "stand" | "kneel" | "prone" } {
    const c = u.isVehicle ? 0 : this.cover?.at(u.x, u.z) ?? 0;
    const elevated = !!u.target && u.target.alive && this.heightAdvantage(u, u.target) >= COMBAT.elevationMin;
    return { cover: CoverMap.label(c), outpost: !!this.outpostAt(u.x, u.z), elevated, stance: u.stance };
  }

  /**
   * Faint aura around units profiting from positional bonuses (cover, outpost, higher ground than
   * their target); brighter with more bonuses. Stances don't count, every soldier in a fire fight uses them.
   */
  private updateAuras() {
    for (const u of this.units) {
      const current = this.auras.get(u);
      let level = 0;
      if (u.alive && !u.vehicle && !u.fogHidden && !u.isStructure) {
        const b = this.bonusesOf(u);
        level = (b.cover ? 1 : 0) + (b.outpost ? 1 : 0) + (b.elevated ? 1 : 0);
      }
      if (current && current.level !== level) {
        current.mesh.dispose();
        this.auras.delete(u);
      }
      if (level === 0) continue;
      let aura = this.auras.get(u);
      if (!aura) {
        aura = { mesh: this.auraTpl[level - 1].createInstance("aura"), level };
        aura.mesh.isPickable = false;
        this.auras.set(u, aura);
      }
      // gentle breathing, offset per unit so a group doesn't pulse in sync
      const k = 1 + Math.sin(this.time * 2.4 + u.id * 1.7) * 0.06;
      const s = u.isVehicle ? 2.4 : 1;
      aura.mesh.scaling.set(s * k, (u.isVehicle ? 1.2 : 1) * (2 - k), s * k);
      aura.mesh.position.set(u.x, u.y + 0.05, u.z);
    }
    for (const [u, a] of this.auras) {
      if (u.removed) {
        a.mesh.dispose();
        this.auras.delete(u);
      }
    }
  }

  hitChance(u: Unit, t: Target): number {
    let p = COMBAT.baseHit;
    if (this.heightAdvantage(u, t) >= COMBAT.elevationMin) p += COMBAT.elevationHit;
    if (t instanceof Unit) {
      let defence = 0;
      if (t.stance === "kneel") defence += COMBAT.kneel;
      else if (t.stance === "prone") defence += COMBAT.prone;
      if (!t.isVehicle && this.cover && this.cover.at(t.x, t.z)) defence += COMBAT.cover;
      if (this.outpostAt(t.x, t.z)) defence += COMBAT.outpost;
      // the heavy machine gun punches through cover
      if (u.hasMg) defence *= 1 - JEEP_MG.pierce;
      p -= defence;
    }
    return Math.max(COMBAT.minHit, p);
  }

  addTracer(from: Unit, to: Target, hit: boolean, kind: WeaponKind) {
    this.onShot?.(from.x, from.z, kind);
    if (to instanceof Unit && (to.type === "jeep" || to.type === "drone")) {
      const flight = Math.hypot(to.x - from.x, to.z - from.z) / (kind === "sniper" ? 800 : 500);
      this.onArmourShot?.(to.x, to.z, hit, 0.02 + flight);
    }
    const spread = hit ? 0.3 : 1.6;
    let ax: number, ay: number, az: number;
    if (from.type === "mgnest") {
      ax = from.x + Math.sin(from.turret) * 1.9;
      az = from.z + Math.cos(from.turret) * 1.9;
      ay = from.y + NEST_DIM.gunY + 0.05;
    } else if (from.isVehicle) {
      // muzzle of the MG on its swivel
      const px = from.x - Math.sin(from.heading) * -JEEP_DIM.turret.z, pz = from.z - Math.cos(from.heading) * -JEEP_DIM.turret.z;
      ax = px + Math.sin(from.turret) * 1.6;
      az = pz + Math.cos(from.turret) * 1.6;
      ay = from.y + JEEP_DIM.turret.y + 0.05;
    } else {
      // the tip of the rifle (see the soldier model: muzzle 1.18 ahead of the shoulders and 0.08 to
      // the right, at 1.25 height, all scaled by 1.45); lying down the rifle points over the ground
      const prone = from.stance === "prone";
      const fwd = prone ? 1.3 : 1.75, side = prone ? 0 : 0.12;
      ax = from.x + Math.sin(from.heading) * fwd + Math.cos(from.heading) * side;
      az = from.z + Math.cos(from.heading) * fwd - Math.sin(from.heading) * side;
      ay = from.y + (prone ? 0.5 : from.stance === "kneel" ? 1.3 : 1.8);
    }
    this.onMuzzle?.(ax, ay, az, kind);
    this.tracers.push({
      ax, ay, az,
      bx: to.x + (Math.random() - 0.5) * spread,
      by: to.y + to.aimY * (0.7 + Math.random() * 0.5),
      bz: to.z + (Math.random() - 0.5) * spread,
      t: 0,
      hit,
      kind,
    });
  }

  damage(t: Target, amount: number, by: Unit | null) {
    if (!t.alive) return;
    t.hp -= amount;
    if (t instanceof Unit) {
      t.combatT = 0;
      if (t.team === PLAYER) {
        if (this.sinceUnitsHit > 30) this.emit("unitsAttacked", PLAYER);
        this.sinceUnitsHit = 0;
      }
      if (t.hp <= 0) {
        t.hp = 0;
        t.kill();
        this.selection.delete(t);
        this.onKilled?.(t);
        if (t.hasMg) this.releaseGunner(t);
        if (t.type === "jeep") this.effects.explode(t.x, t.z, 30, 2.5, null, 1.6);
        if (t.isStructure) {
          this.blockStructure(t, -1);
          if (t.type === "mgnest") this.effects.explode(t.x, t.z, 0, 0.1, null, 1.1);
          if (t.team === PLAYER) this.emit("structureLost", PLAYER);
        }
        if (t.team === PLAYER && !t.isStructure) this.emit("unitLost", PLAYER);
      } else if (by) {
        t.onAttacked(by);
      }
    } else if (t instanceof Barracks) {
      if (t.team === PLAYER && this.baseAlertCooldown <= 0) {
        this.baseAlertCooldown = 15;
        this.emit("baseAttacked", PLAYER);
      }
      if (t.hp <= 0) {
        t.hp = 0;
        t.destroy();
        if (this.selectedBuilding === t) this.selectedBuilding = null;
        if (!this.result) {
          this.result = t.team === PLAYER ? "lose" : "win";
          this.emit(this.result, PLAYER);
        }
      }
    }
  }

  // ---------------------------------------------------------------- update

  update(dt: number) {
    this.baseAlertCooldown -= dt;
    this.sinceUnitsHit += dt;
    for (const o of this.outposts) {
      o.update(dt, this);
      if (o.owner !== null) this.credits[o.owner] += o.income * dt;
    }
    for (const b of this.buildings) b.update(dt, this);
    for (const u of this.units) u.update(dt, this);
    this.effects.update(dt);
    this.artillery.update(dt);
    if (this.mode === "skirmish" && !this.result) this.checkSkirmishEnd();

    // soft separation; heavier and moving units push lighter / idle ones aside
    const active = this.units.filter((u) => u.alive && !u.vehicle && !u.isStructure && !u.stats.flying);
    for (const u of this.units) if (u.alive && (u.isStructure || u.stats.flying)) u.postMove(dt, this);
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        const min = a.radius + b.radius + 0.05;
        let dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz); }
        const ma = a.stats.mass * (a.moving ? 2 : 1), mb = b.stats.mass * (b.moving ? 2 : 1);
        const overlap = min - d;
        a.x -= (dx / d) * overlap * (mb / (ma + mb));
        a.z -= (dz / d) * overlap * (mb / (ma + mb));
        b.x += (dx / d) * overlap * (ma / (ma + mb));
        b.z += (dz / d) * overlap * (ma / (ma + mb));
      }
    }

    const lim = MAP_HALF - 1;
    for (const u of active) {
      // never end up inside a building, trunk or hedge: slide along it, or step back
      const L = u.navLayer;
      if (this.nav.isBlocked(u.x, u.z, L)) {
        if (!this.nav.isBlocked(u.x, u.pz, L)) u.z = u.pz;
        else if (!this.nav.isBlocked(u.px, u.z, L)) u.x = u.px;
        else if (!this.nav.isBlocked(u.px, u.pz, L)) { u.x = u.px; u.z = u.pz; }
        else ({ x: u.x, z: u.z } = this.nav.freePoint(u.x, u.z, L)); // stuck inside: pop out
      }
      u.x = Math.min(Math.max(u.x, -lim), lim);
      u.z = Math.min(Math.max(u.z, -lim), lim);
      u.postMove(dt, this);
    }
    // gunners ride along (keeps their position current for release and the minimap)
    for (const u of this.units) {
      if (u.vehicle) {
        u.x = u.vehicle.x;
        u.z = u.vehicle.z;
        u.y = u.vehicle.y;
      }
    }

    this.time += dt;
    this.updateAuras();
    for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].removed) this.units.splice(i, 1);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      this.tracers[i].t += dt;
      if (this.tracers[i].t > TRACER_LIFE) this.tracers.splice(i, 1);
    }
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t += dt;
      const k = 1 - m.t / MARKER_LIFE;
      if (k <= 0) {
        m.outer.dispose();
        m.inner.dispose();
        this.markers.splice(i, 1);
      } else {
        // outer ring contracts onto the point, the core blinks
        const r = 0.35 + k * k * 1.6;
        m.outer.scaling.set(r, 1, r);
        m.inner.isVisible = Math.floor(m.t * 10) % 2 === 0;
      }
    }
    for (let i = this.orderLines.length - 1; i >= 0; i--) {
      const l = this.orderLines[i];
      l.t += dt;
      if (l.t > ORDER_LINE_LIFE || !l.unit.alive || (l.target && !l.target.alive)) this.orderLines.splice(i, 1);
    }
  }
}
