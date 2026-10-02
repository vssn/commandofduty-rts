import { Mesh, StandardMaterial, Color3, TransformNode, VertexData, type InstancedMesh, type Scene } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import type { TreeInfo } from "./scenery";
import type { Terrain } from "./terrain";

/** One wing (pivot at the body, pointing along +x), dark and two-sided. */
function wingTemplate(scene: Scene): Mesh {
  const m = new Mesh("birdWing", scene);
  const vd = new VertexData();
  // a slim swept-back triangle plus a little body half
  vd.positions = [0, 0, 0.12, 0.42, 0.02, -0.08, 0, 0, -0.16, 0, 0, 0.12, 0, 0, -0.16, -0.06, -0.03, 0];
  vd.indices = [0, 1, 2, 3, 4, 5];
  const normals: number[] = [];
  VertexData.ComputeNormals(vd.positions, vd.indices, normals);
  vd.normals = normals;
  vd.applyToMesh(m);
  const mat = new StandardMaterial("birdMat", scene);
  mat.diffuseColor = new Color3(0.1, 0.09, 0.08);
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false;
  m.material = mat;
  m.isPickable = false;
  m.isVisible = false;
  return m;
}

/** A bird: body node with a left and a right wing that flap. */
class Bird {
  readonly node: TransformNode;
  private readonly left: InstancedMesh;
  private readonly right: InstancedMesh;
  readonly phase = Math.random() * 10;

  constructor(scene: Scene, wing: Mesh, size: number) {
    this.node = new TransformNode("bird", scene);
    this.node.scaling.setAll(size);
    this.left = wing.createInstance("wingL");
    this.right = wing.createInstance("wingR");
    this.right.parent = this.left.parent = this.node;
    this.left.scaling.x = -1;
    this.left.isPickable = this.right.isPickable = false;
  }

  /** `flap` -1..1: wings down .. up; `fold` 0..1 folds them against the body (perched). */
  pose(x: number, y: number, z: number, heading: number, bank: number, flap: number, fold = 0) {
    this.node.position.set(x, y, z);
    this.node.rotation.set(0, heading, bank);
    const a = flap * 0.75 * (1 - fold) - fold * 1.3;
    this.right.rotation.z = a;
    this.left.rotation.z = -a;
  }
}

interface Flock { birds: Bird[]; offsets: [number, number, number][]; cx: number; cz: number; radius: number; speed: number; angle: number; alt: number; drift: number }
interface Hopper { bird: Bird; from: TreeInfo; to: TreeInfo; t: number; dur: number; wait: number; peak: number }

/**
 * Birds: small flocks circling high over the map (wide loops that drift slowly across it, flapping
 * in bursts and gliding), and single birds hopping from tree to tree in short arcs, sitting a few
 * seconds on a crown before flying on.
 */
export class Birds {
  private readonly flocks: Flock[] = [];
  private readonly hoppers: Hopper[] = [];
  private time = 0;
  private enabled = true;

  constructor(scene: Scene, private readonly terrain: Terrain, trees: TreeInfo[]) {
    const wing = wingTemplate(scene);
    for (let f = 0; f < 4; f++) {
      const n = 7 + Math.floor(Math.random() * 7);
      const flock: Flock = {
        birds: [], offsets: [],
        cx: (Math.random() - 0.5) * MAP_HALF * 1.2, cz: (Math.random() - 0.5) * MAP_HALF * 1.2,
        radius: 30 + Math.random() * 40, speed: (Math.random() < 0.5 ? -1 : 1) * (0.14 + Math.random() * 0.08),
        angle: Math.random() * Math.PI * 2, alt: 30 + Math.random() * 14, drift: Math.random() * Math.PI * 2,
      };
      for (let i = 0; i < n; i++) {
        flock.birds.push(new Bird(scene, wing, 1.6 + Math.random() * 0.4));
        // loose V / cloud formation behind the leader
        flock.offsets.push([(Math.random() - 0.5) * 9, (Math.random() - 0.5) * 3, -Math.random() * 10]);
      }
      this.flocks.push(flock);
    }
    const inside = trees.filter((t) => Math.abs(t.x) < MAP_HALF - 4 && Math.abs(t.z) < MAP_HALF - 4);
    for (let i = 0; i < 12 && inside.length > 1; i++) {
      const from = inside[Math.floor(Math.random() * inside.length)];
      this.hoppers.push({ bird: new Bird(scene, wing, 1.2), from, to: from, t: 1, dur: 1, wait: Math.random() * 5, peak: 4 });
    }
    this.trees = inside;
  }

