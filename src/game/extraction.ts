import {
  Color3, Color4, DynamicTexture, Mesh, MeshBuilder, ParticleSystem, PointLight, StandardMaterial, TransformNode, Vector3,
  type FreeCamera, type Scene, type Texture,
} from "@babylonjs/core";
import type { AudioSystem } from "../audio/audio";
import { MAP_HALF } from "../config";
import { smoothstep } from "../util/noise";
import { createGlowSpot } from "../world/lighting";
import type { Terrain } from "../world/terrain";
import type { Game } from "./game";
import type { Unit } from "./unit";

/**
 * The commandos mission's last objective: once the last outpost is down, a blue smoke flare marks an
 * extraction point somewhere remote. When the agent reaches it, a transport helicopter comes in
 * over him and sets down, he backs up its loading ramp with his rifle on the distance, the ramp
 * closes, and the helicopter lifts off and flies away while the camera circles it.
 */

/** The agent is picked up once he is this close to the flare. */
export const EXTRACT_RADIUS = 7;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (a: number, b: number, t: number) => smoothstep(a, b, t);

/** Soft round puff (white, alpha falling off), for smoke and dust. */
function puffTexture(scene: Scene): Texture {
  const size = 64;
  const tex = new DynamicTexture("softPuff", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.45, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

/**
 * A remote spot for the extraction: inside the map but away from its edge, far from every outpost
 * (still standing or not), from the villages and from where the agent is now, on open ground where
 * a helicopter can set down (no trees or buildings close by). The most remote of a number of tries.
 */
export function pickExtractionPoint(game: Game, from: { x: number; z: number }): { x: number; z: number } {
  const L = game.layout, nav = game.nav;
  const lim = MAP_HALF - 22;
  let best: { x: number; z: number } | null = null, bestScore = -Infinity;
  for (let i = 0; i < 1200; i++) {
    const x = (Math.random() * 2 - 1) * lim, z = (Math.random() * 2 - 1) * lim;
    if (L.suburbs.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + 10)) continue;
    if (L.forests.some((f) => Math.hypot(x - f.x, z - f.z) < f.r + 8)) continue;
    if (L.nearestRoad(x, z).d < 3) continue;
    if (!nav.areaFree(x, z, 6, 6, 0, 0)) continue;
    const post = Math.min(...game.outposts.map((o) => Math.hypot(x - o.x, z - o.z)));
    const agent = Math.hypot(x - from.x, z - from.z);
    if (post < 30 || agent < 55) continue;
    const score = post + agent * 0.3 + Math.random() * 10;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }
  // (fallback: the far corner from the agent)
  return best ?? nav.freePoint(-Math.sign(from.x || 1) * lim, -Math.sign(from.z || 1) * lim);
}

/** The blue smoke flare that marks the extraction point: a burning stick, its glow, a rising blue column. */
export class ExtractionFlare {
  private readonly meshes: Mesh[] = [];
  private readonly smoke: ParticleSystem;
  private readonly sparks: ParticleSystem;

  constructor(scene: Scene, terrain: Terrain, readonly x: number, readonly z: number) {
    const y = terrain.heightAt(x, z);
    const stick = MeshBuilder.CreateCylinder("flareStick", { height: 0.45, diameter: 0.1, tessellation: 8 }, scene);
    stick.position.set(x, y + 0.12, z);
    stick.rotation.z = 1.2; // lying on the ground, propped up a little
    const sm = new StandardMaterial("flareStickMat", scene);
    sm.diffuseColor = new Color3(0.6, 0.12, 0.08);
    stick.material = sm;
    const tip = MeshBuilder.CreateSphere("flareTip", { diameter: 0.16, segments: 6 }, scene);
    tip.position.set(x - 0.2, y + 0.2, z);
    const tm = new StandardMaterial("flareTipMat", scene);
    tm.emissiveColor = new Color3(0.6, 0.85, 1);
    tm.disableLighting = true;
    tip.material = tm;
    const glow = createGlowSpot(scene, terrain, x, z, 7, [0.25, 0.5, 1], 0.55);
    this.meshes.push(stick, tip, glow);
    for (const m of this.meshes) m.isPickable = false;
    const tex = puffTexture(scene);

    // the column of blue smoke, rising and drifting off with the wind
    const ps = new ParticleSystem("flareSmoke", 320, scene);
    ps.particleTexture = tex;
    ps.emitter = new Vector3(x - 0.2, y + 0.3, z);
    ps.createSphereEmitter(0.25, 1);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 28;
    ps.minEmitPower = 0.6;
    ps.maxEmitPower = 1.4;
    ps.minLifeTime = 6;
    ps.maxLifeTime = 9;
    ps.updateSpeed = 1 / 60;
    ps.gravity = new Vector3(0.55, 0.9, 0.25);
    ps.addSizeGradient(0, 0.8, 1.2);
    ps.addSizeGradient(0.4, 3, 4);
    ps.addSizeGradient(1, 7, 9);
    ps.addColorGradient(0, new Color4(0.45, 0.65, 1, 0.0));
    ps.addColorGradient(0.05, new Color4(0.35, 0.55, 1, 0.75));
    ps.addColorGradient(0.5, new Color4(0.28, 0.42, 0.8, 0.4));
    ps.addColorGradient(1, new Color4(0.2, 0.28, 0.5, 0));
    ps.addDragGradient(0, 0.2);
    ps.addDragGradient(1, 0.6);
    ps.minAngularSpeed = -0.4;
    ps.maxAngularSpeed = 0.4;
    ps.preWarmCycles = 300; // already burning when it appears
    ps.preWarmStepOffset = 4;
    ps.start();
    this.smoke = ps;

    // sparks spitting from the burning end
    const sp = new ParticleSystem("flareSparks", 60, scene);
    sp.particleTexture = tex;
    sp.emitter = new Vector3(x - 0.2, y + 0.22, z);
    sp.createHemisphericEmitter(0.05, 0);
    sp.blendMode = ParticleSystem.BLENDMODE_ADD;
    sp.emitRate = 30;
    sp.minEmitPower = 1;
    sp.maxEmitPower = 2.5;
    sp.minLifeTime = 0.2;
    sp.maxLifeTime = 0.5;
    sp.minSize = 0.06;
    sp.maxSize = 0.14;
    sp.updateSpeed = 1 / 60;
    sp.gravity = new Vector3(0, -6, 0);
    sp.color1 = new Color4(0.7, 0.85, 1, 1);
    sp.color2 = new Color4(1, 0.8, 0.5, 1);
    sp.colorDead = new Color4(0.2, 0.3, 0.8, 0);
    sp.start();
    this.sparks = sp;
  }

  dispose() {
    this.smoke.dispose(true);
    this.sparks.dispose(false);
    for (const m of this.meshes) m.dispose();
  }
}

// ------------------------------------------------------------------ helicopter

/** Cabin floor height and the ramp's hinge (local, the helicopter faces +z). */
const FLOOR = 1.25;
/** Height (over the landing place) of the approach and of the climb before flying away. */
const CRUISE = 60;
const TAIL = -10;
const RAMP = 4.6;

/**
 * Tandem-rotor transport helicopter (local frame: nose +z, origin on the ground under its middle):
 * a long boxy fuselage with a rounded nose and cockpit windows, side sponsons, wheels, the two
 * rotor towers with three-bladed rotors (turning against each other, with a blur disc when they
 * run), navigation lights, a dark cabin and the loading ramp at the tail.
 */
class Helicopter {
  readonly root: TransformNode;
  private readonly rotors: TransformNode[] = [];
  private readonly blurs: Mesh[] = [];
  private readonly rampPivot: TransformNode;
  private readonly beacon: Mesh;
  private spin = 0;
  readonly meshes: Mesh[] = [];

  constructor(scene: Scene) {
    this.root = new TransformNode("heli", scene);
    const olive = new StandardMaterial("heliSkin", scene);
    olive.diffuseColor = new Color3(0.2, 0.23, 0.17);
    olive.specularColor = new Color3(0.08, 0.08, 0.08);
    olive.metadata = { rough: 0.6, metal: 0.15 };
    const dark = new StandardMaterial("heliInside", scene);
    dark.diffuseColor = new Color3(0.05, 0.05, 0.05);
    dark.specularColor = Color3.Black();
    dark.backFaceCulling = false;
    const glass = new StandardMaterial("heliGlass", scene);
    glass.diffuseColor = new Color3(0.04, 0.06, 0.08);
    glass.specularColor = new Color3(0.5, 0.55, 0.6);
    glass.specularPower = 64;
    const metal = new StandardMaterial("heliMetal", scene);
    metal.diffuseColor = new Color3(0.1, 0.1, 0.1);
    metal.specularColor = new Color3(0.2, 0.2, 0.2);
    const glowMat = (c: [number, number, number]) => {
      const m = new StandardMaterial("heliLight", scene);
      m.emissiveColor = new Color3(...c);
      m.disableLighting = true;
      return m;
    };
    const add = (m: Mesh, mat: StandardMaterial, parent: TransformNode = this.root) => {
      m.material = mat;
      m.parent = parent;
      m.isPickable = false;
      this.meshes.push(m);
      return m;
    };
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat = olive, parent?: TransformNode) => {
      const m = MeshBuilder.CreateBox("heliPart", { width: w, height: h, depth: d }, scene);
      m.position.set(x, y, z);
      return add(m, mat, parent);
    };
    const W = 4.6, zc = -1.5, len = 17;
    // fuselage: floor, belly, sides, roof with a rounded top; dark inside, open at the tail
    box(W, 0.3, len, 0, FLOOR - 0.15, zc);
    box(W - 0.6, 0.6, len, 0, FLOOR - 0.6, zc);
    for (const x of [-1, 1]) {
      box(0.2, 3.9, len, x * (W / 2 - 0.1), FLOOR + 1.95, zc);
      box(0.02, 3.7, len - 0.4, x * (W / 2 - 0.22), FLOOR + 1.9, zc, dark); // inner wall
      // round windows along the cabin
      for (let i = 0; i < 4; i++) box(0.04, 0.5, 0.5, x * (W / 2 + 0.01), FLOOR + 2.6, 4 - i * 3.2, glass);
    }
    box(W, 0.3, len, 0, FLOOR + 3.9, zc);
    const top = MeshBuilder.CreateCylinder("heliTop", { height: len, diameter: W, tessellation: 18 }, scene);
    top.rotation.x = Math.PI / 2;
    top.scaling.set(1, 1, 0.32);
    top.position.set(0, FLOOR + 3.9, zc);
    add(top, olive);
    box(W - 0.5, 0.02, len - 0.4, 0, FLOOR + 0.02, zc, dark); // cabin floor
    box(W - 0.5, 0.02, len - 0.4, 0, FLOOR + 3.72, zc, dark); // ceiling
    box(W - 0.5, 3.7, 0.1, 0, FLOOR + 1.9, zc + len / 2 - 0.2, dark); // cockpit bulkhead
    // nose and cockpit
    const nose = MeshBuilder.CreateSphere("heliNose", { diameter: 1, segments: 12 }, scene);
    nose.scaling.set(W, 3.6, 4.6);
    nose.position.set(0, FLOOR + 1.9, 7.2);
    add(nose, olive);
    for (const x of [-0.8, 0.8]) {
      const win = box(1.3, 0.9, 0.08, x, FLOOR + 2.9, 9.15, glass);
      win.rotation.x = -0.55;
      win.rotation.y = x * 0.35;
    }
    for (const x of [-1, 1]) box(0.06, 0.8, 1.4, x * 2.05, FLOOR + 2.6, 8.0, glass);
    // sponsons and wheels
    for (const x of [-1, 1]) {
      box(1.0, 1.4, 11, x * 2.75, FLOOR - 0.1, -1.2);
      for (const z of [5.6, -6.2]) {
        const w = MeshBuilder.CreateCylinder("heliWheel", { height: 0.4, diameter: 0.9, tessellation: 12 }, scene);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * 2.4, 0.45, z);
        add(w, metal);
        box(0.15, 0.6, 0.15, x * 2.4, 0.85, z, metal);
      }
    }
    // rotor towers: the tall rear pylon and the low front one
    box(2.6, 2.6, 5, 0, FLOOR + 4.9, -7.8);
    box(1.8, 1.0, 3, 0, FLOOR + 4.3, 7.0);
    const hubs: [number, number, number][] = [[7.2, FLOOR + 5.3, 1], [-8.4, FLOOR + 6.7, -1]];
    for (const [z, y, dirn] of hubs) {
      const shaft = MeshBuilder.CreateCylinder("heliShaft", { height: 0.7, diameter: 0.4, tessellation: 8 }, scene);
      shaft.position.set(0, y - 0.3, z);
      add(shaft, metal);
      const hub = new TransformNode("heliRotor", scene);
      hub.parent = this.root;
      hub.position.set(0, y, z);
      hub.metadata = { dirn };
      for (let k = 0; k < 3; k++) {
        const blade = MeshBuilder.CreateBox("heliBlade", { width: 0.55, height: 0.08, depth: 11 }, scene);
        blade.position.set(Math.sin((k * Math.PI * 2) / 3) * 5.6, 0, Math.cos((k * Math.PI * 2) / 3) * 5.6);
        blade.rotation.y = (k * Math.PI * 2) / 3;
        add(blade, metal, hub);
      }
      this.rotors.push(hub);
      // the blur of the turning blades
      const disc = MeshBuilder.CreateDisc("heliBlur", { radius: 11.1, tessellation: 36 }, scene);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(0, y + 0.02, z);
      const dm = new StandardMaterial("heliBlurMat", scene);
      dm.diffuseColor = new Color3(0.08, 0.08, 0.08);
      dm.specularColor = Color3.Black();
      dm.alpha = 0;
      dm.backFaceCulling = false;
      dm.disableDepthWrite = true;
      add(disc, dm);
      this.blurs.push(disc);
    }
    // loading ramp, hinged at the cabin floor at the tail
    this.rampPivot = new TransformNode("heliRampPivot", scene);
    this.rampPivot.parent = this.root;
    this.rampPivot.position.set(0, FLOOR, TAIL + 1.5);
    box(W - 0.4, 0.25, RAMP, 0, 0, -RAMP / 2, olive, this.rampPivot);
    box(W - 0.8, 0.02, RAMP - 0.2, 0, 0.14, -RAMP / 2, dark, this.rampPivot); // its inner side
    // lights: red left, green right, white tail, a red beacon on top
    const red = glowMat([1, 0.15, 0.1]), green = glowMat([0.2, 1, 0.3]), white = glowMat([1, 1, 0.95]);
    const lamp = (x: number, y: number, z: number, m: StandardMaterial) => {
      const s = MeshBuilder.CreateSphere("heliLamp", { diameter: 0.22, segments: 6 }, scene);
      s.position.set(x, y, z);
      return add(s, m);
    };
    lamp(-3.3, FLOOR, 4, red);
    lamp(3.3, FLOOR, 4, green);
    lamp(0, FLOOR + 6.3, -10.3, white);
    this.beacon = lamp(0, FLOOR + 4.6, 1, red);
    for (const m of this.meshes) m.alwaysSelectAsActiveMesh = true;
    this.setRamp(0);
  }

  /** 0 = closed (ramp up), 1 = open (ramp down on the ground). */
  setRamp(k: number) {
    const open = -Math.asin(FLOOR / RAMP);
    this.rampPivot.rotation.x = lerp(Math.PI / 2, open, k);
  }

  /** Rotors turning (speed 0..1), the beacon flashing. */
  update(dt: number, speed: number, time: number) {
    this.spin += dt * 17 * speed;
    for (const r of this.rotors) r.rotation.y = this.spin * (r.metadata as { dirn: number }).dirn;
    for (const b of this.blurs) (b.material as StandardMaterial).alpha = 0.22 * speed;
    this.beacon.scaling.setAll(time % 1.2 < 0.12 ? 1.6 : 0.4);
  }

  /** World position of a point given in the helicopter's frame. */
  toWorld(x: number, y: number, z: number): Vector3 {
    this.root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(new Vector3(x, y, z), this.root.getWorldMatrix());
  }

  dispose() {
    for (const m of this.meshes) m.material?.dispose();
    this.root.dispose();
  }
}

