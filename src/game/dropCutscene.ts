import {
  Color3, Curve3, DynamicTexture, FresnelParameters, Mesh, PointLight, StandardMaterial, MeshBuilder, Quaternion, Texture, TransformNode, Vector3, VertexData,
  type FreeCamera, type Scene,
} from "@babylonjs/core";
import type { AudioSystem } from "../audio/audio";
import { COMMANDOS, MAP_HALF } from "../config";
import { rng, smoothstep, valueNoise } from "../util/noise";
import { HIP_X, HIP_Y, mat, SHOULDER_Y } from "../world/models";
import { SQUAT } from "./views";
import type { Terrain } from "../world/terrain";
import type { Game } from "./game";
import type { SoldierView } from "./views";
import { AgentView } from "./agentView";

/**
 * The opening cutscene of a commandos mission: the agent falls from the night sky in a wingsuit,
 * opens his parachute, glides past a few enemy outposts while the announcer briefs him, lands,
 * sheds suit and pack (they stay on the ground) and readies his rifle.
 *
 * The world stands still meanwhile. The agent's own figure is posed by hand (see SoldierView.parts;
 * the rigged figure, AgentView, takes the same parts over its bones) and handed back to the game at the end.
 */

/** Seconds into the scene. */
const T = {
  // a long free fall and a low opening: only a short glide under the canopy, so less of the land
  // around is given away (and the scene is quicker)
  aEnd: 10.0, open: 10.5, bEnd: 12.5, flare: 17.3, touch: 19.5, still: 20.5, unclip: 21.6, shed: 22.3,
  // out of the suit he drops into a crouch, takes up his rifle and checks it, then rises
  crouch: 23.0, rifle: 23.9, check: 24.5, rise: 26.7, end: 28.6,
};
/** Height of the feet when the canopy opens (and once it has slowed him down). */
const OPEN_ALT = 50;
const CANOPY_ALT = 42;
/** Height of the feet above the landing spot at the start of the fall. */
const START_ALT = 235;
const FADE = 0.8;

const DIRECTIONS = ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"];
const NUMBERS = ["kein", "ein", "zwei", "drei", "vier", "fünf", "sechs"];

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (a: number, b: number, t: number) => smoothstep(a, b, t);
/** 1 while crouching after the landing (down quickly, up a little slower). */
const crouchW = (t: number) => ease(T.crouch, T.crouch + 0.7, t) * (1 - ease(T.rise, T.rise + 0.9, t));
/** 1 while looking the rifle over in the crouch. */
const checkW = (t: number) => ease(T.check, T.check + 0.5, t) * (1 - ease(T.rise - 0.7, T.rise, t));

/**
 * Horizontal speed along the flight path (units/s): the wingsuit glides steeply (about 40 degrees
 * at a sink of ~18.5/s), the canopy slows him to a gentle glide, almost still on touchdown.
 */
const FLY_SPEED = 22, CHUTE_SPEED = 9;
function speed(t: number): number {
  if (t < T.aEnd) return FLY_SPEED;
  if (t < T.bEnd) return lerp(FLY_SPEED, CHUTE_SPEED, ease(T.aEnd, T.bEnd, t));
  if (t < T.touch - 2.5) return CHUTE_SPEED;
  if (t < T.touch) return lerp(CHUTE_SPEED, 3, ease(T.touch - 2.5, T.touch, t));
  return lerp(3, 0, ease(T.touch, T.touch + 0.9, t));
}

/** Height above the landing spot (feet). */
function altitude(t: number): number {
  if (t < T.aEnd) return lerp(START_ALT, OPEN_ALT, t / T.aEnd);
  if (t < T.bEnd) return lerp(OPEN_ALT, CANOPY_ALT, (t - T.aEnd) / (T.bEnd - T.aEnd));
  if (t < T.touch) return CANOPY_ALT * Math.pow(1 - (t - T.bEnd) / (T.touch - T.bEnd), 1.15);
  return 0;
}

/** A pose of one arm: elbow and wrist, in the standing figure's frame (x mirrored for the left side). */
interface ArmPose { elbow: [number, number, number]; wrist: [number, number, number] }
const SX = 0.26 * 1.45; // shoulder half width
const ARM_POSES: Record<"fly" | "chute" | "down" | "chest", ArmPose> = {
  // (upper arm ~0.45, forearm ~0.48 - the figure's own proportions)
  // braced against the air: shoulder, elbow and wrist in one straight, taut line
  fly: { elbow: [SX + 0.455, SHOULDER_Y - 0.14, -0.03], wrist: [SX + 0.93, SHOULDER_Y - 0.2, -0.06] },
  chute: { elbow: [0.74, SHOULDER_Y + 0.18, 0.1], wrist: [0.5, SHOULDER_Y + 0.6, 0.12] },
  down: { elbow: [0.58, SHOULDER_Y - 0.55, 0], wrist: [0.5, HIP_Y - 0.05, 0.12] },
  chest: { elbow: [0.42, SHOULDER_Y - 0.6, 0.15], wrist: [0.12, SHOULDER_Y - 0.5, 0.32] },
};

const LEG = 1.18; // hip to ankle

/**
 * Wingsuit fabric (grey multiplier, tinted by the material): ram-air cells between ribs running
 * back from the reinforced leading edge, seams, a darker trailing edge, a grey reflective strip near
 * the wrist and a fine weave. u runs from the body (0) to the wrist (1), v from the trailing (0) to
 * the leading edge (1).
 */
function suitTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("wingsuitFabric", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const r = rng(404);
  const weave = Float32Array.from({ length: size * size }, () => r());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = 1 - y / size;
      let k = 0.78 + (weave[y * size + x] - 0.5) * 0.06 + ((x + y) % 2) * 0.015;
      // inflated cells: lighter in the middle of each cell, a crease along every rib
      const cell = (u * 8) % 1;
      if (v > 0.35) k += Math.sin(cell * Math.PI) * 0.1 - (cell < 0.05 || cell > 0.95 ? 0.12 : 0);
      if (Math.abs(v - 0.35) < 0.008 || Math.abs(v - 0.68) < 0.006) k -= 0.16; // seams
      if (v > 0.9) k += 0.06 - (x % 6 === 0 && Math.abs(v - 0.93) < 0.01 ? 0.2 : 0); // reinforced edge, stitching
      if (v < 0.07) k -= 0.12; // trailing edge
      if (u > 0.84 && u < 0.89 && v > 0.45) k = 0.98; // reflective strip
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.max(0, Math.min(1, k)) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

type P2 = [number, number];

/** Distance from p to the segment a-b (2D). */
function segDist2(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1e-9;
  const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - dx * k, p[1] - a[1] - dz * k);
}

function inPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The wingsuit as it lies where the agent stepped out of it: an empty, crumpled jumpsuit with its
 * wings. Laid out flat (x across, z towards the collar, hips at the origin) as limp sleeves and legs
 * - one arm flung out, one folded back, a knee bent - with the membranes between them; puffed
 * where the cloth lies double, creased and wrinkled all over, and draped over the ground.
 */
function droppedSuit(scene: Scene, terrain: Terrain, hip: Vector3, rotY: number, material: StandardMaterial): Mesh {
  // sleeves and legs: [from, to, radius]
  const tubes: [P2, P2, number][] = [
    [[0, 0.02], [0, 0.55], 0.21], // torso
    [[0, 0.66], [0.02, 0.72], 0.12], // collar
    [[-0.22, 0.55], [-0.62, 0.66], 0.075], [[-0.62, 0.66], [-0.98, 0.43], 0.065], // left arm, flung out
    [[0.22, 0.55], [0.56, 0.36], 0.075], [[0.56, 0.36], [0.36, 0.04], 0.065], // right arm, folded back
    [[-0.11, -0.04], [-0.22, -0.5], 0.085], [[-0.22, -0.5], [-0.3, -0.96], 0.075], // left leg
    [[0.11, -0.04], [0.36, -0.42], 0.085], [[0.36, -0.42], [0.17, -0.86], 0.075], // right leg, knee bent
  ];
  const wings: P2[][] = [
    [[-0.2, 0.55], [-0.62, 0.66], [-0.98, 0.43], [-0.22, -0.02]],
    [[0.2, 0.55], [0.56, 0.36], [0.36, 0.04], [0.2, -0.02]],
    [[-0.11, -0.04], [-0.3, -0.96], [0.17, -0.86], [0.11, -0.04]],
  ];
  const step = 0.025, x0 = -1.12, z0 = -1.08, nx = 90, nz = 82;
  const c = Math.cos(rotY), sn = Math.sin(rotY);
  const pos: number[] = [], col: number[] = [], uv: number[] = [], inside: boolean[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step, p: P2 = [x, z];
      let tube = 0;
      for (const [a, b, rad] of tubes) tube = Math.max(tube, 1 - segDist2(p, a, b) / rad);
      const wing = wings.some((w) => inPolygon(p, w));
      const isIn = tube > 0 || wing;
      inside.push(isIn);
      // empty sleeves stay a little puffed; creases run across the membranes, wrinkles everywhere
      // (the cloth tucks down to the ground at its edges)
      const puff = tube > 0 ? Math.sqrt(tube) * 0.11 : 0;
      const crease = wing ? Math.pow(Math.abs(Math.sin(x * 9 + z * 4 + valueNoise(x * 3, z * 3, 6) * 2.5)), 3) * 0.045 : 0;
      const fold = valueNoise(x * 5, z * 5, 7) * 0.02;
      const wrinkle = valueNoise(x * 13, z * 13, 8) * 0.018 + valueNoise(x * 30, z * 30, 9) * 0.006;
      const h = 0.015 + Math.max(0, puff + crease + fold + wrinkle);
      const wx = hip.x + x * c + z * sn, wz = hip.z - x * sn + z * c;
      pos.push(wx, terrain.heightAt(wx, wz) + h, wz);
      // ridges catch the light, folds lie in shadow
      const k = 0.62 + puff * 3.5 + crease * 6 + (fold + wrinkle) * 8;
      col.push(k, k, k, 1);
      uv.push(x * 1.4 + 0.5, z * 1.4 + 0.5);
    }
  }
  const idx: number[] = [];
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = at(i, j), b = at(i + 1, j), cc = at(i + 1, j + 1), d = at(i, j + 1);
      if (inside[a] && inside[cc] && inside[d]) idx.push(a, cc, d);
      if (inside[a] && inside[b] && inside[cc]) idx.push(a, b, cc);
    }
  }
  const nor: number[] = [];
  VertexData.ComputeNormals(pos, idx, nor);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = nor;
  vd.colors = col;
  vd.uvs = uv;
  const m = new Mesh("droppedSuit", scene);
  vd.applyToMesh(m);
  m.material = material;
  m.isPickable = false;
  m.receiveShadows = true;
  return m;
}

