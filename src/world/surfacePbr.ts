import {
  MaterialPluginBase, type AbstractEngine, type Material, type MaterialDefines, type Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import type { SurfaceKind } from "./models";
import { loadTextureLayers, type TextureLayers } from "./textureLayers";

/**
 * Photo textures for the outposts' buildings and the containers in the realistic graphics mode
 * (Poly Haven, CC0 - see public/textures/LICENSE.md). `tile`: metres per repeat, `bump`: strength
 * of the normal map.
 */
const SURFACES: Record<SurfaceKind, { path: string; layer: number; tile: number; bump: number }> = {
  wood: { path: "props/weathered_planks", layer: 0, tile: 2.0, bump: 0.9 },
  fabric: { path: "props/hessian_230", layer: 1, tile: 0.7, bump: 0.8 },
  concrete: { path: "props/concrete_wall_008", layer: 2, tile: 3.0, bump: 0.6 },
  metal: { path: "props/corrugated_iron_02", layer: 3, tile: 2.2, bump: 1.0 },
  earth: { path: "terrain/brown_mud_dry", layer: 4, tile: 2.0, bump: 0.9 },
  // soldiers' uniforms: the same weave, much finer (the figures are two metres tall)
  cloth: { path: "props/hessian_230", layer: 5, tile: 0.14, bump: 0.9 },
};
const ORDER = (Object.keys(SURFACES) as SurfaceKind[]).sort((a, b) => SURFACES[a].layer - SURFACES[b].layer);

let layersPromise: Promise<TextureLayers> | null = null;

/** Starts loading the surface textures (wood, cloth, metal, ...) in the background. */
export function preloadSurfaceTextures(scene: Scene) {
  layersPromise ??= loadTextureLayers(scene, ORDER.map((k) => SURFACES[k].path));
}
let layers: TextureLayers | null = null;
/** Plugins waiting for the textures. */
const waiting = new Set<SurfaceTexturePlugin>();

/**
 * Projects a texture onto the material's meshes from three sides, blended by the surface direction,
 * so boxes and cylinders need no texture coordinates and the texture keeps its real-world scale on
 * every part. The projection follows the model's own axes (not the world's): planks, ribs and
 * seams run square to a container or a roof however it is turned. Like on the ground, the texture brings detail relative to its
 * mean colour (the part keeps its paint), its roughness and its normal map.
 */
class SurfaceTexturePlugin extends MaterialPluginBase {
  constructor(material: Material, private readonly kind: SurfaceKind) {
    super(material, "SurfaceTexture", 210, { SURFACETEX: false });
    this._enable(true);
  }

  getClassName() {
    return "SurfaceTexturePlugin";
  }

  ready() {
    this.markAllDefinesAsDirty();
  }

  prepareDefines(defines: MaterialDefines) {
    defines.SURFACETEX = !!layers;
  }

  isReadyForSubMesh(): boolean {
    return !layers || (layers.albedo.isReady() && layers.normal.isReady());
  }

  getSamplers(samplers: string[]) {
    samplers.push("spAlbedo", "spNormal");
  }

  getUniforms() {
    return {
      ubo: [
        { name: "spMean", size: 3, type: "vec3" },
        { name: "spParams", size: 3, type: "vec3" },
      ],
      fragment: `#ifdef SURFACETEX
uniform vec3 spMean;
uniform vec3 spParams;
#endif`,
    };
  }

  bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh) {
    if (!layers) return;
    const s = SURFACES[this.kind];
    ubo.updateColor3("spMean", layers.means[s.layer]);
    ubo.updateFloat3("spParams", s.layer, 1 / s.tile, s.bump);
    ubo.setTexture("spAlbedo", layers.albedo);
    ubo.setTexture("spNormal", layers.normal);
  }

  getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef SURFACETEX
varying vec3 vSpPos;
varying vec3 vSpNrm;
varying vec3 vSpX;
varying vec3 vSpY;
varying vec3 vSpZ;
#endif`,
        // model-space position and normal, and the model's axes in the world (for the normal map)
        CUSTOM_VERTEX_MAIN_END: `#ifdef SURFACETEX
vSpPos = positionUpdated;
vSpNrm = normalUpdated;
vSpX = normalize(mat3(finalWorld) * vec3(1.0, 0.0, 0.0));
vSpY = normalize(mat3(finalWorld) * vec3(0.0, 1.0, 0.0));
vSpZ = normalize(mat3(finalWorld) * vec3(0.0, 0.0, 1.0));
#endif`,
      };
    }
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SURFACETEX
uniform highp sampler2DArray spAlbedo;
uniform highp sampler2DArray spNormal;
varying vec3 vSpPos;
varying vec3 vSpNrm;
varying vec3 vSpX;
varying vec3 vSpY;
varying vec3 vSpZ;
#endif`,
      CUSTOM_FRAGMENT_UPDATE_ALPHA: `#ifdef SURFACETEX
vec3 spP = vSpPos * spParams.y;
vec3 spG = normalize(vSpNrm);
vec3 spB = pow(abs(spG), vec3(4.0));
spB /= spB.x + spB.y + spB.z;
// three projections: onto the side walls (u along the wall, v up) and from above
vec3 spUvX = vec3(spP.zy, spParams.x), spUvY = vec3(spP.xz, spParams.x), spUvZ = vec3(spP.xy, spParams.x);
vec4 spA = texture(spAlbedo, spUvX) * spB.x + texture(spAlbedo, spUvY) * spB.y + texture(spAlbedo, spUvZ) * spB.z;
surfaceAlbedo *= mix(vec3(1.0), pow(spA.rgb, vec3(2.2)) / max(spMean, vec3(0.002)), 0.85);
float spRough = clamp(spA.a, 0.3, 1.0);
// normal maps per projection, bent into world space (whiteout-style blend)
vec3 spTx = texture(spNormal, spUvX).xyz * 2.0 - 1.0;
vec3 spTy = texture(spNormal, spUvY).xyz * 2.0 - 1.0;
vec3 spTz = texture(spNormal, spUvZ).xyz * 2.0 - 1.0;
vec3 spD = vec3(0.0, spTx.y, spTx.x) * spB.x + vec3(spTy.x, 0.0, spTy.y) * spB.y + vec3(spTz.x, spTz.y, 0.0) * spB.z;
normalW = normalize(normalW + (vSpX * spD.x + vSpY * spD.y + vSpZ * spD.z) * spParams.z);
#endif`,
      "!float roughness=reflectivityOut\\.roughness;": `float roughness=reflectivityOut.roughness;
#ifdef SURFACETEX
roughness=spRough;microSurface=1.0-spRough;
#endif`,
    };
  }

  dispose(forceDisposeTextures?: boolean) {
    waiting.delete(this);
    super.dispose(forceDisposeTextures);
  }
}

/** Gives a PBR material the texture of its surface kind (loaded once, on first use). */
export function attachSurfaceTexture(material: Material, kind: SurfaceKind) {
  const plugin = new SurfaceTexturePlugin(material, kind);
  if (layers) return;
  waiting.add(plugin);
  layersPromise ??= loadTextureLayers(material.getScene(), ORDER.map((k) => SURFACES[k].path));
  layersPromise.then(
    (l) => {
      layers = l;
      for (const p of waiting) p.ready();
      waiting.clear();
    },
    (e) => console.warn("surface textures unavailable", e),
  );
}
