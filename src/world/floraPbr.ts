import {
  Color3, DynamicTexture, Material, Matrix, Mesh, MeshBuilder, ShaderStore, StandardMaterial, Texture, VertexBuffer, VertexData,
  type Scene, type ShadowGenerator,
} from "@babylonjs/core";
import { rng, valueNoise } from "../util/noise";
import type { RGB } from "./layout";

/**
 * Babylon multiplies the instance colour into the vertex colour whenever a mesh has both, even in
 * a pass drawn without instancing, where the attribute is not declared and the shader fails to
 * compile. Our plants have both (shading per vertex, tint per instance): guard the line. Applied
 * when the plants are built - the shader chunks are loaded on demand, by then they are there.
 */
function guardInstanceColors() {
  const inc = ShaderStore.IncludesShadersStore;
  const code = inc.vertexColorMixing;
  if (code) inc.vertexColorMixing = code.replace("#ifdef INSTANCESCOLOR\nvColor*=instanceColor;", "#if defined(INSTANCESCOLOR) && defined(INSTANCES)\nvColor*=instanceColor;");
}

/**
 * Plants of the realistic graphics mode: low-poly but more natural trees (broadleaf crowns of
 * several leafy clumps with a cut-out leaf shell, layered firs) and cereal plants instead of the
 * square tufts on the fields. They use the very same placements as the classic plants (thin
 * instances, one draw call per template) and are only built when the mode is first switched on.
 */

// ------------------------------------------------------------------ geometry helpers

/** Growing vertex lists of one template mesh. */
class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: RGB, u = 0, v = 0): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nor.push(nx / l, ny / l, nz / l);
    this.col.push(shade[0], shade[1], shade[2], 1);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  build(name: string, scene: Scene): Mesh {
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.pos;
    vd.normals = this.nor;
    vd.colors = this.col;
    vd.uvs = this.uv;
    vd.indices = this.idx;
    vd.applyToMesh(m);
    return m;
  }
}

const shadeOf = (k: number, warm = 0): RGB => [k * (1 + warm), k, k * (1 - warm)];

/** Unit icosphere (positions, indices, uvs) used for the leaf clumps. */
function sphere(scene: Scene, subdivisions: number) {
  const s = MeshBuilder.CreateIcoSphere("tmp", { radius: 1, subdivisions }, scene);
  const data = {
    pos: s.getVerticesData(VertexBuffer.PositionKind)!,
    idx: s.getIndices()!,
    uv: s.getVerticesData(VertexBuffer.UVKind)!,
  };
  s.dispose();
  return data;
}

/**
 * Leaf texture: hundreds of small leaves (light grey, tinted per tree by the instance colour) on a
 * transparent ground, so the crown's outer shell gets a ragged, leafy outline.
 */
const leafTextures = new WeakMap<Scene, DynamicTexture>();

function leafTexture(scene: Scene): DynamicTexture {
  const cached = leafTextures.get(scene);
  if (cached) return cached;
  const size = 256;
  const tex = new DynamicTexture("leaves", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const r = rng(77);
  for (let i = 0; i < 520; i++) {
    const x = r() * size, y = r() * size, len = 7 + r() * 7, a = r() * Math.PI * 2;
    const v = 170 + Math.floor(r() * 85);
    // some leaves a little warmer or greener than the rest
    const warm = (r() - 0.5) * 40;
    ctx.fillStyle = `rgb(${Math.min(255, v + warm)}, ${v}, ${Math.max(0, v - warm * 1.4)})`;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      // tile seamlessly: leaves crossing an edge are drawn on the other side as well
      ctx.save();
      ctx.translate(x + ox, y + oy);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.quadraticCurveTo(0, -len * 0.38, len / 2, 0);
      ctx.quadraticCurveTo(0, len * 0.38, -len / 2, 0);
      ctx.fill();
      ctx.restore();
    }
  }
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.uScale = tex.vScale = 2.5;
  leafTextures.set(scene, tex);
  return tex;
}

// ------------------------------------------------------------------ tree templates

interface Clump { x: number; y: number; z: number; r: number }