/** Arc of the ram-air canopy (unit size: span x -0.5..0.5): the tips hang down. */
const canopyArc = (x: number) => -0.28 * (2 * x) * (2 * x);
/** Cells of the canopy across its span. */
const CELLS = 9;

/**
 * Ram-air canopy as used for military free-fall, in unit size (span 1 along x, chord 0.4 along z
 * with the leading edge at +z, scaled up by the scene): an arched wing with an airfoil profile,
 * nine cells whose top skin puffs up between the ribs, open cell mouths along the leading edge and
 * closed tips. Lighter on top, darker underneath and in the mouths (vertex colours).
 */
function ramAirCanopy(scene: Scene): Mesh {
  const ns = 45, nc = 12;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const thick = (u: number) => 0.11 * (u < 0.78 ? Math.sin((u / 0.78) * (Math.PI / 2)) : 1 - ((u - 0.78) / 0.22) ** 2 * 0.25);
  const add = (x: number, y: number, z: number, k: number) => {
    pos.push(x, y, z);
    col.push(k, k, k * 0.97, 1);
    return pos.length / 3 - 1;
  };
  const top: number[][] = [], bottom: number[][] = [];
  for (let i = 0; i <= ns; i++) {
    const x = -0.5 + i / ns;
    const cell = (((x + 0.5) * CELLS) % 1 + 1) % 1;
    const puff = Math.sin(cell * Math.PI);
    top.push([]);
    bottom.push([]);
    for (let j = 0; j <= nc; j++) {
      const u = j / nc, z = -0.2 + u * 0.4, a = canopyArc(x);
      // (a glossy band towards the leading edge, as if the sky were mirrored in the curved top skin)
      top[i].push(add(x, a + thick(u) * (0.85 + 0.15 * puff), z, 0.78 + 0.18 * puff + 0.15 * Math.pow(Math.max(0, u - 0.45) / 0.55, 2) * (0.7 + 0.3 * puff)));
      bottom[i].push(add(x, a + 0.004 * puff, z, 0.62 + 0.08 * puff));
    }
  }
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nc; j++) {
      quad(top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j]);
      quad(bottom[i][j], bottom[i + 1][j], bottom[i + 1][j + 1], bottom[i][j + 1]);
    }
    // trailing edge: the skins meet; leading edge: the dark cell mouths (ribs a little lighter)
    const cell = ((((-0.5 + (i + 0.5) / ns) + 0.5) * CELLS) % 1 + 1) % 1;
    const rib = cell < 0.12 || cell > 0.88;
    const k = rib ? 0.5 : 0.18;
    const tA = top[i][nc], tB = top[i + 1][nc], bA = bottom[i][nc], bB = bottom[i + 1][nc];
    const m0 = add(pos[tA * 3], pos[tA * 3 + 1], pos[tA * 3 + 2], k), m1 = add(pos[tB * 3], pos[tB * 3 + 1], pos[tB * 3 + 2], k);
    const m2 = add(pos[bB * 3], pos[bB * 3 + 1], pos[bB * 3 + 2] + 0.004, k), m3 = add(pos[bA * 3], pos[bA * 3 + 1], pos[bA * 3 + 2] + 0.004, k);
    quad(m0, m3, m2, m1);
  }
  // closed tips
  for (const i of [0, ns]) for (let j = 0; j < nc; j++) quad(top[i][j], bottom[i][j], bottom[i][j + 1], top[i][j + 1]);
  const nor: number[] = [];
  VertexData.ComputeNormals(pos, idx, nor);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = nor;
  vd.colors = col;
  const m = new Mesh("dropCanopy", scene);
  vd.applyToMesh(m);
  return m;
}

/**
 * Coated nylon, dark grey with a sheen: glossy highlights where a light catches it and a cool
 * shimmer along the edges (a Fresnel glow, as if it mirrored the sky). Facing the viewer it keeps a
 * faint glow so it stays readable at night. The realistic mode gets a smooth, slightly metallic
 * surface with a rim light instead.
 */
function nylon(scene: Scene, name: string, c: [number, number, number], facing = 0.3, gloss = 1): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(...c);
  m.specularColor = new Color3(0.32 * gloss, 0.34 * gloss, 0.37 * gloss);
  m.specularPower = 48;
  m.emissiveColor = Color3.White();
  const f = new FresnelParameters();
  f.bias = 0.1;
  f.power = 2.2;
  f.leftColor = new Color3(0.25 * gloss, 0.27 * gloss, 0.31 * gloss); // at the edges: the sheen
  f.rightColor = new Color3(c[0] * facing, c[1] * facing, c[2] * facing); // facing the viewer
  m.emissiveFresnelParameters = f;
  m.backFaceCulling = false;
  m.twoSidedLighting = true;
  // (the rim light is added wherever the surface turns away - seen from below that is most of a
  // canopy: kept faint, a cool shimmer rather than a glow)
  m.metadata = { rough: 0.3 + (1 - gloss) * 0.45, metal: 0.45 * gloss, rim: [0.2 * gloss, 0.22 * gloss, 0.26 * gloss] };
  return m;
}

