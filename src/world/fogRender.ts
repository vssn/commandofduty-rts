import { Constants, Effect, Matrix, PostProcess, RawTexture, Texture, Vector3, type Camera, type Scene } from "@babylonjs/core";
import type { Haze } from "./environment";
import { MAP_HALF } from "../config";
import type { FogOfWar } from "../game/fog";

Effect.ShadersStore["fogOfWarFragmentShader"] = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform sampler2D fogSampler;
uniform mat4 invViewProj;
uniform float mapHalf;
uniform float strength;
uniform float texel;
uniform vec3 camPos;
uniform vec3 sunDir;
uniform vec3 hazeColor;
uniform vec3 hazeSun;
// x: start distance, y: density, z: max, w: depth density
uniform vec4 hazeParams;

// soft sample: centre plus a ring of 8 taps, so cell edges never show
float fogAt(vec2 uv) {
  float r = texel * 1.6;
  float v = texture2D(fogSampler, uv).r * 2.0;
  v += texture2D(fogSampler, uv + vec2(r, 0.0)).r;
  v += texture2D(fogSampler, uv - vec2(r, 0.0)).r;
  v += texture2D(fogSampler, uv + vec2(0.0, r)).r;
  v += texture2D(fogSampler, uv - vec2(0.0, r)).r;
  v += texture2D(fogSampler, uv + vec2(r, r) * 0.707).r;
  v += texture2D(fogSampler, uv - vec2(r, r) * 0.707).r;
  v += texture2D(fogSampler, uv + vec2(r, -r) * 0.707).r;
  v += texture2D(fogSampler, uv - vec2(r, -r) * 0.707).r;
  return v / 10.0;
}

void main(void) {
  vec4 col = texture2D(textureSampler, vUV);
  float depth = texture2D(depthSampler, vUV).r;
  if (depth >= 0.9999) { gl_FragColor = col; return; }
  // world position of this pixel from the depth buffer
  vec4 world = invViewProj * vec4(vUV * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;

  // distance haze (aerial perspective): far ground fades into the haze colour, warmer towards the
  // sun; deep ground (the gorge) fills up with haze as well
  vec3 toP = world.xyz - camPos;
  float dist = length(toP);
  float fDist = 1.0 - exp(-max(0.0, dist - hazeParams.x) * hazeParams.y);
  float fDeep = 1.0 - exp(-max(0.0, -world.y - 8.0) * hazeParams.w);
  float haze = min(hazeParams.z, 1.0 - (1.0 - fDist) * (1.0 - fDeep));
  float towardsSun = pow(max(dot(toP / dist, -sunDir), 0.0), 6.0);
  col.rgb = mix(col.rgb, mix(hazeColor, hazeSun, towardsSun), haze);
  if (strength <= 0.0) { gl_FragColor = col; return; }

  vec2 fuv = (world.xz + mapHalf) / (2.0 * mapHalf);
  // beyond the playable area (cliffs, mountains) the fog continues from the nearest map edge,
  // dimmed with distance so the scenery stays a backdrop
  float v = fogAt(clamp(fuv, vec2(0.0), vec2(1.0)));
  float outside = max(abs(world.x), abs(world.z)) - mapHalf;
  v *= 1.0 - 0.35 * smoothstep(0.0, 40.0, outside);
  // a touch of world-space noise breaks up banding in the soft gradients
  float n = fract(sin(dot(floor(world.xz * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
  v = clamp(v + (n - 0.5) * 0.03, 0.0, 1.0);
  v = v * v * (3.0 - 2.0 * v) * 0.35 + v * 0.65; // gentle S-curve: soft but not washed out
  // explored = greyish and darker, never seen = almost black
  float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  vec3 grey = mix(col.rgb, vec3(lum) * vec3(0.86, 0.9, 1.0), (1.0 - v) * 0.7);
  vec3 fogged = grey * mix(0.1, 1.0, v);
  gl_FragColor = vec4(mix(col.rgb, fogged, strength), col.a);
}
`;

/**
 * Screen-space fog of war: reconstructs each pixel's world position from the depth buffer and
 * darkens it by the fog grid, so terrain, trees and buildings are all covered consistently.
 */
export class FogRenderer {
  /** 0 = off (main menu), 1 = full fog. */
  strength = 1;
  private readonly tex: RawTexture;
  private readonly data: Uint8Array;
  private readonly blurA: Float32Array;
  private readonly blurB: Float32Array;
  private readonly invViewProj = new Matrix();

  constructor(
    scene: Scene,
    camera: Camera,
    private readonly fog: FogOfWar,
    /** Current haze settings and the sun's direction (changes with day / night). */
    haze: () => Haze,
    sunDir: Vector3,
    /** Camera distance to the ground focus (for a zoom-relative haze start). */
    camDistance: () => number,
  ) {
    const n = fog.n;
    this.data = new Uint8Array(n * n * 4);
    this.blurA = new Float32Array(n * n);
    this.blurB = new Float32Array(n * n);
    this.tex = new RawTexture(this.data, n, n, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    this.tex.wrapU = this.tex.wrapV = Texture.CLAMP_ADDRESSMODE;

    const depth = scene.enableDepthRenderer(camera, true, true);
    const pp = new PostProcess(
      "fogOfWar", "fogOfWar",
      ["invViewProj", "mapHalf", "strength", "texel", "camPos", "sunDir", "hazeColor", "hazeSun", "hazeParams"],
      ["depthSampler", "fogSampler"], 1, camera,
    );
    pp.samples = 4; // keep anti-aliasing although the scene now renders into a texture
    pp.onApply = (effect) => {
      camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), this.invViewProj);
      this.invViewProj.invert();
      effect.setMatrix("invViewProj", this.invViewProj);
      effect.setFloat("mapHalf", MAP_HALF);
      effect.setFloat("strength", this.strength);
      effect.setFloat("texel", 1 / n);
      effect.setTexture("depthSampler", depth.getDepthMap());
      effect.setTexture("fogSampler", this.tex);
      const h = haze();
      effect.setVector3("camPos", camera.globalPosition);
      effect.setVector3("sunDir", sunDir);
      effect.setFloat3("hazeColor", h.color[0], h.color[1], h.color[2]);
      effect.setFloat3("hazeSun", h.sunColor[0], h.sunColor[1], h.sunColor[2]);
      effect.setFloat4("hazeParams", camDistance() * h.start, h.density, h.max, h.depth);
    };
  }

  /** Separable binomial blur [1 4 6 4 1] along x or z, clamped at the map border. */
  private blur(src: Float32Array, dst: Float32Array, alongX: boolean) {
    const n = this.fog.n;
    const w = [1, 4, 6, 4, 1];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) {
          const ii = alongX ? Math.min(n - 1, Math.max(0, i + k)) : i;
          const jj = alongX ? j : Math.min(n - 1, Math.max(0, j + k));
          s += src[ii + jj * n] * w[k + 2];
        }
        dst[i + j * n] = s / 16;
      }
    }
  }

  /** Uploads the current fog values, softened with two blur passes so the grid never shows. */
  update() {
    const d = this.data;
    this.blur(this.fog.values, this.blurA, true);
    this.blur(this.blurA, this.blurB, false);
    this.blur(this.blurB, this.blurA, true);
    this.blur(this.blurA, this.blurB, false);
    const v = this.blurB;
    for (let i = 0; i < v.length; i++) {
      const b = Math.round(v[i] * 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    this.tex.update(d);
  }
}
