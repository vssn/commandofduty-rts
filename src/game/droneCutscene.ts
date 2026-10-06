import { Color3, Matrix, PointLight, Vector3, type FreeCamera, type InstancedMesh, type Scene } from "@babylonjs/core";
import type { AudioSystem } from "../audio/audio";
import { COMMANDOS, ENEMY } from "../config";
import { smoothstep } from "../util/noise";
import type { Charge, CommandosMission } from "./commandos";
import type { Game } from "./game";
import type { Outpost } from "./outpost";
import type { Unit } from "./unit";
import { PILOT_CASE_Z } from "../world/models";

/**
 * The cutscene before the second outpost goes up: the camera shows the blast, then cuts to another
 * outpost where a drone pilot runs out, kneels, sets down his laptop, spreads out his drone and sends
 * it up. The drone hovers a moment, then turns its violet light into the camera and the picture
 * floods violet. The mission's first drone is this one.
 *
 * The world stands still (only the effects run); the blast is set off by the cutscene itself.
 */

/** Seconds into the scene. */
const T = {
  blast: 2.4, dip1: 5.0, run: 5.7, kneel: 8.0, drone: 8.45, unfold: 8.7, spin: 10.2, lift: 10.9, hover: 13.0, dip2: 15.0, fly: 15.5, end: 20.0,
};
const FADE = 0.9;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (a: number, b: number, t: number) => smoothstep(a, b, t);

export class DroneCutscene {
  readonly focus = new Vector3();
  active = true;

  private readonly scene: Scene;
  private readonly mission: CommandosMission;
  private readonly post: Outpost;
  private t = 0;
  private shake = 0;
  private blasted = false;
  private finished = false;
  private skipping = false;

  // pilot and drone
  private readonly start = { x: 0, z: 0 };
  private readonly spot = { x: 0, z: 0 };
  /** Run direction of the pilot (unit vector) and its heading. */
  private readonly f = new Vector3();
  private runAng = 0;
  private pilot: Unit | null = null;
  private drone: Unit | null = null;
  private rotors: { m: InstancedMesh; home: Vector3 }[] = [];
  private body: InstancedMesh | null = null;
  private light: PointLight | null = null;
  private spinK = 0;
  private buzzOn = false;
  private fired = new Set<string>();
  private readonly camSpot: Vector3;
  private readonly droneEnd = new Vector3();

  // camera
  private readonly camPos = new Vector3();
  private readonly camLook = new Vector3();
  private camFov = 0.8;
  private camInit = false;
  private phase = 0;
  private readonly baseFov: number;

  private readonly rootEl = document.getElementById("cutscene")!;
  private readonly fadeEl = document.getElementById("cut-fade")!;
  private readonly tintEl = document.getElementById("cut-tint")!;
  private readonly floodEl = document.getElementById("cut-flood")!;
  private readonly flareEl = document.getElementById("cut-flare")!;

  constructor(
    private readonly game: Game,
    private readonly audio: AudioSystem,
    private readonly camera: FreeCamera,
    private readonly charge: Charge,
    private readonly onDone: () => void,
  ) {
    this.scene = game.scene;
    this.mission = game.commandos!;
    this.post = charge.target as Outpost;
    this.baseFov = camera.fov;

    // the pilot comes from another outpost, not too close to the blast
    const others = game.outposts.filter((o) => !o.destroyed && o !== this.post)
      .sort((a, b) => Math.hypot(a.x - this.post.x, a.z - this.post.z) - Math.hypot(b.x - this.post.x, b.z - this.post.z));
    const o2 = others.find((o) => Math.hypot(o.x - this.post.x, o.z - this.post.z) >= 25) ?? others[0] ?? this.post;
    const nav = game.nav;
    const out = Math.atan2(o2.x - this.post.x, o2.z - this.post.z) + 0.7; // outwards, away from the blast
    const s = nav.freePoint(o2.x, o2.z);
    const p = nav.freePoint(o2.x + Math.sin(out) * o2.radius * 0.95, o2.z + Math.cos(out) * o2.radius * 0.95);
    this.start.x = s.x; this.start.z = s.z;
    this.spot.x = p.x; this.spot.z = p.z;
    this.runAng = Math.atan2(p.x - s.x, p.z - s.z);
    if (Math.hypot(p.x - s.x, p.z - s.z) < 3) this.runAng = out;
    this.f.set(Math.sin(this.runAng), 0, Math.cos(this.runAng));
    // the camera for the last shot: on the ground, further along the pilot's direction
    this.camSpot = this.findSpot(p.x, p.z, this.runAng, 13, 1.1);
    this.droneEnd.set(this.camSpot.x - this.f.x * 4.5, 0, this.camSpot.z - this.f.z * 4.5);

    // look: black for a moment, then the picture
    this.rootEl.hidden = false;
    this.dip(true);
    this.update(0);
  }