  private readonly trees: TreeInfo[];

  /** Hidden at night. */
  setEnabled(on: boolean) {
    this.enabled = on;
    for (const f of this.flocks) for (const b of f.birds) b.node.setEnabled(on);
    for (const h of this.hoppers) h.bird.node.setEnabled(on);
  }

  private crown(t: TreeInfo): number {
    return this.terrain.heightAt(t.x, t.z) + (t.conifer ? 7.6 : 6.3);
  }

  update(dt: number) {
    if (!this.enabled) return;
    this.time += dt;
    const T = this.time;
    for (const f of this.flocks) {
      // the loop's centre wanders slowly, staying over the map
      f.drift += dt * 0.03;
      f.cx = Math.max(-80, Math.min(80, f.cx + Math.cos(f.drift) * dt * 1.5));
      f.cz = Math.max(-80, Math.min(80, f.cz + Math.sin(f.drift * 0.7) * dt * 1.5));
      f.angle += f.speed * dt;
      const lx = f.cx + Math.cos(f.angle) * f.radius, lz = f.cz + Math.sin(f.angle) * f.radius;
      // heading along the circle (tangent), banked into the turn
      const tx = -Math.sin(f.angle) * Math.sign(f.speed), tz = Math.cos(f.angle) * Math.sign(f.speed);
      const heading = Math.atan2(tx, tz);
      const bank = -Math.sign(f.speed) * 0.25;
      f.birds.forEach((b, i) => {
        const [ox, oy, oz] = f.offsets[i];
        const sway = Math.sin(T * 0.7 + b.phase) * 0.8;
        const x = lx + Math.cos(heading) * (ox + sway) + Math.sin(heading) * oz;
        const z = lz - Math.sin(heading) * (ox + sway) + Math.cos(heading) * oz;
        // bursts of flapping, then gliding with wings slightly raised
        const flapping = Math.sin(T * 0.5 + b.phase) > -0.2;
        const flap = flapping ? Math.sin(T * 11 + b.phase * 3) : 0.25;
        b.pose(x, f.alt + oy + Math.sin(T * 0.9 + b.phase) * 0.6, z, heading, bank, flap);
      });
    }
    for (const h of this.hoppers) {
      if (h.t >= 1) {
        // perched on a crown, wings folded, now and then a little hop on the spot
        h.wait -= dt;
        const y = this.crown(h.to) + (h.wait % 2 < 0.15 ? 0.15 : 0);
        h.bird.pose(h.to.x, y, h.to.z, h.bird.node.rotation.y + (h.wait % 3 < dt ? 0.8 : 0), 0, 0, 1);
        if (h.wait > 0) continue;
        // pick another tree not too far away
        const near = this.trees.filter((t) => t !== h.to && Math.hypot(t.x - h.to.x, t.z - h.to.z) < 35 && Math.hypot(t.x - h.to.x, t.z - h.to.z) > 6);
        if (!near.length) { h.wait = 3; continue; }
        h.from = h.to;
        h.to = near[Math.floor(Math.random() * near.length)];
        const dist = Math.hypot(h.to.x - h.from.x, h.to.z - h.from.z);
        h.t = 0;
        h.dur = dist / (8 + Math.random() * 3);
        h.peak = 2 + dist * 0.12;
        h.wait = 2 + Math.random() * 7;
        continue;
      }
      h.t = Math.min(1, h.t + dt / h.dur);
      const k = h.t;
      const x = h.from.x + (h.to.x - h.from.x) * k, z = h.from.z + (h.to.z - h.from.z) * k;
      const y = this.crown(h.from) * (1 - k) + this.crown(h.to) * k + Math.sin(k * Math.PI) * h.peak;
      const heading = Math.atan2(h.to.x - h.from.x, h.to.z - h.from.z);
      h.bird.pose(x, y, z, heading, 0, Math.sin(T * 16 + h.bird.phase), 0);
    }
  }
}
