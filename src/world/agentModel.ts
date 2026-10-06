import "@babylonjs/loaders/glTF/glTFFileLoader";
import "@babylonjs/loaders/glTF/2.0";
import {
  Color3, LoadAssetContainerAsync, Matrix, Mesh, MeshBuilder, PBRMaterial, Quaternion, StandardMaterial, TransformNode, Vector3,
  type AssetContainer, type Scene,
} from "@babylonjs/core";
import { HIP_Y } from "./models";

/**
 * The agent's figure: "SWAT" by Quaternius (CC0, see public/models/LICENSE.md), a rigged low-poly
 * model with its own animations. The legs, hips and spine move with the model's clips (idle, walk,
 * run, running backwards, death); the arms are set by hand (two-bone IK) onto a scoped rifle built
 * here, since the model's own gun clips hold a pistol in one hand. On top of the clips the view can
 * turn single bones (crouch, kneel, the drop cutscene's poses).
 */

let containerPromise: Promise<AssetContainer> | null = null;
let data: AgentData | null = null;

/** Starts loading the agent's figure (public/models/swat.glb); resolves once it can be instantiated. */
export function loadAgentModel(scene: Scene): Promise<void> {
  containerPromise ??= LoadAssetContainerAsync(`${import.meta.env.BASE_URL}models/swat.glb`, scene);
  return containerPromise.then((c) => {
    data ??= bake(c);
  });
}

/** True once the figure is loaded (otherwise the agent is built from primitives like the soldiers). */
export function agentModelReady(): boolean {
  return !!data;
}

/** Clip baked to fixed-rate samples per bone: rotations (x, y, z, w) and, for some bones, positions. */
interface Clip {
  duration: number;
  frames: number;
  rot: Float32Array[];
  pos: (Float32Array | null)[];
}
interface AgentData {
  container: AssetContainer;
  /** Names of the animated nodes (the bones' transform nodes), in hierarchy order. */
  bones: string[];
  /** Their rest positions (for clips that don't move a bone). */
  rest: Vector3[];
  clips: Map<string, Clip>;
  /** Linear base colours of the model's materials, by name. */
  colors: Map<string, Color3>;
}

const RATE = 30;

function bake(c: AssetContainer): AgentData {
  for (const g of c.animationGroups) g.stop();
  const armature = c.transformNodes.find((n) => n.name === "CharacterArmature")!;
  const bones = armature.getDescendants(false).filter((n) => n instanceof TransformNode && !(n instanceof Mesh)).map((n) => n.name);
  const index = new Map(bones.map((b, i) => [b, i]));
  const clips = new Map<string, Clip>();
  for (const g of c.animationGroups) {
    const name = g.name.split("|").pop()!;
    const fps = g.targetedAnimations[0]?.animation.framePerSecond ?? 60;
    const duration = (g.to - g.from) / fps;
    const frames = Math.max(2, Math.round(duration * RATE) + 1);
    const rot = bones.map((b) => {
      const n = c.transformNodes.find((t) => t.name === b)!;
      const q = n.rotationQuaternion ?? Quaternion.FromEulerVector(n.rotation);
      const a = new Float32Array(frames * 4);
      for (let f = 0; f < frames; f++) a.set([q.x, q.y, q.z, q.w], f * 4);
      return a;
    });
    const pos: (Float32Array | null)[] = bones.map(() => null);
    for (const ta of g.targetedAnimations) {
      const i = index.get((ta.target as TransformNode).name);
      if (i === undefined) continue;
      const keys = ta.animation.getKeys();
      const prop = ta.animation.targetProperty;
      if (prop !== "rotationQuaternion" && prop !== "position") continue;
      const out = prop === "rotationQuaternion" ? rot[i] : (pos[i] = new Float32Array(frames * 3));
      let k = 0;
      for (let f = 0; f < frames; f++) {
        const frame = g.from + Math.min(duration, f / RATE) * fps;
        while (k < keys.length - 2 && keys[k + 1].frame <= frame) k++;
        const a = keys[k], b = keys[Math.min(keys.length - 1, k + 1)];
        const s = b.frame > a.frame ? Math.min(1, Math.max(0, (frame - a.frame) / (b.frame - a.frame))) : 0;
        if (prop === "rotationQuaternion") {
          const q = Quaternion.Slerp(a.value as Quaternion, b.value as Quaternion, s);
          out.set([q.x, q.y, q.z, q.w], f * 4);
        } else {
          const v = Vector3.Lerp(a.value as Vector3, b.value as Vector3, s);
          out.set([v.x, v.y, v.z], f * 3);
        }
      }
    }
    clips.set(name, { duration, frames, rot, pos });
  }
  const colors = new Map<string, Color3>();
  for (const m of c.materials) if (m instanceof PBRMaterial) colors.set(m.name, m.albedoColor.clone());
  const rest = bones.map((b) => c.transformNodes.find((t) => t.name === b)!.position.clone());
  return { container: c, bones, rest, clips, colors };
}

