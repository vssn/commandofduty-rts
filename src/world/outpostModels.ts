import { Color3, DynamicTexture, Material, MeshBuilder, StandardMaterial, Texture, type Mesh, type Scene } from "@babylonjs/core";
import type { OutpostKind } from "../config";
import { toWorld, type RGB } from "./layout";
import { brickBox } from "./masonry";
import { createGable, HOSPITAL_TENT, mat, merge, type SurfaceKind } from "./models";

/**
 * The capturable outposts in the near-future look: concrete T-walls and jersey barriers with yellow and black hazard
 * stripes, container modules with LED strips, chain-link fences with razor wire, a sensor head instead of a radome.
 * One model for both graphics modes (the realistic one textures the parts by what they are made of).
 */

/** Radar station: the concrete drum and the sensor head on it; `top`: the head's highest point (the warning light sits on it). */
export const RADAR_DIM = { drumH: 2.4, drumR: 2.2, headR: 2.25, top: 7.3 };

const CONCRETE: RGB = [0.6, 0.6, 0.58];
const CONCRETE_DARK: RGB = [0.47, 0.47, 0.46];
const STEEL: RGB = [0.2, 0.205, 0.22];
const STEEL_LIGHT: RGB = [0.42, 0.43, 0.45];
const PANEL: RGB = [0.3, 0.31, 0.33];
const WHITE: RGB = [0.88, 0.89, 0.9];
const GLASS: RGB = [0.07, 0.09, 0.12];
const TARP: RGB = [0.22, 0.23, 0.24];
const RED: RGB = [0.78, 0.1, 0.08];
const DARK: RGB = [0.1, 0.1, 0.11];
const EARTH: RGB = [0.36, 0.27, 0.18];
/** Lights: warning yellow, cool white, status green, the red cross. */
const LED_YELLOW: RGB = [1, 0.85, 0.08];
const LED_WHITE: RGB = [0.85, 0.95, 1];
const LED_GREEN: RGB = [0.25, 1, 0.5];
const LED_RED: RGB = [1, 0.16, 0.12];

const SURFACE = new Map<string, SurfaceKind>([
  [CONCRETE.join(), "concrete"], [CONCRETE_DARK.join(), "concrete"],
  [STEEL.join(), "metal"], [STEEL_LIGHT.join(), "metal"], [PANEL.join(), "metal"], [WHITE.join(), "metal"],
  [TARP.join(), "fabric"], [EARTH.join(), "earth"],
]);

const hazardMats = new Map<string, StandardMaterial>();
const meshMats = new Map<string, StandardMaterial>();

/** Yellow and black diagonal hazard stripes (one tile = 0.6 m), shared per scene. */
function hazardMaterial(scene: Scene): StandardMaterial {
  let m = hazardMats.get(scene.uid);
  if (m) return m;
  const S = 128, tex = new DynamicTexture("hazardTex", { width: S, height: S }, scene, true);
  const g = tex.getContext() as CanvasRenderingContext2D;
  g.fillStyle = "#16161a";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#f2cd12";
  // two stripes per tile, drawn wrapped so the tile is seamless
  for (let k = -2; k < 4; k++) {
    g.beginPath();
    g.moveTo(k * 64, 0);
    g.lineTo(k * 64 + 32, 0);
    g.lineTo(k * 64 + 32 + S, S);
    g.lineTo(k * 64 + S, S);
    g.closePath();
    g.fill();
  }
  tex.update(true);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  m = new StandardMaterial("hazard", scene);
  m.diffuseTexture = tex;
  m.specularColor = new Color3(0.08, 0.08, 0.08);
  m.metadata = { rough: 0.6, surface: "metal" };
  hazardMats.set(scene.uid, m);
  return m;
}