/** Soft cloud puff: a lumpy, noisy round blob (white, its shape in the alpha). */
function cloudTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const tex = new DynamicTexture("dropCloud", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const r = rng(77);
  const lumps = Array.from({ length: 6 }, (_, k) => ({ x: 0.5 + (k ? (r() - 0.5) * 0.4 : 0), y: 0.5 + (k ? (r() - 0.5) * 0.3 : 0), rad: k ? 0.16 + r() * 0.1 : 0.3 }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let d = 0;
      for (const l of lumps) d = Math.max(d, 1 - Math.hypot(u - l.x, v - l.y) / l.rad);
      const n = valueNoise(u * 7, v * 7, 3) * 0.5 + valueNoise(u * 17, v * 17, 4) * 0.25;
      const a = Math.max(0, Math.min(1, d * 1.3 + n * 0.45 - 0.05)) * Math.min(1, Math.min(u, v, 1 - u, 1 - v) * 6);
      const i = (y * size + x) * 4;
      // a little brighter on top (moonlight), denser and darker below
      const lum = 0.82 + (0.5 - v) * 0.3 + n * 0.15;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.max(0, Math.min(1, lum)) * 255);
      img.data[i + 3] = Math.round(a * a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

export class DropCutscene {
  /** Ground point below the figure (the sun and shadows follow it). */
  readonly focus = new Vector3();
  active = true;

  private readonly scene: Scene;
  private readonly terrain: Terrain;
  private readonly view: SoldierView | AgentView;
  private readonly parts: SoldierView["parts"] | AgentView["parts"];
  /** The rigged figure (null: the figure built from parts). */
  private readonly rigged: AgentView | null;
  private t = 0;
  private readonly fired = new Set<string>();
  private shake = 0;

  // flight path
  private readonly pts: Vector3[];
  private readonly cum: number[] = [];
  private readonly total: number;
  private readonly fTab: number[] = [];
  /** Lowest allowed height of the feet over time (same steps as fTab). */
  private readonly floorTab: number[] = [];
  private readonly land: Vector3;
  private readonly landDir: Vector3;
  private readonly y0: number;
  private readonly agentHeading: number;

  // scene objects
  private readonly fly: TransformNode;
  private readonly body: TransformNode;
  private readonly limbs: Mesh[] = [];
  private readonly hands: Mesh[] = [];
  private readonly membrane: Mesh;
  private readonly memPos: Float32Array;
  private readonly pack: Mesh;
  private readonly canopy: Mesh;
  /** Risers with their connector links (shown with the lines) and the body harness (shed with the suit). */
  private readonly risers: Mesh[] = [];
  private readonly harness: Mesh[] = [];
  /** The cloud layer he drops out of at the start. */
  private readonly clouds: Mesh[] = [];
  /** The canopy lying on the ground: a crumpled heap and its lines (made when it comes down). */
  private pile: Mesh[] | null = null;
  private canopyLines: Mesh;
  private readonly shedNode: TransformNode;
  private readonly suitMat: StandardMaterial;
  /** The empty wingsuit lying on the ground (made when the agent has stepped out of it). */
  private dropped: Mesh | null = null;
  private straps: Mesh[] = [];
  private shedT = -1;
  private packVy = 0;
  private touchPos = new Vector3();
  private linesOn = true;
  private d1!: Vector3;
  private d2!: Vector3;
  private readonly light: PointLight;

  // camera
  private readonly camPos = new Vector3();
  private readonly camLook = new Vector3();
  private camFov = 0.42;
  private camPsi: number | null = null;
  private camInit = false;
  private readonly baseFov: number;

  // briefing
  private readonly lines: string[];
  private spoken = -1;
  private speech: boolean;
  private readonly subEl = document.getElementById("cut-sub")!;
  private readonly fadeEl = document.getElementById("cut-fade")!;
  private readonly rootEl = document.getElementById("cutscene")!;
  private endTimer = 0;
  private finished = false;

  constructor(
    private readonly game: Game,
    private readonly audio: AudioSystem,
    private readonly camera: FreeCamera,
    private readonly onDone: () => void,
  ) {
    const sc = game.scene;
    this.scene = sc;
    this.terrain = game.terrain;
    const agent = game.commandos!.agent;
    this.view = agent.view as SoldierView | AgentView;
    this.parts = this.view.parts;
    this.rigged = agent.view instanceof AgentView ? agent.view : null;
    if (this.rigged) {
      this.rigged.applyPose(0);
      this.rigFit.shoulder = this.rigged.joint("UpperArm.L").y;
    }
    this.agentHeading = agent.heading;
    this.baseFov = camera.fov;
    this.y0 = this.terrain.heightAt(agent.x, agent.z);

    // ---- flight path: past a few outposts (they lie to the left of the path), ending at the landing spot
    const L = new Vector3(agent.x, 0, agent.z);
    const posts = game.outposts
      .filter((o) => !o.destroyed)
      .map((o) => ({ p: new Vector3(o.x, 0, o.z), d: Math.hypot(o.x - L.x, o.z - L.z) }))
      .filter((o) => o.d > 30 && o.d < 150)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .sort((a, b) => b.d - a.d)
      .map((o) => o.p);
    const way: Vector3[] = [];
    for (let i = 0; i < posts.length; i++) {
      const next = i + 1 < posts.length ? posts[i + 1] : L;
      const dir = next.subtract(posts[i]).normalize();
      way.push(posts[i].add(new Vector3(dir.z, 0, -dir.x).scale(34)));
    }
    if (!way.length) {
      const a = Math.random() * Math.PI * 2;
      way.push(L.add(new Vector3(Math.sin(a), 0, Math.cos(a)).scale(90)));
    }
    const last = way[way.length - 1];
    const toL = L.subtract(last).normalize();
    way.push(L.subtract(toL.scale(20)), L);
    this.land = L;
    this.landDir = toL;

    // speed table (cumulative share of the path covered at time t)
    const dtT = 0.02;
    let acc = 0;
    this.fTab.push(0);
    for (let t = 0; t < T.still + 0.6; t += dtT) {
      acc += speed(t) * dtT;
      this.fTab.push(acc);
    }
    for (let i = 0; i < this.fTab.length; i++) this.fTab[i] /= acc;
    // the path is exactly as long as he flies at these speeds: waypoints too far out are dropped,
    // a path too short is extended back from its start
    const len = (w: Vector3[]) => w.reduce((sum, p, i) => (i ? sum + Vector3.Distance(w[i - 1], p) : 0), 0);
    while (way.length > 2 && len(way.slice(1)) >= acc) way.shift();
    const along = len(way);
    const ext = Math.max(0, acc - along);
    // extended back from the first waypoint - turned if need be so the flight starts over the map
    // (not over the mountains at its edge)
    const back = way.length > 1 ? way[0].subtract(way[1]).normalize() : toL.scale(-1);
    const inside = (v: Vector3) => Math.abs(v.x) < MAP_HALF - 8 && Math.abs(v.z) < MAP_HALF - 8;
    let d0 = back;
    for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
      const a0 = Math.atan2(back.x, back.z) + turn;
      const cand = new Vector3(Math.sin(a0), 0, Math.cos(a0));
      if (inside(way[0].add(cand.scale(ext))) && inside(way[0].add(cand.scale(ext * 0.5)))) {
        d0 = cand;
        break;
      }
    }
    const start = way[0].add(d0.scale(ext));
    const all = [start, way[0].add(d0.scale(ext * 0.5)), ...way];
    this.pts = Curve3.CreateCatmullRomSpline(all, 24, false).getPoints();
    this.cum.push(0);
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + Vector3.Distance(this.pts[i - 1], this.pts[i]));
    this.total = this.cum[this.cum.length - 1];
    // the lowest the feet may be at each moment: clear of the ground below, and never lower than
    // what lies ahead (a running maximum from the landing backwards) - so the descent never jumps up
    const p = new Vector3();
    for (let i = this.fTab.length - 1, next = -Infinity; i >= 0; i--) {
      const t = i * dtT;
      this.at(this.fTab[i] * this.total, p);
      const clear = Math.min(10, altitude(t) * 0.8);
      next = Math.max(next, this.terrain.heightAt(p.x, p.z) + clear);
      this.floorTab[i] = next;
    }

    // ---- the figure: the agent's own parts, posed by hand
    this.fly = new TransformNode("dropFly", sc);
    this.body = new TransformNode("dropBody", sc);
    this.body.parent = this.fly;
    this.view.root.parent = this.body;
    this.view.root.position.set(0, -HIP_Y, 0);
    this.view.root.rotation.set(0, 0, 0);
    this.parts.arms.setEnabled(false);
    this.parts.shadow.setEnabled(false);
    this.parts.torso.rotation.set(0, 0, 0);

    const cloth = (name: string, c: [number, number, number]) => {
      const m = new StandardMaterial(name, sc);
      m.diffuseColor = new Color3(...c);
      m.emissiveColor = new Color3(c[0] * 0.3, c[1] * 0.3, c[2] * 0.3); // (the night is dark: the figure must stay readable)
      m.specularColor = Color3.Black();
      m.backFaceCulling = false;
      m.twoSidedLighting = true;
      return m;
    };
    // as dark as the agent's combat suit (same greyish olive), only a faint sheen left
    const suit = nylon(sc, "dropSuit", [0.12, 0.125, 0.115], 0.12, 0.35);
    suit.diffuseTexture = suitTexture(sc);
    this.suitMat = suit;
    const sleeve = nylon(sc, "dropSleeve", [0.1, 0.104, 0.096], 0.12, 0.35);
    for (let i = 0; i < 4; i++) {
      const m = MeshBuilder.CreateCylinder("dropArm", { height: 1, diameter: 0.17, tessellation: 8 }, sc);
      m.material = sleeve;
      m.parent = this.view.root;
      m.isPickable = false;
      this.limbs.push(m);
    }
    for (let i = 0; i < 2; i++) {
      const h = MeshBuilder.CreateSphere("dropHand", { diameter: 0.17, segments: 6 }, sc);
      h.material = mat(sc, [0.75, 0.55, 0.42]);
      h.parent = this.view.root;
      h.isPickable = false;
      this.hands.push(h);
    }

    // the rigged figure has arms of its own: they are set onto the same targets
    if (this.rigged) for (const m of [...this.limbs, ...this.hands]) m.setEnabled(false);

    // wingsuit membrane (11 vertices, updated every frame)
    this.membrane = new Mesh("dropWing", sc);
    this.memPos = new Float32Array(11 * 3);
    const idx: number[] = [];
    for (const o of [0, 5]) idx.push(o, o + 1, o + 4, o + 1, o + 2, o + 4, o + 2, o + 3, o + 4, o + 3, o, o + 4);
    idx.push(3, 2, 10, 10, 2, 7, 10, 7, 8); // between the legs: (H_L, A_L, C), (C, A_L, A_R), (C, A_R, H_R)
    // (the left wing is vertices 0..4: S, W, A, H, Mid; the right wing 5..9; 10 = crotch)
    const vd = new VertexData();
    vd.positions = Array.from(this.memPos);
    vd.indices = idx;
    vd.normals = new Array(33).fill(0);
    // each wing: shoulder, wrist, ankle, hip, middle (u body to wrist, v trailing to leading edge); crotch
    const wingUv = [0, 1, 1, 1, 1, 0, 0, 0, 0.5, 0.5];
    vd.uvs = [...wingUv, ...wingUv, 0.25, 0];
    vd.applyToMesh(this.membrane, true);
    this.membrane.material = suit;
    this.membrane.parent = this.view.root;
    this.membrane.isPickable = false;
    this.membrane.alwaysSelectAsActiveMesh = true;

    this.pack = MeshBuilder.CreateBox("dropPack", { width: 0.55, height: 0.75, depth: 0.28 }, sc);
    this.pack.material = nylon(sc, "dropPack", [0.09, 0.093, 0.087], 0.12, 0.35);
    this.pack.parent = this.view.root;
    this.pack.position.copyFrom(this.fit(new Vector3(0, SHOULDER_Y - 0.5, -0.3)));
    if (this.rigged) this.pack.scaling.set(0.78, 0.88, 0.8);
    this.pack.isPickable = false;
    // harness: shoulder straps down its front, a chest strap with a buckle, a carry loop on top
    const strapMat = cloth("dropStrap", [0.1, 0.1, 0.09]);
    const strap = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const b = MeshBuilder.CreateBox("dropStrap", { width: w, height: h, depth: d }, sc);
      b.material = strapMat;
      b.parent = this.pack;
      b.position.set(x, y, z);
      b.isPickable = false;
      this.straps.push(b);
      return b;
    };
    strap(0.06, 0.78, 0.03, -0.14, 0, 0.15);
    strap(0.06, 0.78, 0.03, 0.14, 0, 0.15);
    strap(0.4, 0.05, 0.03, 0, 0.12, 0.165);
    strap(0.07, 0.07, 0.04, 0, 0.12, 0.18).material = mat(sc, [0.55, 0.55, 0.52]); // buckle
    strap(0.2, 0.04, 0.12, 0, 0.39, 0.02); // carry loop

    this.shedNode = new TransformNode("dropShed", sc);

    // parachute: an olive ram-air canopy with its lines. Solid, matt cloth that stays a little
    // lighter than the night sky, so it reads as a surface against it (not as a hole in the haze)
    this.canopy = ramAirCanopy(sc);
    // as dark as the suit: against the night sky it stands as a dark silhouette with a faint sheen
    this.canopy.material = nylon(sc, "dropChute", [0.12, 0.125, 0.115], 0.12, 0.35);
    this.canopy.isPickable = false;
    this.canopy.setEnabled(false);
    this.canopy.alwaysSelectAsActiveMesh = true;
    this.canopyLines = MeshBuilder.CreateLineSystem("dropLines", { lines: this.lineSet(), updatable: true }, sc) as unknown as Mesh;
    (this.canopyLines as unknown as { color: Color3 }).color = new Color3(0.2, 0.205, 0.195); // dark like suit and canopy
    this.canopyLines.alwaysSelectAsActiveMesh = true;
    this.canopyLines.setEnabled(false);
    this.makeHarness();

    // low camera spots at the landing site, free of trees and houses (and with a clear line to the agent)
    const lf0 = this.landDir, af0 = new Vector3(Math.sin(this.agentHeading), 0, Math.cos(this.agentHeading));
    this.d1 = this.viewpoint(Math.atan2(lf0.x, lf0.z) - 0.45, 7, 1.6);
    this.d2 = this.viewpoint(Math.atan2(af0.x, af0.z) + 1.0, 6.5, 1.5);

    // a pale light travels with the figure (the night is too dark to see him), lighting only him and his gear
    this.light = new PointLight("dropLight", new Vector3(0.5, 2.5, -2.5), sc);
    this.light.parent = this.fly;
    this.light.diffuse = new Color3(0.7, 0.8, 1);
    this.light.specular = Color3.Black();
    this.light.intensity = 1.8;
    this.light.range = 60;
    this.light.includedOnlyMeshes = [...this.view.root.getChildMeshes(), this.canopy];

    // ---- the briefing
    this.lines = this.briefing();
    this.speech = false;
    this.rootEl.hidden = false;
    this.subEl.textContent = "";
    this.subEl.classList.remove("show");
    this.fadeEl.style.transition = "none";
    this.fadeEl.style.opacity = "1";
    void this.fadeEl.offsetWidth;
    this.fadeEl.style.transition = `opacity ${FADE}s ease`;
    this.fadeEl.style.opacity = "0";
    document.getElementById("cut-skip")!.onclick = () => this.skip();

    this.makeClouds();
    this.pose(0);
    this.place(0);
    this.cameraFor(0, 1);
  }

  /**
   * A layer of moonlit cloud around the jump point: the agent starts inside it and falls out of its
   * underside; the camera, a little below him, comes out first and sees him emerge. Later the layer
   * hangs above him as a backdrop.
   */
  private makeClouds() {
    const sc = this.scene;
    const mt = new StandardMaterial("dropCloudMat", sc);
    mt.diffuseTexture = cloudTexture(sc);
    mt.useAlphaFromDiffuseTexture = true;
    mt.emissiveColor = new Color3(0.27, 0.3, 0.37); // moonlit
    mt.disableLighting = true;
    mt.backFaceCulling = false;
    mt.disableDepthWrite = true;
    mt.alpha = 0.9;
    const tpl = MeshBuilder.CreatePlane("dropCloud", { size: 1 }, sc);
    tpl.material = mt;
    tpl.billboardMode = Mesh.BILLBOARDMODE_ALL;
    tpl.isPickable = false;
    tpl.isVisible = false;
    this.clouds.push(tpl);
    const r = rng(2024);
    const c = this.position(0.6);
    const base = this.position(0).y - 15; // the cloud base, a little below where he starts
    for (let i = 0; i < 90; i++) {
      // denser near his path, thinning out to the sides
      const a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * 60;
      const m = tpl.clone("dropCloud");
      m.isVisible = true;
      const size = 9 + r() * 16;
      m.scaling.set(size * (1.2 + r() * 0.6), size, 1);
      m.position.set(c.x + Math.cos(a) * d, base + size * 0.35 + r() * 20, c.z + Math.sin(a) * d);
      m.alwaysSelectAsActiveMesh = true;
      this.clouds.push(m);
    }
    // dense puffs wrapped round his first metres: he is hidden in the cloud at first and breaks out of it
    for (let k = 0; k <= 7; k++) {
      const at = this.position(k * 0.16);
      for (let j = 0; j < 3; j++) {
        const m = tpl.clone("dropCloud");
        m.isVisible = true;
        const size = 7 + r() * 6;
        m.scaling.set(size * 1.3, size, 1);
        m.position.set(at.x + (r() - 0.5) * 6, at.y + (r() - 0.3) * 4, at.z + (r() - 0.5) * 6);
        m.alwaysSelectAsActiveMesh = true;
        this.clouds.push(m);
      }
    }
  }

  /** A camera spot about `dist` from the landing site around direction `ang`, in the open; turns and shortens until one fits. */
  private viewpoint(ang: number, dist: number, height: number): Vector3 {
    const nav = this.game.nav, L = this.land;
    const clear = (x: number, z: number) => {
      if (!nav.areaFree(x, z, 3.4, 3.4, 0, 0) || !nav.areaFree(L.x, L.z, 2, 2, 0, 0)) return false;
      // (the crowns of trees are wider than their trunks: look along three lines)
      const dx = x - L.x, dz = z - L.z, len = Math.hypot(dx, dz) || 1;
      const px = -dz / len, pz = dx / len;
      for (let s = 1; s < len; s += 0.75) {
        const k = s / len;
        for (const off of [-1.8, 0, 1.8]) if (nav.isBlocked(lerp(L.x, x, k) + px * off, lerp(L.z, z, k) + pz * off)) return false;
      }
      return true;
    };
    for (const d of [dist, dist * 0.8, dist * 0.65, dist * 0.5]) {
      for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 2.6, -2.6, Math.PI]) {
        const a = ang + turn, x = L.x + Math.sin(a) * d, z = L.z + Math.cos(a) * d;
        if (clear(x, z)) return new Vector3(x, this.terrain.heightAt(x, z) + height, z);
      }
    }
    return new Vector3(L.x + Math.sin(ang) * dist, this.terrain.heightAt(L.x, L.z) + height + 2, L.z + Math.cos(ang) * dist);
  }

  // ------------------------------------------------------------------ briefing text

  private briefing(): string[] {
    const g = this.game, m = g.commandos!;
    const a = g.commandos!.agent;
    const count = new Map<string, number>();
    for (const c of m.caches) {
      const ang = Math.atan2(c.x - a.x, c.z - a.z);
      const d = DIRECTIONS[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
      count.set(d, (count.get(d) ?? 0) + 1);
    }
    const where = [...count].map(([d, n]) => (n > 1 ? `${NUMBERS[n]} im ${d}` : `eines im ${d}`));
    const list = where.length > 1 ? `${where.slice(0, -1).join(", ")} und ${where[where.length - 1]}` : where[0] ?? "";
    const n = m.caches.length;
    if (m.kind === "documents") {
      return [
        `Agent. Ihr Auftrag: Bergen Sie die Dokumente aus ${NUMBERS[m.embassies.length] ?? m.embassies.length} Botschaften. Die Villen am Park sind auf Ihrer Karte markiert.`,
        "Die Botschaften sind stark bewacht. Halten Sie Stellungen, um Verstärkung zu erhalten.",
        `Sie haben ${Math.round(m.timeLimit / 60)} Minuten. Viel Erfolg.`,
      ];
    }
    return [
      `Agent. Ihr Auftrag: Sprengen Sie ${COMMANDOS.targets} feindliche Stellungen, und bleiben Sie unentdeckt.`,
      `Sie landen ohne Sprengstoff. Die Depots liegen versteckt an Waldrändern: ${NUMBERS[n] ?? n} Stück, ${list}.`,
      `Meiden Sie Scheinwerfer und Drohnen. Sie haben ${Math.round(m.timeLimit / 60)} Minuten. Viel Erfolg.`,
    ];
  }

  // ------------------------------------------------------------------ path

  private share(t: number): number {
    const i = Math.min(this.fTab.length - 1, Math.max(0, t / 0.02));
    const i0 = Math.floor(i);
    return lerp(this.fTab[i0], this.fTab[Math.min(this.fTab.length - 1, i0 + 1)], i - i0);
  }

  /** Point on the path at distance s (and its direction). */
  private at(s: number, out: Vector3): Vector3 {
    s = Math.min(this.total, Math.max(0, s));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const k = (s - this.cum[lo]) / Math.max(1e-6, this.cum[hi] - this.cum[lo]);
    return Vector3.LerpToRef(this.pts[lo], this.pts[hi], k, out);
  }

  /** Position of the pelvis at time t. */
  private position(t: number, out = new Vector3()): Vector3 {
    this.at(this.share(Math.min(t, T.still + 0.5)) * this.total, out);
    const alt = altitude(t);
    const i = Math.min(this.floorTab.length - 1, Math.max(0, t / 0.02));
    const i0 = Math.floor(i), i1 = Math.min(this.floorTab.length - 1, i0 + 1);
    const floor = lerp(this.floorTab[i0], this.floorTab[i1], i - i0);
    const feet = Math.max(this.y0 + alt, floor);
    out.y = feet + HIP_Y;
    return out;
  }

  private heading(t: number): number {
    const s = this.share(Math.min(t, T.still)) * this.total;
    const a = this.at(s - 2, new Vector3()), b = this.at(s + 2, new Vector3());
    let h = Math.atan2(b.x - a.x, b.z - a.z);
    if (this.share(t) > 0.995) h = Math.atan2(this.landDir.x, this.landDir.z);
    if (t > T.still + 0.7) {
      const f = Math.atan2(this.landDir.x, this.landDir.z);
      let d = this.agentHeading - f;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      h = f + d * ease(T.still + 0.7, T.still + 2.2, t);
    }
    return h;
  }

  // ------------------------------------------------------------------ posing

  private once(key: string, at: number, fn: () => void) {
    if (this.t >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn();
    }
  }

  /** Puts the figure's frame (position, heading, tilt) at time t. */
  private place(t: number) {
    const p = this.position(t);
    const ahead = this.position(t + 0.1), back = this.position(Math.max(0, t - 0.1));
    const horiz = Math.hypot(ahead.x - back.x, ahead.z - back.z);
    const glide = Math.min(1.1, Math.max(0, Math.atan2(back.y - ahead.y, Math.max(0.01, horiz))));
    const k = ease(T.aEnd + 0.45, T.aEnd + 2.3, t);
    const psi = this.heading(t);
    this.fly.position.copyFrom(p);
    if (!this.rigged) this.fly.position.y -= SQUAT.drop * crouchW(t); // the hips sink into the crouch (the rigged figure sets its feet itself)
    const bank = Math.sin(t * 0.7) * 0.2 * (1 - k) + Math.sin(t * 0.5) * 0.05 * k;
    this.fly.rotation.set(glide * (1 - k), psi, bank);
    const hang = -0.14 + 0.05 * Math.sin(t * 0.8);
    const flare = ease(T.flare, T.touch, t);
    const upright = ease(T.touch, T.still, t);
    const after = lerp(lerp(hang, -0.55, flare), 0, upright);
    this.body.rotation.x = lerp(Math.PI / 2, after, k);
    this.focus.set(p.x, this.terrain.heightAt(p.x, p.z), p.z);
  }

  private pose(t: number) {
    const k = ease(T.aEnd + 0.45, T.aEnd + 2.3, t);
    // head: looks ahead in the fall (the body lies flat), then down at the ground
    this.parts.head.rotation.set(lerp(-1.25, 0.1, k), 0, 0);
    // legs
    const spread = 0.18 * (1 - k) + 0.03;
    const flare = ease(T.flare, T.touch, t);
    const land = ease(T.touch, T.touch + 0.5, t);
    const base = lerp(0.1 + 0.05 * Math.sin(t * 1.1), -0.9, flare) * (1 - land);
    const swing = t > T.touch ? Math.sin((t - T.touch) * 10) * 0.5 * (1 - ease(T.touch, T.still, t)) : 0;
    const flight = 1 - k;
    this.parts.legL.rotation.set(lerp(base + swing, 0.08, flight), 0, -spread);
    this.parts.legR.rotation.set(lerp(base - swing, 0.08, flight), 0, spread);
    const bend = 0.45 * flare * (1 - land);
    this.parts.shinL.rotation.x = bend + Math.max(0, -swing) * 0.9;
    this.parts.shinR.rotation.x = bend + Math.max(0, swing) * 0.9;
    // the crouch: thighs forward, shins folded back, the upper body leaning over the knees
    const c = crouchW(t), w = checkW(t);
    if (c > 0) {
      this.parts.legL.rotation.x = lerp(this.parts.legL.rotation.x, SQUAT.thigh, c);
      this.parts.legR.rotation.x = lerp(this.parts.legR.rotation.x, SQUAT.thigh - 0.08, c);
      this.parts.shinL.rotation.x = lerp(this.parts.shinL.rotation.x, SQUAT.shin, c);
      this.parts.shinR.rotation.x = lerp(this.parts.shinR.rotation.x, SQUAT.shin + 0.06, c);
    }
    this.parts.torso.rotation.x = SQUAT.lean * c;
    // head: keeps looking ahead over the lean; down at the rifle while checking it
    this.parts.head.rotation.x += -SQUAT.lean * 0.7 * c + 0.45 * w;
    this.parts.head.rotation.y = 0.2 * w;

    // arms: wide in the fall, up on the toggles under the canopy, down after landing, hands to the chest to unclip
    const open = ease(T.open - 0.2, T.open + 0.9, t);
    const down = ease(T.touch + 0.2, T.touch + 1.2, t);
    const chest = ease(T.still + 0.3, T.unclip - 0.2, t) * (1 - ease(T.shed, T.shed + 0.6, t));
    const wFly = 1 - open, wChute = open * (1 - down), wDown = down * (1 - chest);
    const pick = (side: number, joint: "elbow" | "wrist") => {
      const v = new Vector3();
      // only a fine, fast tremor of the hands under the air pressure (the arms are tensed)
      const flut = joint === "wrist" ? Math.sin(t * 41 + side * 1.7) * 0.012 * wFly : 0;
      for (const [name, w] of [["fly", wFly], ["chute", wChute], ["down", wDown], ["chest", chest]] as const) {
        const q = ARM_POSES[name][joint];
        v.x += side * q[0] * w;
        v.y += q[1] * w;
        v.z += (q[2] + flut) * w;
      }
      return v;
    };
    let shoulder = (side: number) => new Vector3(side * SX, SHOULDER_Y - 0.08, 0);
    const wrists: Vector3[] = [], sides = [-1, 1];
    const rig = this.rigged;
    if (rig) {
      // the rigged figure's arms reach for the same poses (fitted to its build), its joints span the membrane
      const target = (side: number) => ({ elbow: this.fit(pick(side, "elbow")), wrist: this.fit(pick(side, "wrist")) });
      rig.armTargets = { L: target(-1), R: target(1) };
      rig.applyPose(t, crouchW(t));
      shoulder = (side) => rig.joint(side < 0 ? "UpperArm.L" : "UpperArm.R");
      for (const s of ["L", "R"]) wrists.push(rig.joint(`Wrist.${s}`));
    } else {
      sides.forEach((side, i) => {
        const s = shoulder(side), e = pick(side, "elbow"), w = pick(side, "wrist");
        this.limb(this.limbs[i * 2], s, e);
        this.limb(this.limbs[i * 2 + 1], e, w);
        this.hands[i].position.copyFrom(w);
        wrists.push(w);
      });
    }

    // membrane
    if (this.shedT < 0) {
      const P = this.memPos;
      const set = (i: number, v: Vector3) => { P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; };
      const ankle = (hipX: number, rx: number, rz: number) => new Vector3(hipX + LEG * Math.sin(rz), HIP_Y - LEG * Math.cos(rz) * Math.cos(rx), -LEG * Math.sin(rx));
      const aL = rig ? rig.joint("Foot.L") : ankle(-HIP_X, this.parts.legL.rotation.x, -spread);
      const aR = rig ? rig.joint("Foot.R") : ankle(HIP_X, this.parts.legR.rotation.x, spread);
      const hL = this.fit(new Vector3(-0.2, HIP_Y + 0.05, -0.02)), hR = this.fit(new Vector3(0.2, HIP_Y + 0.05, -0.02));
      // the membrane stands taut and full, quivering only a little
      const bulge = (0.08 + Math.sin(t * 37) * 0.008) * wFly + 0.04;
      sides.forEach((side, i) => {
        const o = i * 5;
        const S = shoulder(side), W = wrists[i], A = side < 0 ? aL : aR, H = side < 0 ? hL : hR;
        const M = S.add(W).add(A).add(H).scale(0.25);
        M.z -= bulge;
        set(o, S); set(o + 1, W); set(o + 2, A); set(o + 3, H); set(o + 4, M);
      });
      set(10, this.fit(new Vector3(0, HIP_Y - 0.1, -0.04)));
      // the leg membrane's corner points follow the legs: left wing's (H, A) and right wing's (A, H)
      const nor = new Array<number>(33).fill(0);
      VertexData.ComputeNormals(P, this.membrane.getIndices()!, nor);
      this.membrane.updateVerticesData("position", P);
      this.membrane.updateVerticesData("normal", nor);
      this.membrane.refreshBoundingInfo();
    }
  }

  /**
   * The rig on the body, in the figure's frame: on each side the lines gather above the shoulder in a
   * connector link with a cuff that bundles them; from it a front and a rear riser (flat webbing) run
   * down to the harness - shoulder straps down the chest, a chest strap with its buckle, a waist
   * strap and leg loops round the tops of the thighs.
   */
  private makeHarness() {
    const sc = this.scene, root = this.view.root;
    const web = new StandardMaterial("dropWebbing", sc);
    web.diffuseColor = new Color3(0.09, 0.092, 0.088);
    web.emissiveColor = new Color3(0.02, 0.02, 0.02);
    web.specularColor = new Color3(0.05, 0.05, 0.05);
    const steel = mat(sc, [0.45, 0.46, 0.48]);
    /** A flat strap (width w, thickness d) from a to b; `face` turns its flat side. */
    const strap = (a: Vector3, b: Vector3, w: number, d: number, list: Mesh[], face = 0) => {
      const m = MeshBuilder.CreateBox("dropWeb", { width: w, height: 1, depth: d }, sc);
      m.material = web;
      m.parent = root;
      m.isPickable = false;
      this.limb(m, this.fit(a), this.fit(b));
      if (face) m.rotationQuaternion = m.rotationQuaternion!.multiply(Quaternion.RotationAxis(Vector3.Up(), face));
      list.push(m);
      return m;
    };
    const SY = SHOULDER_Y;
    for (const side of [-1, 1]) {
      // risers and the link where the lines meet
      const link = this.linkPoint(side);
      for (const dz of [0.035, -0.035]) strap(new Vector3(side * 0.27, SY + 0.02, -0.03 + dz), this.unfit(link.add(new Vector3(0, -0.06, dz * 0.4))), 0.045, 0.012, this.risers);
      const ring = MeshBuilder.CreateTorus("dropLink", { diameter: 0.07, thickness: 0.018, tessellation: 10 }, sc);
      ring.material = steel;
      ring.parent = root;
      ring.position.copyFrom(link.add(new Vector3(0, -0.04, 0)));  // (linkPoint() is fitted already)
      ring.rotation.z = Math.PI / 2;
      this.risers.push(ring);
      const cuff = MeshBuilder.CreateCylinder("dropCuff", { height: 0.12, diameter: 0.06, tessellation: 8 }, sc); // the band round the bundle
      cuff.material = web;
      cuff.parent = root;
      cuff.position.copyFrom(link.add(new Vector3(0, 0.06, 0)));
      this.risers.push(cuff);
      // harness: over the shoulder and down the chest to the leg loop
      strap(new Vector3(side * 0.24, SY + 0.03, -0.12), new Vector3(side * 0.2, SY + 0.04, 0.12), 0.06, 0.02, this.harness);
      strap(new Vector3(side * 0.2, SY + 0.02, 0.15), new Vector3(side * 0.13, HIP_Y + 0.05, 0.27), 0.06, 0.02, this.harness);
      // leg loop round the top of the thigh
      strap(new Vector3(side * 0.13, HIP_Y + 0.05, 0.27), new Vector3(side * 0.27, HIP_Y - 0.12, 0.08), 0.05, 0.02, this.harness);
      strap(new Vector3(side * 0.27, HIP_Y - 0.12, 0.08), new Vector3(side * 0.16, HIP_Y - 0.08, -0.17), 0.05, 0.02, this.harness);
    }
    // chest strap with its buckle, waist strap
    strap(new Vector3(-0.19, SY - 0.4, 0.28), new Vector3(0.19, SY - 0.4, 0.28), 0.05, 0.02, this.harness, Math.PI / 2);
    const buckle = MeshBuilder.CreateBox("dropBuckle", { width: 0.07, height: 0.06, depth: 0.025 }, sc);
    buckle.material = steel;
    buckle.parent = root;
    buckle.position.copyFrom(this.fit(new Vector3(0, SY - 0.4, 0.295)));
    this.harness.push(buckle);
    strap(new Vector3(-0.24, HIP_Y + 0.22, 0.2), new Vector3(0.24, HIP_Y + 0.22, 0.2), 0.05, 0.02, this.harness, Math.PI / 2);
    for (const m of this.risers) m.setEnabled(false);
  }

  /** Where the lines of one side meet, above the shoulder (figure frame). */
  private linkPoint(side: number): Vector3 {
    return this.fit(new Vector3(side * 0.22, SHOULDER_Y + 0.72, -0.05));
  }

  /**
   * A point on the built figure (where the rig, pack and wingsuit were laid out) moved onto the
   * rigged figure's build: hips at the same height, lower and narrower shoulders standing higher
   * out of the vest, a slimmer chest set a little forward.
   */
  private fit(v: Vector3): Vector3 {
    if (!this.rigged) return v.clone();
    const top = this.rigFit.shoulder;
    const k = Math.min(1, Math.max(0, (v.y - HIP_Y) / (SHOULDER_Y - HIP_Y)));
    const y = (v.y <= HIP_Y ? v.y : v.y >= SHOULDER_Y ? v.y - SHOULDER_Y + top : HIP_Y + (v.y - HIP_Y) * (top - HIP_Y) / (SHOULDER_Y - HIP_Y))
      + 0.12 * smoothstep(SHOULDER_Y - 0.3, SHOULDER_Y, v.y);
    return new Vector3(v.x * (0.82 - 0.22 * k), y, 0.054 + 0.773 * v.z);
  }

  /** The inverse of fit() (for points already fitted). */
  private unfit(v: Vector3): Vector3 {
    if (!this.rigged) return v.clone();
    // solved numerically: a few fixed-point steps are plenty for the smooth map
    const g = v.clone();
    for (let i = 0; i < 6; i++) g.addInPlace(v.subtract(this.fit(g)).multiplyByFloats(1.4, 1, 1.29));
    return g;
  }
  private readonly rigFit = { shoulder: 0 };

  /** Lays a cylinder (height 1 along y) between two points. */
  private limb(m: Mesh, a: Vector3, b: Vector3) {
    const d = b.subtract(a), len = d.length();
    m.position.copyFrom(a.add(b).scale(0.5));
    m.scaling.set(1, Math.max(0.01, len), 1);
    const dir = d.scale(1 / Math.max(1e-6, len));
    const axis = Vector3.Cross(Vector3.Up(), dir);
    const al = axis.length();
    m.rotationQuaternion = al < 1e-5 ? (dir.y > 0 ? Quaternion.Identity() : Quaternion.RotationAxis(Vector3.Right(), Math.PI)) : Quaternion.RotationAxis(axis.scale(1 / al), Math.acos(Math.min(1, Math.max(-1, dir.y))));
  }

  // ------------------------------------------------------------------ parachute

  private lineSet(): Vector3[][] {
    const out: Vector3[][] = [];
    for (let i = 0; i < 16; i++) out.push([Vector3.Zero(), new Vector3(0, 0.01 * (i + 1), 0)]);
    return out;
  }

  private chute(t: number) {
    if (t < T.open) return;
    const e = Math.min(1, (t - T.open) / 1.3);
    const grow = e < 1 ? 1 - Math.pow(1 - e, 3) + Math.sin(e * Math.PI) * 0.12 : 1;
    this.canopy.setEnabled(true);
    const p = this.position(t);
    const f = new Vector3(Math.sin(this.fly.rotation.y), 0, Math.cos(this.fly.rotation.y));
    const above = p.add(new Vector3(0, 6.3, 0)).subtract(f.scale(0.3));
    const trail = p.add(new Vector3(0, 1, 0)).subtract(f.scale(2.5));
    const open = 1 - Math.pow(1 - e, 2);
    const pos = Vector3.Lerp(trail, above, open);
    // after touchdown the canopy sinks down behind the agent and lies there
    const c = ease(T.touch, T.touch + 3, t);
    if (t < T.touch) this.touchPos.copyFrom(pos);
    const ground = this.landedCanopy();
    this.canopy.position.copyFrom(Vector3.Lerp(c > 0 ? this.touchPos : pos, ground, c));
    const sw = Math.sin(t * 0.9) * 0.05 * (1 - c);
    this.canopy.rotation.set(0.12 * (1 - c) + sw, this.fly.rotation.y, Math.sin(t * 1.3) * 0.04 * (1 - c));
    // collapsed on the ground: bunched up along its span, no longer glowing against the sky
    const wide = 9 * grow;
    this.canopy.scaling.set(wide * lerp(1, 0.72, c), Math.max(0.05, 3.6 * grow * lerp(1, 0.07, c)), wide * lerp(1, 1.1, c));
    // once down, the flat canopy gives way to the crumpled heap with its lines
    if (c > 0.55) {
      this.makePile();
      const k = Math.min(1, (c - 0.55) / 0.35);
      this.canopy.visibility = 1 - k;
      for (const m of this.pile!) m.visibility = k;
      if (k >= 1) this.canopy.setEnabled(false);
    }

    // lines from the canopy's rim to the harness
    if (!this.linesOn) return;
    this.fly.computeWorldMatrix(true);
    this.body.computeWorldMatrix(true);
    this.view.root.computeWorldMatrix(true);
    this.canopy.computeWorldMatrix(true);
    const rW = this.view.root.getWorldMatrix(), cW = this.canopy.getWorldMatrix();
    const lines: Vector3[][] = [];
    // four line groups on each side, each at the leading and at the trailing edge of the
    // canopy's underside, down to the front and rear risers
    for (let i = 0; i < 16; i++) {
      const side = i % 8 < 4 ? -1 : 1;
      const x = side * (0.07 + (i % 4) * 0.13);
      const front = i < 8;
      const rim = Vector3.TransformCoordinates(new Vector3(x, canopyArc(x), front ? 0.17 : -0.18), cW);
      // all lines of a side gather in its connector link above the shoulder
      const link = this.linkPoint(side).add(new Vector3(0, 0.12, front ? 0.01 : -0.01));
      const harness = Vector3.TransformCoordinates(link, rW);
      lines.push([rim, harness]);
    }
    this.canopyLines = MeshBuilder.CreateLineSystem("dropLines", { lines, instance: this.canopyLines as never }, this.scene) as unknown as Mesh;
    this.canopyLines.setEnabled(t >= T.open + 0.15);
    for (const m of this.risers) m.setEnabled(t >= T.open + 0.15);
  }

  /**
   * The canopy as it lies after the landing: a crumpled heap of cloth (irregular outline, longer
   * across than deep, folds and creases, higher in the middle) draped over the ground, and its lines
   * running across the grass towards the spot where the agent unclipped them.
   */
  private makePile() {
    if (this.pile) return;
    const sc = this.scene, T0 = this.terrain;
    const c = this.landedCanopy();
    const ang = Math.atan2(this.landDir.x, this.landDir.z);
    const fx = Math.sin(ang), fz = Math.cos(ang); // towards the agent
    const rx = fz, rz = -fx; // across
    const rings = 16, segs = 48;
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    for (let k = 0; k <= rings; k++) {
      const f = k / rings;
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        // outline: wider across (the span), with lobes where cloth spilled out
        const R = 1 + valueNoise(Math.cos(a) * 1.6 + 3, Math.sin(a) * 1.6, 41) * 0.35 + Math.sin(a * 3 + 1) * 0.08;
        const lx = Math.cos(a) * f * R * 2.3, lz = Math.sin(a) * f * R * 1.5;
        const x = c.x + rx * lx + fx * lz, z = c.z + rz * lx + fz * lz;
        // a heap: highest inside, with folds and creases
        const dome = Math.pow(1 - f * f, 0.8) * 0.55 * (0.7 + 0.3 * valueNoise(x * 0.9, z * 0.9, 42));
        const folds = Math.abs(Math.sin(lx * 3.1 + valueNoise(x * 1.5, z * 1.5, 43) * 3)) * 0.12 * (1 - f * 0.6);
        const crinkle = valueNoise(x * 6, z * 6, 44) * 0.04 + valueNoise(x * 14, z * 14, 45) * 0.015;
        const h = 0.03 + Math.max(0, dome + folds + crinkle) * (k === rings ? 0.15 : 1);
        pos.push(x, T0.heightAt(x, z) + h, z);
        const sh = 0.6 + folds * 2.6 + crinkle * 5 + dome * 0.4;
        col.push(sh, sh, sh * 1.02, 1);
      }
    }
    for (let k = 0; k < rings; k++) {
      for (let j = 0; j < segs; j++) {
        const a = k * segs + j, b = k * segs + ((j + 1) % segs), cc = (k + 1) * segs + ((j + 1) % segs), d = (k + 1) * segs + j;
        idx.push(a, cc, b, a, d, cc);
      }
    }
    const nor: number[] = [];
    VertexData.ComputeNormals(pos, idx, nor);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nor;
    vd.colors = col;
    const heap = new Mesh("canopyHeap", sc);
    vd.applyToMesh(heap);
    const mt = nylon(sc, "canopyHeapMat", [0.14, 0.145, 0.135], 0.05, 0.35);
    heap.material = mt;
    heap.isPickable = false;
    heap.receiveShadows = true;
    // the lines: from the heap's edge facing the agent, in loose curves over the grass to where he stood
    const lineMat = new StandardMaterial("canopyCordMat", sc);
    lineMat.diffuseColor = new Color3(0.15, 0.155, 0.145); // dark like the canopy
    lineMat.emissiveColor = new Color3(0.015, 0.015, 0.014);
    lineMat.specularColor = Color3.Black();
    const end = new Vector3(this.land.x - fx * 0.9, 0, this.land.z - fz * 0.9);
    const out: Mesh[] = [heap];
    for (let i = 0; i < 16; i++) {
      const s = (i % 8 - 3.5) / 3.5 + (i < 8 ? -0.06 : 0.06);
      const sx = c.x + rx * s * 1.9 + fx * (1.2 - Math.abs(s) * 0.4), sz = c.z + rz * s * 1.9 + fz * (1.2 - Math.abs(s) * 0.4);
      const ex = end.x + rx * s * 0.25, ez = end.z + rz * s * 0.25;
      const path: Vector3[] = [];
      for (let k = 0; k <= 14; k++) {
        const t = k / 14;
        const wob = Math.sin(t * Math.PI * (2 + (i % 3))) * 0.35 * Math.sin(t * Math.PI) + valueNoise(i * 3.1, t * 4, 46) * 0.2;
        const x = lerp(sx, ex, t) + rx * wob, z = lerp(sz, ez, t) + rz * wob;
        path.push(new Vector3(x, T0.heightAt(x, z) + 0.03, z));
      }
      const tube = MeshBuilder.CreateTube("canopyCord", { path, radius: 0.012, tessellation: 4 }, sc);
      tube.material = lineMat;
      tube.isPickable = false;
      out.push(tube);
    }
    for (const m of out) m.visibility = 0;
    this.light.includedOnlyMeshes.push(...out);
    this.pile = out;
  }

  /** Where the collapsed canopy lies: behind the landing spot. */
  private landedCanopy(): Vector3 {
    const g = this.land.clone();
    g.x -= this.landDir.x * 5.2;
    g.z -= this.landDir.z * 5.2;
    g.y = this.terrain.heightAt(g.x, g.z) + 0.25;
    return g;
  }

  // ------------------------------------------------------------------ shedding

  private startShed() {
    this.view.root.computeWorldMatrix(true);
    const o = this.view.root.getAbsolutePosition();
    this.shedNode.position.copyFrom(o);
    this.shedNode.rotation.set(0, this.fly.rotation.y, 0);
    this.membrane.parent = this.shedNode;
    this.pack.parent = this.shedNode;
    for (const m of [...this.harness, ...this.risers]) m.setEnabled(false); // he steps out of the harness with the suit
    this.shedT = 0;
    this.packVy = 0;
  }

  private shedStep(dt: number) {
    if (this.shedT < 0) return;
    this.shedT += dt;
    const f = Math.min(1, this.shedT / 0.85);
    this.shedNode.rotation.x = -(Math.PI / 2) * f * f;
    const ground = this.terrain.heightAt(this.shedNode.position.x, this.shedNode.position.z);
    this.shedNode.position.y = Math.max(ground + 0.04, this.shedNode.position.y - dt * 2 * f);
    if (f >= 1) {
      this.shedNode.position.y = ground + 0.04;
      this.settleSuit();
    }
    // the stretched membrane gives way to the crumpled suit
    if (this.dropped) {
      const k = Math.min(1, (this.shedT - 0.85) / 0.35);
      this.dropped.visibility = k;
      this.membrane.visibility = 1 - k;
      if (k >= 1) this.membrane.setEnabled(false);
    }
  }

  /** Lays the empty wingsuit on the ground where the fallen membrane lies (behind the agent). */
  private settleSuit() {
    if (this.dropped) return;
    this.shedNode.computeWorldMatrix(true);
    // the hips of the fallen suit: the figure's hip point after the fall backwards
    const hip = Vector3.TransformCoordinates(new Vector3(0, HIP_Y, 0), this.shedNode.getWorldMatrix());
    // head away from the agent, a little askew
    const rotY = this.shedNode.rotation.y + Math.PI + 0.25;
    const mt = new StandardMaterial("droppedSuitMat", this.scene);
    mt.diffuseColor = new Color3(0.14, 0.145, 0.135); // as dark as the suit was in the air
    mt.metadata = { rough: 0.35, metal: 0.35 };
    mt.diffuseTexture = this.suitMat.diffuseTexture;
    mt.specularColor = new Color3(0.12, 0.13, 0.14); // the coated nylon glints a little in the moonlight
    mt.specularPower = 40;
    mt.backFaceCulling = false;
    this.dropped = droppedSuit(this.scene, this.terrain, hip, rotY, mt);
    this.dropped.visibility = 0;
    this.light.includedOnlyMeshes.push(this.dropped);
  }

  // ------------------------------------------------------------------ camera

  private cameraFor(t: number, dt: number) {
    const p = this.position(t);
    // the camera follows a smoothed flight direction: in the bends of the path it would otherwise
    // swing far round (it circles him at a distance)
    if (this.camPsi === null) this.camPsi = this.fly.rotation.y;
    const turn = Math.atan2(Math.sin(this.fly.rotation.y - this.camPsi), Math.cos(this.fly.rotation.y - this.camPsi));
    this.camPsi += turn * Math.min(1, dt * 0.9);
    const psi = this.camPsi;
    const f = new Vector3(Math.sin(psi), 0, Math.cos(psi));
    const r = new Vector3(f.z, 0, -f.x);
    const up = Vector3.Up();
    let pos: Vector3, look: Vector3, fov: number, k: number;

    // A: chase shot circling from the front round to the back - from a little below and far off
    // with a long lens: the agent stands against the night sky, the land far below (and what lies
    // beyond the map's edge) stays out of the frame
    const phi = lerp(0.5, 2.7, ease(0, 6.5, t));
    const dist = lerp(16, 26, ease(0, 7, t));
    // (as he gets lower the camera rises to his height, so it never scrapes over the hills below)
    const below = lerp(4.5, 6.5, ease(0, 6, t)) * ease(45, 110, altitude(t)) - 2 * (1 - ease(45, 110, altitude(t)));
    const A = p.add(f.scale(Math.cos(phi) * dist)).add(r.scale(Math.sin(phi) * dist)).subtract(up.scale(below));
    const aLook = p.add(f.scale(0.5)).subtract(up.scale(0.25)); // on his body (he lies flat in the air)
    // B: from behind and below while the canopy opens above him, still against the sky
    const B = p.subtract(f.scale(30)).add(r.scale(11)).subtract(up.scale(3));
    const bLook = p.add(up.scale(4.5));
    // C: from the side, high above the outposts which lie to the other side
    const C = p.add(r.scale(24)).add(up.scale(15)).subtract(f.scale(9));
    const cLook = p.subtract(r.scale(7)).subtract(up.scale(4));
    // D: low at the landing spot, first from the front, then from the side
    const gl = this.land;
    const gh = this.terrain.heightAt(gl.x, gl.z);
    const D1 = this.d1, D2 = this.d2;
    const dLook1 = new Vector3(gl.x, gh + lerp(3, 1.3, ease(T.touch - 2, T.touch + 0.5, t)), gl.z);
    const dLook2 = new Vector3(gl.x, gh + lerp(1.35, 0.85, crouchW(t)), gl.z);

    const ab = ease(T.aEnd - 0.5, T.aEnd + 0.8, t);
    const bc = ease(T.bEnd - 0.5, T.bEnd + 2.5, t);
    const cd = ease(T.flare - 3, T.touch - 0.8, t);
    const dd = ease(T.unclip, T.shed + 1.2, t);
    const lerpV = (a: Vector3, b: Vector3, w: number) => Vector3.Lerp(a, b, w);
    pos = lerpV(lerpV(lerpV(A, B, ab), C, bc), lerpV(D1, D2, dd), cd);
    look = lerpV(lerpV(lerpV(aLook, bLook, ab), cLook, bc), lerpV(dLook1, dLook2, dd), cd);
    // long lens (narrow field) in the sky, wider once the land below is the subject
    fov = lerp(lerp(lerp(0.42, 0.5, ab), 0.85, bc), lerp(0.7, 0.66, dd), cd);
    // smooth: the chase follows closely, the moves between shots are slow sweeps
    k = t < T.aEnd - 0.5 ? 7 : t < T.bEnd + 3 ? 3 : 2.6;
    if (cd > 0.05) k = 3.5;
    if (this.shake > 0) {
      const s = this.shake * 0.35;
      pos = pos.add(new Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    pos.y = Math.max(pos.y, this.terrain.heightAt(pos.x, pos.z) + 0.9);

    const w = this.camInit ? 1 - Math.exp(-k * dt) : 1;
    this.camInit = true;
    Vector3.LerpToRef(this.camPos, pos, w, this.camPos);
    // the aim stays on him: in the fast fall a lagging aim would leave him at the bottom of the frame
    const wLook = w >= 1 ? 1 : 1 - Math.exp(-(t < T.aEnd ? 40 : k * 1.5) * dt);
    Vector3.LerpToRef(this.camLook, look, wLook, this.camLook);
    this.camFov += (fov - this.camFov) * w;
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(this.camLook);
    this.camera.fov = this.camFov;
  }

  // ------------------------------------------------------------------ subtitles

  private subtitle(i: number) {
    if (i === this.spoken) return;
    this.spoken = i;
    this.subEl.classList.remove("show");
    if (i < 0) return;
    window.setTimeout(() => {
      if (this.finished) return;
      this.subEl.textContent = this.lines[i];
      this.subEl.classList.add("show");
    }, 120);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    this.once("brief", 2.2, () => {
      this.speech = this.audio.briefing(this.lines, (i) => this.subtitle(i));
    });
    // no voice (or it never starts): subtitles follow the clock
    if (t > 2.2 && (!this.speech || (this.spoken < 0 && t > 6))) {
      const starts = [2.4, 9.0, 16];
      let i = -1;
      starts.forEach((s, n) => { if (t >= s) i = n; });
      this.subtitle(i);
    }
    if (t > T.end - 2) this.subtitle(-1);

    this.place(t);
    this.pose(t);
    this.once("open", T.open, () => { this.audio.chuteOpen(); this.shake = 1; });
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.chute(t);
    this.once("touch", T.touch, () => this.audio.landThud());
    this.once("unclip", T.unclip, () => {
      this.audio.clothRustle(0.5);
      this.linesOn = false;
      this.canopyLines.setEnabled(false);
      for (const m of this.risers) m.setEnabled(false); // the risers are released with the canopy
    });
    this.once("shed", T.shed, () => {
      this.audio.clothRustle(1.1);
      this.startShed();
    });
    this.once("rifle", T.rifle, () => {
      for (const m of [...this.limbs, ...this.hands]) m.setEnabled(false);
      this.parts.arms.setEnabled(true);
    });
    // working the bolt and the safety while he looks the rifle over
    this.once("check", T.check + 0.35, () => this.audio.rifleReady());
    if (t >= T.rifle) {
      // the rifle comes up out of the carry; in the crouch it is raised and rolled to be looked over
      const up = ease(T.rifle + 0.1, T.rifle + 0.9, t);
      const c = crouchW(t), w = checkW(t);
      this.parts.arms.rotation.set(
        lerp(0.05, 0.3, up) - SQUAT.lean * 0.6 * c - w * (0.55 + Math.sin(t * 1.3) * 0.08),
        lerp(0, -0.28, up) + 0.15 * w,
        lerp(0, 0.1, up) + w * (0.5 + Math.sin(t * 0.9) * 0.15),
      );
      this.parts.arms.position.y = SHOULDER_Y - HIP_Y;
      this.rigged?.applyPose(t, crouchW(t));
    }
    this.shedStep(dt);
    this.cameraFor(t, dt);

    // wind: rushing in the fall, a soft breeze under the canopy, gone at touchdown
    const fall = 1 - ease(T.aEnd, T.open + 1.2, t);
    const level = (t < T.touch ? lerp(0.16, 1, fall) * (0.88 + 0.12 * Math.sin(t * 7.3)) : 0) * (t < 1.5 ? t / 1.5 : 1);
    this.audio.windSet(level, lerp(0.35, 0.95, fall));

    if (t >= T.end && !this.endTimer) {
      this.endTimer = 1;
      this.fadeEl.style.opacity = "1";
      window.setTimeout(() => this.finish(), FADE * 1000);
    }
  }

  skip() {
    if (!this.active || this.finished) return;
    this.fadeEl.style.opacity = "1";
    this.audio.windStop();
    this.audio.stopSpeech();
    this.t = T.end + 1;
    this.endTimer = 1;
    window.setTimeout(() => {
      this.layoutLanded();
      this.finish();
    }, FADE * 1000);
  }

  /** The leftovers lie where they landed (also when the scene is skipped). */
  private layoutLanded() {
    this.canopy.setEnabled(false);
    this.makePile();
    for (const m of this.pile!) m.visibility = 1;
    this.canopyLines.setEnabled(false);
    if (this.shedT < 0) {
      this.view.root.parent = this.body;
      this.fly.position.set(this.land.x, this.terrain.heightAt(this.land.x, this.land.z) + HIP_Y, this.land.z);
      this.fly.rotation.set(0, Math.atan2(this.landDir.x, this.landDir.z), 0);
      this.body.rotation.x = 0;
      this.startShed();
    }
    this.shedNode.rotation.x = -Math.PI / 2;
    this.shedNode.position.y = this.terrain.heightAt(this.shedNode.position.x, this.shedNode.position.z) + 0.04;
    this.settleSuit();
    this.dropped!.visibility = 1;
    this.membrane.setEnabled(false);
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    this.audio.windStop();
    this.audio.stopSpeech();
    // hand the agent's figure back to the game
    const v = this.view, p = this.parts;
    v.root.parent = null;
    p.arms.setEnabled(true);
    p.shadow.setEnabled(true);
    p.arms.position.y = SHOULDER_Y - HIP_Y;
    p.legL.rotation.set(0, 0, 0);
    p.legR.rotation.set(0, 0, 0);
    p.shinL.rotation.set(0, 0, 0);
    p.shinR.rotation.set(0, 0, 0);
    p.head.rotation.set(0, 0, 0);
    p.torso.rotation.set(0, 0, 0);
    if (this.rigged) this.rigged.armTargets = null;
    this.camera.fov = this.baseFov;
    for (const m of [...this.limbs, ...this.hands, ...this.clouds, ...this.harness, ...this.risers]) m.dispose();
    this.fly.dispose();
    this.body.dispose();
    this.subEl.classList.remove("show");
    this.onDone();
    // fade back in (the letterbox bars went with the body class)
    this.fadeEl.style.opacity = "0";
    window.setTimeout(() => (this.rootEl.hidden = true), FADE * 1000 + 100);
  }

  /** Removes what the scene left on the ground (back to the menu). */
  dispose() {
    this.active = false;
    this.finished = true;
    this.audio.windStop();
    this.audio.stopSpeech();
    this.rootEl.hidden = true;
    for (const n of [this.light, this.canopy, this.canopyLines, this.membrane, this.pack, this.shedNode, this.fly, this.body] as { dispose(): void }[]) n.dispose();
    this.dropped?.dispose();
    for (const m of [...this.clouds, ...this.harness, ...this.risers]) if (!m.isDisposed()) m.dispose();
    for (const m of this.pile ?? []) m.dispose();
    for (const m of [...this.limbs, ...this.hands]) if (!m.isDisposed()) m.dispose();
  }
}
