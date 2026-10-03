import {
  Color3, MaterialPluginBase, PBRMaterial, RawTexture, Texture, VertexBuffer,
  type AbstractEngine, type Material, type MaterialDefines, type Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import { ROAD_RANGE, type Terrain } from "./terrain";
import { loadTextureLayers, type TextureLayers } from "./textureLayers";

/**
 * Texture layers of the realistic ground (Poly Haven, CC0 - see public/textures/LICENSE.md), in
 * the order of the texture arrays: `tile` is the size in metres of one repeat.
 */
const LAYERS = [
  { name: "leafy_grass", tile: 3.4 }, // natural ground
  { name: "brown_mud_dry", tile: 2.6 }, // dirt roads, verges, trodden earth
  { name: "dry_mud_field_001", tile: 4.5 }, // fields
  { name: "asphalt_02", tile: 4.5 }, // asphalt roads
  { name: "gravel_concrete", tile: 3.2 }, // base pads, kerbs
  { name: "rock_face_03", tile: 7 }, // slopes, gorge, mountain
] as const;

/** Road surface colours (gamma), as on the classic ground. */
const ROAD_COLORS = {
  asphalt: [0.28, 0.28, 0.3], curb: [0.62, 0.6, 0.56], vergeTown: [0.5, 0.5, 0.36],
  dirt: [0.55, 0.41, 0.26], dirtCentre: [0.52, 0.45, 0.27], vergeDirt: [0.54, 0.47, 0.28],
} as const;
const vec3 = (c: readonly number[]) => `vec3(${c.map((v) => v.toFixed(3)).join(", ")})`;

let layersPromise: Promise<TextureLayers> | null = null;

/**
 * Blends the texture layers over the ground in the PBR shader: the baked masks decide where roads,
 * fields and pads lie (smooth curves instead of triangle edges), the slope where rock shows. Each
 * layer multiplies its detail (relative to its mean colour) onto the painted colour, and brings its
 * own roughness and normal map.
 */
class TerrainSplatPlugin extends MaterialPluginBase {
  private layers: TextureLayers | null = null;

  constructor(
    material: Material,
    private readonly decal: RawTexture,
    private readonly kind: RawTexture,
    private readonly roads: RawTexture,
    private readonly half: number,
  ) {
    super(material, "TerrainSplat", 210, { TERRAINSPLAT: false });
    this._enable(true);
  }

  /** The layer textures are ready: switch the blending on. */
  setLayers(layers: TextureLayers) {
    this.layers = layers;
    this.markAllDefinesAsDirty();
  }

  getClassName() {
    return "TerrainSplatPlugin";
  }

  prepareDefines(defines: MaterialDefines) {
    defines.TERRAINSPLAT = !!this.layers;
  }

  isReadyForSubMesh(): boolean {
    const l = this.layers;
    if (!l) return true;
    return l.albedo.isReady() && l.normal.isReady() && this.decal.isReady() && this.kind.isReady() && this.roads.isReady();
  }

  getSamplers(samplers: string[]) {
    samplers.push("tsAlbedo", "tsNormal", "tsDecal", "tsKind", "tsRoads");
  }

  getUniforms() {
    return {
      ubo: [
        ...LAYERS.map((_, i) => ({ name: `tsMean${i}`, size: 3, type: "vec3" })),
        { name: "tsHalf", size: 1, type: "float" },
      ],
      fragment: `#ifdef TERRAINSPLAT
${LAYERS.map((_, i) => `uniform vec3 tsMean${i};`).join("\n")}
uniform float tsHalf;
#endif`,
    };
  }

  bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh) {
    const l = this.layers;
    if (!l) return;
    l.means.forEach((m, i) => ubo.updateColor3(`tsMean${i}`, m));
    ubo.updateFloat("tsHalf", this.half);
    ubo.setTexture("tsAlbedo", l.albedo);
    ubo.setTexture("tsNormal", l.normal);
    ubo.setTexture("tsDecal", this.decal);
    ubo.setTexture("tsKind", this.kind);
    ubo.setTexture("tsRoads", this.roads);
  }

  getCustomCode(shaderType: string) {
    if (shaderType !== "fragment") return null;
    const tiles = LAYERS.map((l) => (1 / l.tile).toFixed(5));
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TERRAINSPLAT
uniform highp sampler2DArray tsAlbedo;
uniform highp sampler2DArray tsNormal;
uniform sampler2D tsDecal;
uniform sampler2D tsKind;
uniform sampler2D tsRoads;
vec3 tsLin(vec3 c) { return pow(c, vec3(2.2)); }
/** Detail of a layer relative to its mean colour (1 = unchanged), slightly toned down. */
vec3 tsDetail(vec4 a, vec3 mean) { return mix(vec3(1.0), tsLin(a.rgb) / max(mean, vec3(0.002)), 0.9); }
#endif`,
      // after the albedo is known, before the lighting: blend colour, normal and roughness
      CUSTOM_FRAGMENT_UPDATE_ALPHA: `#ifdef TERRAINSPLAT
vec2 tsP = vPositionW.xz;
vec2 tsUv = tsP / (2.0 * tsHalf) + 0.5;
float tsIn = step(abs(tsP.x), tsHalf) * step(abs(tsP.y), tsHalf);
vec4 tsDec = texture(tsDecal, tsUv);
tsDec.a *= tsIn;
vec4 tsK = texture(tsKind, tsUv);
tsK /= max(tsK.r + tsK.g + tsK.b + tsK.a, 0.001);
// the layers, each in its own scale and slightly turned so the repeats do not line up
vec4 tsA0 = texture(tsAlbedo, vec3(tsP * ${tiles[0]}, 0.0));
vec4 tsA1 = texture(tsAlbedo, vec3(mat2(0.96, 0.28, -0.28, 0.96) * tsP * ${tiles[1]}, 1.0));
vec4 tsA2 = texture(tsAlbedo, vec3(tsP * ${tiles[2]}, 2.0));
// asphalt runs along its street: the baked street direction turns its texture
vec4 tsRdTex = texture(tsRoads, tsUv);
vec2 tsDir2 = tsRdTex.ba * 2.0 - 1.0;
float tsAng = 0.5 * atan(tsDir2.y, tsDir2.x);
vec2 tsAsUv = mat2(cos(tsAng), -sin(tsAng), sin(tsAng), cos(tsAng)) * tsP * ${tiles[3]};
vec4 tsA3 = texture(tsAlbedo, vec3(tsAsUv, 3.0));
vec4 tsA4 = texture(tsAlbedo, vec3(tsP * ${tiles[4]}, 4.0));
vec3 tsN0 = texture(tsNormal, vec3(tsP * ${tiles[0]}, 0.0)).xyz;
vec3 tsN1 = texture(tsNormal, vec3(mat2(0.96, 0.28, -0.28, 0.96) * tsP * ${tiles[1]}, 1.0)).xyz;
vec3 tsN2 = texture(tsNormal, vec3(tsP * ${tiles[2]}, 2.0)).xyz;
vec3 tsN3 = texture(tsNormal, vec3(tsAsUv, 3.0)).xyz;
vec3 tsN4 = texture(tsNormal, vec3(tsP * ${tiles[4]}, 4.0)).xyz;
// rock: projected from above on gentle slopes, from the side on steep faces
vec3 tsGeo = normalize(vNormalW);
float tsSlope = 1.0 - clamp(tsGeo.y, 0.0, 1.0);
float tsRock = smoothstep(0.16, 0.42, tsSlope);
vec2 tsSide = mix(vPositionW.xy, vPositionW.zy, step(abs(tsGeo.z), abs(tsGeo.x)));
float tsSteep = smoothstep(0.35, 0.65, tsSlope);
vec2 tsRockUv = mix(tsP, tsSide, tsSteep) * ${tiles[5]};
vec4 tsA5 = texture(tsAlbedo, vec3(tsRockUv, 5.0));
vec3 tsN5 = texture(tsNormal, vec3(tsRockUv, 5.0)).xyz;
// the grass a second time, much larger and turned: patches of lusher and sparser growth that
// break up the repeats and still read from high above
vec4 tsA0m = texture(tsAlbedo, vec3(mat2(0.6, 0.8, -0.8, 0.6) * tsP * 0.043, 0.0));
vec3 tsGrass = tsDetail(tsA0, tsMean0) * mix(vec3(1.0), tsDetail(tsA0m, tsMean0), 0.75);
// natural ground (grass or rock) under the painted surfaces
vec3 tsNat = mix(tsGrass, tsDetail(tsA5, tsMean5), tsRock);
vec3 tsPaint = tsK.r * tsDetail(tsA1, tsMean1) + tsK.g * tsDetail(tsA2, tsMean2) + tsK.b * tsDetail(tsA3, tsMean3) + tsK.a * tsDetail(tsA4, tsMean4);
vec3 tsCol = mix(surfaceAlbedo * tsNat, tsLin(tsDec.rgb) * tsPaint, tsDec.a);
float tsRough = mix(mix(tsA0.a, tsA5.a, tsRock), dot(tsK, vec4(tsA1.a, tsA2.a, tsA3.a, tsA4.a)), tsDec.a);
vec3 tsNm = mix(mix(tsN0, tsN5, tsRock), tsK.r * tsN1 + tsK.g * tsN2 + tsK.b * tsN3 + tsK.a * tsN4, tsDec.a);
// roads from the baked distances (metres to the edge, negative on the road): edges stay crisp
// and straight at any angle, anti-aliased over about one pixel
vec2 tsRd = (tsRdTex.rg * 2.0 - 1.0) * ${ROAD_RANGE.toFixed(1)};
tsRd = mix(vec2(${ROAD_RANGE.toFixed(1)}), tsRd, tsIn);
vec2 tsAa = fwidth(tsRd) * 0.75 + 0.015;
float tsJag = (tsA0m.g - 0.5) * 0.5; // a little irregularity for the worn verges
// dirt roads: worn verge, the track, its grassy centre hump
float tsW = smoothstep(1.8, 0.0, tsRd.y + tsJag) * 0.75 * step(0.0, tsRd.y);
tsCol = mix(tsCol, tsLin(${vec3(ROAD_COLORS.vergeDirt)}) * tsDetail(tsA1, tsMean1), tsW);
tsRough = mix(tsRough, tsA1.a, tsW); tsNm = mix(tsNm, tsN1, tsW);
tsW = smoothstep(tsAa.y, -tsAa.y, tsRd.y);
vec3 tsDirtC = mix(tsLin(${vec3(ROAD_COLORS.dirt)}), tsLin(${vec3(ROAD_COLORS.dirtCentre)}), smoothstep(-0.8, -1.0, tsRd.y));
tsCol = mix(tsCol, tsDirtC * tsDetail(tsA1, tsMean1), tsW);
tsRough = mix(tsRough, tsA1.a, tsW); tsNm = mix(tsNm, tsN1, tsW);
// asphalt streets: verge, kerb (0..0.6 m) and the street itself
tsW = smoothstep(2.4, 0.6, tsRd.x + tsJag) * 0.75 * step(0.6, tsRd.x);
tsCol = mix(tsCol, tsLin(${vec3(ROAD_COLORS.vergeTown)}) * tsDetail(tsA1, tsMean1), tsW);
tsRough = mix(tsRough, tsA1.a, tsW); tsNm = mix(tsNm, tsN1, tsW);
tsW = smoothstep(0.6 + tsAa.x, 0.6 - tsAa.x, tsRd.x);
tsCol = mix(tsCol, tsLin(${vec3(ROAD_COLORS.curb)}) * tsDetail(tsA4, tsMean4), tsW);
tsRough = mix(tsRough, tsA4.a, tsW); tsNm = mix(tsNm, tsN4, tsW);
tsW = smoothstep(tsAa.x, -tsAa.x, tsRd.x);
tsCol = mix(tsCol, tsLin(${vec3(ROAD_COLORS.asphalt)}) * tsDetail(tsA3, tsMean3), tsW);
tsRough = mix(tsRough, tsA3.a, tsW); tsNm = mix(tsNm, tsN3, tsW);
surfaceAlbedo = tsCol;
tsRough = clamp(tsRough, 0.35, 1.0);
vec3 tsNt = tsNm * 2.0 - 1.0;
// tangent frame of the top projection (u = x, v = z), bent with the ground
vec3 tsT = normalize(vec3(1.0, 0.0, 0.0) - normalW * normalW.x);
vec3 tsB = cross(tsT, normalW);
normalW = normalize(tsT * tsNt.x + tsB * tsNt.y + normalW * max(tsNt.z, 0.2));
#endif`,
      // the layers' roughness replaces the material's
      "!float roughness=reflectivityOut\\.roughness;": `float roughness=reflectivityOut.roughness;
#ifdef TERRAINSPLAT
roughness=tsRough;microSurface=1.0-tsRough;
#endif`,
    };
  }
}

