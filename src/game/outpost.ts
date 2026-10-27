import { MeshBuilder, Vector3, type Mesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { CAPTURE_BONUS, CAPTURE_TIME, HOSPITAL_HEAL, OUTPOST_HEAL, OUTPOSTS, PLAYER, type OutpostKind, type Team } from "../config";
import { toWorld, type OutpostSpec, type RGB } from "../world/layout";
import { createGarageExitMesh, createPharmacyMesh } from "../world/cityModels";
import { createRing, mat, TEAM_COLOR } from "../world/models";
import { createOutpostMesh, RADAR_DIM } from "../world/outpostModels";
import type { Terrain } from "../world/terrain";
import type { Game } from "./game";
import { Production } from "./production";

const NEUTRAL: RGB = [0.62, 0.64, 0.68];
/** Masts and display housings. */
const MAST: RGB = [0.18, 0.185, 0.2];

/**
 * Capturable map object. A team takes it by keeping at least one soldier inside the area
 * for CAPTURE_TIME seconds while no enemy soldier is inside. The first capture pays a one-time
 * bonus; afterwards the owner earns a steady income.
 */
export class Outpost {
  readonly kind: OutpostKind;
  /** The city map's version of this outpost (pharmacy, car park), or null. */
  readonly look: "pharmacy" | "garage" | null;
  readonly name: string;
  readonly income: number;
  readonly radius: number;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  owner: Team | null = null;
  /** Team currently making progress (or holding paused progress). */
  capturer: Team | null = null;
  /** 0..1 */
  progress = 0;
  /** True while soldiers of both teams are inside. */
  contested = false;
  /** True while a manned MG nest of the owner keeps attackers from taking it. */
  guarded = false;
  private bonusPaid = false;
  /** Workshops build jeeps, field hospitals medics for their owner. */
  readonly production: Production | null;
  readonly spawn: { x: number; z: number };
  rally: { x: number; z: number };
  readonly rot: number;
  private readonly ring: Mesh;
  private readonly flag: Mesh;
  /** Extra flags around the area, hoisted in the owner's colour once the outpost is taken. */
  private readonly banners: { flag: Mesh; frame: Mesh; x: number; z: number; y: number }[] = [];
  /** The main display's housing. */
  private readonly flagFrame: Mesh;
  /** 0 = the edge displays are dark, 1 = fully switched on. */
  private hoist = 0;
  private readonly model: Mesh;
  /** Radar only: red warning light on top of the dome, blinking while the station is manned. */
  private readonly beacon: Mesh | null = null;
  /** Blown up (commandos): no owner, no income, cannot be taken any more. */
  destroyed = false;
  private flagT = Math.random() * 10;
  /** Seconds until the owner may be warned again that this outpost is being taken. */
  private warnCooldown = 0;

  /** On which level it lies (power station: 1 on a raised walkway's platform); only soldiers there count. */
  readonly level: 0 | 1;

  constructor(spec: OutpostSpec, scene: Scene, terrain: Terrain, shadows: ShadowGenerator, surface?: (x: number, z: number, level: 0 | 1) => number) {
    this.level = spec.level ?? 0;
    const ground = (x: number, z: number) => (surface ? surface(x, z, this.level) : terrain.heightAt(x, z));
    const cfg = OUTPOSTS[spec.kind];
    this.kind = spec.kind;
    this.look = spec.look ?? null;
    this.name = spec.look === "pharmacy" ? "Apotheke" : spec.look === "garage" ? "Tiefgarage" : cfg.name;
    this.income = cfg.income;
    this.radius = cfg.radius;
    this.x = spec.x;
    this.z = spec.z;
    this.y = ground(spec.x, spec.z);
    this.rot = spec.rot;
    this.production = spec.kind === "workshop" ? new Production(["jeep", "tank"]) : spec.kind === "hospital" ? new Production(["medic"]) : null;
    this.spawn = toWorld(spec.x, spec.z, spec.rot, 0, 6.5);
    this.rally = toWorld(spec.x, spec.z, spec.rot, 0, 13);

    const mesh = spec.look === "pharmacy" ? createPharmacyMesh(scene) : spec.look === "garage" ? createGarageExitMesh(scene) : createOutpostMesh(scene, spec.kind);
    this.model = mesh;
    mesh.position.set(spec.x, this.y, spec.z);
    mesh.rotation.y = spec.rot;
    mesh.freezeWorldMatrix();
    shadows.addShadowCaster(mesh);
    if (spec.kind === "radar") {
      this.beacon = MeshBuilder.CreateSphere("radarBeacon", { diameter: 0.32, segments: 6 }, scene);
      this.beacon.position.set(spec.x, this.y + RADAR_DIM.top + 0.1, spec.z);
      this.beacon.material = mat(scene, [1, 0.12, 0.08], { emissive: true });
      this.beacon.isPickable = false;
      this.beacon.setEnabled(false);
    }

    this.ring = createRing(scene, `outpostRing-${spec.kind}`, this.radius * 2, 0.18, NEUTRAL);
    this.ring.position.set(spec.x, this.y + 0.3, spec.z);

    const polePos = toWorld(spec.x, spec.z, spec.rot, this.radius * 0.55, -this.radius * 0.55);
    const poleY = ground(polePos.x, polePos.z);
    // instead of flags: displays on steel masts, lit in the owner's colour (facing the camera, i.e. south)
    const display = (name: string, x: number, y: number, z: number, w: number, h: number, mast: number) => {
      const pole = MeshBuilder.CreateBox(`${name}Mast`, { width: 0.14, height: mast, depth: 0.14 }, scene);
      pole.position.set(x, y + mast / 2, z);
      pole.material = mat(scene, MAST);
      pole.isPickable = false;
      shadows.addShadowCaster(pole);
      const frame = MeshBuilder.CreateBox(`${name}Frame`, { width: w + 0.16, height: h + 0.16, depth: 0.1 }, scene);
      frame.position.set(x, y + mast - h / 2 - 0.1, z + 0.08);
      frame.material = mat(scene, MAST);
      frame.isPickable = false;
      shadows.addShadowCaster(frame);
      const screen = MeshBuilder.CreatePlane(name, { width: w, height: h }, scene);
      screen.position.set(x, y + mast - h / 2 - 0.1, z + 0.02);
      screen.isPickable = false;
      return { screen, frame };
    };
    const main = display("outpostFlag", polePos.x, poleY, polePos.z, 1.8, 1.1, 6);
    this.flag = main.screen;
    this.flagFrame = main.frame;

    // three more displays on the edge of the area; dark until the outpost has an owner
    for (const a of [0.5, 2.6, 4.6]) {
      const p = toWorld(spec.x, spec.z, spec.rot, Math.sin(a) * this.radius * 0.88, Math.cos(a) * this.radius * 0.88);
      const y = ground(p.x, p.z);
      const { screen, frame } = display("banner", p.x, y, p.z, 1.3, 0.8, 4);
      screen.setEnabled(false);
      this.banners.push({ flag: screen, frame, x: p.x, z: p.z, y });
    }
    this.applyOwnerColors();
  }

  /** Back to the start of a game: neutral, capture bonus unpaid, rebuilt if it was blown up. */
  reset() {
    if (this.destroyed) {
      this.destroyed = false;
      this.model.scaling.setAll(1);
      this.model.rotation.z = 0;
      this.model.position.y = this.y;
      this.model.freezeWorldMatrix();
      this.flag.setEnabled(true);
      this.flagFrame.setEnabled(true);
      for (const b of this.banners) b.frame.setEnabled(true);
      this.ring.setEnabled(true);
    }
    this.owner = null;
    this.capturer = null;
    this.progress = 0;
    this.contested = this.guarded = false;
    this.bonusPaid = false;
    this.warnCooldown = 0;
    this.production?.clear();
    this.rally = toWorld(this.x, this.z, this.rot, 0, 13);
    this.applyOwnerColors();
  }

  /** Hands the outpost to `team` without a capture (and without the capture bonus). */
  seize(team: Team) {
    this.owner = team;
    this.bonusPaid = true;
    this.capturer = null;
    this.progress = 0;
    this.applyOwnerColors();
  }

  private applyOwnerColors() {
    const c = this.owner === null ? NEUTRAL : TEAM_COLOR[this.owner];
    this.flag.material = mat(this.flag.getScene(), c, { emissive: true });
    // a new owner's displays switch on one after the other
    this.hoist = 0;
    for (const b of this.banners) b.flag.material = this.flag.material;
    this.ring.material = mat(this.ring.getScene(), c, { emissive: true });
    (this.ring.material as { zOffset: number }).zOffset = -8;
  }

  /** Blows the outpost up: the structure collapses into a low heap, the flag and area ring go. */
  destroy() {
    this.destroyed = true;
    this.owner = null;
    this.capturer = null;
    this.progress = 0;
    this.production?.clear();
    this.model.unfreezeWorldMatrix();
    this.model.scaling.set(1.1, 0.22, 1.1);
    this.model.rotation.z = 0.08;
    this.model.position.y -= 0.15;
    this.flag.setEnabled(false);
    this.flagFrame.setEnabled(false);
    this.ring.setEnabled(false);
    for (const b of this.banners) {
      b.flag.setEnabled(false);
      b.frame.setEnabled(false);
    }
  }

  update(dt: number, g: Game) {
    if (this.destroyed) return;
    this.flagT += dt;
    this.warnCooldown -= dt;
    if (this.production && this.owner !== null) this.production.update(dt, g, this.owner, this.spawn, this.rally);
    // the radar is in use: its warning light blinks
    this.beacon?.setEnabled(this.owner !== null && this.flagT % 1.4 < 0.7);
    this.hoist = this.owner === null ? 0 : Math.min(1, this.hoist + dt / 2.5);
    const up = this.hoist * this.hoist * (3 - 2 * this.hoist);
    // each display switches on like a screen: a bright line that opens up, a short flicker
    this.banners.forEach((b, i) => {
      const k = Math.max(0, Math.min(1, up * 1.6 - i * 0.3));
      b.flag.setEnabled(k > 0.02 && !(k < 1 && (this.flagT * 30 + i * 7) % 5 < 1));
      b.flag.scaling.y = Math.max(0.04, k);
    });

    this.guarded = false;
    const inside: [number, number] = [0, 0];
    // the commandos agent is a saboteur: he neither takes outposts nor stops the enemy from holding them
    // (in the city he does: holding one brings soldiers over to his side)
    const agentCounts = g.commandos?.kind === "documents";
    const occupants = g.units.filter((u) => u.alive && !u.vehicle && !u.isStructure && (u.type !== "agent" || agentCounts) && u.level === this.level && Math.hypot(u.x - this.x, u.z - this.z) <= this.radius);
    for (const u of occupants) inside[u.team]++;
    this.contested = inside[0] > 0 && inside[1] > 0;
    if (this.contested) return; // enemy soldier present: progress is frozen, nobody heals

    // own soldiers slowly recover inside the outpost, faster in a field hospital
    const heal = this.kind === "hospital" ? HOSPITAL_HEAL : OUTPOST_HEAL;
    for (const u of occupants) if (u.team === this.owner) u.hp = Math.min(u.maxHp, u.hp + heal * dt);

    const present: Team | null = inside[0] > 0 ? 0 : inside[1] > 0 ? 1 : null;
    if (present === null || present === this.owner) {
      // nobody (or only the owner) inside: unfinished progress fades away
      this.progress = Math.max(0, this.progress - dt / CAPTURE_TIME);
      if (this.progress === 0) this.capturer = null;
      return;
    }
    // a manned MG nest holds the outpost: it has to be destroyed first
    this.guarded = this.owner !== null && !!g.guardedBy(this);
    if (this.guarded) return;
    if (this.capturer !== present) {
      this.capturer = present;
      this.progress = 0;
      // the owner hears about it once when the enemy starts taking his outpost
      if (this.owner !== null && this.warnCooldown <= 0) {
        this.warnCooldown = 30;
        g.emit("outpostThreatened", this.owner, { outpost: this, bonus: 0 });
        if (this.owner === PLAYER) g.ping(this.x, this.z, "threat");
      }
    }
    this.progress += dt / CAPTURE_TIME;
    if (this.progress >= 1) this.capture(present, g);
  }

  private capture(team: Team, g: Game) {
    const previous = this.owner;
    // orders of the previous owner are refunded
    if (this.production && previous !== null) g.credits[previous] += this.production.clear();
    this.owner = team;
    this.capturer = null;
    this.progress = 0;
    let bonus = 0;
    if (!this.bonusPaid) {
      this.bonusPaid = true;
      bonus = CAPTURE_BONUS;
      g.credits[team] += bonus;
    }
    this.applyOwnerColors();
    const structures = g.transferStructures(this, team);
    g.emit("captured", team, { outpost: this, bonus, structures });
    g.ping(this.x, this.z, team === PLAYER ? "capture" : "lost");
    if (previous !== null) g.emit("outpostLost", previous, { outpost: this, bonus: 0 });
  }
}