// ------------------------------------------------------------------ cutscene

export class ExtractionCutscene {
  readonly focus = new Vector3();
  active = true;

  private readonly scene: Scene;
  private readonly terrain: Terrain;
  private readonly agent: Unit;
  private readonly heli: Helicopter;
  private readonly dust: ParticleSystem;
  private readonly light: PointLight;
  private t = 0;
  private finished = false;
  private skipping = false;
  private readonly fired = new Set<string>();

  // layout: the helicopter sets down beyond the flare, its ramp towards the agent
  private readonly dir: Vector3;
  private readonly side: Vector3;
  private readonly center: Vector3;
  private readonly start: Vector3;
  /** From the landing place towards the middle of the map (the way in and out). */
  private readonly inward: Vector3;
  private readonly a0: Vector3;
  private readonly rampEnd: Vector3;
  private readonly rampTop: Vector3;
  private readonly inside: Vector3;
  private readonly T: { touch: number; open: number; walk: number; ramp: number; inside: number; close: number; lift: number; depart: number; end: number };

  // camera
  private readonly camPos = new Vector3();
  private readonly camLook = new Vector3();
  private camInit = false;
  private readonly baseFov: number;
  private camFov = 0.75;
  private readonly fadeEl = document.getElementById("cut-fade")!;
  private readonly rootEl = document.getElementById("cutscene")!;