/**
 * The ground in the realistic graphics mode: a PBR material with texture layers, smooth normals and
 * linear natural colours. Switched on and off by the PBR mode; the classic ground is restored exactly.
 */
export class RealisticTerrain {
  private material: PBRMaterial | null = null;
  private plugin: TerrainSplatPlugin | null = null;
  private classic: { material: Material | null; normals: Float32Array; colors: Float32Array } | null = null;
  private ground: { normals: Float32Array; colors: Float32Array } | null = null;
  private masks: { decal: RawTexture; kind: RawTexture; roads: RawTexture; half: number } | null = null;
  private arrays: TextureLayers | null = null;

  constructor(private readonly scene: Scene, private readonly terrain: Terrain) {}

  /** Call after the atmosphere exists (it attaches itself to PBR materials created afterwards). */
  enable() {
    const mesh = this.terrain.mesh;
    if (this.material) return;
    this.classic = {
      material: mesh.material,
      normals: mesh.getVerticesData(VertexBuffer.NormalKind) as Float32Array,
      colors: mesh.getVerticesData(VertexBuffer.ColorKind) as Float32Array,
    };
    this.ground ??= this.terrain.realisticGround();
    if (!this.masks) {
      const m = this.terrain.bakeSurfaces();
      const tex = (data: Uint8Array, name: string) => {
        const t = RawTexture.CreateRGBATexture(data, m.res, m.res, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
        t.name = name;
        t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
        return t;
      };
      this.masks = { decal: tex(m.decal, "groundDecal"), kind: tex(m.kind, "groundKind"), roads: tex(m.roads, "groundRoads"), half: m.half };
    }
    mesh.setVerticesData(VertexBuffer.NormalKind, this.ground.normals);
    mesh.setVerticesData(VertexBuffer.ColorKind, this.ground.colors);

    const mat = new PBRMaterial("terrainPbr", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    this.plugin = new TerrainSplatPlugin(mat, this.masks.decal, this.masks.kind, this.masks.roads, this.masks.half);
    this.material = mat;
    mesh.material = mat;

    if (this.arrays) this.plugin.setLayers(this.arrays);
    else {
      layersPromise ??= loadTextureLayers(this.scene, LAYERS.map((l) => `terrain/${l.name}`));
      layersPromise.then(
        (l) => {
          this.arrays = l;
          this.plugin?.setLayers(l);
        },
        (e) => console.warn("ground textures unavailable", e),
      );
    }
  }

  disable() {
    if (!this.material || !this.classic) return;
    const mesh = this.terrain.mesh;
    mesh.material = this.classic.material;
    mesh.setVerticesData(VertexBuffer.NormalKind, this.classic.normals);
    mesh.setVerticesData(VertexBuffer.ColorKind, this.classic.colors);
    // the material goes (the atmosphere is rebuilt with the next switch); the textures stay cached
    this.material.dispose(false, false);
    this.material = null;
    this.plugin = null;
  }
}
