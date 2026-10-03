import {
  Color3, MaterialPluginBase, PBRMaterial, RawTexture, Texture, VertexBuffer,
  type AbstractEngine, type Material, type MaterialDefines, type Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import { ROAD_RANGE, type Terrain } from "./terrain";
import { bakeOcclusion, bakePathMap, PATH_RANGE, type PathLine } from "./pathMap";
import type { MapLayout, V2 } from "./layout";
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
    private readonly paths: RawTexture,
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
    return l.albedo.isReady() && l.normal.isReady() && this.decal.isReady() && this.kind.isReady() && this.roads.isReady() && this.paths.isReady();
  }

  getSamplers(samplers: string[]) {
    samplers.push("tsAlbedo", "tsNormal", "tsDecal", "tsKind", "tsRoads", "tsPaths");
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
    ubo.setTexture("tsPaths", this.paths);
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
uniform sampler2D tsPaths;
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
// asphalt runs along its street: the baked street direction turns its texture
vec4 tsRdTex = texture(tsRoads, tsUv);
vec2 tsDir2 = tsRdTex.ba * 2.0 - 1.0;
float tsAng = 0.5 * atan(tsDir2.y, tsDir2.x);
// roads from the baked distances (metres to the edge, negative on the road): edges stay crisp
// and straight at any angle, anti-aliased over about one pixel
vec2 tsRd = (tsRdTex.rg * 2.0 - 1.0) * ${ROAD_RANGE.toFixed(1)};
tsRd = mix(vec2(${ROAD_RANGE.toFixed(1)}), tsRd, tsIn);
vec2 tsAa = fwidth(tsRd) * 0.75 + 0.015;
// footpaths: distance to the path's edge and how strongly the path shows
vec4 tsPth = texture(tsPaths, tsUv);
float tsPd = mix(${PATH_RANGE.toFixed(1)}, (tsPth.r * 2.0 - 1.0) * ${PATH_RANGE.toFixed(1)}, tsIn);
float tsPAa = fwidth(tsPd) * 0.75 + 0.015;
// The layers, each in its own scale and slightly turned so the repeats do not line up. Only the
// layers that show at this pixel are read (the rest has zero weight): the texture reads are the
// main cost of the ground. Explicit gradients keep the filtering right inside the branches.
vec2 tsDx = dFdx(tsP), tsDy = dFdy(tsP);
mat2 tsRot1 = mat2(0.96, 0.28, -0.28, 0.96);
mat2 tsRotAs = mat2(cos(tsAng), -sin(tsAng), sin(tsAng), cos(tsAng));
vec2 tsAsUv = tsRotAs * tsP * ${tiles[3]};
bool tsUse1 = tsDec.a * tsK.r > 0.003 || tsRd.y < 3.0 || tsRd.x < 2.7 || tsPd < 1.6;
bool tsUse2 = tsDec.a * tsK.g > 0.003;
bool tsUse3 = tsDec.a * tsK.b > 0.003 || tsRd.x < tsAa.x + 0.02;
bool tsUse4 = tsDec.a * tsK.a > 0.003 || tsRd.x < 0.62 + tsAa.x || tsRd.y < 1.0;
vec4 tsA0 = textureGrad(tsAlbedo, vec3(tsP * ${tiles[0]}, 0.0), tsDx * ${tiles[0]}, tsDy * ${tiles[0]});
vec3 tsN0 = textureGrad(tsNormal, vec3(tsP * ${tiles[0]}, 0.0), tsDx * ${tiles[0]}, tsDy * ${tiles[0]}).xyz;
vec4 tsA1 = vec4(0.5), tsA2 = vec4(0.5), tsA3 = vec4(0.5), tsA4 = vec4(0.5);
vec3 tsN1 = vec3(0.5, 0.5, 1.0), tsN2 = tsN1, tsN3 = tsN1, tsN4 = tsN1;
// mid-scale noise (a few metres) that makes the edges of the farm tracks irregular
vec4 tsWob = vec4(0.5);
if (tsRd.y < 3.0 || tsPd < 1.6) {
  mat2 tsRotW = mat2(0.8, -0.6, 0.6, 0.8);
  tsWob = textureGrad(tsAlbedo, vec3(tsRotW * tsP * 0.11, 0.0), tsRotW * tsDx * 0.11, tsRotW * tsDy * 0.11);
}
if (tsUse1) {
  vec2 tsU = tsRot1 * tsP * ${tiles[1]};
  vec2 tsGx = tsRot1 * tsDx * ${tiles[1]}, tsGy = tsRot1 * tsDy * ${tiles[1]};
  tsA1 = textureGrad(tsAlbedo, vec3(tsU, 1.0), tsGx, tsGy);
  tsN1 = textureGrad(tsNormal, vec3(tsU, 1.0), tsGx, tsGy).xyz;
}
if (tsUse2) {
  vec2 tsU = tsP * ${tiles[2]};
  tsA2 = textureGrad(tsAlbedo, vec3(tsU, 2.0), tsDx * ${tiles[2]}, tsDy * ${tiles[2]});
  tsN2 = textureGrad(tsNormal, vec3(tsU, 2.0), tsDx * ${tiles[2]}, tsDy * ${tiles[2]}).xyz;
}
if (tsUse3) {
  vec2 tsGx = tsRotAs * tsDx * ${tiles[3]}, tsGy = tsRotAs * tsDy * ${tiles[3]};
  tsA3 = textureGrad(tsAlbedo, vec3(tsAsUv, 3.0), tsGx, tsGy);
  tsN3 = textureGrad(tsNormal, vec3(tsAsUv, 3.0), tsGx, tsGy).xyz;
}
if (tsUse4) {
  vec2 tsU = tsP * ${tiles[4]};
  tsA4 = textureGrad(tsAlbedo, vec3(tsU, 4.0), tsDx * ${tiles[4]}, tsDy * ${tiles[4]});
  tsN4 = textureGrad(tsNormal, vec3(tsU, 4.0), tsDx * ${tiles[4]}, tsDy * ${tiles[4]}).xyz;
}
// rock: projected from above on gentle slopes, from the side on steep faces
vec3 tsGeo = normalize(vNormalW);
float tsSlope = 1.0 - clamp(tsGeo.y, 0.0, 1.0);
float tsRock = smoothstep(0.16, 0.42, tsSlope);
vec2 tsSide = mix(vPositionW.xy, vPositionW.zy, step(abs(tsGeo.z), abs(tsGeo.x)));
float tsSteep = smoothstep(0.35, 0.65, tsSlope);
vec2 tsRockUv = mix(tsP, tsSide, tsSteep) * ${tiles[5]};
vec2 tsRockDx = dFdx(tsRockUv), tsRockDy = dFdy(tsRockUv);
vec4 tsA5 = vec4(0.5);
vec3 tsN5 = vec3(0.5, 0.5, 1.0);
if (tsRock > 0.003) {
  tsA5 = textureGrad(tsAlbedo, vec3(tsRockUv, 5.0), tsRockDx, tsRockDy);
  tsN5 = textureGrad(tsNormal, vec3(tsRockUv, 5.0), tsRockDx, tsRockDy).xyz;
}
// the grass a second time, much larger and turned: patches of lusher and sparser growth that
// break up the repeats and still read from high above
mat2 tsRotM = mat2(0.6, 0.8, -0.8, 0.6);
vec4 tsA0m = textureGrad(tsAlbedo, vec3(tsRotM * tsP * 0.043, 0.0), tsRotM * tsDx * 0.043, tsRotM * tsDy * 0.043);
vec3 tsGrass = tsDetail(tsA0, tsMean0) * mix(vec3(1.0), tsDetail(tsA0m, tsMean0), 0.75);
// natural ground (grass or rock) under the painted surfaces
vec3 tsNat = mix(tsGrass, tsDetail(tsA5, tsMean5), tsRock);
vec3 tsPaint = tsK.r * tsDetail(tsA1, tsMean1) + tsK.g * tsDetail(tsA2, tsMean2) + tsK.b * tsDetail(tsA3, tsMean3) + tsK.a * tsDetail(tsA4, tsMean4);
vec3 tsCol = mix(surfaceAlbedo * tsNat, tsLin(tsDec.rgb) * tsPaint, tsDec.a);
float tsRough = mix(mix(tsA0.a, tsA5.a, tsRock), dot(tsK, vec4(tsA1.a, tsA2.a, tsA3.a, tsA4.a)), tsDec.a);
vec3 tsNm = mix(mix(tsN0, tsN5, tsRock), tsK.r * tsN1 + tsK.g * tsN2 + tsK.b * tsN3 + tsK.a * tsN4, tsDec.a);
float tsJag = (tsA0m.g - 0.5) * 0.5; // a little irregularity for the worn verges
// Footpaths (trampled earth), drawn here too: bare soil in the middle, worn grass at the irregular edges.
// Drawn first, so a farm track a path runs into covers its end.
float tsPE = tsPd + (tsWob.g - 0.5) * 0.7 + (tsA1.g - 0.5) * 0.3;
float tsPPatch = smoothstep(0.3, 0.7, tsWob.r * 0.6 + tsA1.r * 0.4);
float tsPWorn = smoothstep(1.1, 0.0, tsPE) * mix(0.2, 0.6, tsPPatch) * tsPth.g;
float tsPCover = smoothstep(tsPAa, -tsPAa, tsPE) * mix(0.6, 1.0, tsPPatch) * tsPth.g;
float tsPBare = smoothstep(0.0, 0.5, -tsPE);
vec3 tsPEarth = tsLin(vec3(0.5, 0.42, 0.29)) * mix(0.85, 1.15, tsWob.g) * tsDetail(tsA1, tsMean1);
vec3 tsPGrass = surfaceAlbedo * tsNat * 0.82;
tsCol = mix(tsCol, mix(tsPGrass, tsPEarth, 0.45), tsPWorn);
tsCol = mix(tsCol, mix(tsPGrass, tsPEarth, tsPBare), tsPCover);
tsRough = mix(tsRough, tsA1.a, max(tsPWorn * 0.6, tsPCover)); tsNm = mix(tsNm, tsN1, max(tsPWorn * 0.5, tsPCover));
// Farm tracks, drawn here (the band mesh of the classic look is hidden): irregular edges, patchy
// verges, two dark wet wheel ruts, a tufty grass strip in the middle and some gravel.
float tsDepth = -tsRd.y; // metres inside the track edge (ruts and strip sit at fixed offsets: puddles match them)
float tsE = tsRd.y + (tsWob.g - 0.5) * 1.0 + (tsA1.g - 0.5) * 0.35; // edge distance with wobble
float tsPatch = smoothstep(0.3, 0.7, tsWob.r * 0.65 + tsA1.r * 0.35);
vec3 tsGrassC = surfaceAlbedo * tsNat;
// worn verge: bare earth creeping into the grass, in patches
float tsW = smoothstep(1.7, 0.0, tsE) * mix(0.35, 0.95, tsPatch) * step(0.0, tsRd.y + 0.5);
tsCol = mix(tsCol, tsLin(${vec3(ROAD_COLORS.vergeDirt)}) * tsDetail(tsA1, tsMean1), tsW);
tsRough = mix(tsRough, tsA1.a, tsW); tsNm = mix(tsNm, tsN1, tsW);
// the track itself: soil with lighter and darker areas
tsW = smoothstep(tsAa.y, -tsAa.y, tsE);
vec3 tsDirtC = tsLin(${vec3(ROAD_COLORS.dirt)}) * mix(0.82, 1.18, tsWob.g) * tsDetail(tsA1, tsMean1);
// gravel and stones mixed into the soil, more on the shoulders than in the ruts
float tsStone = smoothstep(0.5, 0.75, tsA1.b * 0.5 + tsWob.b * 0.5) * 0.7;
tsDirtC = mix(tsDirtC, tsLin(${vec3(ROAD_COLORS.dirt)}) * 1.25 * tsDetail(tsA4, tsMean4), tsStone);
// wheel ruts: dark, damp and compacted
float tsRut = smoothstep(0.42, 0.08, abs(tsDepth - 1.02));
tsDirtC *= mix(1.0, 0.58, tsRut);
// grass strip between the ruts, tufty and broken up
float tsStrip = smoothstep(1.4, 1.75, tsDepth + (tsA1.g - 0.5) * 0.5) * smoothstep(0.3, 0.6, tsPatch + tsA0m.g * 0.3);
tsDirtC = mix(tsDirtC, tsGrassC * 0.9, tsStrip);
tsCol = mix(tsCol, tsDirtC, tsW);
float tsTrackRough = mix(mix(tsA1.a, tsA4.a, tsStone), 0.55, tsRut * 0.7);
tsRough = mix(tsRough, mix(tsTrackRough, tsA0.a, tsStrip), tsW);
vec3 tsTrackN = mix(tsN1, tsN4, tsStone);
tsNm = mix(tsNm, mix(tsTrackN, tsN0, tsStrip), tsW);
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
// static ambient occlusion: darker and cooler under foliage, darker and greyer between houses
vec2 tsAo = tsPth.ba * tsIn;
tsCol *= mix(vec3(1.0), vec3(0.45, 0.58, 0.42), tsAo.x);
tsCol *= mix(vec3(1.0), vec3(0.62, 0.58, 0.56), tsAo.y);
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
  private masks: { decal: RawTexture; kind: RawTexture; roads: RawTexture; paths: RawTexture; half: number } | null = null;
  private arrays: TextureLayers | null = null;

  constructor(private readonly scene: Scene, private readonly terrain: Terrain, private readonly footpaths: () => PathLine[],
    /** What shades the ground: for the baked ambient occlusion. */
    private readonly occluders: () => { trees: V2[]; layout: MapLayout },
  ) {}

  /** Footpaths (r, g) and the static ambient occlusion (b, a) in one map. */
  private bakePaths(res: number, half: number): Uint8Array {
    const data = bakePathMap(this.footpaths(), res, half);
    const o = this.occluders();
    bakeOcclusion(data, res, half, o.trees, o.layout);
    return data;
  }

  /** Switches the ground to its realistic material. */
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
      this.masks = { decal: tex(m.decal, "groundDecal"), kind: tex(m.kind, "groundKind"), roads: tex(m.roads, "groundRoads"), paths: tex(this.bakePaths(m.res, m.half), "groundPaths"), half: m.half };
    }
    mesh.setVerticesData(VertexBuffer.NormalKind, this.ground.normals);
    mesh.setVerticesData(VertexBuffer.ColorKind, this.ground.colors);

    const mat = new PBRMaterial("terrainPbr", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    this.plugin = new TerrainSplatPlugin(mat, this.masks.decal, this.masks.kind, this.masks.roads, this.masks.paths, this.masks.half);
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
    // the material goes; the textures stay cached
    this.material.dispose(false, false);
    this.material = null;
    this.plugin = null;
  }
}