  constructor(
    private readonly game: Game,
    private readonly audio: AudioSystem,
    private readonly camera: FreeCamera,
    flare: { x: number; z: number },
    private readonly onDone: () => void,
  ) {
    this.scene = game.scene;
    this.terrain = game.terrain;
    this.agent = game.commandos!.agent;
    this.baseFov = camera.fov;
    const a = this.agent;
    this.a0 = new Vector3(a.x, 0, a.z);
    let d = new Vector3(flare.x - a.x, 0, flare.z - a.z);
    if (d.length() < 0.5) d = new Vector3(Math.sin(a.heading), 0, Math.cos(a.heading));
    d.normalize();
    // the landing place: beyond the flare (its ramp comes down a few steps behind the agent), on a
    // free stretch - turned a little or shifted aside if trees are in the way
    const nav = game.nav;
    let c: Vector3 | null = null;
    search: for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
      const dd = new Vector3(Math.sin(Math.atan2(d.x, d.z) + turn), 0, Math.cos(Math.atan2(d.x, d.z) + turn));
      const sd = new Vector3(dd.z, 0, -dd.x);
      // (off to one side of the flare: the smoke burns beside the helicopter, not under it)
      for (const along of [9, 7, 11, 5]) {
        for (const lat of [10, -10, 12, -12, 8, -8]) {
          const p = new Vector3(flare.x, 0, flare.z).add(dd.scale(along)).add(sd.scale(lat));
          if (nav.areaFree(p.x, p.z, 3.2, 11, Math.atan2(dd.x, dd.z), 0)) {
            c = p;
            d = dd;
            break search;
          }
        }
      }
    }
    this.dir = d;
    this.side = new Vector3(this.dir.z, 0, -this.dir.x);
    c ??= new Vector3(flare.x, 0, flare.z).add(this.dir.scale(9)).add(this.side.scale(10));
    c.y = Math.max(...[[2.4, 5.6], [-2.4, 5.6], [2.4, -6.2], [-2.4, -6.2]].map(([x, z]) =>
      this.terrain.heightAt(c.x + this.side.x * x + this.dir.x * z, c.z + this.side.z * x + this.dir.z * z)));
    this.center = c;
    // in from over the map (never over the mountains at its edge), high, then straight down
    const inward = new Vector3(-c.x, 0, -c.z);
    this.inward = inward.length() > 20 ? inward.normalize() : this.dir.scale(-1);
    this.start = c.add(this.inward.scale(120)).add(new Vector3(0, CRUISE, 0));