/** The clumps of a broadleaf crown (unit tree: trunk up to ~2.4 m, crown ~2.4..5.6 m). */
function crownClumps(seed: number): Clump[] {
  const r = rng(seed);
  const clumps: Clump[] = [{ x: 0, y: 3.95, z: 0, r: 1.3 }];
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.6;
    const d = 0.85 + r() * 0.3;
    clumps.push({ x: Math.cos(a) * d, y: 3.3 + r() * 0.7, z: Math.sin(a) * d, r: 0.85 + r() * 0.3 });
  }
  clumps.push({ x: (r() - 0.5) * 0.5, y: 4.75, z: (r() - 0.5) * 0.5, r: 0.85 });
  return clumps;
}

/**
 * One layer of a broadleaf crown: lumpy spheres (noise-displaced) whose normals lean towards the
 * crown's centre direction, which makes the foliage shade softly as one mass. Darker underneath
 * and inside (baked ambient occlusion). `grow` scales the clumps (the leaf shell sits outside).
 */
function crownLayer(scene: Scene, name: string, clumps: Clump[], subdivisions: number, grow: number, dark: number, seed: number): Mesh {
  const g = new Geo();
  const s = sphere(scene, subdivisions);
  const cy = 3.9;
  clumps.forEach((c, ci) => {
    const base = g.pos.length / 3;
    for (let v = 0; v < s.pos.length / 3; v++) {
      const dx = s.pos[v * 3], dy = s.pos[v * 3 + 1], dz = s.pos[v * 3 + 2];
      const bump = 1 + valueNoise(dx * 1.6 + ci * 3.1 + dy, dz * 1.6 - dy * 1.3, seed) * 0.2;
      const rr = c.r * grow * bump;
      const x = c.x + dx * rr, y = c.y + dy * rr * 0.92, z = c.z + dz * rr;
      // normal: mostly away from the crown's centre, a little from the clump's own surface
      const ox = x, oy = (y - cy) * 0.8, oz = z;
      const ol = Math.hypot(ox, oy, oz) || 1;
      const nx = (ox / ol) * 0.7 + dx * 0.3, ny = (oy / ol) * 0.7 + dy * 0.3 + 0.15, nz = (oz / ol) * 0.7 + dz * 0.3;
      const up = Math.min(1, Math.max(0, (y - 2.5) / 3));
      const k = dark * (0.5 + 0.5 * up) * (0.9 + valueNoise(x * 2, z * 2 + y, seed + 5) * 0.12);
      g.vertex(x, y, z, nx, ny, nz, shadeOf(k, valueNoise(x, z, seed + 9) * 0.06), s.uv[v * 2] + ci * 0.37, s.uv[v * 2 + 1] + ci * 0.21);
    }
    for (let i = 0; i < s.idx.length; i += 3) g.tri(base + s.idx[i], base + s.idx[i + 1], base + s.idx[i + 2]);
  });
  return g.build(name, scene);
}

/** Tapered trunk with three branches reaching into the crown. */
function broadleafTrunk(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const trunk = MeshBuilder.CreateCylinder("t", { height: 3.2, diameterTop: 0.16, diameterBottom: 0.42, tessellation: 7 }, scene);
  trunk.position.y = 1.6;
  parts.push(trunk);
  for (let k = 0; k < 3; k++) {
    const b = MeshBuilder.CreateCylinder("b", { height: 1.5, diameterTop: 0.05, diameterBottom: 0.14, tessellation: 5 }, scene);
    const a = (k / 3) * Math.PI * 2 + 0.4;
    b.position.set(Math.cos(a) * 0.38, 2.55 + k * 0.2, Math.sin(a) * 0.38);
    b.rotation.set(Math.sin(a) * 0.75, 0, -Math.cos(a) * 0.75);
    parts.push(b);
  }
  const m = Mesh.MergeMeshes(parts, true)!;
  m.name = "trunkReal";
  return m;
}

/**
 * Fir: stacked drooping tiers with star-shaped (twiggy) rims, lighter at the tips and dark
 * underneath, topped by a slim tip.
 */
