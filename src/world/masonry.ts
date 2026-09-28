import {
  Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Texture, Vector3, Vector4, type Scene, type TransformNode,
} from "@babylonjs/core";
import { rng } from "../util/noise";
import type { RGB } from "./layout";

/** World size of one repeat of the brick texture (4 bricks wide, 8 courses high). */
const BRICK_TILE = { w: 2.0, h: 2.0 };

const brickTextures = new Map<Scene, DynamicTexture>();

/**
 * Greyscale brick pattern that multiplies the wall colour: staggered bricks with individually
 * varied shade, darker mortar joints and a little grit.
 */
function brickTexture(scene: Scene): DynamicTexture {
  let tex = brickTextures.get(scene);
  if (tex) return tex;
  const size = 256, rows = 8, cols = 4, bw = size / cols, bh = size / rows, mortar = 3;
  tex = new DynamicTexture("bricks", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const r = rng(77);
  const shade: number[] = [];
  for (let i = 0; i < rows * (cols + 1); i++) shade.push(0.86 + r() * 0.14);
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / bh);
    const offset = row % 2 ? bw / 2 : 0;
    for (let x = 0; x < size; x++) {
      const xs = (x + offset) % size;
      const col = Math.floor(xs / bw);
      const inX = xs - col * bw, inY = y - row * bh;
      const joint = inX < mortar || inY < mortar;
      let v = joint ? 0.66 : shade[row * (cols + 1) + col];
      v += (Math.random() - 0.5) * 0.06;
      const i = (x + y * size) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  brickTextures.set(scene, tex);
  return tex;
}

const brickMats = new Map<string, StandardMaterial>();

/** Brick-textured wall material in the given colour (shared per scene and colour). */
export function brickMaterial(scene: Scene, c: RGB): StandardMaterial {
  const key = scene.uid + ":" + c.join(",");
  let m = brickMats.get(key);
  if (!m) {
    m = new StandardMaterial("brick" + key, scene);
    m.diffuseTexture = brickTexture(scene);
    m.diffuseColor = new Color3(c[0] * 1.08, c[1] * 1.08, c[2] * 1.08); // offsets the darker joints
    m.specularColor = Color3.Black();
    brickMats.set(key, m);
  }
  return m;
}

/** Per-face UVs so the bricks keep their real size on a box of the given dimensions. */
export function brickFaceUV(w: number, h: number, d: number): Vector4[] {
  const u = (len: number) => len / BRICK_TILE.w, v = h / BRICK_TILE.h;
  return [
    new Vector4(0, 0, u(w), v), new Vector4(0, 0, u(w), v),
    new Vector4(0, 0, u(d), v), new Vector4(0, 0, u(d), v),
    new Vector4(0, 0, 0.01, 0.01), new Vector4(0, 0, 0.01, 0.01),
  ];
}

/** Brick box of real size, centred like MeshBuilder.CreateBox. */
export function brickBox(scene: Scene, name: string, w: number, h: number, d: number, c: RGB): Mesh {
  const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, faceUV: brickFaceUV(w, h, d), wrap: true }, scene);
  m.material = brickMaterial(scene, c);
  return m;
}

// ------------------------------------------------------------------ roof tiles

/** A gable roof (ridge along local z, eaves at y = 0) of width `w`, height `h`, depth `d`, placed by `transform`. */
export interface RoofSpec { w: number; h: number; d: number; color: RGB; transform: Matrix }

const TILE = { size: 0.46, step: 0.38, thick: 0.07 };

/**
 * Covers gable roofs with rows of small, slightly overlapping and tilted tiles (like shingles or
 * clay tiles), staggered every other course and varied in shade. One thin-instanced mesh; if a
 * `parent` is given, transforms are relative to it (so tiles move with e.g. a sinking building).
 */
export function createRoofTiles(scene: Scene, name: string, roofs: RoofSpec[], parent?: TransformNode): Mesh {
  const r = rng(name.length * 131 + roofs.length);
  const tile = MeshBuilder.CreateBox(name, { width: TILE.size, height: TILE.thick, depth: TILE.size * 0.94 }, scene);
  const mt = new StandardMaterial(name + "Mat", scene);
  mt.diffuseColor = Color3.White();
  mt.specularColor = Color3.Black();
  tile.material = mt;

  const matrices: number[] = [];
  const colors: number[] = [];
  const local = new Matrix(), world = new Matrix();
  for (const roof of roofs) {
    const half = roof.w / 2;
    const slope = Math.hypot(half, roof.h);
    const alpha = Math.atan2(roof.h, half);
    const courses = Math.max(1, Math.ceil(slope / TILE.step));
    const perRow = Math.max(1, Math.round(roof.d / TILE.size));
    for (const side of [-1, 1]) {
      for (let c = 0; c < courses; c++) {
        // distance up the slope from the eave; each course overlaps the one below
        const t = Math.min(1, (c + 0.5) / courses);
        const stagger = c % 2 ? 0.5 : 0;
        for (let k = 0; k < perRow; k++) {
          const z = -roof.d / 2 + ((k + 0.5 + stagger) % perRow) * (roof.d / perRow);
          // point on the slope, pushed out along the slope normal so the tile sits on top
          const nx = side * Math.sin(alpha), ny = Math.cos(alpha);
          const x = side * half * (1 - t) + nx * (TILE.thick / 2 + 0.02);
          const y = roof.h * t + ny * (TILE.thick / 2 + 0.02);
          // tilt with the slope plus a little extra so the lower edge lifts like a real tile
          const tilt = side * -(alpha + 0.06 + (r() - 0.5) * 0.05);
          Matrix.ComposeToRef(
            Vector3.One(),
            Quaternion.RotationYawPitchRoll((r() - 0.5) * 0.04, 0, tilt),
            new Vector3(x, y, z + (r() - 0.5) * 0.03),
            local,
          );
          local.multiplyToRef(roof.transform, world);
          matrices.push(...world.asArray());
          const shade = 0.9 + r() * 0.22;
          colors.push(roof.color[0] * shade, roof.color[1] * shade, roof.color[2] * shade, 1);
        }
      }
    }
  }
  tile.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
  tile.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  tile.thinInstanceRefreshBoundingInfo(false);
  tile.isPickable = false;
  tile.receiveShadows = true;
  if (parent) tile.parent = parent;
  return tile;
}