    this.heli = new Helicopter(this.scene);
    this.heli.root.rotation.y = Math.atan2(this.dir.x, this.dir.z);
    this.placeHeli(0);
    // the path up the ramp, in world space (with the helicopter at its landing place)
    const at = (lz: number, ly: number) => {
      const p = c.add(this.dir.scale(lz));
      p.y = c.y + ly;
      return p;
    };
    const tail = TAIL + 1.5;
    this.rampEnd = at(tail - Math.cos(Math.asin(FLOOR / RAMP)) * RAMP, 0);
    this.rampEnd.y = this.terrain.heightAt(this.rampEnd.x, this.rampEnd.z);
    this.rampTop = at(tail, FLOOR);
    this.inside = at(tail + 4.5, FLOOR);
    // timing: the walk takes as long as the way to the ramp is long
    const walk = Math.hypot(this.rampEnd.x - a.x, this.rampEnd.z - a.z) / 1.7;
    const T = { touch: 8.0, open: 0, walk: 9.0, ramp: 0, inside: 0, close: 0, lift: 0, depart: 0, end: 0 };
    T.ramp = T.walk + walk;
    T.inside = T.ramp + 2.6;
    T.close = T.inside;
    T.lift = T.inside + 1.0;
    T.depart = T.lift + 4.5;
    T.end = T.depart + 7;
    this.T = T;

