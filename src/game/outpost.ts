import { MeshBuilder, Vector3, type Mesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { CAPTURE_BONUS, CAPTURE_TIME, HOSPITAL_HEAL, OUTPOST_HEAL, OUTPOSTS, type OutpostKind, type Team } from "../config";
import { toWorld, type OutpostSpec, type RGB } from "../world/layout";
import { createOutpostDetail } from "../world/outpostDetail";
import { createGarageExitMesh, createPharmacyMesh } from "../world/cityModels";
import { createOutpostMesh, createRing, mat, RADAR_DIM, TEAM_COLOR } from "../world/models";
import type { Terrain } from "../world/terrain";
import type { Game } from "./game";
import { Production } from "./production";

const NEUTRAL: RGB = [0.9, 0.88, 0.8];

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
  private readonly banners: { flag: Mesh; x: number; z: number; y: number }[] = [];
  /** 0 = banners lowered, 1 = fully hoisted. */
  private hoist = 0;
  private readonly model: Mesh;
  /** Extra detail of the realistic graphics mode (built on first use). */
  private detail: Mesh | null = null;
  private detailOn = false;
  private readonly scene: Scene;
  private readonly shadows: ShadowGenerator;
  private readonly seed: number;
  /** Radar only: red warning light on top of the dome, blinking while the station is manned. */
  private readonly beacon: Mesh | null = null;
  /** Blown up (commandos): no owner, no income, cannot be taken any more. */
  destroyed = false;
  private flagT = Math.random() * 10;
  /** Seconds until the owner may be warned again that this outpost is being taken. */
  private warnCooldown = 0;

  constructor(spec: OutpostSpec, scene: Scene, terrain: Terrain, shadows: ShadowGenerator) {
    const cfg = OUTPOSTS[spec.kind];
    this.kind = spec.kind;
    this.look = spec.look ?? null;
    this.name = spec.look === "pharmacy" ? "Apotheke" : spec.look === "garage" ? "Tiefgarage" : cfg.name;
    this.income = cfg.income;
    this.radius = cfg.radius;
    this.x = spec.x;
    this.z = spec.z;
    this.y = terrain.heightAt(spec.x, spec.z);
    this.rot = spec.rot;
    this.production = spec.kind === "workshop" ? new Production(["jeep"]) : spec.kind === "hospital" ? new Production(["medic"]) : null;
    this.spawn = toWorld(spec.x, spec.z, spec.rot, 0, 6.5);
    this.rally = toWorld(spec.x, spec.z, spec.rot, 0, 13);

    this.scene = scene;
    this.shadows = shadows;
    this.seed = Math.round(spec.x * 31 + spec.z * 17) | 1;
    const mesh = spec.look === "pharmacy" ? createPharmacyMesh(scene) : spec.look === "garage" ? createGarageExitMesh(scene) : createOutpostMesh(scene, spec.kind);
    this.model = mesh;
    mesh.position.set(spec.x, this.y, spec.z);
    mesh.rotation.y = spec.rot;
    mesh.freezeWorldMatrix();
    shadows.addShadowCaster(mesh);
    if (spec.kind === "radar") {
      this.beacon = MeshBuilder.CreateSphere("radarBeacon", { diameter: 0.32, segments: 6 }, scene);
      this.beacon.position.set(spec.x, this.y + RADAR_DIM.domeY + RADAR_DIM.domeR + 0.08, spec.z);
      this.beacon.material = mat(scene, [1, 0.12, 0.08], { emissive: true });
      this.beacon.isPickable = false;
      this.beacon.setEnabled(false);
    }

    this.ring = createRing(scene, `outpostRing-${spec.kind}`, this.radius * 2, 0.18, NEUTRAL);
    this.ring.position.set(spec.x, this.y + 0.3, spec.z);

    const polePos = toWorld(spec.x, spec.z, spec.rot, this.radius * 0.55, -this.radius * 0.55);
    const poleY = terrain.heightAt(polePos.x, polePos.z);
    const pole = MeshBuilder.CreateCylinder("outpostPole", { height: 6, diameter: 0.14, tessellation: 6 }, scene);
    pole.position.set(polePos.x, poleY + 3, polePos.z);
    pole.material = mat(scene, [0.7, 0.7, 0.7]);
    pole.isPickable = false;
    shadows.addShadowCaster(pole);

    this.flag = MeshBuilder.CreateBox("outpostFlag", { width: 1.8, height: 1.1, depth: 0.06 }, scene);
    this.flag.setPivotPoint(new Vector3(-0.9, 0, 0));
    this.flag.position.set(polePos.x + 0.9, poleY + 5.35, polePos.z);
    this.flag.isPickable = false;
    shadows.addShadowCaster(this.flag);

    // three more flagpoles on the edge of the area; bare until the outpost has an owner
    for (const a of [0.5, 2.6, 4.6]) {
      const p = toWorld(spec.x, spec.z, spec.rot, Math.sin(a) * this.radius * 0.88, Math.cos(a) * this.radius * 0.88);
      const y = terrain.heightAt(p.x, p.z);
      const bannerPole = MeshBuilder.CreateCylinder("bannerPole", { height: 4, diameter: 0.1, tessellation: 6 }, scene);
      bannerPole.position.set(p.x, y + 2, p.z);
      bannerPole.material = mat(scene, [0.62, 0.6, 0.55]);
      bannerPole.isPickable = false;
      shadows.addShadowCaster(bannerPole);
      const flag = MeshBuilder.CreateBox("banner", { width: 1.3, height: 0.8, depth: 0.05 }, scene);
      flag.setPivotPoint(new Vector3(-0.65, 0, 0));
      flag.position.set(p.x + 0.65, y, p.z);
      flag.isPickable = false;
      flag.setEnabled(false);
      shadows.addShadowCaster(flag);
      this.banners.push({ flag, x: p.x, z: p.z, y });
    }
    this.applyOwnerColors();
  }

  /** Shows the extra model detail of the realistic graphics mode (built the first time it is needed). */
  setDetail(on: boolean) {
    this.detailOn = on;
    if (on && !this.detail && !this.look) {
      this.detail = createOutpostDetail(this.scene, this.kind, this.seed);
      this.detail.position.copyFrom(this.model.position);
      this.detail.rotation.copyFrom(this.model.rotation);
      this.detail.scaling.copyFrom(this.model.scaling);
      this.detail.freezeWorldMatrix();
      this.shadows.addShadowCaster(this.detail);
    }
    this.detail?.setEnabled(on && !this.destroyed);
  }

  /** Back to the start of a game: neutral, capture bonus unpaid, rebuilt if it was blown up. */
  reset() {
    if (this.destroyed) {
      this.destroyed = false;
      this.model.scaling.setAll(1);
      this.model.rotation.z = 0;
      this.model.position.y = this.y;
      this.model.freezeWorldMatrix();
      this.setDetail(this.detailOn);
      this.flag.setEnabled(true);
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
    this.flag.material = mat(this.flag.getScene(), c);
    // a new owner hoists his own flags from the bottom
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
    this.detail?.setEnabled(false); // the rubble heap is the plain model
    this.flag.setEnabled(false);
    this.ring.setEnabled(false);
    for (const b of this.banners) b.flag.setEnabled(false);
  }

  update(dt: number, g: Game) {
    if (this.destroyed) return;
    this.flagT += dt;
    this.warnCooldown -= dt;
    if (this.production && this.owner !== null) this.production.update(dt, g, this.owner, this.spawn, this.rally);
    this.flag.rotation.y = Math.sin(this.flagT * 2.1) * 0.25;
    // the radar is in use: its warning light blinks
    this.beacon?.setEnabled(this.owner !== null && this.flagT % 1.4 < 0.7);
    this.hoist = this.owner === null ? 0 : Math.min(1, this.hoist + dt / 2.5);
    const up = this.hoist * this.hoist * (3 - 2 * this.hoist);
    this.banners.forEach((b, i) => {
      b.flag.setEnabled(up > 0.02);
      b.flag.position.y = b.y + 0.7 + up * 2.85;
      b.flag.rotation.y = Math.sin(this.flagT * 2.3 + i * 1.7) * 0.3;
    });

    this.guarded = false;
    const inside: [number, number] = [0, 0];
    // the commandos agent is a saboteur: he neither takes outposts nor stops the enemy from holding them
    // (in the city he does: holding one brings soldiers over to his side)
    const agentCounts = g.commandos?.kind === "documents";
    const occupants = g.units.filter((u) => u.alive && !u.vehicle && !u.isStructure && (u.type !== "agent" || agentCounts) && Math.hypot(u.x - this.x, u.z - this.z) <= this.radius);
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
    if (previous !== null) g.emit("outpostLost", previous, { outpost: this, bonus: 0 });
  }
}
