import { Color3, Constants, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, type Scene } from "@babylonjs/core";
import type { Terrain } from "../world/terrain";
import type { WeaponKind } from "./game";

/** Seconds a flash lasts. */
const LIFE = 0.11;
const SLOTS = 10;
/** Grid cells per side of the ground patch. */
const GRID = 14;

/** Peak size (metres) of the muzzle glow and radius of the lit ground patch, by weapon. */
const SIZE: Record<WeaponKind, { glow: number; ground: number; alpha: number }> = {
  rifle: { glow: 1.5, ground: 5, alpha: 0.5 },
  mg: { glow: 2.1, ground: 7, alpha: 0.6 },
  sniper: { glow: 2.6, ground: 10, alpha: 0.7 },
};

interface Slot { glow: Mesh; ground: Mesh; glowMat: StandardMaterial; groundMat: StandardMaterial; t: number; peak: { glow: number; ground: number; alpha: number } }

function glowTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const t = new DynamicTexture("muzzleGlow", { width: size, height: size }, scene, true, Texture.BILINEAR_SAMPLINGMODE);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  t.update();
  t.hasAlpha = true;
  return t;
}

/**
 * Muzzle flashes that light up their surroundings (commandos mode, by night): a glowing flare at
 * the muzzle and a warm, soft patch of light on the ground around it. Both are additive and unlit,
 * so they cost no scene lights and work in the classic and the realistic graphics mode.
 */
export class MuzzleFlashes {
  /** Only the night mission uses them. */
  enabled = false;
  private readonly slots: Slot[] = [];
  private next = 0;
  private base: Float32Array | null = null;

  constructor(private readonly scene: Scene, private readonly terrain: Terrain) {}

  private build(): void {
    const tex = glowTexture(this.scene);
    const mat = (name: string, color: Color3) => {
      const m = new StandardMaterial(name, this.scene);
      m.disableLighting = true;
      m.diffuseColor = Color3.Black();
      m.specularColor = Color3.Black();
      m.emissiveColor = color;
      m.opacityTexture = tex;
      m.alphaMode = Constants.ALPHA_ADD;
      m.disableDepthWrite = true;
      m.backFaceCulling = false;
      m.fogEnabled = false;
      m.alpha = 0;
      return m;
    };
    for (let i = 0; i < SLOTS; i++) {
      const glowMat = mat(`muzzleGlowMat${i}`, new Color3(1, 0.85, 0.55));
      const glow = MeshBuilder.CreatePlane(`muzzleGlow${i}`, { size: 1 }, this.scene);
      glow.billboardMode = Mesh.BILLBOARDMODE_ALL;
      glow.material = glowMat;
      const groundMat = mat(`muzzleGroundMat${i}`, new Color3(1, 0.68, 0.32));
      // a grid draped over the terrain at every flash (a flat disc would be cut off by slopes)
      const ground = MeshBuilder.CreateGround(`muzzleGround${i}`, { width: 2, height: 2, subdivisions: GRID, updatable: true }, this.scene);
      ground.material = groundMat;
      ground.alphaIndex = 12; // over the see-through tracks and light spots
      for (const m of [glow, ground]) {
        m.isPickable = false;
        m.setEnabled(false);
      }
      this.slots.push({ glow, ground, glowMat, groundMat, t: LIFE, peak: SIZE.rifle });
    }
  }

  flash(x: number, y: number, z: number, kind: WeaponKind) {
    if (!this.enabled) return;
    if (!this.slots.length) this.build();
    const s = this.slots[this.next];
    this.next = (this.next + 1) % SLOTS;
    s.t = 0;
    s.peak = SIZE[kind];
    s.glow.position.set(x, y, z);
    this.drape(s.ground, x, z, s.peak.ground);
    s.glow.setEnabled(true);
    s.ground.setEnabled(true);
  }

  /** Lays the unit grid of `ground` (scaled to `r`) over the terrain around (x, z). */
  private drape(ground: Mesh, x: number, z: number, r: number) {
    const base = (this.base ??= Float32Array.from(ground.getVerticesData("position")!));
    const pos = Float32Array.from(base);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = x + pos[i] * r;
      pos[i + 2] = z + pos[i + 2] * r;
      pos[i + 1] = this.terrain.heightAt(pos[i], pos[i + 2]) + 0.2;
    }
    ground.updateVerticesData("position", pos);
    ground.refreshBoundingInfo(); // otherwise it is culled at its old place
  }

  update(dt: number) {
    for (const s of this.slots) {
      if (s.t >= LIFE) continue;
      s.t += dt;
      const k = Math.min(1, s.t / LIFE);
      if (k >= 1) {
        s.glow.setEnabled(false);
        s.ground.setEnabled(false);
        continue;
      }
      const fade = (1 - k) * (0.8 + Math.random() * 0.4);
      const grow = 0.6 + 0.4 * k;
      s.glowMat.alpha = Math.min(1, fade * 1.2);
      s.glow.scaling.setAll(s.peak.glow * grow);
      s.groundMat.alpha = s.peak.alpha * fade;
    }
  }

  /** Switches everything off at once (new game, other mode). */
  clear() {
    for (const s of this.slots) {
      s.t = LIFE;
      s.glow.setEnabled(false);
      s.ground.setEnabled(false);
    }
  }
}
