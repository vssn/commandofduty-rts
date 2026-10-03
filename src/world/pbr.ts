import {
  Color3, ColorCurves, ImageProcessingConfiguration, Mesh, MultiMaterial, PBRMaterial, StandardMaterial, VertexBuffer, ShadowGenerator, type DirectionalLight, type HemisphericLight, type Material,
  type Scene,
} from "@babylonjs/core";
import type { RGB } from "./layout";
import { camoTexture, type PbrLook, type SurfaceKind } from "./models";
import { attachSurfaceTexture } from "./surfacePbr";
import { attachRim } from "./rimPbr";

/** Colour grading of the realistic mode (ColorCurves scale: -100..100). */
const GRADE = { saturation: -10, highlights: 20, shadows: 12, tint: 18, exposure: 1.55 };

const toLinear = (v: number) => Math.pow(v, 2.2);

/** PBR copy -> the classic material it replaces. */
const classicOf = new WeakMap<Material, StandardMaterial>();
/**
 * The classic material behind `m` (itself if it is not a PBR copy). Game code that tints or fades
 * materials works on the classic ones; their alpha and glow are mirrored onto the PBR copies.
 */
export function classicMaterial(m: Material): Material {
  return classicOf.get(m) ?? m;
}

/** Saved settings of the classic look, restored when PBR is switched off again. */
interface Classic { sunIntensity: number; sunColor: Color3; hemiIntensity: number; exposure: number; contrast: number; darkness: number; quality: number }

/**
 * Optional physically based rendering ("Realistisch"): every lit material is replaced by an
 * equivalent PBR material (matte, non-metallic; colour and texture carried over), vertex and
 * instance colours are converted to linear space and the light levels are lifted to suit. There is
 * deliberately no physically based atmosphere (too costly on phones); the classic haze stays.
 * Switching is live and can be undone; materials created later are converted as they appear.
 *
 * Kept as they are: unlit / self-illuminated materials (lights, glows, markers) and the puddles'
 * fake sky reflection.
 */