  // ------------------------------------------------------------------ helpers

  private ground(x: number, z: number) {
    return this.game.terrain.heightAt(x, z);
  }

  /** A camera spot about `dist` from (cx, cz) around direction `ang`, in the open. */
  private findSpot(cx: number, cz: number, ang: number, dist: number, height: number): Vector3 {
    const nav = this.game.nav;
    for (const d of [dist, dist * 0.8, dist * 0.6]) {
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const x = cx + Math.sin(ang + turn) * d, z = cz + Math.cos(ang + turn) * d;
        if (nav.areaFree(x, z, 2.4, 2.4, 0, 0)) return new Vector3(x, this.ground(x, z) + height, z);
      }
    }
    const x = cx + Math.sin(ang) * dist, z = cz + Math.cos(ang) * dist;
    return new Vector3(x, this.ground(x, z) + height + 1.5, z);
  }

  /** A quick dip through black (`first`: from black into the picture). */
  private dip(first = false) {
    const el = this.fadeEl;
    if (first) {
      el.style.transition = "none";
      el.style.opacity = "1";
      void el.offsetWidth;
      el.style.transition = "opacity 0.6s ease";
      el.style.opacity = "0";
      return;
    }
    el.style.transition = "opacity 0.25s ease";
    el.style.opacity = "1";
    window.setTimeout(() => {
      el.style.transition = "opacity 0.4s ease";
      el.style.opacity = "0";
    }, 380);
  }

  private once(key: string, at: number, fn: () => void) {
    if (this.t >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn();
    }
  }

  private blast() {
    if (this.blasted) return;
    this.blasted = true;
    this.mission.detonate(this.charge, true);
  }

  /** Pilot and drone, spawned when the scene needs them. */
  private spawnCast() {
    if (this.pilot) return;
    const g = this.game;
    const pilot = g.spawnUnit("pilot", ENEMY, this.start.x, this.start.z);
    pilot.heading = this.runAng;
    pilot.stance = "stand";
    const dx = this.spot.x + this.f.x * PILOT_CASE_Z, dz = this.spot.z + this.f.z * PILOT_CASE_Z;
    const drone = g.spawnUnit("drone", ENEMY, dx, dz);
    drone.heading = this.runAng;
    drone.altitude = 0.12;
    this.pilot = pilot;
    this.drone = drone;
    drone.view.setEnabled(false);
    for (const n of drone.view.root.getChildren()) {
      if (n.name === "rotor") this.rotors.push({ m: n as InstancedMesh, home: (n as InstancedMesh).position.clone() });
      else if (n.name === "droneBody") this.body = n as InstancedMesh;
    }
    // a pale light keeps the two in view (the night is dark)
    const L = new PointLight("droneCineLight", new Vector3(this.spot.x - this.f.x * 2 + 1, this.ground(this.spot.x, this.spot.z) + 3.2, this.spot.z - this.f.z * 2), this.scene);
    L.diffuse = new Color3(0.65, 0.78, 1);
    L.specular = Color3.Black();
    L.intensity = 1.5;
    L.range = 16;
    L.includedOnlyMeshes = [...pilot.view.root.getChildMeshes(), ...drone.view.root.getChildMeshes()];
    this.light = L;
  }

  private setFold(k: number) {
    for (const r of this.rotors) r.m.position.copyFrom(r.home).scaleInPlace(lerp(0.2, 1, k));
    this.body?.scaling.setAll(lerp(0.75, 1, k));
  }

  // ------------------------------------------------------------------ actors

  private act(dt: number) {
    const t = this.t, g = this.game;
    this.once("blast", T.blast, () => { this.blast(); this.shake = 1; });
    this.shake = Math.max(0, this.shake - dt * 1.3);
    g.effects.update(dt);
    if (t >= T.dip1 - 0.4) this.once("cast", T.dip1 - 0.4, () => this.spawnCast());
    const pilot = this.pilot, drone = this.drone;
    if (!pilot || !drone) return;

    // the pilot runs out of the outpost to his spot, then kneels
    const run = ease(T.run, T.kneel - 0.2, t);
    const px = lerp(this.start.x, this.spot.x, run), pz = lerp(this.start.z, this.spot.z, run);
    pilot.px = pilot.x;
    pilot.pz = pilot.z;
    pilot.x = px;
    pilot.z = pz;
    const running = t >= T.run && t < T.kneel - 0.2;
    pilot.moving = running;
    pilot.stance = t >= T.kneel ? "kneel" : "stand";
    pilot.heading = this.runAng;
    pilot.postMove(dt, g);

    // the drone: folded in its case, spread out, motor starts, lifts out of the case and climbs away
    // from him (forward, so it never rises close to his head)
    drone.view.setEnabled(t >= T.drone);
    const unfold = ease(T.unfold, T.unfold + 1.6, t);
    this.setFold(unfold);
    this.once("unfold", T.unfold, () => this.audio.droneUnfold());
    this.spinK = ease(T.spin, T.spin + 1.0, t);
    const up = ease(T.lift, T.lift + 3.4, t);
    const out = PILOT_CASE_Z + 2.6 * ease(T.lift + 0.9, T.lift + 3.6, t);
    let x = this.spot.x + this.f.x * out, z = this.spot.z + this.f.z * out, alt = lerp(0.12, 4.8, up);
    if (t >= T.fly) {
      const fl = ease(T.fly, T.end - 0.3, t);
      x = lerp(x, this.droneEnd.x, fl);
      z = lerp(z, this.droneEnd.z, fl);
      alt = lerp(4.8, COMMANDOS.drones.altitude, ease(T.fly, T.end - 1, t));
    }
    drone.px = drone.x;
    drone.pz = drone.z;
    drone.x = x;
    drone.z = z;
    drone.altitude = alt;
    drone.heading = this.runAng;
    drone.postMove(dt * this.spinK, g);
    // (the rotors stand still until the motor starts)
    if (this.spinK < 0.02) for (const r of this.rotors) r.m.rotation.y = 0;
    const buzz = this.spinK * (0.55 + 0.45 * ease(T.lift, T.lift + 3, t));
    if (buzz > 0 || this.buzzOn) {
      this.audio.droneBuzz(buzz);
      this.buzzOn = buzz > 0;
    }

    this.once("dip2", T.dip2, () => this.dip());
  }

  // ------------------------------------------------------------------ camera

  private cameraFor(dt: number) {
    const t = this.t, post = this.post;
    const py = this.ground(post.x, post.z);
    const phase = t < T.dip1 + 0.38 ? 1 : t < T.kneel ? 2 : t < T.dip2 + 0.38 ? 3 : 4;
    // (the cuts happen behind the black of the dips)
    const cut = phase !== this.phase;
    this.phase = phase;
    if (cut) this.camInit = false;
    let pos = new Vector3(), look = new Vector3(), fov = 0.8, k = 4;
    const pilotP = this.pilot ? new Vector3(this.pilot.x, this.pilot.y + 1.1, this.pilot.z) : new Vector3(this.spot.x, this.ground(this.spot.x, this.spot.z) + 1.1, this.spot.z);
    const dronePos = this.drone ? new Vector3(this.drone.x, this.drone.y + this.drone.altitude, this.drone.z) : pilotP;
    if (phase === 1) {
      // the blast: from a distance, slowly closing in
      const ang = Math.atan2(-post.x, -post.z) + 0.6 + t * 0.03;
      const dist = Math.max(24, post.radius * 2.6) * lerp(1, 0.8, t / T.dip1);
      pos.set(post.x + Math.sin(ang) * dist, py + 8.5, post.z + Math.cos(ang) * dist);
      look.set(post.x, py + 2.5, post.z);
      fov = 0.85;
      k = 8;
    } else if (phase === 2) {
      // the pilot runs out: from the side, a little way off
      if (!this.fired.has("cam2")) {
        this.fired.add("cam2");
        this.cam2 = this.findSpot((this.start.x + this.spot.x) / 2, (this.start.z + this.spot.z) / 2, this.runAng + Math.PI / 2, 10, 1.7);
      }
      pos.copyFrom(this.cam2);
      look.copyFrom(pilotP).addInPlace(new Vector3(0, 0.1, 0));
      fov = 0.8;
      k = 5;
    } else if (phase === 3) {
      if (t < T.hover - 0.4) {
        // kneeling, drone spreads out and rises: close, low, from the side
        if (!this.fired.has("cam3")) {
          this.fired.add("cam3");
          this.cam3 = this.findSpot(this.spot.x, this.spot.z, this.runAng + 2.2, 7, 1.15);
        }
        pos.copyFrom(this.cam3);
        look.copyFrom(Vector3.Lerp(pilotP, dronePos, 0.6));
        look.y = Math.max(look.y, pilotP.y - 0.3);
        fov = 0.75;
        k = 4;
      } else {
        // as the drone sees it: from its height down onto the pilot
        pos.copyFrom(dronePos).addInPlace(new Vector3(this.f.x * 4.5, 1.2, this.f.z * 4.5));
        look.copyFrom(pilotP);
        fov = 0.7;
        k = 10;
      }
    } else {
      // the drone comes at the camera, which lies on the ground
      pos.copyFrom(this.camSpot);
      look.copyFrom(dronePos);
      fov = lerp(0.85, 0.7, ease(T.fly, T.end, t));
      k = 7;
    }
    if (this.shake > 0) {
      const s = this.shake * 0.6;
      pos.addInPlace(new Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    pos.y = Math.max(pos.y, this.ground(pos.x, pos.z) + 0.6);
    const w = this.camInit ? 1 - Math.exp(-k * dt) : 1;
    this.camInit = true;
    Vector3.LerpToRef(this.camPos, pos, w, this.camPos);
    Vector3.LerpToRef(this.camLook, look, w, this.camLook);
    this.camFov += (fov - this.camFov) * w;
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(this.camLook);
    this.camera.fov = this.camFov;
    this.focus.set(this.camLook.x, this.ground(this.camLook.x, this.camLook.z), this.camLook.z);
  }

  private cam2 = new Vector3();
  private cam3 = new Vector3();

  // ------------------------------------------------------------------ the violet light

  private light2(dt: number) {
    const t = this.t;
    if (t < T.fly || !this.drone) return;
    const prox = ease(T.fly + 0.4, T.end - 1.0, t);
    const eng = this.scene.getEngine();
    const w = eng.getRenderWidth(), h = eng.getRenderHeight();
    const d = this.drone;
    const p = Vector3.Project(new Vector3(d.x, d.y + d.altitude, d.z), Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), this.camera.viewport.toGlobal(w, h));
    const fl = this.flareEl;
    if (p.z > 0 && p.z < 1) {
      fl.style.left = `${(p.x / w) * 100}%`;
      fl.style.top = `${(p.y / h) * 100}%`;
      const size = lerp(40, 2600, prox * prox * prox);
      fl.style.width = fl.style.height = `${size}px`;
      fl.style.opacity = `${Math.min(1, prox * 1.6)}`;
    } else {
      fl.style.opacity = "0";
    }
    this.tintEl.style.opacity = `${ease(T.fly + 1.4, T.end - 0.8, t) * 0.85}`;
    this.floodEl.style.opacity = `${ease(T.end - 1.2, T.end - 0.2, t)}`;
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    if (!this.active || this.finished) return;
    this.t += dt;
    this.act(dt);
    // the world stands still, but whoever the blast caught falls: their death plays out on screen
    if (this.blasted) for (const u of this.game.units) if (!u.alive && !u.removed) u.update(dt, this.game);
    this.cameraFor(dt);
    this.light2(dt);
    if (this.t >= T.end && !this.skipping) this.finish();
  }

  skip() {
    if (!this.active || this.finished || this.skipping) return;
    this.skipping = true;
    this.fadeEl.style.transition = "opacity 0.4s ease";
    this.fadeEl.style.opacity = "1";
    window.setTimeout(() => this.finish(), 450);
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    const g = this.game;
    // whatever the scene did not get to: the blast, the cast in place
    this.blast();
    this.spawnCast();
    const pilot = this.pilot!, drone = this.drone!;
    pilot.px = pilot.x = this.spot.x;
    pilot.pz = pilot.z = this.spot.z;
    pilot.moving = false;
    pilot.stance = "kneel";
    pilot.heading = this.runAng;
    pilot.postMove(0.016, g);
    this.setFold(1);
    drone.view.setEnabled(true);
    drone.x = this.t >= T.end ? this.droneEnd.x : this.spot.x + this.f.x * (PILOT_CASE_Z + 2.6);
    drone.z = this.t >= T.end ? this.droneEnd.z : this.spot.z + this.f.z * (PILOT_CASE_Z + 2.6);
    drone.altitude = COMMANDOS.drones.altitude;
    drone.postMove(0.016, g);
    this.audio.droneBuzz(0);
    this.light?.dispose();
    this.light = null;
    this.camera.fov = this.baseFov;
    // the mission's first drone is this one
    this.mission.escalate({ pilot, drone });
    // violet at the end, back into the game
    this.floodEl.style.transition = "none";
    this.floodEl.style.opacity = this.t >= T.end ? "1" : "0";
    this.fadeEl.style.opacity = "0";
    void this.floodEl.offsetWidth;
    this.onDone();
    this.floodEl.style.transition = "opacity 1.4s ease";
    this.tintEl.style.transition = "opacity 1.4s ease";
    this.flareEl.style.transition = "opacity 0.6s ease";
    this.floodEl.style.opacity = "0";
    this.tintEl.style.opacity = "0";
    this.flareEl.style.opacity = "0";
    window.setTimeout(() => {
      this.rootEl.hidden = true;
      this.floodEl.style.transition = this.tintEl.style.transition = this.flareEl.style.transition = "";
    }, FADE * 1000 + 700);
  }

  dispose() {
    this.active = false;
    this.finished = true;
    this.audio.droneBuzz(0);
    this.light?.dispose();
    this.rootEl.hidden = true;
  }
}