function firMesh(scene: Scene, seed: number): Mesh {
  const g = new Geo();
  const r = rng(seed);
  const tiers = 6, spikes = 9;
  for (let t = 0; t < tiers; t++) {
    const k = t / (tiers - 1);
    const yBottom = 1.4 + t * 0.95, yTop = yBottom + 1.55 - k * 0.3;
    const R = 1.75 - k * 1.2;
    const turn = r() * Math.PI;
    const apex = g.vertex(0, yTop, 0, 0, 1, 0, shadeOf(0.95));
    const under = g.vertex(0, yBottom + 0.45, 0, 0, -1, 0, shadeOf(0.35));
    const ring: number[] = [], ringUnder: number[] = [];
    for (let i = 0; i < spikes * 2; i++) {
      const a = turn + (i / (spikes * 2)) * Math.PI * 2;
      const spike = i % 2 === 0;
      const rr = R * (spike ? 1 + (r() - 0.5) * 0.15 : 0.68);
      const y = yBottom - (spike ? 0.18 : 0) + (r() - 0.5) * 0.1;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      ring.push(g.vertex(x, y, z, Math.cos(a) * 0.7, 0.75, Math.sin(a) * 0.7, shadeOf(spike ? 0.82 : 0.6, 0.02)));
      ringUnder.push(g.vertex(x, y, z, Math.cos(a) * 0.4, -0.6, Math.sin(a) * 0.4, shadeOf(0.4)));
    }
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      g.tri(apex, ring[j], ring[i]);
      g.tri(under, ringUnder[i], ringUnder[j]);
    }
  }
  // slim tip
  const tip = g.vertex(0, 8.1, 0, 0, 1, 0, shadeOf(1));
  const base: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    base.push(g.vertex(Math.cos(a) * 0.28, 6.7, Math.sin(a) * 0.28, Math.cos(a), 0.5, Math.sin(a), shadeOf(0.8)));
  }
  for (let i = 0; i < 5; i++) g.tri(tip, base[(i + 1) % 5], base[i]);
  return g.build("firReal", scene);
}

// ------------------------------------------------------------------ crop templates

/**
 * Cereal plant (scaled per instance like the classic tuft, whose footprint is ~0.3 m): a few
 * stalks leaning outwards, each a thin blade with an ear on top. The ear is a slim four-sided
 * spindle tilted along the lean, so from above it reads as a golden grain. Seen from high up the
 * field becomes a stippled carpet of ears over the stripes. Normals point mostly up so both sides
 * of the blades shade alike.
 */
function cerealMesh(scene: Scene, ears: boolean, seed: number): Mesh {
  const g = new Geo();
  const r = rng(seed);
  const stalks = ears ? 4 : 5;
  // the template is wider than the classic tuft so the plants fill the rows
  const W = 1.7;
  for (let s = 0; s < stalks; s++) {
    const a = (s / stalks) * Math.PI * 2 + r() * 0.6;
    const d = (0.08 + r() * 0.2) * W;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const lean = (ears ? 0.18 + r() * 0.14 : 0.3 + r() * 0.2) * W;
    // ripe cereal stands taller than the classic tufts
    const h = (ears ? 1.9 : 1.2) * (0.75 + r() * 0.3);
    const top = ears ? h * 0.7 : h;
    const tx = bx + Math.cos(a) * lean * (top / h), tz = bz + Math.sin(a) * lean * (top / h);
    const w = ears ? 0.05 : 0.16;
    // the blade faces sideways to its lean so it is seen from above as well
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const n: [number, number, number] = [Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35];
    const v0 = g.vertex(bx - px, 0, bz - pz, ...n, shadeOf(0.42));
    const v1 = g.vertex(bx + px, 0, bz + pz, ...n, shadeOf(0.42));
    const v2 = g.vertex(tx, top, tz, ...n, shadeOf(ears ? 0.95 : 1.05));
    g.tri(v0, v1, v2);
    if (!ears) continue;
    // ear: spindle from the stalk's top further along the lean, four faces each side
    const len = 0.3 * h, ew = 0.08 * W;
    const ex = tx + Math.cos(a) * len * 0.45, ez = tz + Math.sin(a) * len * 0.45, ey = top + len * 0.5;
    const ux = Math.cos(a), uz = Math.sin(a);
    const b = g.vertex(tx, top, tz, 0, 1, 0, shadeOf(0.95, 0.08));
    const t = g.vertex(tx + ux * len * 0.9, top + len, tz + uz * len * 0.9, 0, 1, 0, shadeOf(1.45, 0.12));
    const side: number[] = [];
    for (let k = 0; k < 4; k++) {
      const q = (k / 4) * Math.PI * 2;
      // ring around the ear's axis (roughly vertical, tilted along the lean)
      const ox = -uz * Math.cos(q) * ew + ux * Math.sin(q) * ew * 0.5;
      const oy = Math.sin(q) * ew * 0.5;
      const oz = ux * Math.cos(q) * ew + uz * Math.sin(q) * ew * 0.5;
      side.push(g.vertex(ex + ox, ey + oy, ez + oz, ox, 0.6, oz, shadeOf(1.35 - k * 0.05, 0.12)));
    }
    for (let k = 0; k < 4; k++) {
      g.tri(b, side[k], side[(k + 1) % 4]);
      g.tri(t, side[(k + 1) % 4], side[k]);
    }
  }
  return g.build(ears ? "cereal" : "shoots", scene);
}

