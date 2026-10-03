import { Color3, DynamicTexture, FresnelParameters, Material, Mesh, StandardMaterial, Texture, VertexData, type Scene } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import { rng, valueNoise } from "../util/noise";
import type { NavGrid } from "../game/nav";
import { toLocal, type MapLayout, type V2 } from "./layout";
import type { Terrain } from "./terrain";
import type { PathLine } from "./pathMap";

/** Width of the textured track band (a little wider than the 3.6 m track, edges fray into the grass). */
const BAND = 4.6;
/** Metres of track per texture repeat. */
const REPEAT = 5;
/** Ruts lie this far left and right of the centre line. */
const RUT = 0.78;

/** Normals of a ground overlay must face up whatever the triangle winding. */
function upNormals(n: number[]) {
  for (let i = 0; i < n.length; i += 3) if (n[i + 1] < 0) { n[i] = -n[i]; n[i + 1] = -n[i + 1]; n[i + 2] = -n[i + 2]; }
}

/**
 * Texture of a farm track, u across (0..1 over BAND), v along: two dark wheel ruts, a raised,
 * lighter shoulder beside each, a grassy strip down the middle and ragged grass edges (alpha cut).
 */
function trackTexture(scene: Scene): DynamicTexture {
  const W = 128, H = 512;
  const tex = new DynamicTexture("trackTex", { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(W, H);
  const rutU = RUT / BAND;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = ((y + 0.5) / H) * REPEAT; // v in metres, tiles seamlessly over REPEAT
      const n1 = valueNoise(u * 24, v * 3, 51), n2 = valueNoise(u * 60, v * 9, 52);
      const c = Math.abs(u - 0.5);
      // base dirt
      let r = 0.56, g = 0.43, b = 0.28;
      const k = 1 + n1 * 0.06 + n2 * 0.05;
      r *= k; g *= k; b *= k;
      // wheel ruts: darker, damp, compacted; slightly lighter ridges beside them
      const rut = Math.abs(c - rutU);
      const inRut = Math.max(0, 1 - rut / 0.06);
      const shoulder = Math.max(0, 1 - Math.abs(rut - 0.085) / 0.03);
      r = r * (1 - inRut * 0.36) + shoulder * 0.04; g = g * (1 - inRut * 0.38) + shoulder * 0.035; b = b * (1 - inRut * 0.4) + shoulder * 0.02;
      // tyre tread marks across the ruts
      if (inRut > 0.3 && Math.sin(v * 22 + n2 * 2) > 0.55) { r *= 0.9; g *= 0.9; b *= 0.9; }
      // grassy strip in the middle, ragged and tufty
      const mid = c + n1 * 0.025 + n2 * 0.02;
      if (mid < 0.07) {
        const t = Math.min(1, (0.07 - mid) / 0.04) * (0.7 + n2 * 0.3);
        r = r * (1 - t) + 0.4 * t; g = g * (1 - t) + 0.5 * t; b = b * (1 - t) + 0.22 * t;
      }
      // grass verges creeping in from the edges; the band frays out (alpha)
      const edge = 0.5 - c + n1 * 0.035 + n2 * 0.02;
      let a = 1;
      // (kept narrow: where tracks cross, one band's fringe would otherwise paint over the other's ruts)
      if (edge < 0.07) {
        const t = Math.min(1, (0.07 - edge) / 0.035) * 0.8;
        r = r * (1 - t) + 0.5 * t; g = g * (1 - t) + 0.52 * t; b = b * (1 - t) + 0.26 * t;
        if (edge < 0.035) a = 0;
      }
      const i = (x + y * W) * 4;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = Math.min(255, g * 255);
      img.data[i + 2] = Math.min(255, b * 255);
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Pale sky with soft clouds, used as the puddles' (fake) reflection. */
function skyTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const tex = new DynamicTexture("puddleSky", { width: S, height: S }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const grad = ctx.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, "#9fb6cf");
  grad.addColorStop(0.6, "#c9d4de");
  grad.addColorStop(1, "#e4e2d6");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  const r = rng(77);
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, rad = 12 + r() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.75)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, rad * 1.6, rad, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update(false);
  return tex;
}

export interface DirtTracks {
  /** Animates the ripples on the puddles. */
  update(dt: number): void;
  /** Dimmer reflections at night. */
  setNight(on: boolean): void;
  /** The textured band over the farm tracks (the realistic ground draws the tracks itself and hides it). */
  readonly trackBands: Mesh;
  /** The footpaths and their band (hidden by the realistic ground, which draws them itself). */
  readonly footpaths: PathLine[];
  readonly pathBands: Mesh;
}

/**
 * Farm tracks drawn sharper than the terrain's vertex colours allow: a textured band laid over each
 * track (ruts, grassy middle strip, frayed edges), plus puddles in the ruts that mirror a pale,
 * cloudy sky and catch the sun.
 */
/** Worn footpath: bare trodden earth in the middle, grass closing in from the frayed edges. */
function pathTexture(scene: Scene): DynamicTexture {
  const W = 64, H = 256;
  const tex = new DynamicTexture("pathTex", { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = ((y + 0.5) / H) * REPEAT;
      const n1 = valueNoise(u * 14, v * 2.5, 61), n2 = valueNoise(u * 40, v * 8, 62);
      const c = Math.abs(u - 0.5) + n1 * 0.06 + n2 * 0.03;
      // trodden earth fading into flattened, yellowed grass
      const earth = 1 - Math.min(1, Math.max(0, (c - 0.24) / 0.12));
      const k = 1 + n2 * 0.08;
      const r = (0.5 * earth + 0.55 * (1 - earth)) * k, g = (0.39 * earth + 0.52 * (1 - earth)) * k, b = (0.25 * earth + 0.26 * (1 - earth)) * k;
      const i = (x + y * W) * 4;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = Math.min(255, g * 255);
      img.data[i + 2] = Math.min(255, b * 255);
      img.data[i + 3] = c < 0.42 ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/**
 * Builds one mesh of ground-hugging bands, each running along a polyline (continuous through its
 * bends, so there are no overlapping joints). Quads lying on asphalt are left out. The bands don't
 * write depth: where two of them cross, the later simply paints over the earlier - no z-fighting.
 */
interface BandLine { pts: V2[]; width: number; taperStart?: boolean; taperEnd?: boolean }

function buildBands(scene: Scene, name: string, terrain: Terrain, onAsphalt: (x: number, z: number) => boolean, lines: BandLine[], tex: Texture): Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
  const across = 7;
  const lim = MAP_HALF + 3;
  /** Metres over which a free end (not a junction) fades out into whatever surface it reaches. */
  const FADE = 7;
  for (const { pts, width, taperStart, taperEnd } of lines) {
    // resample the polyline every ~0.9 m
    const samples: { x: number; z: number; s: number }[] = [];
    let s = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(len / 0.9));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n, s: s + (len * k) / n });
      s += len;
    }
    if (samples.length < 2) continue;
    const base = pos.length / 3;
    const total = samples[samples.length - 1].s;
    samples.forEach((p, i) => {
      // ends that run into a junction narrow down, so they merge into the crossing track
      const taper = Math.min(taperStart ? 0.3 + 0.7 * Math.min(1, p.s / 3.5) : 1, taperEnd ? 0.3 + 0.7 * Math.min(1, (total - p.s) / 3.5) : 1);
      // averaged direction at each sample: the band bends smoothly round the corners
      const q0 = samples[Math.max(0, i - 1)], q1 = samples[Math.min(samples.length - 1, i + 1)];
      const tl = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1;
      const tx = (q1.x - q0.x) / tl, tz = (q1.z - q0.z) / tl;
      for (let j = 0; j < across; j++) {
        const o = (j / (across - 1) - 0.5) * width * taper;
        const x = p.x + tz * o, z = p.z - tx * o;
        const cx = Math.max(-lim, Math.min(lim, x)), cz = Math.max(-lim, Math.min(lim, z));
        pos.push(x, terrain.heightAt(cx, cz) + 0.1, z);
        uv.push(j / (across - 1), p.s / REPEAT);
        const fade = Math.min(taperStart ? 1 : p.s / FADE, taperEnd ? 1 : (total - p.s) / FADE, 1);
        col.push(1, 1, 1, fade * fade * (3 - 2 * fade));
      }
    });
    for (let i = 0; i < samples.length - 1; i++) {
      // leave the band out where it runs over a village street
      const m = samples[i], m1 = samples[i + 1];
      if (onAsphalt((m.x + m1.x) / 2, (m.z + m1.z) / 2)) continue;
      for (let j = 0; j < across - 1; j++) {
        const a = base + i * across + j, b = a + 1, c = a + across, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.uvs = uv;
  vd.colors = col;
  const normals: number[] = [];
  VertexData.ComputeNormals(pos, idx, normals);
  upNormals(normals);
  vd.normals = normals;
  vd.applyToMesh(mesh);
  mesh.hasVertexAlpha = true;
  const m = new StandardMaterial(`${name}Mat`, scene);
  m.diffuseTexture = tex;
  m.useAlphaFromDiffuseTexture = true;
  // frayed edges cut out sharply by the texture, free ends faded softly through the vertex alpha
  m.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
  m.alphaCutOff = 0.5;
  m.specularColor = Color3.Black();
  m.backFaceCulling = false;
  m.disableDepthWrite = true; // overlapping bands never fight over depth
  m.zOffset = -2;
  mesh.material = m;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.alphaIndex = 1; // before the light spots (see lighting.ts)
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Closest point on segment ab to p, with its distance. */
function closestOnSegment(p: V2, a: V2, b: V2): { x: number; z: number; d: number } {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  const x = a.x + dx * t, z = a.z + dz * t;
  return { x, z, d: Math.hypot(p.x - x, p.z - z) };
}

export function createDirtTracks(scene: Scene, layout: MapLayout, terrain: Terrain, nav: NavGrid): DirtTracks {
  const asphalt = layout.roads.filter((r) => r.kind === "asphalt");
  const onAsphalt = (x: number, z: number) => asphalt.some((r) => closestOnSegment({ x, z }, r.a, r.b).d < r.w / 2 + 0.4);

  // farm tracks: chain the segments into continuous polylines
  const lines: BandLine[] = [];
  for (const rd of layout.roads) {
    if (rd.kind !== "dirt") continue;
    const last = lines[lines.length - 1];
    const tail = last?.pts[last.pts.length - 1];
    if (tail && Math.hypot(tail.x - rd.a.x, tail.z - rd.a.z) < 0.01) last.pts.push(rd.b);
    else lines.push({ pts: [rd.a, rd.b], width: BAND });
  }
  // an end that meets another track (not at a village street) is a junction
  const meets = (p: V2, self: BandLine) => !onAsphalt(p.x, p.z) && lines.some((l) => l !== self && l.pts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1));
  for (const l of lines) {
    l.taperStart = meets(l.pts[0], l);
    l.taperEnd = meets(l.pts[l.pts.length - 1], l);
  }
  const trackBands = buildBands(scene, "dirtTracks", terrain, onAsphalt, lines, trackTexture(scene));

  // footpaths: from every outpost a trodden path winds to the nearest track or street
  const fr = rng(515);
  const inField = (x: number, z: number) => layout.fields.some((f) => {
    const l = toLocal(f.cx, f.cz, f.rot, x, z);
    return Math.abs(l.x) < f.hw + 1 && Math.abs(l.z) < f.hd + 1;
  });
  const paths: BandLine[] = [];
  for (const o of layout.outposts) {
    const candidates = layout.roads
      .map((r) => closestOnSegment(o, r.a, r.b))
      .filter((c) => c.d > 9 && c.d < 70)
      .sort((a, b) => a.d - b.d);
    for (const c of candidates) {
      const dx = (c.x - o.x) / c.d, dz = (c.z - o.z) / c.d;
      const start = { x: o.x + dx * 4, z: o.z + dz * 4 };
      // a gentle bend: the control point sits a little off the straight line
      const bend = (fr() - 0.5) * 0.35 * c.d;
      const ctrl = { x: (start.x + c.x) / 2 - dz * bend, z: (start.z + c.z) / 2 + dx * bend };
      const pts: V2[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push({ x: u * u * start.x + 2 * u * t * ctrl.x + t * t * c.x, z: u * u * start.z + 2 * u * t * ctrl.z + t * t * c.z });
      }
      // only where people would actually walk: not through woods, buildings, hedges or fields
      const clear = pts.every((p, i) => i < 2 || (!nav.isBlocked(p.x, p.z) && !inField(p.x, p.z)));
      if (!clear) continue;
      paths.push({ pts, width: 2.1, taperEnd: true }); // fades into the track it joins
      break;
    }
  }
  const pathBands = buildBands(scene, "footpaths", terrain, onAsphalt, paths, pathTexture(scene));

  // ---- puddles in the ruts
  const r = rng(909);
  const ppos: number[] = [], pidx: number[] = [];
  // a dark ring of wet mud around each puddle
  const mpos: number[] = [], midx: number[] = [];
  for (const rd of layout.roads) {
    if (rd.kind !== "dirt") continue;
    const len = Math.hypot(rd.b.x - rd.a.x, rd.b.z - rd.a.z);
    const dx = (rd.b.x - rd.a.x) / len, dz = (rd.b.z - rd.a.z) / len;
    for (let s = 3 + r() * 6; s < len - 2; s += 5 + r() * 12) {
      if (r() < 0.35) continue;
      const side = r() < 0.5 ? -1 : 1;
      const o = side * RUT + (r() - 0.5) * 0.06;
      const cx = rd.a.x + dx * s + dz * o, cz = rd.a.z + dz * s - dx * o;
      if (Math.abs(cx) > MAP_HALF - 3 || Math.abs(cz) > MAP_HALF - 3 || onAsphalt(cx, cz)) continue;
      // not on steep stretches: water runs off there
      if (Math.abs(terrain.heightAt(cx + dx, cz + dz) - terrain.heightAt(cx - dx, cz - dz)) > 0.5) continue;
      const len2 = 0.7 + r() * 1.5, wid = 0.24 + r() * 0.18; // long and narrow, filling the rut
      // a hair above the (later drawn, see-through) track band, so the band never covers them
      const y = terrain.heightAt(cx, cz) + 0.17;
      const segs = 22, seed = r() * 100;
      const blob = (out: number[], ind: number[], grow: number, yy: number) => {
        const base = out.length / 3;
        out.push(cx, yy, cz);
        for (let k = 0; k < segs; k++) {
          const ang = (k / segs) * Math.PI * 2;
          const wob = 1 + valueNoise(Math.cos(ang) * 2 + seed, Math.sin(ang) * 2, 53) * 0.3;
          // rounded, slightly boxy outline (superellipse) instead of pointed ends
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 0.6), ez = Math.sign(sa) * Math.pow(Math.abs(sa), 0.8);
          const ax = ex * (len2 * wob + grow), az = ez * (wid * wob + grow);
          // along the track (dx, dz) and across it
          out.push(cx + dx * ax + dz * az, yy, cz + dz * ax - dx * az);
          ind.push(base, base + 1 + k, base + 1 + ((k + 1) % segs));
        }
      };
      blob(ppos, pidx, 0, y);
      blob(mpos, midx, 0.22, y - 0.015);
    }
  }
  const puddles = new Mesh("puddles", scene);
  const pvd = new VertexData();
  pvd.positions = ppos;
  pvd.indices = pidx;
  const pn: number[] = [];
  VertexData.ComputeNormals(ppos, pidx, pn);
  upNormals(pn);
  pvd.normals = pn;
  pvd.applyToMesh(puddles);
  const mud = new Mesh("puddleMud", scene);
  const mvd = new VertexData();
  mvd.positions = mpos;
  mvd.indices = midx;
  const mn: number[] = [];
  VertexData.ComputeNormals(mpos, midx, mn);
  upNormals(mn);
  mvd.normals = mn;
  mvd.applyToMesh(mud);
  const mudMat = new StandardMaterial("puddleMudMat", scene);
  mudMat.diffuseColor = new Color3(0.27, 0.2, 0.13);
  mudMat.specularColor = new Color3(0.15, 0.13, 0.1);
  mudMat.specularPower = 24;
  mudMat.backFaceCulling = false;
  mudMat.zOffset = -1.5;
  mud.material = mudMat;
  mud.isPickable = false;
  mud.receiveShadows = true;
  mud.freezeWorldMatrix();

  const sky = skyTexture(scene);
  sky.coordinatesMode = Texture.SPHERICAL_MODE; // follows the view: shifts as the camera moves
  const pm = new StandardMaterial("puddleMat", scene);
  // dark, still water: mostly the deep colour, the sky only as a soft sheen, a hot spot of sunlight
  pm.diffuseColor = new Color3(0.06, 0.07, 0.07);
  pm.specularColor = new Color3(1, 0.95, 0.85);
  pm.specularPower = 120;
  pm.reflectionTexture = sky;
  sky.level = 0.6;
  pm.reflectionFresnelParameters = new FresnelParameters();
  pm.reflectionFresnelParameters.bias = 0.15;
  pm.reflectionFresnelParameters.power = 2;
  pm.reflectionFresnelParameters.leftColor = new Color3(0.85, 0.88, 0.9);
  pm.reflectionFresnelParameters.rightColor = new Color3(0.35, 0.38, 0.42);
  pm.backFaceCulling = false;
  pm.zOffset = -2;
  puddles.material = pm;
  puddles.isPickable = false;
  puddles.receiveShadows = true;
  puddles.freezeWorldMatrix();

  let t = 0;
  return {
    trackBands,
    footpaths: paths,
    pathBands,
    update(dt: number) {
      // a light breeze ripples the water: the reflection wobbles a little
      t += dt;
      sky.uOffset = Math.sin(t * 0.7) * 0.012 + t * 0.004;
      sky.vOffset = Math.cos(t * 0.9) * 0.01;
    },
    setNight(on: boolean) {
      sky.level = on ? 0.15 : 0.6;
      pm.specularColor = on ? new Color3(0.5, 0.6, 0.8) : new Color3(1, 0.95, 0.85);
    },
  };
}
