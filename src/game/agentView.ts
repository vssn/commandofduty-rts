import { Matrix, Vector3, type InstancedMesh, type Mesh, type Scene, type TransformNode } from "@babylonjs/core";
import { AgentRig } from "../world/agentModel";
import { HIP_Y } from "../world/models";
import { smoothstep } from "../util/noise";
import { SQUAT, type UnitView } from "./views";
import type { Unit } from "./unit";

/** A hand-posed part of the figure (as the cutscenes see it): a rotation like a mesh's, and a switch. */
class Part {
  readonly rotation = new Vector3();
  readonly position = new Vector3();
  private on = true;
  setEnabled(v: boolean) {
    this.on = v;
  }
  isEnabled() {
    return this.on;
  }
}

/**
 * The rifle and the hands on it, in the gun frame (origin between the shoulders, figure axes):
 * shouldered and aimed straight ahead. Carrying, checking or lowering it turns this frame.
 */
const GRIP = new Vector3(0.1, -0.04, 0.32);
/**
 * Wrist joints (the hands reach on from there): right above and behind the pistol grip (the
 * elbow out to the side), left below and to the left of the fore-end, so the forearm comes up
 * from under the rifle.
 */
const HAND_R = GRIP.add(new Vector3(0.02, 0.06, -0.15));
const HAND_L = GRIP.add(new Vector3(-0.1, -0.05, 0.15));
/**
 * The hands' set: knuckles (wrist → knuckle of the middle finger) and thumb, and where the
 * fingers curl. Right: knuckles down the right side of the grip, thumb over its left, fingers
 * round its front. Left: palm up under the fore-end, thumb up its left side, fingers up its right.
 */
const KNUCKLES_R = new Vector3(0, -0.5, 0.85);
const THUMB_R = new Vector3(-0.8, 0.1, 0.5);
const CURL_R = new Vector3(-0.6, 0, -0.4);
const KNUCKLES_L = new Vector3(0.35, 0.15, 0.9);
const THUMB_L = new Vector3(-0.6, 0.5, 0.4);
const CURL_L = new Vector3(-0.2, 1, 0);
const POLE_R = new Vector3(0.5, -0.3, -0.1);
const POLE_L = new Vector3(-0.15, -0.8, 0.15);

const euler = (v: Vector3, out = new Matrix()) => Matrix.RotationYawPitchRollToRef(v.y, v.x, v.z, out);

/**
 * The agent's view with the rigged model (see AgentRig): clips for idle, walking, running and
 * backing away, blended by speed; postures (crouch, kneel, prone) and the rifle set by hand on top.
 * The cutscenes pose it through `parts` like the built figure, followed by `applyPose()`.
 */
export class AgentView implements UnitView {
  readonly rig: AgentRig;
  readonly root: TransformNode;
  private readonly shadow: InstancedMesh;
  /** Parts posed by the cutscenes (rotations relative to the clip pose). */
  readonly parts: { torso: Part; arms: Part; head: Part; legL: Part; legR: Part; shinL: Part; shinR: Part; shadow: InstancedMesh };
  /** Arm targets of a cutscene while the rifle is put away (figure frame): wrist and elbow per side. */
  armTargets: { L: { elbow: Vector3; wrist: Vector3 }; R: { elbow: Vector3; wrist: Vector3 } } | null = null;
  /** Extra turn of the upper body (radians), e.g. sweeping the rifle while backing away. */
  twist = 0;

  private phase = 0;
  private backPhase = 0;
  private stride = 0;
  private back = 0;
  private run = 0;
  private aimW = 0;
  private idleW = 0;
  private idleT = Math.random() * 40;
  private readonly seed = Math.random() * 10;
  private kneelW = 0;
  private proneW = 0;
  private squatW = 0;
  private deathRifle: Matrix | null = null;

  constructor(scene: Scene, name: string, blob: Mesh) {
    this.rig = new AgentRig(scene, name);
    this.root = this.rig.root;
    this.shadow = blob.createInstance("blob");
    this.shadow.isPickable = false;
    this.parts = {
      torso: new Part(), arms: new Part(), head: new Part(), legL: new Part(), legR: new Part(), shinL: new Part(), shinR: new Part(), shadow: this.shadow,
    };
  }

  /** Meshes that cast shadows. */
  get meshes(): Mesh[] {
    return [...this.rig.meshes, this.rig.rifle];
  }

  /** A joint's position in the figure frame (e.g. "Wrist.L", "Foot.R", "UpperArm.L"). */
  joint(bone: string): Vector3 {
    return this.rig.posFig(bone);
  }