/** Chain-link mesh: a diamond grid of wire, the rest cut out (alpha test). */
function chainLinkMaterial(scene: Scene): StandardMaterial {
  let m = meshMats.get(scene.uid);
  if (m) return m;
  const S = 64, tex = new DynamicTexture("chainLinkTex", { width: S, height: S }, scene, true);
  const g = tex.getContext() as CanvasRenderingContext2D;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "rgba(170,175,180,1)";
  g.lineWidth = 3;
  for (const [ax, ay, bx, by] of [[0, 0, S, S], [S, 0, 0, S], [-S, 0, S, 2 * S], [0, -S, 2 * S, S]]) {
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
  }
  tex.update(true);
  tex.hasAlpha = true;
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  m = new StandardMaterial("chainLink", scene);
  m.diffuseTexture = tex;
  m.useAlphaFromDiffuseTexture = true;
  m.transparencyMode = Material.MATERIAL_ALPHATEST;
  m.alphaCutOff = 0.4;
  m.backFaceCulling = false;
  m.specularColor = Color3.Black();
  m.metadata = { rough: 0.5, metal: 0.6 };
  meshMats.set(scene.uid, m);
  return m;
}

/** Scales a box's UVs to its size, face by face (by the normals), so a tiled texture keeps its scale (`tile` metres). */
function worldUV(m: Mesh, w: number, h: number, d: number, tile: number) {
  const uv = m.getVerticesData("uv"), n = m.getVerticesData("normal");
  if (!uv || !n) return;
  for (let i = 0; i < uv.length / 2; i++) {
    const nx = Math.abs(n[i * 3]), ny = Math.abs(n[i * 3 + 1]);
    const [su, sv] = ny > 0.5 ? [w, d] : nx > 0.5 ? [d, h] : [w, h];
    uv[i * 2] *= su / tile;
    uv[i * 2 + 1] *= sv / tile;
  }
  m.setVerticesData("uv", uv);
}

