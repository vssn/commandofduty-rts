import { MeshBuilder, Vector3, type Mesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { CAPTURE_BONUS, CAPTURE_TIME, OUTPOST_HEAL, OUTPOSTS, type OutpostKind, type Team } from "../config";
import { toWorld, type OutpostSpec, type RGB } from "../world/layout";
import { createOutpostMesh, createRing, mat, TEAM_COLOR } from "../world/models";
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
  private bonusPaid = false;
  /** Workshops build jeeps for their owner. */
  readonly production: Production | null;
  readonly spawn: { x: number; z: number };
  rally: { x: number; z: number };
  readonly rot: number;
  private readonly ring: Mesh;
  private readonly flag: Mesh;
  private readonly model: Mesh;
  /** Blown up (commandos): no owner, no income, cannot be taken any more. */
  destroyed = false;
  private flagT = Math.random() * 10;

  constructor(spec: OutpostSpec, scene: Scene, terrain: Terrain, shadows: ShadowGenerator) {
    const cfg = OUTPOSTS[spec.kind];
    this.kind = spec.kind;
    this.name = cfg.name;
    this.income = cfg.income;
    this.radius = cfg.radius;
    this.x = spec.x;
    this.z = spec.z;
    this.y = terrain.heightAt(spec.x, spec.z);
    this.rot = spec.rot;
    this.production = spec.kind === "workshop" ? new Production(["jeep"]) : null;
    this.spawn = toWorld(spec.x, spec.z, spec.rot, 0, 6.5);
    this.rally = toWorld(spec.x, spec.z, spec.rot, 0, 13);

    const mesh = createOutpostMesh(scene, spec.kind);
    this.model = mesh;
    mesh.position.set(spec.x, this.y, spec.z);
    mesh.rotation.y = spec.rot;
    mesh.freezeWorldMatrix();
    shadows.addShadowCaster(mesh);

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
    this.ring.setEnabled(false);
  }

  update(dt: number, g: Game) {
    if (this.destroyed) return;
    this.flagT += dt;
    if (this.production && this.owner !== null) this.production.update(dt, g, this.owner, this.spawn, this.rally);
    this.flag.rotation.y = Math.sin(this.flagT * 2.1) * 0.25;

    const inside: [number, number] = [0, 0];
    // the commandos agent is a saboteur: he neither takes outposts nor stops the enemy from holding them
    const occupants = g.units.filter((u) => u.alive && !u.vehicle && u.type !== "agent" && Math.hypot(u.x - this.x, u.z - this.z) <= this.radius);
    for (const u of occupants) inside[u.team]++;
    this.contested = inside[0] > 0 && inside[1] > 0;
    if (this.contested) return; // enemy soldier present: progress is frozen, nobody heals

    // own soldiers slowly recover inside the outpost
    for (const u of occupants) if (u.team === this.owner) u.hp = Math.min(u.maxHp, u.hp + OUTPOST_HEAL * dt);

    const present: Team | null = inside[0] > 0 ? 0 : inside[1] > 0 ? 1 : null;
    if (present === null || present === this.owner) {
      // nobody (or only the owner) inside: unfinished progress fades away
      this.progress = Math.max(0, this.progress - dt / CAPTURE_TIME);
      if (this.progress === 0) this.capturer = null;
      return;
    }
    if (this.capturer !== present) {
      this.capturer = present;
      this.progress = 0;
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
    g.emit("captured", team, { outpost: this, bonus });
    if (previous !== null) g.emit("outpostLost", previous, { outpost: this, bonus: 0 });
  }
}
