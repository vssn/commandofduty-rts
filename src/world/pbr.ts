import {
  Color3, Mesh, MultiMaterial, PBRMaterial, StandardMaterial, VertexBuffer, type DirectionalLight, type HemisphericLight, type Material,
  type Scene,
} from "@babylonjs/core";
import { Atmosphere } from "@babylonjs/addons/atmosphere/index.js";
import type { SurfaceKind } from "./models";
import { attachSurfaceTexture } from "./surfacePbr";

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
interface Classic { sunIntensity: number; sunColor: Color3; hemiIntensity: number; exposure: number }

/**
 * Optional physically based rendering ("Realistisch"): every lit material is replaced by an
 * equivalent PBR material (matte, non-metallic; colour and texture carried over), vertex and
 * instance colours are converted to linear space, and - in daylight - Babylon's physically based
 * atmosphere provides the sky, the sun's colour and aerial perspective. Switching is live and can
 * be undone; materials created later are converted as they appear.
 *
 * Kept as they are: unlit / self-illuminated materials (lights, glows, markers) and the puddles'
 * fake sky reflection.
 */
export class PbrMode {
  active = false;
  private readonly swapped = new Map<StandardMaterial, PBRMaterial>();
  /** Gamma vertex / instance colours of converted meshes, to restore them. */
  private readonly colorBackup = new Map<Mesh, { vertex?: Float32Array; instance?: Float32Array }>();
  private atmosphere: Atmosphere | null = null;
  private night = false;
  private dirty = false;
  private classic: Classic | null = null;
  private ambient = new Color3(0, 0, 0);

  constructor(
    private readonly scene: Scene,
    private readonly sun: DirectionalLight,
    private readonly hemi: HemisphericLight,
    /** Our own distance haze is switched off while the atmosphere draws aerial perspective. */
    private readonly setHaze: (on: boolean) => void,
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
      this.ambient = this.scene.ambientColor.clone();
      this.capture();
      // the atmosphere must exist before the PBR materials are made: it attaches to new ones
      this.updateAtmosphere();
      for (const e of this.extras) e.enable();
      this.convertAll();
      this.applyLighting();
    } else {
      for (const e of this.extras) e.disable();
      this.restoreAll();
      this.atmosphere?.dispose();
      this.atmosphere = null;
      // the atmosphere drives the scene's ambient colour; the classic look has none
      this.scene.ambientColor = this.ambient.clone();
      this.setHaze(true);
      this.restoreLighting();
    }
  }

  /** Remembers the classic light levels (the environment has just set them). */
  private capture() {
    this.classic = {
      sunIntensity: this.sun.intensity, sunColor: this.sun.diffuse.clone(),
      hemiIntensity: this.hemi.intensity, exposure: this.scene.imageProcessingConfiguration.exposure,
    };
  }

  private restoreLighting() {
    if (!this.classic) return;
    this.sun.intensity = this.classic.sunIntensity;
    this.sun.diffuse = this.classic.sunColor.clone();
    this.hemi.intensity = this.classic.hemiIntensity;
    this.scene.imageProcessingConfiguration.exposure = this.classic.exposure;
  }

  /** Night (commandos): no atmosphere - the moonlit lighting stays in charge. Call after the environment switched. */
  setNight(on: boolean) {
    this.night = on;
    if (!this.active) return;
    this.capture();
    this.atmosphere?.setEnabled(!on);
    this.setHaze(on || !this.atmosphere);
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
    }
  }

  private updateAtmosphere() {
    const engine = this.scene.getEngine();
    if (this.atmosphere || !Atmosphere.IsSupported(engine)) {
      this.setHaze(!this.atmosphere || this.night);
      return;
    }
    // the atmosphere drives the first light of the scene: make it the sun
    const lights = this.scene.lights;
    const i = lights.indexOf(this.sun);
    if (i > 0) {
      lights.splice(i, 1);
      lights.unshift(this.sun);
    }
    this.atmosphere = new Atmosphere("atmosphere", this.scene, [this.sun], {
      isLinearSpaceLight: true,
      // the battlefield is only a few hundred metres across: strengthen the haze a little so it shows
      aerialPerspectiveIntensity: 1.6,
      aerialPerspectiveSaturation: 0.9,
      diffuseSkyIrradianceIntensity: 1.2,
    });
    this.atmosphere.setEnabled(!this.night);
    this.setHaze(this.night);
  }

  /** Light levels for PBR: the atmosphere colours the sun by day; the hemispheric fill is only a soft extra. */
  private applyLighting() {
    if (!this.classic) return;
    const ip = this.scene.imageProcessingConfiguration;
    this.restoreLighting();
    if (this.night || !this.atmosphere) {
      // PBR divides diffuse light by pi less forgivingly: lift the classic levels a little
      this.sun.intensity = this.classic.sunIntensity * 1.6;
      this.hemi.intensity = this.classic.hemiIntensity * 1.4;
    } else {
      // white sunlight: the atmosphere tints it by the air it passes through
      this.sun.diffuse = new Color3(1, 1, 1);
      this.sun.intensity = 6;
      this.hemi.intensity = 0.25;
      ip.exposure = 1.1;
    }
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
    p.metallic = 0;
    p.roughness = 0.85;
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
    // the atmosphere is rebuilt on the next switch: its material plugin belongs to these materials
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