/** Scale of the model: its hips at the height of the soldiers' hips. */
const SCALE = HIP_Y / 0.858;

/** Looks of the model's materials: colour as authored (linear) and the realistic mode's roughness / metal. */
const LOOKS: Record<string, { rough: number; metal?: number }> = {
  Swat: { rough: 0.88 }, // the suit: matt cloth
  Swat_Black: { rough: 0.6 }, // vest, belt, gloves, boots
  Skin: { rough: 0.55 },
  Visor: { rough: 0.12, metal: 0.4 }, // the helmet's glossy visor
};

/** A pose layer: a clip at a time (seconds), weighted. */
export interface ClipLayer { clip: string; t: number; w: number }

const tmpM = new Matrix(), tmpM2 = new Matrix(), tmpQ = new Quaternion(), tmpS = new Vector3(), tmpP = new Vector3();

/** One agent figure: the model's meshes and bones under `root` (feet at the origin, facing +z). */
export class AgentRig {
  readonly root: TransformNode;
  readonly meshes: Mesh[] = [];
  readonly materials: StandardMaterial[] = [];
  readonly rifle: Mesh;
  private readonly nodes: TransformNode[];
  /** The model's top node (under the root). */
  private readonly top: TransformNode;
  private readonly byName = new Map<string, TransformNode>();
  private readonly data: AgentData;
  /** Gun frame relative to the chest (shoulder centre, figure axes at rest), see gunFrame(). */
  private readonly gunOffset = new Matrix();
  /** Bone lengths of the arms (upper arm, forearm), in figure units. */
  readonly armLen: { upper: number; fore: number };
  /** Walk / run / backwards: distance covered per clip cycle, for feet that don't slide. */
  readonly stride = new Map<string, number>();
  /** Height of the feet's joints above the soles when standing. */
  readonly footRest: number;

  constructor(scene: Scene, name: string) {
    const d = data!;
    this.data = d;
    this.root = new TransformNode(name, scene);
    const inst = d.container.instantiateModelsToScene((n) => `${name}:${n}`, false, { doNotInstantiate: true });
    for (const g of inst.animationGroups) g.dispose();
    const top = inst.rootNodes[0] as TransformNode;
    this.top = top;
    top.parent = this.root;
    top.scaling.scaleInPlace(SCALE);
    for (const n of top.getDescendants(false)) {
      const bare = n.name.slice(name.length + 1);
      if (n instanceof Mesh) {
        const src = n.material;
        if (!src) continue;
        // the classic look's flat material (the realistic mode converts it like all others)
        const lin = d.colors.get(src.name) ?? new Color3(0.2, 0.2, 0.2);
        const m = new StandardMaterial(`${name}-${src.name}`, scene);
        m.diffuseColor = lin.toGammaSpace();
        m.specularColor = Color3.Black();
        const look = LOOKS[src.name] ?? { rough: 0.8 };
        m.metadata = { rough: look.rough, metal: look.metal };
        n.material = m;
        n.isPickable = false;
        this.materials.push(m);
        this.meshes.push(n);
      } else if (n instanceof TransformNode) {
        this.byName.set(bare, n);
      }
    }
    this.nodes = d.bones.map((b) => {
      const n = this.byName.get(b)!;
      n.rotationQuaternion ??= Quaternion.Identity();
      return n;
    });

    this.rifle = buildRifle(scene, `${name}-rifle`);
    this.rifle.parent = this.root;
    this.materials.push(this.rifle.material as StandardMaterial);

    // calibration with the root at the origin: the idle pose's chest carries the gun frame
    this.pose([{ clip: "Idle_Gun", t: 0, w: 1 }]);
    const upL = this.posFig("UpperArm.L"), upR = this.posFig("UpperArm.R");
    const center = upL.add(upR).scale(0.5);
    Matrix.TranslationToRef(center.x, center.y, center.z, tmpM);
    this.node("Chest").getWorldMatrix().invertToRef(tmpM2);
    tmpM.multiplyToRef(tmpM2, this.gunOffset);
    this.armLen = {
      upper: Vector3.Distance(upR, this.posFig("LowerArm.R")),
      fore: Vector3.Distance(this.posFig("LowerArm.R"), this.posFig("Wrist.R")),
    };
    this.footRest = Math.min(this.posFig("Foot.L").y, this.posFig("Foot.R").y);
    for (const clip of ["Walk", "Run", "Run_Back"]) {
      const c = d.clips.get(clip)!;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 24; i++) {
        this.pose([{ clip, t: (i / 24) * c.duration, w: 1 }]);
        const z = this.posFig("Foot.L").z;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      this.stride.set(clip, 2 * (hi - lo));
    }
  }