export class PbrMode {
  active = false;
  private readonly swapped = new Map<StandardMaterial, PBRMaterial>();
  /** Gamma vertex / instance colours of converted meshes, to restore them. */
  private readonly colorBackup = new Map<Mesh, { vertex?: Float32Array; instance?: Float32Array }>();
  private dirty = false;
  private classic: Classic | null = null;
  /** The classic image processing (tone mapping, curves), restored with the classic look. */
  private classicGrade: { toneMapping: boolean; type: number; curves: boolean; colorCurves: ColorCurves | null } | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly sun: DirectionalLight,
    private readonly hemi: HemisphericLight,
    private readonly shadows: ShadowGenerator,
    /** Parts with their own realistic look (e.g. the textured ground), switched along. */
    private readonly extras: { enable(): void; disable(): void }[] = [],
  ) {
    // anything added later (a mission's props, new units' materials) is converted on the next frame
    scene.onNewMeshAddedObservable.add(() => (this.dirty = true));
    scene.onNewMaterialAddedObservable.add(() => (this.dirty = true));
  }

  setEnabled(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.capture();
      this.applyGrade();
      for (const e of this.extras) e.enable();
      this.convertAll();
      this.applyLighting();
    } else {
      for (const e of this.extras) e.disable();
      this.restoreAll();
      this.restoreGrade();
      this.restoreLighting();
    }
  }

  /**
   * Film look for the realistic mode: ACES tone mapping (soft highlights, rich shadows) and colour
   * curves - more saturation, brighter highlights with a warm tint, deeper shadows with a cool one.
   */
  private applyGrade() {
    const ip = this.scene.imageProcessingConfiguration;
    this.classicGrade = { toneMapping: ip.toneMappingEnabled, type: ip.toneMappingType, curves: ip.colorCurvesEnabled, colorCurves: ip.colorCurves };
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    const c = new ColorCurves();
    c.globalSaturation = GRADE.saturation;
    c.highlightsExposure = GRADE.highlights;
    c.highlightsHue = 42; // warm
    c.highlightsDensity = GRADE.tint;
    c.shadowsExposure = GRADE.shadows;
    c.shadowsHue = 215; // cool
    c.shadowsDensity = GRADE.tint;
    ip.colorCurves = c;
    ip.colorCurvesEnabled = true;
  }

  private restoreGrade() {
    const g = this.classicGrade;
    if (!g) return;
    const ip = this.scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = g.toneMapping;
    ip.toneMappingType = g.type;
    ip.colorCurves = g.colorCurves;
    ip.colorCurvesEnabled = g.curves;
    this.classicGrade = null;
  }

  /** Remembers the classic light levels (the environment has just set them). */
  private capture() {
    this.classic = {
      sunIntensity: this.sun.intensity, sunColor: this.sun.diffuse.clone(),
      hemiIntensity: this.hemi.intensity, exposure: this.scene.imageProcessingConfiguration.exposure,
      contrast: this.scene.imageProcessingConfiguration.contrast,
      darkness: this.shadows.getDarkness(), quality: this.shadows.filteringQuality,
    };
  }

  private restoreLighting() {
    if (!this.classic) return;
    this.sun.intensity = this.classic.sunIntensity;
    this.sun.diffuse = this.classic.sunColor.clone();
    this.hemi.intensity = this.classic.hemiIntensity;
    this.scene.imageProcessingConfiguration.exposure = this.classic.exposure;
    this.scene.imageProcessingConfiguration.contrast = this.classic.contrast;
    this.shadows.setDarkness(this.classic.darkness);
    this.shadows.filteringQuality = this.classic.quality;
  }

  /** Day / night (commandos) changed the classic light levels: take them over. Call after the environment switched. */
  setLighting() {
    if (!this.active) return;
    this.capture();
    this.applyLighting();
  }

  /** Converts materials that appeared since the last frame and mirrors fades / glows onto the copies. */
  update() {
    if (!this.active) return;
    if (this.dirty) {
      this.dirty = false;
      this.convertAll();
    }
    for (const [s, p] of this.swapped) {
      p.alpha = s.alpha;
      p.emissiveColor.copyFrom(s.emissiveColor);
      // materials that change their colour in the game (the agent in the thermal look)
      if ((s.metadata as { mirrorDiffuse?: boolean } | null)?.mirrorDiffuse) {
        const d = s.diffuseColor;
        p.albedoColor.set(toLinear(d.r), toLinear(d.g), toLinear(d.b));
      }
    }
  }

  /**
   * Light levels for PBR: PBR divides diffuse light by pi less forgivingly, so the sun is lifted. The
   * sky fill stays low and the contrast a little higher: shadows stay deep and forms read crisply.
   */
  private applyLighting() {
    if (!this.classic) return;
    this.restoreLighting();
    this.sun.intensity = this.classic.sunIntensity * 1.9;
    this.hemi.intensity = this.classic.hemiIntensity * 0.7;
    // crisp, deep shadows like on a sunny day: less sky fill, darker shadow, a tighter filter
    this.shadows.setDarkness(this.classic.darkness * 0.5);
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_LOW;
    // ACES takes some brightness: make up for it
    this.scene.imageProcessingConfiguration.exposure = this.classic.exposure * GRADE.exposure;
    this.scene.imageProcessingConfiguration.contrast = this.classic.contrast * 1.15;
  }

  // ---------------------------------------------------------------- materials

  private keepsClassic(m: StandardMaterial): boolean {
    return m.disableLighting || !!m.reflectionTexture;
  }

  private pbrFor(m: StandardMaterial): PBRMaterial {
    let p = this.swapped.get(m);
    if (p) return p;
    p = new PBRMaterial(`${m.name}-pbr`, this.scene);
    const d = m.diffuseColor;
    p.albedoColor = new Color3(toLinear(d.r), toLinear(d.g), toLinear(d.b));
    p.albedoTexture = m.diffuseTexture;
    p.bumpTexture = m.bumpTexture;
    p.metallic = (m.metadata as { metal?: number } | null)?.metal ?? 0;
    p.roughness = (m.metadata as { rough?: number } | null)?.rough ?? 0.85;
    p.emissiveColor = m.emissiveColor.clone();
    p.alpha = m.alpha;
    p.transparencyMode = m.transparencyMode;
    p.alphaCutOff = m.alphaCutOff;
    p.useAlphaFromAlbedoTexture = m.useAlphaFromDiffuseTexture;
    p.backFaceCulling = m.backFaceCulling;
    p.zOffset = m.zOffset;
    p.disableDepthWrite = m.disableDepthWrite;
    p.alphaMode = m.alphaMode;
    p.fogEnabled = m.fogEnabled;
    // parts made of wood, fabric, concrete, metal or earth get a matching photo texture
    // a different look in this mode (e.g. a helmet's camouflage cover)
    const look = (m.metadata as { pbr?: PbrLook } | null)?.pbr;
    if (look?.color) p.albedoColor = new Color3(toLinear(look.color[0]), toLinear(look.color[1]), toLinear(look.color[2]));
    if (look?.camo) p.albedoTexture = camoTexture(this.scene);
    // a rim light inside the surface (the soldiers' team colour)
    const rim = (m.metadata as { rim?: RGB } | null)?.rim;
    if (rim) attachRim(p, [toLinear(rim[0]), toLinear(rim[1]), toLinear(rim[2])]);
    const surface = (m.metadata as { surface?: SurfaceKind } | null)?.surface;
    if (surface) attachSurfaceTexture(p, surface);
    this.swapped.set(m, p);
    classicOf.set(p, m);
    return p;
  }

  /** Material to use in PBR mode for `m` (the same one if it stays classic). */
  private convert(m: Material | null): Material | null {
    if (!m) return m;
    if (m instanceof MultiMaterial) {
      // a merged mesh: convert its parts (and keep the multi-material)
      if (m.subMaterials.some((s) => s instanceof StandardMaterial && !this.keepsClassic(s))) {
        m.subMaterials = m.subMaterials.map((s) => (s instanceof StandardMaterial && !this.keepsClassic(s) ? this.pbrFor(s) : s));
      }
      return m;
    }
    if (m instanceof StandardMaterial && !this.keepsClassic(m)) return this.pbrFor(m);
    return m;
  }

  private convertAll() {
    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh)) continue; // instances follow their source mesh
      const mm = mesh;
      const before = mm.material;
      const after = this.convert(before);
      if (after !== before) mm.material = after;
      if (after !== before || before instanceof MultiMaterial) this.linearizeColors(mm);
    }
  }

  private restoreAll() {
    const back = new Map<PBRMaterial, StandardMaterial>();
    for (const [s, p] of this.swapped) back.set(p, s);
    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh)) continue;
      const mm = mesh;
      const m = mm.material;
      if (m instanceof MultiMaterial) m.subMaterials = m.subMaterials.map((s) => (s instanceof PBRMaterial && back.get(s)) || s);
      else if (m instanceof PBRMaterial && back.has(m)) mm.material = back.get(m)!;
    }
    for (const [mesh, b] of this.colorBackup) {
      if (b.vertex) mesh.setVerticesData(VertexBuffer.ColorKind, b.vertex);
      if (b.instance) mesh.thinInstanceSetBuffer("color", b.instance, 4, true);
    }
    this.colorBackup.clear();
    for (const p of this.swapped.values()) p.dispose();
    this.swapped.clear();
  }

  private instanceColors(mesh: Mesh): Float32Array | null {
    const storage = (mesh as unknown as { _userThinInstanceBuffersStorage?: { data: Record<string, Float32Array> } })._userThinInstanceBuffersStorage;
    // Babylon stores the user's "color" buffer under "instanceColor"
    return storage?.data?.instanceColor ?? storage?.data?.color ?? null;
  }

  /** PBR expects linear colours; ours are authored in gamma space. Converted once per mesh, restorable. */
  private linearizeColors(mesh: Mesh) {
    if (this.colorBackup.has(mesh)) return;
    const backup: { vertex?: Float32Array; instance?: Float32Array } = {};
    const lin = (src: Float32Array) => {
      const out = Float32Array.from(src);
      for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = toLinear(out[i + c]);
      return out;
    };
    // vertex and instance colours multiply: both are converted
    const inst = this.instanceColors(mesh);
    if (inst) {
      backup.instance = inst;
      // the buffers are static: replace rather than update
      mesh.thinInstanceSetBuffer("color", lin(inst), 4, true);
    }
    const v = mesh.getVerticesData(VertexBuffer.ColorKind);
    if (v) {
      backup.vertex = Float32Array.from(v);
      mesh.setVerticesData(VertexBuffer.ColorKind, lin(backup.vertex));
    }
    if (inst || v) this.colorBackup.set(mesh, backup);
  }

}