    // the landing light and the dust its rotors whip up
    this.light = new PointLight("heliLight", new Vector3(), this.scene);
    this.light.diffuse = new Color3(0.9, 0.92, 1);
    this.light.specular = new Color3(0.2, 0.2, 0.2);
    this.light.intensity = 0;
    this.light.range = 40;
    const dust = new ParticleSystem("rotorWash", 500, this.scene);
    dust.particleTexture = puffTexture(this.scene);
    dust.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    dust.emitter = new Vector3(c.x, c.y + 0.3, c.z);
    dust.startPositionFunction = (_m, pos) => {
      const ang = Math.random() * Math.PI * 2, r = 2 + Math.random() * 9;
      pos.set(c.x + Math.cos(ang) * r, this.terrain.heightAt(c.x + Math.cos(ang) * r, c.z + Math.sin(ang) * r) + 0.3, c.z + Math.sin(ang) * r);
    };
    dust.startDirectionFunction = (_m, dir, p) => {
      const dx = p.position.x - c.x, dz = p.position.z - c.z, l = Math.hypot(dx, dz) || 1;
      dir.set(dx / l, 0.15 + Math.random() * 0.25, dz / l);
    };
    dust.minEmitPower = 5;
    dust.maxEmitPower = 10;
    dust.minLifeTime = 1.2;
    dust.maxLifeTime = 2.4;
    dust.updateSpeed = 1 / 60;
    dust.addSizeGradient(0, 1, 1.6);
    dust.addSizeGradient(1, 3.5, 5);
    dust.addColorGradient(0, new Color4(0.3, 0.27, 0.22, 0.5));
    dust.addColorGradient(1, new Color4(0.3, 0.27, 0.22, 0));
    dust.addDragGradient(0, 0.2);
    dust.addDragGradient(1, 0.8);
    dust.emitRate = 0;
    dust.start();
    this.dust = dust;

