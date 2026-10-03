import { TransformNode, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import { DRONE_DIM, HIP_X, HIP_Y, JEEP_DIM, KNEE, NEST_DIM, SHOULDER_Y, THROW_SHOULDER, type SoldierTemplates } from "../world/models";
import type { Terrain } from "../world/terrain";
import { smoothstep } from "../util/noise";
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
export interface NestTemplates { body: Mesh; gun: Mesh; crew: SoldierTemplates; pennants: [Mesh, Mesh] }

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
  /** Medic: 1 while treating a patient (hands reach forward). */
  private healW = 0;
  private treatT = 0;
  /** Medic idling: 1 while kneeling to check his kit. */
  private gearW = 0;
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
    this.phase += moved * 2.9 * (1 + grade * 0.9);
    this.stride += ((walking ? 1 : 0) - this.stride) * Math.min(1, dt * 10);
    // quicker cadence with slightly shorter steps, so the feet keep pace with the ground
    const swing = Math.sin(this.phase) * 0.48 * (1 - grade * 0.35) * this.stride;

    // postures: kneel = lunge with lowered hips, prone = body flat, head and weapon raised forward
    const blend = Math.min(1, dt * 5);
    // medic idling: every ~17 s he kneels down for a few seconds and goes through his satchel
    let gear = 0;
    if (u.type === "medic" && this.idleW > 0.9) {
      const gc = (this.idleT + this.seed * 5) % 17;
      gear = smoothstep(9, 9.8, gc) * (1 - smoothstep(13.2, 14, gc));
    }
    this.gearW += (gear - this.gearW) * Math.min(1, dt * 4);
    this.kneelW += (Math.max(u.stance === "kneel" ? 1 : 0, gear) - this.kneelW) * blend;
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
    const idle = !u.moving && !aiming && !u.healing && u.stance === "stand" && u.throwT > 1;
    this.healW += ((u.healing ? 1 : 0) - this.healW) * Math.min(1, dt * 4);
    if (u.healing) this.treatT += dt;
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
    // grenadiers and medics carry no rifle: only a slight relaxed swing instead of the diagonal rifle carry
    const carry = (1 - this.aimW) * (u.type === "grenadier" || u.type === "medic" ? 0.3 : 1) * (1 - this.healW) * (1 - this.gearW);
    const breath = Math.sin(it * 1.9) * 0.012 * iw;
    // treating: both hands reach down and forward to the patient, working in a slow rhythm
    // drone pilot: hands on the laptop keyboard, fingers busy
    const typing = u.type === "pilot" ? 0.95 + Math.sin(this.phase + performance.now() * 0.012) * 0.04 : 0;
    const treat = typing + this.healW * (1.05 + Math.sin(this.treatT * 4 + this.seed) * 0.12)
      // checking his kit: hands down at the satchel, rummaging
      + this.gearW * (0.85 + Math.sin(it * 5 + this.seed) * 0.12);
    // grenadiers and medics walk with free arms: each swings against the leg on its side, with a
    // slight bend forward, fading out when the hands are busy (aiming, treating) or kneeling / lying
    const freeArms = u.type === "grenadier" || u.type === "medic";
    const busy = (1 - this.aimW) * (1 - this.healW) * (1 - this.gearW) * (1 - k) * (1 - p);
    const armSwing = freeArms ? swing * 1.15 * busy : 0;
    const armFwd = freeArms ? this.stride * 0.1 * busy : 0;
    // elbows out a little more the faster the swing
    const armRoll = freeArms ? Math.abs(swing) * 0.12 * busy : 0;
    this.arms.rotation.set(
      -p * 1.2 + throwLean + (throwing ? curve(tt, THROW.freeArm) : 0) + carry * (0.3 + iw * 0.32) - check * 0.45 + breath * 2 - treat - armSwing - armFwd,
      carry * (-0.28 - iw * 0.12) + check * 0.2,
      carry * 0.1 - armRoll,
    );
    this.arms.position.y = SHOULDER_Y + breath;
    if (this.throwArm) {
      // throwing arm: relaxed swing with the body normally, the full wind-up and throw when throwing
      this.throwArm.rotation.set(
        -p * 1.2 + throwLean + (throwing ? curve(tt, THROW.arm) : carry * 0.3 + breath * 2 + armSwing - armFwd - (u.type === "medic" ? treat : 0)) - check * 0.3,
        0,
        throwing ? curve(tt, THROW.armRoll) : armRoll,
      );
      this.throwArm.position.y = THROW_SHOULDER.y + breath;
    }
    // head: looks around while idle (slow sweep with the occasional quick glance), otherwise ahead
    const look = cycle > 4 && cycle < 8.5 ? Math.sin((cycle - 4) / 4.5 * Math.PI * 2) * 0.6 : Math.sin(it * 0.3 + this.seed) * 0.12;
    // the medic looks around more widely and turns his shoulders with it; head down while checking his kit
    const medic = u.type === "medic";
    const scan = medic ? look * 1.35 : look;
    const screenLook = u.type === "pilot" ? 0.4 : 0; // eyes on his screen
    this.head.rotation.set(-p * 1.2 + throwLean * 0.6 - check * 0.25 + breath + this.gearW * 0.5 + screenLook, scan * iw * (1 - this.gearW) * (screenLook ? 0.2 : 1), 0);
    if (medic) this.root.rotation.y += look * 0.3 * iw * (1 - this.gearW);
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

  /** Pose at the moment of death, captured on the first death frame. */
  private death: {
    prone: boolean; y: number; px: number; pz: number; rx: number;
    armsX: number; headX: number; legL: number; legR: number; shinL: number; shinR: number;
  } | null = null;

  /**
   * Death: lying soldiers stay down, slump and let the weapon slide off to the side; standing or
   * kneeling ones sag onto both knees, sway, then topple forward onto their face.
   */
  animateDeath(u: Unit, t: number) {
    const ease = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    if (!this.death) {
      this.death = {
        prone: u.stance === "prone" || this.proneW > 0.5,
        y: this.root.position.y, px: this.root.position.x, pz: this.root.position.z, rx: this.root.rotation.x,
        armsX: this.arms.rotation.x, headX: this.head.rotation.x,
        legL: this.legL.rotation.x, legR: this.legR.rotation.x, shinL: this.shinL.rotation.x, shinR: this.shinR.rotation.x,
      };
    }
    const d = this.death;
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    let lie: number;

    if (d.prone) {
      // already down: a last twitch, the body settles, head drops, the rifle slides off to the side
      const k = ease(t / 0.7);
      const twitch = t < 0.25 ? Math.sin(t * 40) * 0.03 * (1 - t / 0.25) : 0;
      this.root.position.set(d.px, d.y - k * 0.08, d.pz);
      this.root.rotation.set(d.rx + twitch, u.heading, k * 0.12);
      this.arms.rotation.set(lerp(d.armsX, -0.1, k), -0.35 * k, 0.55 * k);
      this.throwArm?.rotation.set(lerp(d.armsX, 0.2, k), 0, 0.4 * k);
      this.head.rotation.set(lerp(d.headX, 0.3, k), 0.35 * k, 0.25 * k);
      this.legL.rotation.x = lerp(d.legL, 0.05, k);
      this.legR.rotation.x = lerp(d.legR, -0.08, k);
      this.shinL.rotation.x = lerp(d.shinL, 0.15, k);
      this.shinR.rotation.x = lerp(d.shinR, 0.3, k);
      lie = 1;
    } else {
      // 1) the legs give way: down onto both knees, head bowed, the rifle sags
      const kneel = ease(t / 0.32);
      // 2) a moment's sway, then he topples forward (accelerating) onto his face
      const fall = Math.min(1, Math.max(0, (t - 0.42) / 0.45));
      const f = fall * fall;
      const drop = (HIP_Y - KNEE_HIP) * kneel;
      const sway = t > 0.3 && t < 0.42 ? Math.sin((t - 0.3) * 26) * 0.04 : 0;
      const tip = f * (Math.PI / 2 - 0.1);
      this.root.position.set(
        d.px + sh * f * 0.25,
        lerp(d.y, u.y - drop, kneel) * (1 - f) + (u.y + 0.26) * f,
        d.pz + ch * f * 0.25,
      );
      this.root.rotation.set(lerp(d.rx, 0.12, kneel) + sway + tip, u.heading, f * 0.1);
      // thighs stay upright while kneeling and stretch out behind as he falls; shins fold back flat
      this.legL.rotation.x = lerp(d.legL, 0, kneel) * (1 - f) - tip * (1 - f) * 0.9;
      this.legR.rotation.x = lerp(d.legR, 0, kneel) * (1 - f) - tip * (1 - f) * 0.9;
      this.shinL.rotation.x = lerp(lerp(d.shinL, 1.5, kneel), 0.25, f);
      this.shinR.rotation.x = lerp(lerp(d.shinR, 1.5, kneel), 0.4, f);
      // arms: the rifle sags while kneeling, then the arms fling forward as he goes down
      this.arms.rotation.set(lerp(lerp(d.armsX, 0.7, kneel), -1.0, f), -0.2 * f, 0.3 * f);
      this.throwArm?.rotation.set(lerp(0.7 * kneel, -0.8, f), 0, 0.2 * f);
      this.head.rotation.set(lerp(lerp(d.headX, 0.35, kneel), -0.3, f), 0.5 * f, 0);
      lie = f;
    }
    this.shadow.place(u.x + sh * lie * 0.9, u.y, u.z + ch * lie * 0.9, u.heading, 0.95, 0.95 + lie * 0.9);
    if (d.prone) this.shadow.place(this.root.position.x, u.y, this.root.position.z, u.heading, 0.95, 1.85);
    if (t > 3) this.root.position.y -= (t - 3) * 0.6;
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
  private readonly driverHead: InstancedMesh;
  private readonly gunnerHead: InstancedMesh;
  /** 1 while the jeep stands still with nothing to shoot at (crew looking around). */
  private idleW = 0;
  private idleT = Math.random() * 30;
  private readonly seed = Math.random() * 10;

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
    this.driverHead = driver.head;
    driver.parent = this.root;
    driver.position.set(D.driver.x, D.bedY + 0.42 - HIP_Y, D.driver.z);

    this.turret = new TransformNode("turret", scene);
    this.turret.parent = this.root;
    this.turret.position.set(0, D.turret.y, D.turret.z);
    this.gun = tpl.gun.createInstance("gun");
    this.gun.parent = this.turret;
    this.gun.isPickable = false;

    // gunner stands in the bed behind the gun, only visible once a soldier has climbed aboard
    const gunner = this.crew(scene, tpl.crew, true);
    this.gunnerHead = gunner.head;
    this.gunner = gunner;
    this.gunner.parent = this.turret;
    this.gunner.position.set(0, D.bedY - D.turret.y, -0.75);
    this.gunner.setEnabled(false);
  }

  private crew(scene: Scene, tpl: SoldierTemplates, legs: boolean): TransformNode & { head: InstancedMesh } {
    const node = new TransformNode("crew", scene) as TransformNode & { head: InstancedMesh };
    const body = tpl.body.createInstance("crewBody");
    body.parent = node;
    body.isPickable = false;
    const upper = buildUpper(tpl, node);
    upper.arms.rotation.x = 0.25;
    node.head = upper.head;
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
    // a positive roll lifts the right side (+x): bank towards the higher side so the hull follows the slope
    const roll = Math.atan2(hR - hL, D.wheelX * 2);
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

    // standing still with nothing to shoot at: the crew looks around - the driver turns his head,
    // the gunner sweeps the MG slowly from side to side
    const idle = moved < 0.001 && !u.firing && !(u.target && u.target.alive);
    this.idleW += ((idle ? 1 : 0) - this.idleW) * Math.min(1, dt * 1.5);
    if (idle) this.idleT += dt;
    const it = this.idleT + this.seed * 4, iw = this.idleW;
    // driver: slow look left and right, now and then a glance back over the shoulder
    const glance = (it % 11) > 8.6 && (it % 11) < 10 ? Math.sin(((it % 11) - 8.6) / 1.4 * Math.PI) * 1.1 : 0;
    this.driverHead.rotation.y = (Math.sin(it * 0.45) * 0.6 + glance * Math.sign(Math.sin(it * 0.07) || 1)) * iw;
    this.driverHead.rotation.x = Math.sin(it * 0.31 + 1) * 0.08 * iw;
    // gunner: the gun swings through a wide arc with short pauses, his head leads a little
    const sweep = Math.sin(it * 0.32) * 0.95 + Math.sin(it * 0.11 + 2) * 0.3;
    this.turret.rotation.y = u.turret - u.heading + sweep * iw * (u.gunner ? 1 : 0);
    this.gunnerHead.rotation.y = Math.cos(it * 0.32) * 0.25 * iw;
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

/** Share of a structure's construction that is done (1 = finished). */
function built(u: Unit): number {
  return u.stats.buildTime > 0 ? 1 - u.buildT / u.stats.buildTime : 1;
}

/**
 * MG nest: sandbag ring rising out of the ground while it is built, a swivelling MG on its tripod,
 * the gunner standing in the pit behind it once manned, and a pennant in the owner's colour.
 */
export class NestView implements UnitView {
  readonly root: TransformNode;
  private readonly turret: TransformNode;
  private readonly gun: InstancedMesh;
  private readonly gunner: TransformNode;
  private readonly pennants: InstancedMesh[];
  private gunnerShown = 0;

  constructor(scene: Scene, tpl: NestTemplates, name: string) {
    this.root = new TransformNode(name, scene);
    const body = tpl.body.createInstance("nest");
    body.parent = this.root;
    body.isPickable = false;
    this.turret = new TransformNode("nestTurret", scene);
    this.turret.parent = this.root;
    this.turret.position.set(0, NEST_DIM.gunY, 0.35);
    this.gun = tpl.gun.createInstance("nestGun");
    this.gun.parent = this.turret;
    this.gun.isPickable = false;
    // the gunner stands in the shallow pit, only his upper body shows above the sandbags
    this.gunner = new TransformNode("nestGunner", scene);
    this.gunner.parent = this.turret;
    const crewBody = tpl.crew.body.createInstance("crewBody");
    crewBody.parent = this.gunner;
    crewBody.isPickable = false;
    buildUpper(tpl.crew, this.gunner).arms.rotation.x = 0.25;
    this.gunner.setEnabled(false);
    this.pennants = tpl.pennants.map((p) => {
      const m = p.createInstance("pennant");
      m.parent = this.root;
      m.position.set(-1.05, 0.15, -0.95);
      m.isPickable = false;
      return m;
    });
  }

  sync(u: Unit, dt: number) {
    const k = built(u);
    this.root.position.set(u.x, u.y - (1 - k) * 0.9, u.z);
    this.root.rotation.set(0, u.heading, 0);
    this.turret.setEnabled(k >= 1);
    this.turret.rotation.y = u.turret - u.heading;
    this.gun.position.z = -u.recoil * 0.12;
    this.pennants.forEach((p, i) => p.setEnabled(i === u.team && k >= 1));
    this.pennants[u.team].rotation.y = Math.sin(performance.now() * 0.002 + u.id) * 0.3;
    this.gunnerShown += ((u.gunner ? 1 : 0) - this.gunnerShown) * Math.min(1, dt * 6);
    this.gunner.setEnabled(this.gunnerShown > 0.02);
    this.gunner.position.set(0, -NEST_DIM.gunY - 0.85 - (1 - this.gunnerShown) * 1.0, -0.75);
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
  }

  dispose() {
    this.root.dispose();
  }

  animateDeath(u: Unit, t: number) {
    // blown apart: the gun is thrown over, the sandbags slump and sink
    const f = Math.min(1, t / 0.5);
    this.gunner.setEnabled(false);
    this.turret.rotation.set(-f * 1.2, u.turret - u.heading + f * 0.8, f * 0.6);
    this.root.scaling.set(1 + f * 0.15, 1 - f * 0.55, 1 + f * 0.15);
    this.root.position.y = u.y - (t > 3 ? (t - 3) * 0.4 : 0);
  }
}

/** Bollards: rise out of the ground while being set, topple and sink when destroyed. */
export class BollardView implements UnitView {
  readonly root: TransformNode;

  constructor(scene: Scene, tpl: Mesh, name: string) {
    this.root = new TransformNode(name, scene);
    const m = tpl.createInstance("bollards");
    m.parent = this.root;
    m.isPickable = false;
  }

  sync(u: Unit) {
    const k = built(u);
    this.root.position.set(u.x, u.y - (1 - k) * 1.1, u.z);
    this.root.rotation.set(0, u.heading, 0);
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
  }

  dispose() {
    this.root.dispose();
  }

  animateDeath(u: Unit, t: number) {
    const f = Math.min(1, t / 0.4);
    this.root.rotation.set(f * 0.5, u.heading, f * 0.25);
    this.root.position.y = u.y - f * 0.3 - (t > 3 ? (t - 3) * 0.5 : 0);
  }
}

export interface DroneTemplates { body: Mesh; rotor: Mesh }

/** FPV drone: hovers with a gentle bob, rotors spin, tilts into its direction of flight, crashes when shot down. */
export class DroneView implements UnitView {
  readonly root: TransformNode;
  private readonly rotors: InstancedMesh[] = [];
  private readonly shadow: BlobShadow;
  private spin = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private tilt = 0;
  private readonly seed = Math.random() * 10;

  constructor(scene: Scene, tpl: DroneTemplates, name: string, blob: Mesh) {
    this.root = new TransformNode(name, scene);
    this.shadow = new BlobShadow(blob);
    const body = tpl.body.createInstance("droneBody");
    body.parent = this.root;
    body.isPickable = false;
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4]) {
      const r = tpl.rotor.createInstance("rotor");
      r.parent = this.root;
      r.position.set(Math.sin(a) * DRONE_DIM.arm, DRONE_DIM.rotorY, Math.cos(a) * DRONE_DIM.arm);
      r.isPickable = false;
      this.rotors.push(r);
    }
  }

  sync(u: Unit, dt: number) {
    const t = performance.now() / 1000;
    const vx = Number.isNaN(this.lastX) ? 0 : (u.x - this.lastX) / Math.max(dt, 1e-3);
    const vz = Number.isNaN(this.lastZ) ? 0 : (u.z - this.lastZ) / Math.max(dt, 1e-3);
    this.lastX = u.x;
    this.lastZ = u.z;
    const speed = Math.min(10, Math.hypot(vx, vz));
    this.tilt += (speed * 0.035 - this.tilt) * Math.min(1, dt * 4);
    this.root.position.set(u.x, u.y + u.altitude + Math.sin(t * 2.3 + this.seed) * 0.12, u.z);
    // nose down into the direction of flight, a slight wobble
    this.root.rotation.set(this.tilt + Math.sin(t * 3.1 + this.seed) * 0.03, u.heading, Math.cos(t * 2.7 + this.seed) * 0.03);
    this.spin += dt * 60;
    this.rotors.forEach((r, i) => (r.rotation.y = this.spin * (i % 2 ? 1 : -1)));
    // a small, faint shadow far below
    this.shadow.place(u.x, u.y, u.z, u.heading, 0.55, 0.55);
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
    // shot down / link lost: tumbles out of the sky and lies in the grass
    const fall = Math.min(1, (t * t) / 1.4);
    this.root.position.set(u.x, u.y + u.altitude * (1 - fall) + 0.1, u.z);
    this.root.rotation.set(fall * 2.4, u.heading + t * (1 - fall) * 9, fall * 1.1);
    this.spin += (1 - fall) * 0.6;
    this.rotors.forEach((r, i) => (r.rotation.y = this.spin * (i % 2 ? 1 : -1)));
    this.shadow.place(u.x, u.y, u.z, u.heading, 0.55, 0.55);
  }
}
