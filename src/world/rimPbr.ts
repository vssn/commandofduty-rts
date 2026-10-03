import { MaterialPluginBase, type Material, type MaterialDefines, type UniformBuffer } from "@babylonjs/core";
import type { RGB } from "./layout";

/**
 * A rim light inside the surface: where a surface turns away from the viewer, a little of `color` is
 * added to the lit result (a Fresnel glow). It sits on the figure's own materials and never reaches
 * beyond their silhouette - used for the soldiers of the realistic mode, in their team's colour.
 */
class RimPlugin extends MaterialPluginBase {
  constructor(material: Material, private readonly color: RGB, private readonly strength: number) {
    super(material, "Rim", 220, { RIMLIGHT: true });
    this._enable(true);
  }

  getClassName() {
    return "RimPlugin";
  }

  prepareDefines(defines: MaterialDefines) {
    defines.RIMLIGHT = true;
  }

  getUniforms() {
    return {
      ubo: [{ name: "rimColor", size: 3, type: "vec3" }],
      fragment: `#ifdef RIMLIGHT
uniform vec3 rimColor;
#endif`,
    };
  }

  bindForSubMesh(ubo: UniformBuffer) {
    ubo.updateFloat3("rimColor", this.color[0] * this.strength, this.color[1] * this.strength, this.color[2] * this.strength);
  }

  getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return {
      // after the lighting, before the final colour: add the glow where the normal turns away
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `#ifdef RIMLIGHT
float rimF = pow(1.0 - clamp(dot(normalize(normalW), normalize(viewDirectionW)), 0.0, 1.0), 2.2);
finalDiffuse += rimColor * rimF;
#endif`,
    };
  }
}

/** Gives a PBR material a rim light in `color` (linear, scaled by `strength`). */
export function attachRim(material: Material, color: RGB, strength = 0.3) {
  new RimPlugin(material, color, strength);
}