/** A soil clod for ploughed fields: a squashed, jittered low-poly lump. */
function clodMesh(scene: Scene): Mesh {
  const m = MeshBuilder.CreateIcoSphere("clod", { radius: 0.5, subdivisions: 1, flat: true }, scene);
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < pos.length; i += 3) {
    const k = 1 + valueNoise(pos[i] * 5, pos[i + 2] * 5 + pos[i + 1] * 3, 4) * 0.25;
    pos[i] *= k;
    pos[i + 1] = (pos[i + 1] + 0.5) * k;
    pos[i + 2] *= k;
  }
  m.setVerticesData(VertexBuffer.PositionKind, pos);
  m.createNormals(false);
  m.convertToFlatShadedMesh();
  return m;
}

// ------------------------------------------------------------------ hedge template

/**
 * One hedge piece in the classic hedge's unit box (x -0.5..0.5 along the hedge, y 0..1 after the
 * shift below, z across): a row of overlapping leafy lumps, each a noise-displaced ellipsoid, with
 * normals leaning away from the hedge's centre line so the row shades softly as one mass. Darker at
 * the foot and inside. `grow` > 1 for the leaf shell around the opaque core.
 */
function hedgeLayer(scene: Scene, name: string, subdivisions: number, grow: number, dark: number, seed: number): Mesh {
  const g = new Geo();
  const s = sphere(scene, subdivisions);
  const r = rng(seed);
  const lumps = 5;
  for (let li = 0; li < lumps; li++) {
    const cx = -0.4 + (li / (lumps - 1)) * 0.8 + (r() - 0.5) * 0.06;
    const ry = 0.48 + r() * 0.08, rz = 0.5 + r() * 0.08, rx = 0.17 + r() * 0.04;
    const cy = (r() - 0.5) * 0.06, cz = (r() - 0.5) * 0.08;
    const base = g.pos.length / 3;
    for (let v = 0; v < s.pos.length / 3; v++) {
      const dx = s.pos[v * 3], dy = s.pos[v * 3 + 1], dz = s.pos[v * 3 + 2];
      const bump = 1 + valueNoise(dx * 1.7 + li * 2.3 + dy, dz * 1.7 - dy, seed) * 0.16;
      const x = cx + dx * rx * grow * bump, y = cy + dy * ry * grow * bump, z = cz + dz * rz * grow * bump;
      // away from the centre line (x axis), a little up
      const ol = Math.hypot(y, z) || 1;
      const nx = dx * 0.35, ny = (y / ol) * 0.75 + dy * 0.25 + 0.2, nz = (z / ol) * 0.75 + dz * 0.25;
      const up = Math.min(1, Math.max(0, y + 0.5));
      const k = dark * (0.5 + 0.5 * up) * (0.9 + valueNoise(x * 6, z * 6 + y * 3, seed + 5) * 0.12);
      g.vertex(x, y, z, nx, ny, nz, shadeOf(k, valueNoise(x * 3, z * 3, seed + 9) * 0.05), s.uv[v * 2] * 0.7 + li * 0.31, s.uv[v * 2 + 1] + li * 0.17);
    }
    for (let i = 0; i < s.idx.length; i += 3) g.tri(base + s.idx[i], base + s.idx[i + 1], base + s.idx[i + 2]);
  }
  return g.build(name, scene);
}

// ------------------------------------------------------------------ the switchable sets

/** A template with its placements, turned into thin instances when built. */
interface Batch { matrices: number[]; colors: number[] }

const plainMaterial = (scene: Scene, name: string, color: RGB = [1, 1, 1]) => {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(...color);
  m.specularColor = Color3.Black();
  return m;
};