    a.ring.isVisible = false;
    this.rootEl.hidden = false;
    this.fadeEl.style.transition = "none";
    this.fadeEl.style.opacity = "1";
    void this.fadeEl.offsetWidth;
    this.fadeEl.style.transition = "opacity 0.9s ease";
    this.fadeEl.style.opacity = "0";
    document.getElementById("cut-skip")!.onclick = () => this.skip();
    this.update(0);
  }

  private once(key: string, at: number, fn: () => void) {
    if (this.t >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn();
    }
  }

  /** Helicopter position and attitude at time t: approach and flare, on the ground, lift-off and departure. */
  private placeHeli(t: number) {
    const T = this.T ?? { touch: 8, lift: 1e9, depart: 1e9 };
    const r = this.heli.root;
    const c = this.center;
    const landYaw = Math.atan2(this.dir.x, this.dir.z);
    const inYaw = Math.atan2(-this.inward.x, -this.inward.z); // flying in: towards the landing place
    const outYaw = Math.atan2(this.inward.x, this.inward.z); // flying out: back over the map
    const turnTo = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
    let pitch = 0, roll = 0, yaw = landYaw;
    const hold = T.touch * 0.45; // end of the level approach, start of the vertical descent
    if (t < hold) {
      // level at cruise height, slowing down to a hover over the landing place
      const k = t / hold;
      r.position.copyFrom(Vector3.Lerp(this.start, c.add(new Vector3(0, CRUISE, 0)), 1 - Math.pow(1 - k, 2)));
      yaw = inYaw;
      pitch = 0.12 * (1 - k) - 0.15 * Math.sin(Math.PI * Math.max(0, (k - 0.6) / 0.4));
    } else if (t < T.touch) {
      // straight down, turning into the landing direction on the way
      const k = (t - hold) / (T.touch - hold);
      r.position.copyFrom(c);
      r.position.y = c.y + CRUISE * (1 - ease(0, 1, k));
      yaw = turnTo(inYaw, landYaw, ease(0, 0.7, k));
      roll = Math.sin(t * 0.9) * 0.02;
    } else if (t < T.lift) {
      r.position.copyFrom(c);
    } else {
      // straight up, turning back towards the map, then away over it, climbing
      const up = ease(T.lift, T.depart, t) * CRUISE;
      yaw = turnTo(landYaw, outYaw, ease(T.lift + 1, T.depart, t));
      const go = Math.max(0, t - T.depart);
      const dist = 2.4 * go * go;
      r.position.copyFrom(c.add(this.inward.scale(dist)));
      r.position.y = c.y + up + dist * 0.15;
      pitch = 0.2 * ease(T.depart, T.depart + 1.5, t);
      roll = Math.sin(t * 0.5) * 0.02;
    }
    r.rotation.set(pitch, yaw, roll);
  }

  /** The agent: waiting with his rifle up, backing to the ramp, up into the cabin. */
  private moveAgent(t: number, dt: number) {
    const a = this.agent, T = this.T;
    const px = a.x, pz = a.z;
    let y = this.terrain.heightAt(a.x, a.z);
    if (t >= T.walk && t < T.ramp) {
      const k = (t - T.walk) / (T.ramp - T.walk);
      a.x = lerp(this.a0.x, this.rampEnd.x, k);
      a.z = lerp(this.a0.z, this.rampEnd.z, k);
      y = this.terrain.heightAt(a.x, a.z);
    } else if (t >= T.ramp) {
      const k = Math.min(1, (t - T.ramp) / (T.inside - T.ramp));
      const up = Math.min(1, k / 0.55), inn = Math.max(0, (k - 0.55) / 0.45);
      const p = inn > 0 ? Vector3.Lerp(this.rampTop, this.inside, inn) : Vector3.Lerp(this.rampEnd, this.rampTop, up);
      a.x = p.x;
      a.z = p.z;
      y = p.y;
    }
    const moved = Math.hypot(a.x - px, a.z - pz);
    a.moving = moved > 1e-4;
    a.stance = "stand";
    // facing away from the helicopter, the rifle on the distance
    a.heading = Math.atan2(-this.dir.x, -this.dir.z);
    a.target = { alive: true } as unknown as Unit;
    a.px = px;
    a.pz = pz;
    a.y = y;
    // backing up: the steps run backwards (negative distance)
    a.view.sync(a, dt, -moved, this.terrain);
    // covering the retreat: the upper body and the rifle sweep slowly across the ground he leaves behind
    const sweep = ease(T.walk - 1, T.walk, t) * (1 - ease(T.inside - 1.2, T.inside - 0.4, t));
    const parts = (a.view as unknown as { parts?: { torso: { rotation: Vector3 } } }).parts;
    if (parts) parts.torso.rotation.y = Math.sin((t - T.walk) * 0.9) * 0.55 * sweep;
    // gone into the dark of the cabin
    a.view.setEnabled(t < T.inside - 0.3);
  }

  private cameraFor(t: number, dt: number) {
    const T = this.T, c = this.center, h = this.heli.root.position, up = new Vector3(0, 1, 0);
    let pos: Vector3, look: Vector3, fov: number, k = 3;
    let rigid = false;
    if (t < T.touch + 0.3) {
      // low beside the agent, looking up at the helicopter coming in and setting down
      pos = this.a0.add(this.side.scale(7)).subtract(this.dir.scale(4));
      pos.y = this.terrain.heightAt(pos.x, pos.z) + 1.5;
      look = h.add(up.scale(2));
      fov = 0.8;
      k = 6;
    } else if (t < T.lift) {
      // the enemy's view: low over the ground in front of him, gliding slowly, while he backs away
      // to the ramp with his rifle on us
      const k2 = ease(T.touch + 0.3, T.lift, t);
      const front = this.dir.scale(-1);
      pos = this.a0.add(front.scale(lerp(10, 8, k2))).add(this.side.scale(lerp(-3.5, 3.5, k2)));
      pos.y = this.terrain.heightAt(pos.x, pos.z) + 0.45;
      const a = this.agent;
      look = new Vector3(a.x, a.y + 1.3, a.z);
      fov = 0.7;
      k = 2.2;
    } else {
      // a camera fixed to the helicopter's side near the tail, looking forward along it: the
      // fuselage, the front rotor and the land below falling away as it climbs and flies off
      pos = this.heli.toWorld(4.4, FLOOR + 3.6, -7.5);
      look = this.heli.toWorld(0.8, FLOOR - 7, 24);
      fov = 1.05;
      rigid = true;
    }
    if (!rigid) pos.y = Math.max(pos.y, this.terrain.heightAt(pos.x, pos.z) + 0.4);
    const w = this.camInit && !rigid ? 1 - Math.exp(-k * dt) : 1;
    this.camInit = true;
    Vector3.LerpToRef(this.camPos, pos, w, this.camPos);
    Vector3.LerpToRef(this.camLook, look, w, this.camLook);
    this.camFov += (fov - this.camFov) * w;
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(this.camLook);
    this.camera.fov = this.camFov;
    this.focus.set(this.camLook.x, this.terrain.heightAt(this.camLook.x, this.camLook.z), this.camLook.z);
  }

  update(dt: number) {
    if (!this.active || this.finished) return;
    this.t += dt;
    const t = this.t, T = this.T;
    this.placeHeli(t);
    this.heli.setRamp(1); // the ramp stays down all the way
    this.heli.update(dt, 1, t);
    this.moveAgent(t, dt);
    // rotor wash: dust when close to the ground
    const alt = this.heli.root.position.y - this.center.y;
    this.dust.emitRate = alt < 14 ? 160 * (1 - alt / 14) : 0;
    // landing light under the nose while low
    this.light.position.copyFrom(this.heli.toWorld(0, -0.5, 4));
    this.light.intensity = 1.6 * (1 - ease(T.depart, T.depart + 3, t));
    // sound: loud when near, fading as it flies off
    const camD = Vector3.Distance(this.camera.position, this.heli.root.position);
    this.audio.heliRotor(Math.min(1, 30 / Math.max(10, camD)) * (t < 1 ? t : 1));
    this.cameraFor(t, dt);
    if (t >= T.end - 1.2 && !this.fired.has("fade")) {
      this.fired.add("fade");
      this.fadeEl.style.transition = "opacity 1.1s ease";
      this.fadeEl.style.opacity = "1";
    }
    if (t >= T.end && !this.skipping) this.finish();
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
    this.audio.heliRotor(0);
    this.camera.fov = this.baseFov;
    // the agent has left the battlefield
    const a = this.agent;
    a.target = null;
    a.moving = false;
    a.view.setEnabled(false);
    this.cleanup();
    this.onDone();
    this.fadeEl.style.transition = "opacity 0.9s ease";
    this.fadeEl.style.opacity = "0";
    window.setTimeout(() => (this.rootEl.hidden = true), 1000);
  }

  private cleanup() {
    this.dust.dispose(true);
    this.light.dispose();
    this.heli.dispose();
  }

  dispose() {
    if (!this.finished) {
      this.finished = true;
      this.active = false;
      this.audio.heliRotor(0);
      this.cleanup();
    }
    this.rootEl.hidden = true;
  }
}