  sync(u: Unit, dt: number, moved: number) {
    const rig = this.rig;
    const speed = Math.abs(moved) / Math.max(dt, 1e-4);
    const walking = u.moving && Math.abs(moved) > 0.001;
    this.stride += ((walking ? 1 : 0) - this.stride) * Math.min(1, dt * 8);
    this.back += ((moved < 0 ? 1 : 0) - this.back) * Math.min(1, dt * 8);
    // walk below ~2.5 units/s, run above: blended, both clips on the same step
    const vWalk = rig.stride.get("Walk")! / rig.duration("Walk");
    const vRun = rig.stride.get("Run")! / rig.duration("Run");
    if (walking) this.run += (smoothstep(vWalk, (vWalk + vRun) / 2, speed) - this.run) * Math.min(1, dt * 4);
    const len = rig.stride.get("Walk")! * (1 - this.run) + rig.stride.get("Run")! * this.run;
    if (moved > 0) this.phase = (this.phase + moved / len) % 1;
    else this.backPhase = (this.backPhase - moved / rig.stride.get("Run_Back")!) % 1;

    const aiming = !!u.target && u.target.alive;
    const idle = !u.moving && !aiming && u.stance === "stand";
    this.aimW += ((aiming ? 1 : 0) - this.aimW) * Math.min(1, dt * 6);
    this.idleW += ((idle ? 1 : 0) - this.idleW) * Math.min(1, dt * 2.5);
    if (idle) this.idleT += dt;
    const iw = this.idleW, it = this.idleT;
    // every ~18 s of idling he drops into a crouch for a while and checks his rifle there
    let squat = 0, squatCheck = 0;
    if (iw > 0.9) {
      const sc = (it + this.seed * 7) % 18;
      squat = smoothstep(6, 6.7, sc) * (1 - smoothstep(12.6, 13.4, sc));
      squatCheck = smoothstep(7.4, 7.9, sc) * (1 - smoothstep(10.6, 11.2, sc));
    }
    this.squatW += (squat - this.squatW) * Math.min(1, dt * 5);
    const blend = Math.min(1, dt * 5);
    this.kneelW += ((u.stance === "kneel" ? 1 : 0) - this.kneelW) * blend;
    this.proneW += ((u.stance === "prone" ? 1 : 0) - this.proneW) * blend;
    const k = this.kneelW, p = this.proneW, sq = this.squatW;

    const shift = Math.sin(it * 0.45 + this.seed);
    const backOff = u.recoil * 0.12 + p * 1.25;
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    this.root.position.set(u.x - sh * backOff, u.y + p * 0.28, u.z - ch * backOff);
    this.root.rotation.set(0.12 * k + p * (Math.PI / 2 - 0.08), u.heading, iw * shift * 0.02);

    const m = this.stride * (1 - k) * (1 - p);
    const fwd = 1 - this.back;
    rig.pose([
      { clip: "Idle_Gun", t: it, w: 1 - m },
      { clip: "Walk", t: this.phase * rig.duration("Walk"), w: m * fwd * (1 - this.run) },
      { clip: "Run", t: ((this.phase + 0.5) % 1) * rig.duration("Run"), w: m * fwd * this.run },
      { clip: "Run_Back", t: this.backPhase * rig.duration("Run_Back"), w: m * this.back },
    ]);

    const lerpS = (a: number, b: number) => a + (b - a) * sq;
    this.parts.legL.rotation.set(lerpS(-1.45 * k, SQUAT.thigh), 0, 0);
    this.parts.shinL.rotation.set(lerpS(1.45 * k + iw * Math.max(0, shift) * 0.22, SQUAT.shin), 0, 0);
    this.parts.legR.rotation.set(lerpS(0.12 * k, SQUAT.thigh - 0.08), 0, 0);
    this.parts.shinR.rotation.set(lerpS(1.45 * k + iw * Math.max(0, -shift) * 0.22, SQUAT.shin + 0.06), 0, 0);
    this.parts.torso.rotation.set(SQUAT.lean * sq + 0.1 * k, this.twist, 0);
    // the rifle: shouldered when engaging, held low across the body otherwise; now and then he
    // checks it, crouching he raises and rolls it to look it over
    const cycle = (it + this.seed * 3) % 12;
    const check = iw * Math.max(0, Math.sin(Math.min(1, cycle / 1.6) * Math.PI));
    const carry = 1 - this.aimW;
    const breath = Math.sin(it * 1.9) * 0.012 * iw;
    const sqc = squatCheck * sq;
    this.parts.arms.rotation.set(
      -p * 1.2 + carry * (0.32 + iw * 0.3) - check * 0.45 + breath * 2 - SQUAT.lean * sq * 0.6 - sqc * (0.55 + Math.sin(it * 1.3) * 0.08) - u.recoil * 0.12,
      carry * (-0.42 - iw * 0.1) + check * 0.2 + sqc * 0.15,
      carry * 0.12 + sqc * (0.5 + Math.sin(it * 0.9) * 0.15),
    );
    this.parts.arms.setEnabled(true);
    const look = cycle > 4 && cycle < 8.5 ? Math.sin((cycle - 4) / 4.5 * Math.PI * 2) * 0.6 : Math.sin(it * 0.3 + this.seed) * 0.12;
    this.parts.head.rotation.set(-p * 1.2 - check * 0.25 + breath - SQUAT.lean * sq * 0.7 + sqc * 0.45, look * iw * (1 - sqc) + sqc * 0.2, 0);

    this.applyParts(Math.max(k, sq));
    this.shadow.position.set(u.x, u.y + 0.06, u.z);
    this.shadow.rotation.y = u.heading;
    this.shadow.scaling.set(0.95 + k * 0.1, 1, 0.95 + k * 0.15 + p * 0.9);
  }