  node(bone: string): TransformNode {
    return this.byName.get(bone)!;
  }

  duration(clip: string): number {
    return this.data.clips.get(clip)!.duration;
  }

  /** Sets every bone from the weighted clips (looping times), then updates the world matrices. */
  pose(layers: readonly ClipLayer[]) {
    const d = this.data;
    const used = layers.filter((l) => l.w > 1e-4);
    const total = used.reduce((s, l) => s + l.w, 0) || 1;
    const samples = used.map((l) => {
      const c = d.clips.get(l.clip)!;
      const t = ((l.t % c.duration) + c.duration) % c.duration;
      const f = (t / c.duration) * (c.frames - 1);
      const f0 = Math.floor(f);
      return { c, f0, f1: Math.min(c.frames - 1, f0 + 1), s: f - f0, w: l.w / total };
    });
    const q = new Quaternion(), qa = new Quaternion(), qb = new Quaternion();
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      q.set(0, 0, 0, 0);
      let px = 0, py = 0, pz = 0, pw = 0;
      for (const sm of samples) {
        const r = sm.c.rot[i];
        qa.set(r[sm.f0 * 4], r[sm.f0 * 4 + 1], r[sm.f0 * 4 + 2], r[sm.f0 * 4 + 3]);
        qb.set(r[sm.f1 * 4], r[sm.f1 * 4 + 1], r[sm.f1 * 4 + 2], r[sm.f1 * 4 + 3]);
        Quaternion.SlerpToRef(qa, qb, sm.s, qa);
        // blend on one hemisphere
        const sign = q.x * qa.x + q.y * qa.y + q.z * qa.z + q.w * qa.w < 0 ? -sm.w : sm.w;
        q.x += qa.x * sign;
        q.y += qa.y * sign;
        q.z += qa.z * sign;
        q.w += qa.w * sign;
        const p = sm.c.pos[i];
        if (p) {
          const a = sm.f0 * 3, b = sm.f1 * 3;
          px += (p[a] + (p[b] - p[a]) * sm.s) * sm.w;
          py += (p[a + 1] + (p[b + 1] - p[a + 1]) * sm.s) * sm.w;
          pz += (p[a + 2] + (p[b + 2] - p[a + 2]) * sm.s) * sm.w;
          pw += sm.w;
        }
      }
      if (samples.length) n.rotationQuaternion!.copyFrom(q.normalize());
      if (pw > 0) n.position.set(px / pw, py / pw, pz / pw);
      else n.position.copyFrom(d.rest[i]);
    }
    this.refresh();
  }

  /** Recomputes the world matrices from the root down. */
  refresh() {
    this.root.computeWorldMatrix(true);
    this.top.computeWorldMatrix(true);
    for (const n of this.top.getDescendants(false)) (n as TransformNode).computeWorldMatrix(true);
    this.rifle?.computeWorldMatrix(true);
  }

  /** Position of a bone's joint in the figure's frame (relative to the root). */
  posFig(bone: string, out = new Vector3()): Vector3 {
    this.node(bone).getWorldMatrix().getTranslationToRef(tmpP);
    this.root.getWorldMatrix().invertToRef(tmpM);
    return Vector3.TransformCoordinatesToRef(tmpP, tmpM, out);
  }

  /** A figure-frame direction / rotation matrix in world space. */
  private figRotation(out: Matrix): Matrix {
    this.root.getWorldMatrix().getRotationMatrixToRef(out);
    return out;
  }

  /**
   * Turns a bone about its own joint by the rotation matrix `r` (figure frame), carrying everything
   * hanging from it along. The world matrices below it are refreshed.
   */
  rotate(bone: string, r: Matrix) {
    const n = this.node(bone);
    const parent = n.parent as TransformNode;
    const W = n.getWorldMatrix();
    const R = this.figRotation(new Matrix());
    // world rotation = R^-1 * r * R (row vectors: into the figure frame, turn, back)
    const Rw = R.clone().transpose().multiply(r).multiply(R);
    const p = W.getTranslation();
    const Wn = W.multiply(Matrix.Translation(-p.x, -p.y, -p.z)).multiply(Rw).multiply(Matrix.Translation(p.x, p.y, p.z));
    parent.getWorldMatrix().invertToRef(tmpM);
    Wn.multiplyToRef(tmpM, tmpM2);
    tmpM2.decompose(tmpS, tmpQ, tmpP);
    n.rotationQuaternion!.copyFrom(tmpQ);
    n.computeWorldMatrix(true);
    for (const c of n.getDescendants(false)) (c as TransformNode).computeWorldMatrix(true);
  }

  /** Turns `bone` so that the direction from its joint to `child`'s joint points along `dir` (figure frame). */
  aim(bone: string, child: string, dir: Vector3) {
    const a = this.posFig(bone), b = this.posFig(child);
    const from = b.subtract(a).normalize();
    const to = dir.normalizeToNew();
    if (Vector3.Dot(from, to) > 0.99999) return;
    const q = new Quaternion();
    Quaternion.FromUnitVectorsToRef(from, to, q);
    const r = new Matrix();
    q.toRotationMatrix(r);
    this.rotate(bone, r);
  }

  /**
   * Sets a hand fully (figure frame): the knuckles (wrist → `child`) along `dir`, then rolled about
   * that line until the thumb (wrist → `thumb`) points as near to `thumbDir` as it can.
   */
  orient(bone: string, child: string, dir: Vector3, thumb: string, thumbDir: Vector3) {
    this.aim(bone, child, dir);
    const a = this.posFig(bone);
    const axis = this.posFig(child).subtract(a).normalize();
    const flat = (v: Vector3) => v.subtract(axis.scale(Vector3.Dot(v, axis)));
    const from = flat(this.posFig(thumb).subtract(a)), to = flat(thumbDir);
    if (from.lengthSquared() < 1e-8 || to.lengthSquared() < 1e-8) return;
    from.normalize();
    to.normalize();
    const angle = Math.atan2(Vector3.Dot(Vector3.Cross(from, to), axis), Vector3.Dot(from, to));
    const q = Quaternion.RotationAxis(axis, angle);
    // (check the sense once: Babylon's quaternion matrices turn row vectors)
    const r = new Matrix();
    q.toRotationMatrix(r);
    if (Vector3.Dot(Vector3.TransformNormal(from, r), to) < Vector3.Dot(from, to) - 1e-6) Quaternion.RotationAxis(axis, -angle).toRotationMatrix(r);
    this.rotate(bone, r);
  }

  /**
   * Bends the fingers (index to pinky, from the knuckles on) by `angle` per joint, their tips
   * turning towards `towards` (figure frame) - e.g. round a grip.
   */
  curl(side: "L" | "R", angle: number, towards: Vector3) {
    for (const f of ["Index", "Middle", "Ring", "Pinky"]) {
      for (let j = 2; j <= 4; j++) {
        const b = `${f}${j}.${side}`, c = j < 4 ? `${f}${j + 1}.${side}` : `${f}4.${side}_end`;
        const d = this.posFig(c).subtract(this.posFig(b)).normalize();
        const n = towards.subtract(d.scale(Vector3.Dot(towards, d)));
        if (n.lengthSquared() < 1e-8) continue;
        n.normalize();
        this.aim(b, c, d.scale(Math.cos(angle)).add(n.scale(Math.sin(angle))));
      }
    }
  }

  /** Two-bone IK: the arm on `side` ("L" / "R") reaches the wrist target, the elbow bent towards `pole` (figure frame). */
  reach(side: "L" | "R", wrist: Vector3, pole: Vector3) {
    const S = this.posFig(`UpperArm.${side}`);
    const { upper: a, fore: b } = this.armLen;
    const d = wrist.subtract(S);
    const len = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, d.length()));
    const n = d.normalize();
    const along = (a * a - b * b + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(0, a * a - along * along));
    const p = pole.subtract(S);
    const perp = p.subtract(n.scale(Vector3.Dot(n, p)));
    if (perp.lengthSquared() < 1e-8) perp.set(0, -1, 0);
    perp.normalize();
    const E = S.add(n.scale(along)).add(perp.scale(h));
    this.aim(`UpperArm.${side}`, `LowerArm.${side}`, E.subtract(S));
    this.aim(`LowerArm.${side}`, `Wrist.${side}`, S.add(n.scale(len)).subtract(E));
  }

  /**
   * The model's feet hang from the root (not from the shins): after the legs were turned by hand,
   * this sets them back under the shins as they were in the clip pose (`before` from footFrames()).
   */
  footFrames(): [Matrix, Matrix] {
    const out: Matrix[] = [];
    for (const s of ["L", "R"]) {
      const inv = new Matrix();
      this.node(`LowerLeg.${s}`).getWorldMatrix().invertToRef(inv);
      out.push(this.node(`Foot.${s}`).getWorldMatrix().multiply(inv));
    }
    return out as [Matrix, Matrix];
  }

  reattachFeet(rel: [Matrix, Matrix]) {
    ["L", "R"].forEach((s, i) => {
      const foot = this.node(`Foot.${s}`);
      const W = rel[i].multiply(this.node(`LowerLeg.${s}`).getWorldMatrix());
      (foot.parent as TransformNode).getWorldMatrix().invertToRef(tmpM);
      W.multiplyToRef(tmpM, tmpM2);
      tmpM2.decompose(tmpS, tmpQ, tmpP);
      foot.rotationQuaternion!.copyFrom(tmpQ);
      foot.position.copyFrom(tmpP);
      foot.computeWorldMatrix(true);
      for (const c of foot.getDescendants(false)) (c as TransformNode).computeWorldMatrix(true);
    });
  }

  /**
   * The gun frame (figure frame): origin between the shoulders, axes as the figure's at rest, carried
   * along by the chest (so the rifle follows the clip's lean, bob and twist).
   */
  gunFrame(out = new Matrix()): Matrix {
    this.gunOffset.multiplyToRef(this.node("Chest").getWorldMatrix(), tmpM2);
    this.root.getWorldMatrix().invertToRef(tmpM);
    tmpM2.multiplyToRef(tmpM, out);
    // keep it a pure rotation + translation (the model's armature is mirrored and scaled)
    out.decompose(tmpS, tmpQ, tmpP);
    return Matrix.ComposeToRef(Vector3.OneReadOnly, tmpQ, tmpP, out);
  }

  /** Places the rifle by its frame `m` in the figure frame (origin at the grip, barrel along +z). */
  placeRifle(m: Matrix) {
    m.decompose(tmpS, tmpQ, tmpP);
    this.rifle.rotationQuaternion ??= new Quaternion();
    this.rifle.rotationQuaternion.copyFrom(tmpQ);
    this.rifle.position.copyFrom(tmpP);
  }

  /** World matrix of a bone (for attaching things to it). */
  world(bone: string): Matrix {
    return this.node(bone).getWorldMatrix();
  }

  dispose() {
    this.root.dispose(false, true);
  }
}

