import { MaterialPluginBase, type Material, type MaterialDefines, type UniformBuffer } from "@babylonjs/core";
import type { RGB } from "./layout";

/** How many lights shine on the scenery at once (the nearest ones). */
export const MAX_SPOTS = 6;

/** A light that lifts trees and buildings: where it shines (world position of its centre), how far, its colour and strength. */
export interface SpotLight { x: number; y: number; z: number; radius: number; color: RGB; intensity: number }

const a = new Float32Array(MAX_SPOTS * 4); // x, y, z, radius
const b = new Float32Array(MAX_SPOTS * 4); // r, g, b, intensity

/** Sets the lights for the next frames (at most `MAX_SPOTS`; the rest are switched off). */
export function setSpotLights(list: readonly SpotLight[]) {
  for (let i = 0; i < MAX_SPOTS; i++) {
    const l = list[i];
    a.set(l ? [l.x, l.y, l.z, l.radius] : [0, 0, 0, 1], i * 4);
    b.set(l ? [l.color[0], l.color[1], l.color[2], l.intensity] : [0, 0, 0, 0], i * 4);
  }
}
setSpotLights([]);

const NAMES = Array.from({ length: MAX_SPOTS }, (_, i) => i);

/**
 * Lets searchlights, drone lights and street lamps light the scenery - trees, houses, vehicles - and
 * not only the ground: each of the nearest few lights adds its colour, scaled by the surface's own
 * colour, to what faces it and is within its reach, falling off smoothly (a little wrap-around so that
 * the walls turned away are not black). A cheap stand-in for real scene lights, of which a material only
 * takes a handful. A light whose strength is 0 costs a single comparison.
 */
class SpotPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "SpotLights", 230, { SPOTLIGHTS: true });
    this._enable(true);
  }

  getClassName() {
    return "SpotPlugin";
  }

  prepareDefines(defines: MaterialDefines) {
    defines.SPOTLIGHTS = true;
  }

  getUniforms() {
    return {
      ubo: NAMES.flatMap((i) => [{ name: `spA${i}`, size: 4, type: "vec4" }, { name: `spB${i}`, size: 4, type: "vec4" }]),
      fragment: `#ifdef SPOTLIGHTS
${NAMES.map((i) => `uniform vec4 spA${i};\nuniform vec4 spB${i};`).join("\n")}
#endif`,
    };
  }

  bindForSubMesh(ubo: UniformBuffer) {
    for (const i of NAMES) {
      ubo.updateFloat4(`spA${i}`, a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]);
      ubo.updateFloat4(`spB${i}`, b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]);
    }
  }

  getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SPOTLIGHTS
vec3 spotLit(vec4 A, vec4 B, vec3 p, vec3 n) {
  vec3 d = A.xyz - p;
  float dist = length(d);
  if (dist >= A.w) return vec3(0.0);
  float fall = 1.0 - dist / A.w;
  float facing = clamp(dot(n, d / max(dist, 0.001)) * 0.65 + 0.35, 0.0, 1.0);
  return B.rgb * B.a * pow(fall, 1.3) * facing;
}
#endif`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `#ifdef SPOTLIGHTS
vec3 spotSum = vec3(0.0);
${NAMES.map((i) => `if (spB${i}.a > 0.0) spotSum += spotLit(spA${i}, spB${i}, vPositionW, normalW);`).join("\n")}
finalDiffuse += (surfaceAlbedo * 0.85 + vec3(0.05)) * spotSum;
#endif`,
    };
  }
}

/** Lets the lights set with `setSpotLights` shine on this PBR material. */
export function attachSpotLights(material: Material) {
  new SpotPlugin(material);
}