function instances(mesh: Mesh, b: Batch, shadows: ShadowGenerator | null) {
  mesh.thinInstanceSetBuffer("matrix", new Float32Array(b.matrices), 16, true);
  if (b.colors.length) mesh.thinInstanceSetBuffer("color", new Float32Array(b.colors), 4, true);
  mesh.thinInstanceRefreshBoundingInfo(false);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.freezeWorldMatrix();
  shadows?.addShadowCaster(mesh);
}

/** Broadleaf crown shape variants and fir variants. */
const CROWNS = 3;
const FIRS = 2;

/**
 * Realistic trees. createVegetation() hands over each tree's placement; the classic meshes are
 * hidden while the realistic ones show.
 */
export class RealisticTrees {
  readonly classic: Mesh[] = [];
  private readonly broad: Batch[] = Array.from({ length: CROWNS }, () => ({ matrices: [], colors: [] }));
  private readonly firs: Batch[] = Array.from({ length: FIRS }, () => ({ matrices: [], colors: [] }));
  private readonly trunks: Batch = { matrices: [], colors: [] };
  private readonly firTrunks: Batch = { matrices: [], colors: [] };
  private meshes: Mesh[] | null = null;
  private readonly r = rng(4242);

  constructor(private readonly scene: Scene, private readonly shadows: ShadowGenerator) {}

  /** Records a tree (its transform and colour as placed by the classic vegetation). */
  add(m: Matrix, conifer: boolean, color: RGB) {
    const r = this.r;
    const arr = m.asArray();
    // per tree a slightly different shade: the forests are less uniform than in the classic look
    const j = () => 1 + (r() - 0.5) * 0.16;
    if (conifer) {
      const b = this.firs[Math.floor(r() * FIRS)];
      b.matrices.push(...arr);
      b.colors.push(color[0] * j(), color[1] * j(), color[2] * j(), 1);
      this.firTrunks.matrices.push(...arr);
    } else {
      const b = this.broad[Math.floor(r() * CROWNS)];
      b.matrices.push(...arr);
      b.colors.push(Math.min(1, color[0] * j()), Math.min(1, color[1] * j()), Math.min(1, color[2] * j()), 1);
      this.trunks.matrices.push(...arr);
    }
  }

  private build(): Mesh[] {
    const scene = this.scene, out: Mesh[] = [];
    guardInstanceColors();
    const leaves = leafTexture(scene);
    const shellMat = plainMaterial(scene, "leafShell");
    shellMat.diffuseTexture = leaves;
    shellMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    shellMat.alphaCutOff = 0.45;
    shellMat.backFaceCulling = false;
    const innerMat = plainMaterial(scene, "leafInner");
    const firMat = plainMaterial(scene, "firNeedles");
    firMat.backFaceCulling = false;
    const barkMat = plainMaterial(scene, "barkReal", [0.3, 0.23, 0.17]);

    this.broad.forEach((b, i) => {
      if (!b.matrices.length) return;
      const clumps = crownClumps(100 + i * 31);
      // opaque core (coarse) and the leafy shell around it
      const inner = crownLayer(scene, `crownCore${i}`, clumps, 1, 0.9, 0.7, 7 + i);
      inner.material = innerMat;
      // (the shell is brightened: its grey leaf texture darkens by about a third on average)
      const shell = crownLayer(scene, `crownLeaves${i}`, clumps, 2, 1.05, 1.4, 7 + i);
      shell.material = shellMat;
      instances(inner, b, this.shadows);
      instances(shell, b, this.shadows);
      out.push(inner, shell);
    });
    this.firs.forEach((b, i) => {
      if (!b.matrices.length) return;
      const fir = firMesh(scene, 900 + i * 17);
      fir.material = firMat;
      instances(fir, b, this.shadows);
      out.push(fir);
    });
    if (this.trunks.matrices.length) {
      const t = broadleafTrunk(scene);
      t.material = barkMat;
      instances(t, this.trunks, this.shadows);
      out.push(t);
    }
    if (this.firTrunks.matrices.length) {
      const t = MeshBuilder.CreateCylinder("firTrunk", { height: 1.8, diameterTop: 0.2, diameterBottom: 0.32, tessellation: 5 }, scene);
      t.position.y = 0.9;
      t.bakeCurrentTransformIntoVertices();
      t.material = barkMat;
      instances(t, this.firTrunks, null);
      out.push(t);
    }
    return out;
  }

