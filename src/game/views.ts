import { TransformNode, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import { HIP_X, HIP_Y, JEEP_DIM, KNEE, SHOULDER_Y, THROW_SHOULDER, type SoldierTemplates } from "../world/models";
import type { Terrain } from "../world/terrain";
import type { Unit } from "./unit";

export type { SoldierTemplates };

/** Arms-with-weapon and head, both pivoting at the shoulders of `parent`. */
export function buildUpper(tpl: SoldierTemplates, parent: TransformNode): { arms: InstancedMesh; head: InstancedMesh; throwArm: InstancedMesh | null } {
  const arms = tpl.arms.createInstance("arms");
  const head = tpl.head.createInstance("head");
  for (const m of [arms, head]) {
    m.parent = parent;
    m.position.set(0, SHOULDER_Y, 0);
    m.isPickable = false;
  }
  let throwArm: InstancedMesh | null = null;
  if (tpl.throwArm) {
    throwArm = tpl.throwArm.createInstance("throwArm");
    throwArm.parent = parent;
    throwArm.position.set(THROW_SHOULDER.x, THROW_SHOULDER.y, 0);
    throwArm.isPickable = false;
  }
  return { arms, head, throwArm };
}

/** Smooth keyframe curve: `keys` are [time, value] pairs, eased between them. */
function curve(t: number, keys: readonly (readonly [number, number])[]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      let f = (t - t0) / (t1 - t0);
      f = f * f * (3 - 2 * f);
      return v0 + (v1 - v0) * f;
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * One-armed grenade throw (seconds since the throw started): the right arm swings back over the
 * head while the body turns away and leans back and the free arm points at the target, then the
 * arm whips forward (the grenade leaves the hand at ~0.42 s) and follows through.
 */
const THROW = {
  duration: 0.62,
  arm: [[0, 0], [0.3, 2.7], [0.36, 2.8], [0.46, -1.25], [0.62, 0]],
  armRoll: [[0, 0], [0.3, -0.35], [0.46, 0.12], [0.62, 0]],
  freeArm: [[0, 0], [0.3, -1.25], [0.46, 0.35], [0.62, 0]],
  lean: [[0, 0], [0.3, -0.28], [0.46, 0.34], [0.62, 0]],
  twist: [[0, 0], [0.3, -0.5], [0.46, 0.3], [0.62, 0]],
} as const;

/** Two-part leg (thigh + shin hanging from the knee) under `parent`, hip at (x, HIP_Y). */
export function buildLeg(tpl: SoldierTemplates, parent: TransformNode, x: number): { thigh: InstancedMesh; shin: InstancedMesh } {
  const thigh = tpl.leg.createInstance("thigh");
  thigh.parent = parent;
  thigh.position.set(x, HIP_Y, 0);
  const shin = tpl.shin.createInstance("shin");
  shin.parent = thigh;
  shin.position.set(0, KNEE.y, KNEE.z);
  thigh.isPickable = shin.isPickable = false;
  return { thigh, shin };
}
export interface JeepTemplates { body: Mesh; wheel: Mesh; gun: Mesh; crew: SoldierTemplates }

/** Visual representation of a unit; all animation lives here, the Unit only holds game state. */
export interface UnitView {
  readonly root: TransformNode;
  /** `moved` is the distance travelled this frame. */
  sync(u: Unit, dt: number, moved: number, terrain: Terrain): void;
  /** `t` = seconds since death. */
  animateDeath(u: Unit, t: number): void;
  /** Show/hide the whole unit including its ground shadow. */
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** Round ground shadow that follows a unit (kept separate from the tilting body). */
class BlobShadow {
  readonly mesh: InstancedMesh;
  constructor(tpl: Mesh) {
    this.mesh = tpl.createInstance("blob");
    this.mesh.isPickable = false;
  }
  place(x: number, y: number, z: number, heading: number, rx: number, rz: number) {
    this.mesh.position.set(x, y + 0.06, z);
    this.mesh.rotation.y = heading;
    this.mesh.scaling.set(rx, 1, rz);
  }
}

/** Hip height when kneeling on one knee (thigh upright, knee just above the ground). */
const KNEE_HIP = -KNEE.y + 0.07;

/** Soldier figure built from instances; body/legs/upper body are animated separately. */
export class SoldierView implements UnitView {
  readonly root: TransformNode;
  private readonly legL: InstancedMesh;
  private readonly legR: InstancedMesh;
  private readonly shinL: InstancedMesh;
  private readonly shinR: InstancedMesh;
  private readonly arms: InstancedMesh;
  private readonly head: InstancedMesh;
  /** Grenadiers only: the right arm with the grenade. */
  private readonly throwArm: InstancedMesh | null;
  private phase = Math.random() * 10;
  /** 1 while engaging a target (weapon shouldered), 0 otherwise. */
  private aimW = 0;
  /** 1 while standing around with nothing to do. */
  private idleW = 0;
  /** Idle clock, started at a random point so a group never moves in sync. */
  private idleT = Math.random() * 40;
  private readonly seed = Math.random() * 10;
  private stride = 0;
  private kneelW = 0;
  private proneW = 0;
  private readonly shadow: BlobShadow;

  constructor(scene: Scene, tpl: SoldierTemplates, name: string, blob: Mesh) {
    this.root = new TransformNode(name, scene);
    this.shadow = new BlobShadow(blob);
    const body = tpl.body.createInstance("body");
    body.isPickable = false;
    body.parent = this.root;
    ({ arms: this.arms, head: this.head, throwArm: this.throwArm } = buildUpper(tpl, this.root));
    ({ thigh: this.legL, shin: this.shinL } = buildLeg(tpl, this.root, -HIP_X));
    ({ thigh: this.legR, shin: this.shinR } = buildLeg(tpl, this.root, HIP_X));
  }

  sync(u: Unit, dt: number, moved: number) {
    const walking = u.moving && moved > 0.001;
    // walk cycle advances with distance so the feet don't slide; uphill = short, quick steps,
    // downhill = longer strides
    const grade = Math.max(-0.6, Math.min(0.6, u.grade));
    this.phase += moved * 2.1 * (1 + grade * 0.9);
    this.stride += ((walking ? 1 : 0) - this.stride) * Math.min(1, dt * 10);
    const swing = Math.sin(this.phase) * 0.55 * (1 - grade * 0.35) * this.stride;

    // postures: kneel = lunge with lowered hips, prone = body flat, head and weapon raised forward
    const blend = Math.min(1, dt * 5);
    this.kneelW += ((u.stance === "kneel" ? 1 : 0) - this.kneelW) * blend;
    this.proneW += ((u.stance === "prone" ? 1 : 0) - this.proneW) * blend;
    const k = this.kneelW, p = this.proneW;
    // walk: the knee flexes while the leg swings forward and straightens as the foot plants
    // (positive x rotation = backwards; the left thigh moves forward while cos(phase) < 0)
    const w = this.stride * (1 - k);
    const kneeL = (0.1 + Math.max(0, -Math.cos(this.phase)) * 0.7) * w;
    const kneeR = (0.1 + Math.max(0, Math.cos(this.phase)) * 0.7) * w;
    // kneel: left leg forward with the thigh level and the shin upright (foot planted),
    // right knee on the ground with the shin lying backwards
    // idle: weight rests on one leg, the other knee relaxes; swaps every few seconds
    const aiming = !!u.target && u.target.alive;
    const idle = !u.moving && !aiming && u.stance === "stand" && u.throwT > 1;
    this.aimW += ((aiming ? 1 : 0) - this.aimW) * Math.min(1, dt * 6);
    this.idleW += ((idle ? 1 : 0) - this.idleW) * Math.min(1, dt * 2.5);
    if (idle) this.idleT += dt;
    const iw = this.idleW, it = this.idleT;
    const shift = Math.sin(it * 0.45 + this.seed);
    this.legL.rotation.x = swing * (1 - k) - 1.45 * k;
    this.shinL.rotation.x = kneeL + 1.45 * k + iw * Math.max(0, shift) * 0.22;
    this.legR.rotation.x = -swing * (1 - k) + 0.12 * k;
    this.shinR.rotation.x = kneeR + 1.45 * k + iw * Math.max(0, -shift) * 0.22;
    // body bob, slightly lower overall so the planted foot touches the ground; on slopes the body
    // rides a little higher so the uphill foot doesn't sink into the hill
    const bob = ((Math.abs(Math.cos(this.phase)) - 0.6) * 0.1 - 0.04 + Math.abs(grade) * 0.4) * this.stride;
    const drop = (HIP_Y - KNEE_HIP) * k; // hips drop to kneeling height
    const back = u.recoil * 0.12 + p * 1.25;
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    this.root.position.set(u.x - sh * back, u.y + bob - drop + p * 0.28, u.z - ch * back);
    // grenade throw (see THROW)
    const throwing = u.throwT < THROW.duration;
    const tt = u.throwT;
    const throwLean = throwing ? curve(tt, THROW.lean) : 0;
    const twist = throwing ? curve(tt, THROW.twist) : 0;
    // lean into the hill when climbing, lean back when going down
    this.root.rotation.set(
      (0.08 + grade * 0.3) * this.stride + 0.12 * k + p * (Math.PI / 2 - 0.08),
      u.heading + twist,
      Math.sin(this.phase) * 0.04 * this.stride + iw * shift * 0.03,
    );

    // weapon: shouldered when engaging, carried across the chest when walking, lowered and angled
    // when standing around. Every ~12 s an idle soldier briefly checks his weapon.
    const cycle = (it + this.seed * 3) % 12;
    const check = iw * Math.max(0, Math.sin(Math.min(1, cycle / 1.6) * Math.PI));
    // grenadiers carry no rifle: only a slight relaxed swing instead of the diagonal rifle carry
    const carry = (1 - this.aimW) * (u.type === "grenadier" ? 0.3 : 1);
    const breath = Math.sin(it * 1.9) * 0.012 * iw;
    this.arms.rotation.set(
      -p * 1.2 + throwLean + (throwing ? curve(tt, THROW.freeArm) : 0) + carry * (0.3 + iw * 0.32) - check * 0.45 + breath * 2,
      carry * (-0.28 - iw * 0.12) + check * 0.2,
      carry * 0.1,
    );
    this.arms.position.y = SHOULDER_Y + breath;
    if (this.throwArm) {
      // throwing arm: relaxed swing with the body normally, the full wind-up and throw when throwing
      this.throwArm.rotation.set(
        -p * 1.2 + throwLean + (throwing ? curve(tt, THROW.arm) : carry * 0.3 + breath * 2) - check * 0.3,
        0,
        throwing ? curve(tt, THROW.armRoll) : 0,
      );
      this.throwArm.position.y = THROW_SHOULDER.y + breath;
    }
    // head: looks around while idle (slow sweep with the occasional quick glance), otherwise ahead
    const look = cycle > 4 && cycle < 8.5 ? Math.sin((cycle - 4) / 4.5 * Math.PI * 2) * 0.6 : Math.sin(it * 0.3 + this.seed) * 0.12;
    this.head.rotation.set(-p * 1.2 + throwLean * 0.6 - check * 0.25 + breath, look * iw, 0);
    this.head.position.y = SHOULDER_Y + breath;
    // round shadow; stretched along the body when lying down, a bit wider when kneeling
    this.shadow.place(u.x, u.y, u.z, u.heading, 0.95 + k * 0.1, 0.95 + k * 0.15 + p * 0.9);
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
    this.shadow.mesh.setEnabled(on);
  }

  dispose() {
    this.root.dispose();
    this.shadow.mesh.dispose();
  }

  animateDeath(u: Unit, t: number) {
    const fall = Math.min(1, t / 0.45);
    this.root.rotation.set(-fall * fall * (Math.PI / 2), u.heading, 0);
    this.legL.rotation.x = this.legR.rotation.x = 0;
    this.shinL.rotation.x = this.shinR.rotation.x = 0;
    this.arms.rotation.set(0.5, -0.3, 0);
    this.throwArm?.rotation.set(0.5, 0, 0);
    this.head.rotation.set(0, 0, 0);
    const lie = fall * fall;
    this.shadow.place(u.x - Math.sin(u.heading) * lie * 1.2, u.y, u.z - Math.cos(u.heading) * lie * 1.2, u.heading, 0.95, 0.95 + lie * 0.9);
    if (t > 3) this.root.position.y = u.y - (t - 3) * 0.6;
  }
}

/** Open jeep: hull follows the terrain, wheels roll and steer, the MG swivels and recoils. */
export class JeepView implements UnitView {
  readonly root: TransformNode;
  private readonly wheels: InstancedMesh[] = [];
  private readonly turret: TransformNode;
  private readonly gun: InstancedMesh;
  private readonly gunner: TransformNode;
  private spin = 0;
  private steer = 0;
  private lastHeading = 0;
  private gunnerShown = 0;
  private readonly shadow: BlobShadow;

  constructor(scene: Scene, tpl: JeepTemplates, name: string, blob: Mesh) {
    const D = JEEP_DIM;
    this.root = new TransformNode(name, scene);
    this.shadow = new BlobShadow(blob);
    const body = tpl.body.createInstance("jeepBody");
    body.parent = this.root;
    body.isPickable = false;
    for (const [x, z] of [[-D.wheelX, D.wheelZ], [D.wheelX, D.wheelZ], [-D.wheelX, -D.wheelZ], [D.wheelX, -D.wheelZ]]) {
      const w = tpl.wheel.createInstance("wheel");
      w.parent = this.root;
      w.position.set(x, D.wheelR, z);
      w.isPickable = false;
      this.wheels.push(w);
    }

    // driver, seated (legs hidden in the footwell)
    const driver = this.crew(scene, tpl.crew, false);
    driver.parent = this.root;
    driver.position.set(D.driver.x, D.bedY + 0.42 - HIP_Y, D.driver.z);

    this.turret = new TransformNode("turret", scene);
    this.turret.parent = this.root;
    this.turret.position.set(0, D.turret.y, D.turret.z);
    this.gun = tpl.gun.createInstance("gun");
    this.gun.parent = this.turret;
    this.gun.isPickable = false;

    // gunner stands in the bed behind the gun, only visible once a soldier has climbed aboard
    this.gunner = this.crew(scene, tpl.crew, true);
    this.gunner.parent = this.turret;
    this.gunner.position.set(0, D.bedY - D.turret.y, -0.75);
    this.gunner.setEnabled(false);
  }

  private crew(scene: Scene, tpl: SoldierTemplates, legs: boolean): TransformNode {
    const node = new TransformNode("crew", scene);
    const body = tpl.body.createInstance("crewBody");
    body.parent = node;
    body.isPickable = false;
    buildUpper(tpl, node).arms.rotation.x = 0.25;
    if (legs) {
      buildLeg(tpl, node, -HIP_X);
      buildLeg(tpl, node, HIP_X);
    }
    return node;
  }

  sync(u: Unit, dt: number, moved: number, terrain: Terrain) {
    const D = JEEP_DIM;
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    // pitch and roll from the ground under the wheels
    const hF = terrain.heightAt(u.x + sh * D.wheelZ, u.z + ch * D.wheelZ);
    const hB = terrain.heightAt(u.x - sh * D.wheelZ, u.z - ch * D.wheelZ);
    const hL = terrain.heightAt(u.x - ch * D.wheelX, u.z + sh * D.wheelX);
    const hR = terrain.heightAt(u.x + ch * D.wheelX, u.z - sh * D.wheelX);
    const pitch = Math.atan2(hB - hF, D.wheelZ * 2);
    const roll = Math.atan2(hL - hR, D.wheelX * 2);
    const shake = u.firing ? (Math.random() - 0.5) * 0.02 : 0;
    const bump = moved > 0.001 ? Math.sin(this.spin * 1.7) * 0.03 : 0;
    this.root.position.set(u.x, (hF + hB + hL + hR) / 4 + bump, u.z);
    this.root.rotation.set(pitch + shake, u.heading, roll);

    this.spin += moved / D.wheelR;
    let turnRate = (u.heading - this.lastHeading) / Math.max(dt, 1e-4);
    if (Math.abs(turnRate) > 10) turnRate = 0; // angle wrap
    this.lastHeading = u.heading;
    this.steer += (Math.max(-0.5, Math.min(0.5, turnRate * 0.25)) - this.steer) * Math.min(1, dt * 6);
    this.wheels.forEach((w, i) => {
      w.rotation.x = this.spin;
      w.rotation.y = i < 2 ? this.steer : 0;
    });

    this.turret.rotation.y = u.turret - u.heading;
    this.gun.position.z = -u.recoil * 0.12;

    const manned = !!u.gunner;
    this.gunnerShown += ((manned ? 1 : 0) - this.gunnerShown) * Math.min(1, dt * 6);
    this.gunner.setEnabled(this.gunnerShown > 0.02);
    // climbing aboard: the gunner rises into position
    this.gunner.position.y = D.bedY - D.turret.y - (1 - this.gunnerShown) * 1.2;
    this.shadow.place(u.x, u.y, u.z, u.heading, 1.7, 2.9);
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
    this.shadow.mesh.setEnabled(on);
  }

  dispose() {
    this.root.dispose();
    this.shadow.mesh.dispose();
  }

  animateDeath(u: Unit, t: number) {
    // blown up: hop, roll onto the side, then settle and sink
    const hop = Math.max(0, Math.sin(Math.min(1, t / 0.7) * Math.PI)) * 1.6;
    const tip = Math.min(1, t / 0.8);
    this.root.rotation.set(-0.3 * tip, u.heading + tip * 0.6, tip * 1.3);
    this.root.position.y = u.y + hop - (t > 3 ? (t - 3) * 0.5 : 0);
    this.gunner.setEnabled(false);
  }
}
