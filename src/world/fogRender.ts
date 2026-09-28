import { Constants, Effect, Matrix, PostProcess, RawTexture, Texture, type Camera, type Scene } from "@babylonjs/core";
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

void main(void) {
  vec4 col = texture2D(textureSampler, vUV);
  float depth = texture2D(depthSampler, vUV).r;
  if (depth >= 0.9999 || strength <= 0.0) { gl_FragColor = col; return; }
  // world position of this pixel from the depth buffer
  vec4 world = invViewProj * vec4(vUV * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;
  vec2 fuv = (world.xz + mapHalf) / (2.0 * mapHalf);
  // beyond the playable area counts as explored
  float v = (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) ? 0.45 : texture2D(fogSampler, fuv).r;
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
  private readonly invViewProj = new Matrix();

  constructor(scene: Scene, camera: Camera, private readonly fog: FogOfWar) {
    const n = fog.n;
    this.data = new Uint8Array(n * n * 4);
    this.tex = new RawTexture(this.data, n, n, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    this.tex.wrapU = this.tex.wrapV = Texture.CLAMP_ADDRESSMODE;

    const depth = scene.enableDepthRenderer(camera, true, true);
    const pp = new PostProcess("fogOfWar", "fogOfWar", ["invViewProj", "mapHalf", "strength"], ["depthSampler", "fogSampler"], 1, camera);
    pp.samples = 4; // keep anti-aliasing although the scene now renders into a texture
    pp.onApply = (effect) => {
      camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), this.invViewProj);
      this.invViewProj.invert();
      effect.setMatrix("invViewProj", this.invViewProj);
      effect.setFloat("mapHalf", MAP_HALF);
      effect.setFloat("strength", this.strength);
      effect.setTexture("depthSampler", depth.getDepthMap());
      effect.setTexture("fogSampler", this.tex);
    };
  }

  /** Uploads the current fog values. */
  update() {
    const v = this.fog.values, d = this.data;
    for (let i = 0; i < v.length; i++) {
      const b = Math.round(v[i] * 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    this.tex.update(d);
  }
}
