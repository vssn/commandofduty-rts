import { Color3, Constants, RawTexture2DArray, Texture, type Scene } from "@babylonjs/core";

/**
 * Loading of photo textures (Poly Haven, CC0 - see public/textures/LICENSE.md) into texture
 * arrays for the realistic graphics mode: one array with albedo (rgb) + roughness (a), one with the
 * tangent-space normals, plus each layer's mean albedo in linear space. Shaders use the textures
 * for detail relative to that mean, so the objects keep their own colours.
 */
export interface TextureLayers { albedo: RawTexture2DArray; normal: RawTexture2DArray; means: Color3[] }

const SIZE = 1024;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`texture ${url} failed to load`));
    img.src = url;
  });
}

/** Loads the layers (each `<path>_diff_1k.jpg`, `_rough_1k.jpg`, `_nor_gl_1k.jpg` under public/textures/). */
export async function loadTextureLayers(scene: Scene, paths: readonly string[]): Promise<TextureLayers> {
  const base = `${import.meta.env.BASE_URL}textures/`;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const pixels = (img: HTMLImageElement) => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  };
  const layer = SIZE * SIZE * 4;
  const albedo = new Uint8Array(layer * paths.length), normal = new Uint8Array(layer * paths.length);
  const means: Color3[] = [];
  const imgs = await Promise.all(paths.map((p) => Promise.all(["diff", "rough", "nor_gl"].map((m) => loadImage(`${base}${p}_${m}_1k.jpg`)))));
  imgs.forEach(([diff, rough, nor], i) => {
    const o = i * layer;
    const d = pixels(diff);
    albedo.set(d, o);
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < d.length; k += 16) {
      r += Math.pow(d[k] / 255, 2.2);
      g += Math.pow(d[k + 1] / 255, 2.2);
      b += Math.pow(d[k + 2] / 255, 2.2);
    }
    const n = d.length / 16;
    means.push(new Color3(r / n, g / n, b / n));
    const rg = pixels(rough);
    for (let k = 0; k < layer; k += 4) albedo[o + k + 3] = rg[k];
    normal.set(pixels(nor), o);
  });
  const arr = (data: Uint8Array, name: string) => {
    const t = new RawTexture2DArray(data, SIZE, SIZE, paths.length, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    t.name = name;
    t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 8;
    return t;
  };
  return { albedo: arr(albedo, `${paths[0]}-albedo`), normal: arr(normal, `${paths[0]}-normal`), means };
}