/**
 * Suppressed, scoped rifle with a short stock, origin at the pistol grip (right hand), barrel along
 * +z. Its own materials (the agent's cloak fades them with the figure).
 */
function buildRifle(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const m = MeshBuilder.CreateBox("rp", { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    parts.push(m);
    return m;
  };
  const tube = (r: number, z0: number, z1: number, y: number) => {
    const m = MeshBuilder.CreateCylinder("rp", { height: z1 - z0, diameter: r * 2, tessellation: 10 }, scene);
    m.rotation.x = Math.PI / 2;
    m.position.set(0, y, (z0 + z1) / 2);
    parts.push(m);
    return m;
  };
  box(0.05, 0.1, 0.18, 0, 0.03, -0.12); // stock (short: the butt sits in the shoulder)
  box(0.04, 0.12, 0.04, 0, -0.01, -0.21); // butt plate
  box(0.055, 0.085, 0.36, 0, 0.06, 0.1); // receiver
  box(0.04, 0.11, 0.05, 0, -0.04, 0.0, 0.25); // pistol grip
  box(0.045, 0.13, 0.06, 0, -0.03, 0.16, -0.15); // magazine
  box(0.06, 0.06, 0.3, 0, 0.055, 0.42); // handguard
  tube(0.022, 0.55, 0.9, 0.06); // suppressor
  tube(0.026, 0.0, 0.3, 0.14); // scope
  box(0.018, 0.045, 0.018, 0, 0.11, 0.06);
  box(0.018, 0.045, 0.018, 0, 0.11, 0.24);
  const m = Mesh.MergeMeshes(parts, true, true)!;
  m.name = name;
  const mat = new StandardMaterial(`${name}-mat`, scene);
  mat.diffuseColor = new Color3(0.13, 0.13, 0.135);
  mat.specularColor = Color3.Black();
  mat.metadata = { rough: 0.4, metal: 0.6 };
  m.material = mat;
  m.isPickable = false;
  return m;
}