  /**
   * Puts the cutscene's parts onto the figure (over a standing idle pose); `plant` 0..1 sets the
   * feet on the ground. The root hangs `HIP_Y` below its parent (the cutscene's hip node).
   */
  applyPose(t: number, plant = 0) {
    this.root.position.y = -HIP_Y;
    this.rig.pose([{ clip: "Idle_Gun", t, w: 1 }]);
    this.applyParts(plant);
  }

  /** Turns the bones by the parts' rotations (relative to the clip pose), arms onto the rifle or the targets, feet planted by `plant`. */
  private applyParts(plant: number) {
    const rig = this.rig, P = this.parts;
    const feet = rig.footFrames();
    const R = new Matrix(), S = new Matrix();
    // legs (from the hips) and shins (in the thigh's frame)
    for (const [leg, shin, side] of [[P.legL, P.shinL, "L"], [P.legR, P.shinR, "R"]] as const) {
      euler(leg.rotation, R);
      if (!R.isIdentity()) rig.rotate(`UpperLeg.${side}`, R);
      euler(shin.rotation, S);
      if (!S.isIdentity()) rig.rotate(`LowerLeg.${side}`, R.clone().transpose().multiply(S).multiply(R));
    }
    rig.reattachFeet(feet);
    // upper body from the waist, head in the upper body's frame
    euler(P.torso.rotation, R);
    if (!R.isIdentity()) rig.rotate("Abdomen", R);
    euler(P.head.rotation, S);
    if (!S.isIdentity()) rig.rotate("Neck", R.clone().transpose().multiply(S).multiply(R));

    // arms: on the rifle, or (rifle put away) to the cutscene's targets
    const gun = P.arms.isEnabled();
    rig.rifle.setEnabled(gun);
    if (gun) {
      const G = euler(P.arms.rotation).multiply(rig.gunFrame());
      rig.placeRifle(Matrix.Translation(GRIP.x, GRIP.y, GRIP.z).multiply(G));
      const at = (v: Vector3) => Vector3.TransformCoordinates(v, G);
      const dir = (v: Vector3) => Vector3.TransformNormal(v, G);
      rig.reach("R", at(HAND_R), at(POLE_R));
      rig.reach("L", at(HAND_L), at(POLE_L));
      rig.orient("Wrist.R", "Middle2.R", dir(KNUCKLES_R), "Thumb2.R", dir(THUMB_R));
      rig.orient("Wrist.L", "Middle2.L", dir(KNUCKLES_L), "Thumb2.L", dir(THUMB_L));
      rig.curl("R", 0.6, dir(CURL_R));
      rig.curl("L", 0.5, dir(CURL_L));
    } else if (this.armTargets) {
      for (const s of ["L", "R"] as const) rig.reach(s, this.armTargets[s].wrist, this.armTargets[s].elbow);
    }

    // feet (or a knee) on the ground while crouching / kneeling
    if (plant > 0.001) {
      const low = Math.min(
        rig.posFig("Foot.L").y - rig.footRest, rig.posFig("Foot.R").y - rig.footRest,
        rig.posFig("LowerLeg.L").y - 0.09, rig.posFig("LowerLeg.R").y - 0.09,
      );
      this.root.position.y -= low * plant;
    }
    rig.refresh();
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
    this.shadow.setEnabled(on);
  }

  dispose() {
    this.rig.dispose();
    this.shadow.dispose();
  }

  /** Death: the model's own fall; the rifle goes down with the right hand. */
  animateDeath(u: Unit, t: number) {
    const rig = this.rig;
    if (!this.deathRifle) {
      // the rifle stays in the hand as it was at the moment of death
      const hand = rig.world("Wrist.R").multiply(Matrix.Invert(this.root.getWorldMatrix()));
      this.deathRifle = rig.rifle.computeWorldMatrix(true).multiply(Matrix.Invert(this.root.getWorldMatrix())).multiply(Matrix.Invert(hand));
    }
    const dur = rig.duration("Death");
    rig.pose([{ clip: "Death", t: Math.min(dur - 0.01, t), w: 1 }]);
    // (the clip falls from standing: from a crouch the figure is set back onto its feet first)
    this.root.rotation.set(0, u.heading, 0);
    this.root.position.set(u.x, u.y - (t > 3 ? (t - 3) * 0.6 : 0), u.z);
    rig.refresh();
    const hand = rig.world("Wrist.R").multiply(Matrix.Invert(this.root.getWorldMatrix()));
    rig.placeRifle(this.deathRifle.multiply(hand));
    this.shadow.position.set(u.x, u.y + 0.06, u.z);
  }
}