export function createOutpostMesh(scene: Scene, kind: OutpostKind): Mesh {
  const parts: Mesh[] = [];
  const surf = (c: RGB) => SURFACE.get(c.join());
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, ry = 0, rx = 0, rz = 0) => {
    const m = MeshBuilder.CreateBox("part", { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.material = mat(scene, c, { surface: surf(c) });
    parts.push(m);
    return m;
  };
  /** A light: LED strip, lamp or lit panel (glows in both graphics modes). */
  const led = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB, ry = 0) => {
    const m = box(w, h, d, x, y, z, c, ry);
    m.material = mat(scene, c, { emissive: true });
    return m;
  };
  const hazard = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) => {
    const m = MeshBuilder.CreateBox("hazard", { width: w, height: h, depth: d }, scene);
    worldUV(m, w, h, d, 0.6);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.material = hazardMaterial(scene);
    parts.push(m);
    return m;
  };
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, tess = 10, rz = 0, rx = 0) => {
    const m = MeshBuilder.CreateCylinder("cyl", { height: h, diameter: d, tessellation: tess }, scene);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.material = mat(scene, c, { surface: surf(c) });
    parts.push(m);
    return m;
  };
  /** A frame for parts placed along a line or turned: local (lx, lz) of an object at (x, z) turned by `ry`. */
  const at = (x: number, z: number, ry: number) => (lx: number, lz: number) => toWorld(x, z, ry, lx, lz);

  /** Concrete T-wall (blast wall), `len` long, ~1.9 high, its face along local x; a hazard band along the top when `stripe`. */
  const tWall = (x: number, z: number, ry: number, len = 1.4, stripe = true) => {
    const p = at(x, z, ry);
    let q = p(0, 0);
    box(len, 0.3, 0.95, q.x, 0.15, q.z, CONCRETE_DARK, ry); // foot
    box(len - 0.04, 1.65, 0.32, q.x, 1.1, q.z, CONCRETE, ry); // slab
    q = p(0, 0);
    if (stripe) hazard(len - 0.02, 0.26, 0.34, q.x, 1.75, q.z, ry);
    // lifting loops on top
    for (const s of [-1, 1]) {
      q = p(s * len * 0.3, 0);
      box(0.08, 0.1, 0.2, q.x, 1.97, q.z, STEEL, ry);
    }
  };
  /** Jersey barrier (low, wide foot), `len` long; hazard stripes on its upper part when `stripe`. */
  const jersey = (x: number, z: number, ry: number, len = 1.6, stripe = false) => {
    box(len, 0.35, 0.66, x, 0.175, z, CONCRETE, ry);
    box(len, 0.55, 0.3, x, 0.62, z, CONCRETE, ry);
    if (stripe) hazard(len + 0.01, 0.2, 0.32, x, 0.78, z, ry);
  };
  /** A row of barriers from (ax, az) to (bx, bz). */
  const row = (ax: number, az: number, bx: number, bz: number, make: (x: number, z: number, ry: number, len: number, i: number) => void, piece = 1.5) => {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), n = Math.max(1, Math.round(len / piece));
    const ry = Math.atan2(-dz, dx);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      make(ax + dx * t, az + dz * t, ry, len / n - 0.05, i);
    }
  };
  /** Container module: corrugated walls, a frame, an LED strip along the top of its front (+z) face. */
  const container = (w: number, h: number, d: number, x: number, y0: number, z: number, c: RGB, light: RGB | null = LED_WHITE, ry = 0) => {
    const p = at(x, z, ry);
    box(w, h, d, x, y0 + h / 2, z, c, ry);
    // ribs on the long faces
    const n = Math.floor(w / 0.42);
    for (let i = 1; i < n; i++) {
      const lx = -w / 2 + (i / n) * w;
      for (const s of [-1, 1]) {
        const q = p(lx, s * (d / 2 + 0.02));
        box(0.08, h - 0.2, 0.04, q.x, y0 + h / 2, q.z, c, ry);
      }
    }
    // corner posts and the top frame
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = p(sx * (w / 2 - 0.06), sz * (d / 2 - 0.06));
      box(0.16, h + 0.02, 0.16, q.x, y0 + h / 2, q.z, STEEL, ry);
    }
    let q = p(0, 0);
    box(w + 0.04, 0.1, d + 0.04, q.x, y0 + h - 0.04, q.z, STEEL, ry);
    if (light) {
      q = p(0, d / 2 + 0.05);
      led(w - 0.4, 0.05, 0.03, q.x, y0 + h - 0.18, q.z, light, ry);
    }
  };
  /** Chain-link fence from (ax, az) to (bx, bz): steel posts, a top rail, the mesh, razor wire coiled along the top. */
  const fence = (ax: number, az: number, bx: number, bz: number, h = 2.0) => {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), ry = Math.atan2(-dz, dx);
    const n = Math.max(1, Math.round(len / 2.6));
    for (let i = 0; i <= n; i++) cyl(h + 0.1, 0.08, ax + (dx * i) / n, (h + 0.1) / 2, az + (dz * i) / n, STEEL_LIGHT, 6);
    const rail = MeshBuilder.CreateCylinder("rail", { height: len, diameter: 0.05, tessellation: 6 }, scene);
    rail.rotation.set(0, ry, Math.PI / 2);
    rail.position.set((ax + bx) / 2, h, (az + bz) / 2);
    rail.material = mat(scene, STEEL_LIGHT, { surface: "metal" });
    parts.push(rail);
    const net = MeshBuilder.CreatePlane("chainLink", { width: len, height: h - 0.1 }, scene);
    const uv = net.getVerticesData("uv")!;
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] *= len / 0.35;
      uv[i + 1] *= (h - 0.1) / 0.35;
    }
    net.setVerticesData("uv", uv);
    net.position.set((ax + bx) / 2, (h - 0.1) / 2 + 0.05, (az + bz) / 2);
    net.rotation.y = ry;
    net.material = chainLinkMaterial(scene);
    parts.push(net);
    // razor wire: a coil of loops along the top
    const loops = Math.round(len / 0.32);
    for (let i = 0; i < loops; i++) {
      const t = (i + 0.5) / loops;
      const coil = MeshBuilder.CreateTorus("razor", { diameter: 0.42, thickness: 0.02, tessellation: 8 }, scene);
      coil.rotation.set(Math.PI / 2, ry + Math.PI / 2 + 0.35, 0);
      coil.position.set(ax + dx * t, h + 0.2, az + dz * t);
      coil.material = mat(scene, STEEL_LIGHT, { surface: "metal" });
      parts.push(coil);
    }
  };

  if (kind === "hospital") {
    // field hospital: a white container ward with lit red crosses, an awning over the stretchers, medical cases,
    // water tanks; jersey barriers along the back
    const T = HOSPITAL_TENT;
    box(7.5, 0.4, 6, 0, 0.1, 0, CONCRETE_DARK);
    container(T.hw * 2, 2.7, T.hd * 2, T.x, 0.3, T.z, WHITE, null);
    const front = T.z + T.hd;
    box(1.1, 2.0, 0.06, T.x, 1.3, front + 0.02, PANEL); // door
    box(0.5, 0.35, 0.03, T.x, 1.85, front + 0.06, GLASS);
    // lit crosses: over the door and on the roof
    const cross = (x: number, y: number, z: number, s: number, flat: boolean) => {
      if (flat) {
        box(s, 0.06, s, x, y, z, WHITE);
        led(s * 0.72, 0.08, s * 0.22, x, y + 0.02, z, LED_RED);
        led(s * 0.22, 0.08, s * 0.72, x, y + 0.02, z, LED_RED);
      } else {
        box(s, s, 0.05, x, y, z, WHITE);
        led(s * 0.72, s * 0.22, 0.07, x, y, z + 0.02, LED_RED);
        led(s * 0.22, s * 0.72, 0.07, x, y, z + 0.02, LED_RED);
      }
    };
    cross(T.x, 2.65, front + 0.05, 0.6, false);
    cross(T.x, 3.06, T.z, 2.0, true);
    led(T.hw * 2 - 0.4, 0.05, 0.03, T.x, 2.82, front + 0.06, LED_RED); // strip along the top
    // awning on two posts over the stretchers
    box(1.9, 0.06, 4.6, 2.45, 2.55, -0.6, WHITE, 0, 0, -0.12);
    for (const z of [-2.75, 1.55]) cyl(2.3, 0.08, 3.3, 1.45, z, STEEL_LIGHT, 6);
    // stretchers: white mattresses on steel frames
    for (const [i, z] of [-1.9, -0.6, 0.7].entries()) {
      const x = 2.3 + (i % 2) * 0.15;
      box(0.72, 0.1, 1.95, x, 0.62, z, [0.8, 0.83, 0.86]);
      for (const sx of [-0.38, 0.38]) box(0.05, 0.05, 2.2, x + sx, 0.55, z, STEEL_LIGHT);
      for (const sx of [-0.38, 0.38]) for (const sz of [-0.8, 0.8]) box(0.05, 0.28, 0.05, x + sx, 0.4, z + sz, STEEL_LIGHT);
      box(0.5, 0.1, 0.3, x, 0.72, z - 0.75, WHITE); // pillow
      if (i === 1) box(0.7, 0.08, 1.2, x, 0.71, z + 0.2, [0.32, 0.42, 0.6]); // blanket
    }
    // medical cases, a red cross on the lid
    const medCase = (x: number, z: number, ry: number) => {
      box(0.9, 0.62, 0.65, x, 0.61, z, WHITE, ry);
      box(0.55, 0.03, 0.15, x, 0.93, z, RED, ry);
      box(0.15, 0.03, 0.55, x, 0.93, z, RED, ry);
      const q = toWorld(x, z, ry, 0, 0.33);
      led(0.3, 0.04, 0.02, q.x, 0.82, q.z, LED_GREEN, ry);
    };
    medCase(2.5, 2.2, 0.15);
    medCase(1.4, 2.4, -0.2);
    box(1.1, 1.0, 1.1, -3.0, 0.8, 2.0, PANEL, 0.3);
    for (const [x, z] of [[-3.1, 0.6], [-3.2, -0.3]]) {
      cyl(1.1, 0.7, x, 0.85, z, WHITE, 12);
      cyl(0.08, 0.72, x, 1.1, z, [0.2, 0.5, 0.85], 12); // blue band
    }
    row(-3.5, -2.85, 1.5, -2.85, (x, z, ry, len, i) => jersey(x, z, ry, len, i % 2 === 0));
  } else if (kind === "bunker") {
    // pillbox: a concrete block with firing slits, a roof slab under a tarp, hazard stripes on the corners,
    // T-walls on both sides of the entrance
    box(4.4, 1.6, 4.4, 0, 0.8, 0, CONCRETE);
    box(5.0, 0.3, 5.0, 0, 1.75, 0, CONCRETE_DARK);
    box(4.5, 0.1, 4.5, 0.05, 1.95, -0.05, TARP, 0.04);
    box(1.4, 1.2, 0.08, 0, 0.6, 2.22, DARK); // entrance
    for (const [x, z, ry] of [[-1.25, 2.22, 0], [1.25, 2.22, 0], [-2.22, 0, Math.PI / 2], [2.22, 0, Math.PI / 2], [0, -2.22, 0]] as [number, number, number][]) {
      box(1.0, 0.18, 0.08, x, 1.3, z, DARK, ry); // firing slits
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) hazard(0.28, 1.6, 0.28, sx * 2.1, 0.8, sz * 2.1);
    for (const x of [-1.6, 1.6]) tWall(x, 3.1, 0, 1.3);
    // a radio aerial and a status light by the door
    cyl(2.4, 0.05, 1.8, 3.1, -1.8, STEEL, 4);
    led(0.12, 0.12, 0.05, 0.95, 1.45, 2.23, LED_GREEN);
  } else if (kind === "trench") {
    // zig-zag line of jersey barriers behind dug earth, warning lamps at the ends, a chain-link fence with razor wire
    const segs: [number, number][] = [[-6, 0.5], [-2, -0.5], [2, 0.5], [6, -0.5]];
    for (const [x, ry] of segs) {
      const z = ry > 0 ? 0.9 : -0.9;
      const p = at(x, z, ry);
      for (let i = 0; i < 3; i++) {
        const q = p(-1.45 + i * 1.45, 0);
        jersey(q.x, q.z, ry, 1.4, (i + Math.round(x)) % 2 === 0);
      }
      const e = at(x, ry > 0 ? -0.3 : -2.1, ry)(0, 0);
      box(4.4, 0.35, 1.2, e.x, 0.05, e.z, EARTH, ry); // dug earth
    }
    for (const [x, z] of [[-7.8, 1.4], [7.8, -1.4]]) {
      box(0.18, 1.4, 0.18, x, 0.7, z, STEEL);
      hazard(0.2, 0.5, 0.2, x, 0.45, z);
      led(0.22, 0.14, 0.22, x, 1.45, z, LED_YELLOW); // warning lamp
    }
    fence(-8, 3.3, 8, 3.3, 1.7);
  } else if (kind === "radar") {
    // sensor station: concrete drum, an octagonal sensor head with four tilted array panels, a lit ring and a mast;
    // an operators' container, a battery unit, an aerial mast
    const R = RADAR_DIM;
    box(7, 0.3, 7, 0, 0.1, 0, CONCRETE_DARK);
    cyl(R.drumH, R.drumR * 2, 0, 0.2 + R.drumH / 2, 0, CONCRETE, 16);
    cyl(0.25, R.drumR * 2 + 0.25, 0, 0.2 + R.drumH, 0, STEEL, 16); // ring beam
    box(0.9, 1.6, 0.06, 0, 1.0, R.drumR - 0.02, PANEL); // door
    hazard(1.1, 0.12, 0.08, 0, 1.86, R.drumR + 0.01); // over the door
    const h0 = 0.35 + R.drumH, h1 = 6.3;
    const head = cyl(h1 - h0, R.headR * 1.85, 0, (h0 + h1) / 2, 0, STEEL, 8);
    head.rotation.y = Math.PI / 8;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const q = toWorld(0, 0, a, 0, R.headR * 0.93);
      const panel = box(2.0, 2.5, 0.12, q.x, (h0 + h1) / 2, q.z, GLASS, a, -0.22);
      panel.material = mat(scene, GLASS, { rough: 0.15, metal: 0.4 });
      box(2.1, 0.08, 0.14, q.x, (h0 + h1) / 2 + 1.25, q.z, WHITE, a, -0.22); // frame
    }
    cyl(0.35, R.headR * 1.5, 0, h1 + 0.17, 0, WHITE, 16); // cap
    const ring = MeshBuilder.CreateTorus("sensorRing", { diameter: R.headR * 1.85, thickness: 0.08, tessellation: 32 }, scene);
    ring.position.y = h1 - 0.05;
    ring.material = mat(scene, LED_YELLOW, { emissive: true });
    parts.push(ring);
    cyl(R.top - h1 - 0.35, 0.12, 0, (h1 + 0.35 + R.top) / 2, 0, STEEL_LIGHT, 6); // mast for the warning light
    // operators' container, battery unit, aerial mast
    container(2.2, 1.9, 1.6, -2.6, 0.25, 2.2, PANEL);
    box(0.6, 0.35, 0.04, -2.2, 1.35, 3.02, GLASS);
    box(1.2, 0.9, 0.8, 2.6, 0.7, -2.4, WHITE);
    led(0.5, 0.05, 0.02, 2.6, 0.95, -1.99, LED_GREEN);
    box(0.08, 4.5, 0.08, 2.9, 2.45, 2.6, STEEL_LIGHT);
    box(0.9, 0.05, 0.05, 2.9, 4.5, 2.6, STEEL_LIGHT);
    led(0.12, 0.12, 0.12, 2.9, 4.75, 2.6, LED_RED);
  } else if (kind === "workshop") {
    // vehicle workshop: the open-fronted brick hall with a flat steel roof, hazard-striped posts and crane, a light bar
    // under the lintel, a charging station and battery packs
    const wall: RGB = [0.56, 0.54, 0.46];
    box(9, 0.3, 11, 0, 0.1, 0.5, CONCRETE_DARK); // concrete apron
    const brickWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = brickBox(scene, "wall", w, h, d, wall);
      m.position.set(x, y, z);
      parts.push(m);
    };
    brickWall(7, 3.6, 0.3, 0, 2.05, -2.85); // back wall
    brickWall(0.3, 3.6, 5.7, -3.35, 2.05, 0);
    brickWall(0.3, 3.6, 5.7, 3.35, 2.05, 0);
    brickWall(7, 0.6, 0.3, 0, 3.55, 2.85); // lintel over the open front
    box(6.4, 0.05, 5.4, 0, 0.26, 0, [0.2, 0.19, 0.17]); // oily floor
    const roof = createGable("workshopRoof", scene);
    roof.scaling.set(7.8, 0.6, 6.6);
    roof.position.y = 3.85;
    roof.material = mat(scene, PANEL, { twoSided: true, surface: "metal" });
    parts.push(roof);
    for (const x of [-3.35, 3.35]) hazard(0.34, 3.0, 0.34, x, 1.75, 2.86);
    led(6.2, 0.06, 0.12, 0, 3.22, 2.7, LED_WHITE); // light bar under the lintel
    // gantry crane over the bay: striped beam on steel legs
    for (const x of [-2.6, 2.6]) box(0.2, 3.2, 0.2, x, 1.85, 2.2, STEEL);
    hazard(5.4, 0.25, 0.25, 0, 3.4, 2.2);
    box(0.05, 1.2, 0.05, 0.8, 2.7, 2.2, DARK);
    // workbench, tyres
    box(2.4, 0.08, 0.7, -1.6, 1.1, -2.2, STEEL_LIGHT);
    box(2.3, 0.8, 0.6, -1.6, 0.65, -2.2, PANEL);
    const tyre = (x: number, y: number, z: number) => cyl(0.35, 1.0, x, y, z, DARK);
    tyre(2.6, 0.45, -1.8);
    tyre(2.6, 0.8, -1.8);
    tyre(2.6, 1.15, -1.8);
    // charging station outside: a pillar with a lit screen and a coiled cable; battery packs beside it
    box(0.5, 1.7, 0.35, 4.0, 1.1, 3.4, WHITE);
    led(0.32, 0.4, 0.03, 4.0, 1.5, 3.59, [0.4, 0.85, 1]);
    led(0.4, 0.05, 0.03, 4.0, 1.9, 3.59, LED_GREEN);
    const coil = MeshBuilder.CreateTorus("cable", { diameter: 0.4, thickness: 0.05, tessellation: 12 }, scene);
    coil.rotation.x = Math.PI / 2;
    coil.position.set(4.3, 0.9, 3.4);
    coil.rotation.z = Math.PI / 2;
    coil.material = mat(scene, DARK);
    parts.push(coil);
    for (const [x, z] of [[-4.0, 3.3], [-4.0, 4.3]]) {
      box(1.0, 0.7, 0.8, x, 0.6, z, PANEL);
      led(0.05, 0.4, 0.4, x + 0.51, 0.65, z, LED_GREEN);
    }
  } else {
    // guard tower: steel legs with cross bracing, a platform, a cabin with a glass band, an LED strip under the flat
    // roof, a searchlight and an aerial; jersey barriers at its foot
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]]) box(0.24, 5.2, 0.24, x, 2.6, z, STEEL);
    const brace = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number) => {
      const len = Math.hypot(bx - ax, y1 - y0, bz - az);
      const m = box(0.08, len, 0.08, (ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2, STEEL);
      m.rotation.set(0, Math.atan2(bx - ax, bz - az), 0);
      m.rotation.x = Math.atan2(Math.hypot(bx - ax, bz - az), y1 - y0);
    };
    for (const [y0, y1] of [[0.3, 2.6], [2.6, 4.9]]) {
      brace(-1.3, 1.3, 1.3, 1.3, y0, y1);
      brace(1.3, -1.3, -1.3, -1.3, y0, y1);
      brace(1.3, 1.3, 1.3, -1.3, y0, y1);
      brace(-1.3, -1.3, -1.3, 1.3, y0, y1);
    }
    box(3.6, 0.25, 3.6, 0, 5.2, 0, STEEL);
    // cabin: panel parapet, corner posts, glass band, flat roof
    for (const [x, z, w, d] of [[0, 1.7, 3.5, 0.12], [0, -1.7, 3.5, 0.12], [1.7, 0, 0.12, 3.5], [-1.7, 0, 0.12, 3.5]]) {
      box(w, 1.0, d, x, 5.82, z, PANEL);
      box(w, 0.75, d * 0.6, x, 6.72, z, GLASS);
    }
    for (const [x, z] of [[-1.7, -1.7], [1.7, -1.7], [1.7, 1.7], [-1.7, 1.7]]) box(0.14, 1.9, 0.14, x, 6.27, z, STEEL);
    box(4.0, 0.2, 4.0, 0, 7.3, 0, PANEL);
    for (const [x, z, w, d] of [[0, 2.0, 3.8, 0.04], [0, -2.0, 3.8, 0.04], [2.0, 0, 0.04, 3.8], [-2.0, 0, 0.04, 3.8]]) led(w, 0.06, d, x, 7.17, z, LED_YELLOW);
    // searchlight and aerial on the roof
    const lamp = cyl(0.45, 0.42, 1.2, 7.7, 1.2, STEEL, 10, 0, Math.PI / 2 - 0.35);
    lamp.rotation.y = 0.5;
    const lens = cyl(0.04, 0.36, 1.31, 7.78, 1.41, LED_WHITE, 10, 0, Math.PI / 2 - 0.35);
    lens.rotation.y = 0.5;
    lens.material = mat(scene, LED_WHITE, { emissive: true });
    cyl(2.6, 0.05, -1.5, 8.6, -1.5, STEEL_LIGHT, 4);
    // ladder
    box(0.08, 5, 0.08, 0.5, 2.4, 1.9, STEEL_LIGHT, 0, 0.25);
    box(0.08, 5, 0.08, -0.5, 2.4, 1.9, STEEL_LIGHT, 0, 0.25);
    for (let i = 0; i < 9; i++) box(1.0, 0.05, 0.05, 0, 0.4 + i * 0.52, 1.43 + i * 0.13, STEEL_LIGHT);
    jersey(-2.4, -1.4, Math.PI / 2, 1.6, true);
    jersey(-2.0, -2.6, 0.2, 1.6, false);
  }

  const m = merge(`outpost-${kind}`, parts);
  m.receiveShadows = true;
  m.isPickable = false;
  return m;
}