  enable() {
    this.meshes ??= this.build();
    for (const m of this.classic) m.setEnabled(false);
    for (const m of this.meshes) m.setEnabled(true);
  }

  disable() {
    for (const m of this.meshes ?? []) m.setEnabled(false);
    for (const m of this.classic) m.setEnabled(true);
  }
}

/**
 * Realistic hedgerows: leafy rows instead of the green boxes, in the same places (the classic
 * hedge's thin-instance transforms), each piece a slightly different green.
 */
export class RealisticHedges {
  readonly classic: Mesh[] = [];
  private readonly batch: Batch = { matrices: [], colors: [] };
  private meshes: Mesh[] | null = null;
  private readonly r = rng(515);

  constructor(private readonly scene: Scene, private readonly shadows: ShadowGenerator) {}

  add(m: Matrix, color: RGB) {
    const r = this.r;
    const j = () => 1 + (r() - 0.5) * 0.18;
    this.batch.matrices.push(...m.asArray());
    this.batch.colors.push(color[0] * j() * 1.05, color[1] * j() * 1.08, color[2] * j(), 1);
  }

  private build(): Mesh[] {
    guardInstanceColors();
    if (!this.batch.matrices.length) return [];
    const core = hedgeLayer(this.scene, "hedgeCore", 1, 0.9, 0.62, 31);
    core.material = plainMaterial(this.scene, "hedgeInner");
    const shellMat = plainMaterial(this.scene, "hedgeLeaves");
    shellMat.diffuseTexture = leafTexture(this.scene);
    shellMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    shellMat.alphaCutOff = 0.45;
    shellMat.backFaceCulling = false;
    // (brightened: the grey leaf texture darkens by about a third on average)
    const shell = hedgeLayer(this.scene, "hedgeLeaves", 2, 1.08, 1.4, 31);
    shell.material = shellMat;
    for (const m of [core, shell]) instances(m, this.batch, this.shadows);
    return [core, shell];
  }

  enable() {
    this.meshes ??= this.build();
    for (const m of this.classic) m.setEnabled(false);
    for (const m of this.meshes) m.setEnabled(true);
  }

  disable() {
    for (const m of this.meshes ?? []) m.setEnabled(false);
    for (const m of this.classic) m.setEnabled(true);
  }
}

/** Kind of field plant: green shoots, ripe cereal with ears, or clods on ploughed soil. */
export type CropKind = "shoots" | "cereal" | "clods";

/** Realistic field plants, placed exactly like the classic tufts (same matrices and colours). */
export class RealisticCrops {
  readonly classic: Mesh[] = [];
  private readonly batches: Record<CropKind, Batch> = {
    shoots: { matrices: [], colors: [] },
    cereal: { matrices: [], colors: [] },
    clods: { matrices: [], colors: [] },
  };
  private meshes: Mesh[] | null = null;

  constructor(private readonly scene: Scene, private readonly shadows: ShadowGenerator) {}

  add(kind: CropKind, m: Matrix, color: [number, number, number, number]) {
    this.batches[kind].matrices.push(...m.asArray());
    this.batches[kind].colors.push(...color);
  }

  private build(): Mesh[] {
    const out: Mesh[] = [];
    guardInstanceColors();
    const leafy = plainMaterial(this.scene, "cropBlades");
    leafy.backFaceCulling = false;
    const soil = plainMaterial(this.scene, "cropClods");
    for (const kind of ["shoots", "cereal", "clods"] as CropKind[]) {
      const b = this.batches[kind];
      if (!b.matrices.length) continue;
      const mesh = kind === "clods" ? clodMesh(this.scene) : cerealMesh(this.scene, kind === "cereal", kind === "cereal" ? 12 : 13);
      mesh.material = kind === "clods" ? soil : leafy;
      // the plants cast shadows: that is what makes them stand out of the textured soil
      instances(mesh, b, kind === "clods" ? null : this.shadows);
      out.push(mesh);
    }
    return out;
  }

  enable() {
    this.meshes ??= this.build();
    for (const m of this.classic) m.setEnabled(false);
    for (const m of this.meshes) m.setEnabled(true);
  }

  disable() {
    for (const m of this.meshes ?? []) m.setEnabled(false);
    for (const m of this.classic) m.setEnabled(true);
  }
}
