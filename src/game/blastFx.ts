import {
  Color3, Color4, DynamicTexture, Light, Material, Mesh, MeshBuilder, ParticleSystem, PointLight, StandardMaterial, Texture, Vector3,
  type Observer, type Scene,
} from "@babylonjs/core";
import { rng } from "../util/noise";

/**
 * Explosions of the realistic graphics mode, built from soft particles instead of low-poly shapes:
 * a blinding flash that lights up the surroundings, a fireball of rolling flame that burns out into
 * soot, a fountain of earth thrown up and raining back down, glowing fragments streaking away, a
 * ring of dust rushing out along the ground and a column of dark smoke that rises, spreads and
 * drifts off with the wind. All textures are drawn at start-up; the particles run on the game's
 * clock (they freeze while the game is paused).
 */

// ------------------------------------------------------------------ textures

/** Smooth hash-free value noise on a small periodic lattice (for the puff shapes). */
function noise2(seed: number) {
  const r = rng(seed);
  const N = 32;
  const lat = Float32Array.from({ length: N * N }, () => r());
  const at = (i: number, j: number) => lat[(((i % N) + N) % N) + (((j % N) + N) % N) * N];
  return (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y);
    let fx = x - i, fy = y - j;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
}

/**
 * 2 x 2 sheet of billowing puffs (128 px cells): a few overlapping round lumps with a ragged,
 * noisy rim. `shaded` lights them from above (smoke, dust); otherwise the brightness follows the
 * density (flame: hot inside, cooler at the rim).
 */
function puffSheet(scene: Scene, name: string, shaded: boolean, seed: number): Texture {
  const cell = 128, size = cell * 2;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const n = noise2(seed);
  const r = rng(seed + 1);
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * cell, oy = Math.floor(c / 2) * cell;
    // lumps of the puff (centre, radius) in cell units
    const lumps = Array.from({ length: 5 }, (_, k) => {
      const a = r() * Math.PI * 2, d = k === 0 ? 0 : 0.12 + r() * 0.1;
      return { x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d, rad: k === 0 ? 0.3 : 0.16 + r() * 0.08 };
    });
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = x / cell, v = y / cell;
        let dens = 0;
        for (const l of lumps) {
          const d = Math.hypot(u - l.x, v - l.y) / l.rad;
          dens = Math.max(dens, 1 - d * d);
        }
        // ragged rim and inner structure from two octaves of noise
        const nz = n(u * 9 + c * 7, v * 9) * 0.65 + n(u * 21 + 3, v * 21 + c * 5) * 0.35;
        dens = Math.max(0, dens * 1.25 - (1 - nz) * 0.55);
        // keep the cell edges empty
        const edge = Math.min(u, v, 1 - u, 1 - v) * 8;
        const a = Math.min(1, dens * 1.6) * Math.min(1, edge);
        let lum: number;
        if (shaded) {
          // light from above: the upper side of every lump brighter, the lower one in shadow
          let lit = 0;
          for (const l of lumps) lit = Math.max(lit, 1 - Math.hypot(u - l.x, v - (l.y - l.rad * 0.35)) / l.rad);
          lum = 0.45 + Math.max(0, lit) * 0.45 + (nz - 0.5) * 0.25;
        } else {
          lum = 0.55 + dens * 0.45 + (nz - 0.5) * 0.3;
        }
        const i = ((oy + y) * size + ox + x) * 4;
        const L = Math.round(Math.min(1, Math.max(0, lum)) * 255);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = L;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

/** Soft round glow (flash, glowing fragments). */
function glowTexture(scene: Scene, name: string): Texture {
  const size = 64;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.85)");
  g.addColorStop(0.6, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

/**
 * Crater left by a blast (512 px colour with alpha, plus a normal map): a blackened bowl, a rim of
 * fresh earth thrown up around it, clods, and soot and spattered soil streaking outwards in rays
 * that fray into the ground.
 */
function craterTextures(scene: Scene): { color: DynamicTexture; normal: DynamicTexture } {
  const size = 512;
  const n = noise2(91);
  const r = rng(92);
  const height = new Float32Array(size * size);
  const color = new DynamicTexture("craterColor", { width: size, height: size }, scene, true);
  const ctx = color.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 2 - 1, v = (y / size) * 2 - 1;
      const rad = Math.hypot(u, v), ang = Math.atan2(v, u);
      // ragged outline and a few longer streaks
      const edge = 1 + (n(Math.cos(ang) * 3 + 5, Math.sin(ang) * 3 + 5) - 0.5) * 0.3;
      const rr = rad / edge;
      const fine = n(u * 24 + 3, v * 24 + 7);
      const ray = n(Math.cos(ang) * 6 + 11, Math.sin(ang) * 6 + 2) * 0.6 + n(ang * 3.5 + 20, rr * 2) * 0.4;
      let c: number[], a: number, h: number;
      if (rr < 0.4) {
        // blackened bowl, darkest in the middle
        c = mix([0.05, 0.04, 0.035], [0.2, 0.15, 0.11], smooth(0, 0.4, rr) * 0.8 + fine * 0.3);
        a = 1;
        h = -(1 - (rr / 0.4) ** 2) * 0.7;
      } else {
        // rim of fresh earth thrown up, merging into the ejecta: soot and soil in rays that fray
        // into the grass
        const rim = [0.36, 0.28, 0.19].map((v, k) => v - fine * [0.1, 0.08, 0.06][k]);
        const ejecta = mix([0.26, 0.2, 0.14], [0.13, 0.1, 0.08], ray);
        const out = smooth(0.52, 0.68, rr);
        c = mix(rim, ejecta, out);
        a = (1 - smooth(0.6, 1.0, rr - (ray - 0.5) * 0.3)) * (1 - out * (0.45 - ray * 0.45)) * (1 - out * 0.25 * (1 - fine));
        const k = (rr - 0.48) / 0.09;
        h = Math.exp(-k * k) * 0.45 + (fine - 0.5) * 0.12 * out * a;
      }
      const i = (y * size + x) * 4;
      img.data[i] = Math.round(Math.min(1, c[0]) * 255);
      img.data[i + 1] = Math.round(Math.min(1, c[1]) * 255);
      img.data[i + 2] = Math.round(Math.min(1, c[2]) * 255);
      img.data[i + 3] = Math.round(Math.max(0, Math.min(1, rad > 0.98 ? 0 : a)) * 255);
      height[y * size + x] = h;
    }
  }
  ctx.putImageData(img, 0, 0);
  // clods scattered over the rim and beyond, each a little lump in the height map too
  for (let k = 0; k < 140; k++) {
    const ang = r() * Math.PI * 2, rad = 0.38 + r() * 0.45, rs = 1.5 + r() * 4;
    const cx = (Math.cos(ang) * rad * 0.5 + 0.5) * size, cy = (Math.sin(ang) * rad * 0.5 + 0.5) * size;
    const l = r() < 0.5 ? 0.12 + r() * 0.08 : 0.32 + r() * 0.1;
    ctx.fillStyle = `rgb(${Math.round(l * 255)}, ${Math.round(l * 0.8 * 255)}, ${Math.round(l * 0.58 * 255)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rs, rs * (0.6 + r() * 0.4), r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    for (let yy = Math.floor(cy - rs); yy <= cy + rs; yy++) {
      for (let xx = Math.floor(cx - rs); xx <= cx + rs; xx++) {
        const d = Math.hypot(xx - cx, yy - cy) / rs;
        if (d < 1 && xx >= 0 && yy >= 0 && xx < size && yy < size) height[yy * size + xx] += (1 - d * d) * 0.25;
      }
    }
  }
  color.update(false);
  color.hasAlpha = true;

  const normal = new DynamicTexture("craterNormal", { width: size, height: size }, scene, true);
  const nctx = normal.getContext() as CanvasRenderingContext2D;
  const nimg = nctx.createImageData(size, size);
  const H = (x: number, y: number) => height[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  const strength = 40;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength / size * 8, dy = (H(x, y + 1) - H(x, y - 1)) * strength / size * 8;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      nimg.data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      nimg.data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);
  normal.update(false);
  return { color, normal };
}

// ------------------------------------------------------------------ the blast

interface Textures { smoke: Texture; fire: Texture; glow: Texture }

/** A flash light: a few point lights are kept (dark) so the shaders never need recompiling. */
interface Flash { light: PointLight; t: number; life: number; power: number }

const LIGHTS = 2;

export class RealisticBlasts {
  private tex: Textures | null = null;
  /** Running particle systems and the game time they have left (their textures are shared). */
  private readonly systems = new Map<ParticleSystem, number>();
  private flashes: Flash[] = [];
  private afterRender: Observer<Scene> | null = null;
  private enabled = false;
  /** Darker smoke and a more striking flash by night. */
  night = false;
  private crater: Mesh | null = null;

  constructor(private readonly scene: Scene) {}

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.tex ??= {
      smoke: puffSheet(this.scene, "blastSmoke", true, 11),
      fire: puffSheet(this.scene, "blastFire", false, 23),
      glow: glowTexture(this.scene, "blastGlow"),
    };
    for (let i = 0; i < LIGHTS; i++) {
      const light = new PointLight(`blastLight${i}`, new Vector3(0, -100, 0), this.scene);
      light.intensity = 0;
      light.diffuse = new Color3(1, 0.62, 0.3);
      light.specular = new Color3(0.4, 0.25, 0.1);
      light.falloffType = Light.FALLOFF_STANDARD;
      this.flashes.push({ light, t: 1, life: 1, power: 0 });
    }
    // the particles only move while the game runs: their clock is stopped after every frame and
    // restarted by update()
    this.afterRender = this.scene.onAfterRenderObservable.add(() => {
      for (const ps of this.systems.keys()) ps.updateSpeed = 0;
    });
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    for (const ps of this.systems.keys()) ps.dispose(false);
    this.systems.clear();
    for (const f of this.flashes) f.light.dispose();
    this.flashes = [];
    this.afterRender?.remove();
    this.afterRender = null;
  }

  get active() {
    return this.enabled;
  }

  /** Template of the crater decal (its material; each crater is draped over the ground on its own). */
  craterTemplate(): Mesh {
    if (this.crater) return this.crater;
    const tex = craterTextures(this.scene);
    const m = MeshBuilder.CreateDisc("crater", { radius: 1, tessellation: 28 }, this.scene);
    m.rotation.x = Math.PI / 2;
    m.bakeCurrentTransformIntoVertices();
    const mt = new StandardMaterial("craterMat", this.scene);
    mt.diffuseTexture = tex.color;
    mt.useAlphaFromDiffuseTexture = true;
    mt.bumpTexture = tex.normal;
    mt.specularColor = Color3.Black();
    mt.transparencyMode = Material.MATERIAL_ALPHABLEND;
    mt.disableDepthWrite = true;
    mt.zOffset = -6;
    m.material = mt;
    m.isPickable = false;
    m.isVisible = false;
    m.receiveShadows = true;
    this.crater = m;
    return m;
  }

  /** Removes everything still burning (new game). */
  clear() {
    for (const ps of this.systems.keys()) ps.dispose(false);
    this.systems.clear();
    for (const f of this.flashes) {
      f.t = f.life;
      f.light.intensity = 0;
    }
  }

  update(dt: number) {
    for (const [ps, left] of this.systems) {
      ps.updateSpeed = 1 / 60;
      // done: dispose, but keep the shared texture
      if (left - dt <= 0) {
        ps.dispose(false);
        this.systems.delete(ps);
      } else this.systems.set(ps, left - dt);
    }
    for (const f of this.flashes) {
      if (f.t >= f.life) continue;
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      // a sharp peak, then a flickering glow that dies down
      f.light.intensity = f.power * (k < 0.08 ? k / 0.08 : (1 - k) ** 2 * (0.85 + Math.random() * 0.3));
      if (k >= 1) f.light.intensity = 0;
    }
  }

  private system(name: string, capacity: number, tex: Texture, x: number, y: number, z: number): ParticleSystem {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = tex;
    // normal coverage unless a system asks for glowing (added) light
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitter = new Vector3(x, y, z);
    ps.updateSpeed = 0;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    this.systems.set(ps, Infinity);
    return ps;
  }

  /** Bursts `count` particles at once (and nothing after). */
  private burst(ps: ParticleSystem, count: number, maxLife: number, delayMs = 0) {
    ps.manualEmitCount = count;
    ps.start(delayMs);
    this.systems.set(ps, delayMs / 1000 + maxLife + 0.3);
  }

  private useSheet(ps: ParticleSystem) {
    ps.isAnimationSheetEnabled = true;
    ps.spriteCellWidth = ps.spriteCellHeight = 128;
    ps.startSpriteCellID = 0;
    ps.endSpriteCellID = 3;
    ps.spriteRandomStartCell = true;
    ps.spriteCellChangeSpeed = 0;
  }

  /** Blast at ground height `y`; `size`: grenade 1, shell 1.5, demolition charge 2.4. */
  spawn(x: number, y: number, z: number, size: number) {
    const T = this.tex;
    if (!T) return;
    const s = size, rs = Math.sqrt(size);
    const night = this.night;

    // flash: lights up soldiers, walls and the ground around it for a moment
    const f = this.flashes.reduce((a, b) => (b.t / b.life > a.t / a.life ? b : a));
    f.light.position.set(x, y + 1.6 * s, z);
    f.light.range = 16 * s;
    f.t = 0;
    f.life = 0.35 + 0.12 * s;
    f.power = (night ? 26 : 14) * s;

    // white-hot flash core
    const flash = this.system("blastFlash", 2, T.glow, x, y + 0.8 * s, z);
    flash.blendMode = ParticleSystem.BLENDMODE_ADD;
    flash.createPointEmitter(Vector3.Zero(), Vector3.Zero());
    flash.minLifeTime = 0.1;
    flash.maxLifeTime = 0.16;
    flash.addSizeGradient(0, 2.5 * s);
    flash.addSizeGradient(1, 6 * s);
    flash.addColorGradient(0, new Color4(1, 0.85, 0.6, 0.9));
    flash.addColorGradient(1, new Color4(1, 0.5, 0.15, 0));
    this.burst(flash, 2, 0.16);

    // fireball: rolling flame that expands fast, slows down and burns out into soot. Drawn opaque
    // (not added up), so the flames keep their orange and yellow instead of washing out to white;
    // only the core above glows
    const fire = this.system("blastFire", Math.round(20 * s), T.fire, x, y + 0.5 * s, z);
    this.useSheet(fire);
    fire.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    fire.createSphereEmitter(0.5 * s, 1);
    fire.minEmitPower = 3 * rs;
    fire.maxEmitPower = 6.5 * rs;
    fire.minLifeTime = 0.4;
    fire.maxLifeTime = 0.8;
    fire.addSizeGradient(0, 0.9 * s, 1.3 * s);
    fire.addSizeGradient(0.4, 1.8 * s, 2.4 * s);
    fire.addSizeGradient(1, 2.3 * s, 2.9 * s);
    fire.addColorGradient(0, new Color4(1, 0.9, 0.55, 1));
    fire.addColorGradient(0.18, new Color4(1, 0.58, 0.16, 1));
    fire.addColorGradient(0.45, new Color4(0.82, 0.28, 0.06, 0.95));
    fire.addColorGradient(0.75, new Color4(0.22, 0.1, 0.05, 0.8));
    fire.addColorGradient(1, new Color4(0.12, 0.08, 0.06, 0));
    fire.addDragGradient(0, 0.2);
    fire.addDragGradient(1, 0.95);
    fire.gravity = new Vector3(0, 3, 0);
    fire.minAngularSpeed = -1.5;
    fire.maxAngularSpeed = 1.5;
    this.burst(fire, Math.round(20 * s), 0.8);

    // earth fountain: thrown up steeply in a cone, raining back down
    const dirt = this.system("blastDirt", Math.round(30 * s), T.smoke, x, y + 0.2, z);
    this.useSheet(dirt);
    dirt.createConeEmitter(0.6 * s, 0.45);
    dirt.minEmitPower = 7 * rs;
    dirt.maxEmitPower = 14 * rs;
    dirt.minLifeTime = 0.8;
    dirt.maxLifeTime = 1.6;
    dirt.gravity = new Vector3(0, -14, 0);
    dirt.addSizeGradient(0, 0.5 * s, 0.9 * s);
    dirt.addSizeGradient(1, 1.4 * s, 2.0 * s);
    const earth = night ? new Color4(0.1, 0.08, 0.06, 1) : new Color4(0.42, 0.33, 0.23, 1);
    dirt.addColorGradient(0, new Color4(earth.r, earth.g, earth.b, 0.95));
    dirt.addColorGradient(0.7, new Color4(earth.r * 1.1, earth.g * 1.1, earth.b * 1.1, 0.6));
    dirt.addColorGradient(1, new Color4(earth.r * 1.2, earth.g * 1.2, earth.b * 1.2, 0));
    dirt.addDragGradient(0, 0.05);
    dirt.addDragGradient(1, 0.3);
    dirt.minAngularSpeed = -2;
    dirt.maxAngularSpeed = 2;
    this.burst(dirt, Math.round(30 * s), 1.6);

    // glowing fragments streaking away and falling
    const sparks = this.system("blastSparks", Math.round(28 * s), T.glow, x, y + 0.6 * s, z);
    sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
    sparks.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    sparks.createHemisphericEmitter(0.4 * s, 1);
    sparks.minEmitPower = 10 * rs;
    sparks.maxEmitPower = 22 * rs;
    sparks.minLifeTime = 0.3;
    sparks.maxLifeTime = 0.9;
    sparks.minSize = 0.12;
    sparks.maxSize = 0.24;
    sparks.minScaleY = 2.5;
    sparks.maxScaleY = 4;
    sparks.gravity = new Vector3(0, -18, 0);
    sparks.addColorGradient(0, new Color4(1, 0.95, 0.75, 1));
    sparks.addColorGradient(0.5, new Color4(1, 0.6, 0.2, 1));
    sparks.addColorGradient(1, new Color4(0.8, 0.2, 0.05, 0));
    this.burst(sparks, Math.round(28 * s), 0.9);

    // dust ring rushing out along the ground and settling
    const dust = this.system("blastDust", Math.round(26 * s), T.smoke, x, y + 0.35, z);
    this.useSheet(dust);
    dust.startPositionFunction = (_m, pos) => {
      const a = Math.random() * Math.PI * 2, d = 0.5 + Math.random() * 0.6 * s;
      pos.set(x + Math.cos(a) * d, y + 0.3 + Math.random() * 0.3, z + Math.sin(a) * d);
    };
    dust.startDirectionFunction = (_m, dir, p) => {
      const dx = p.position.x - x, dz = p.position.z - z, l = Math.hypot(dx, dz) || 1;
      dir.set(dx / l, 0.08 + Math.random() * 0.12, dz / l);
    };
    dust.minEmitPower = 7 * rs;
    dust.maxEmitPower = 12 * rs;
    dust.minLifeTime = 1.3;
    dust.maxLifeTime = 2.4;
    dust.addSizeGradient(0, 0.8 * s, 1.2 * s);
    dust.addSizeGradient(1, 2.6 * s, 3.4 * s);
    const dc = night ? new Color4(0.09, 0.085, 0.08, 1) : new Color4(0.6, 0.53, 0.42, 1);
    dust.addColorGradient(0, new Color4(dc.r, dc.g, dc.b, 0.7));
    dust.addColorGradient(0.5, new Color4(dc.r, dc.g, dc.b, 0.45));
    dust.addColorGradient(1, new Color4(dc.r, dc.g, dc.b, 0));
    dust.addDragGradient(0, 0.3);
    dust.addDragGradient(1, 0.97);
    dust.minAngularSpeed = -0.6;
    dust.maxAngularSpeed = 0.6;
    this.burst(dust, Math.round(26 * s), 2.4, 30);

    // smoke column: soot rising from the fireball, spreading and drifting off with the wind
    const smoke = this.system("blastSmoke", Math.round(22 * s), T.smoke, x, y + 1.0 * s, z);
    this.useSheet(smoke);
    smoke.createSphereEmitter(0.8 * s, 1);
    smoke.minEmitPower = 0.6;
    smoke.maxEmitPower = 1.6;
    smoke.minLifeTime = 4;
    smoke.maxLifeTime = 7.5;
    smoke.gravity = new Vector3(0.45, 1.1, 0.25); // buoyancy plus a light breeze
    smoke.addSizeGradient(0, 1.2 * s, 1.8 * s);
    smoke.addSizeGradient(0.3, 2.6 * s, 3.4 * s);
    smoke.addSizeGradient(1, 5.4 * s, 6.8 * s);
    // dense at first, then it spreads and becomes ever more transparent while it drifts off
    const sc = night ? 0.09 : 0.24;
    smoke.addColorGradient(0, new Color4(sc * 0.6, sc * 0.55, sc * 0.5, 0));
    smoke.addColorGradient(0.06, new Color4(sc * 0.7, sc * 0.65, sc * 0.6, 0.85));
    smoke.addColorGradient(0.3, new Color4(sc * 1.1, sc * 1.05, sc * 1.0, 0.6));
    smoke.addColorGradient(0.6, new Color4(sc * 1.5, sc * 1.45, sc * 1.4, 0.3));
    smoke.addColorGradient(0.85, new Color4(sc * 1.8, sc * 1.75, sc * 1.7, 0.1));
    smoke.addColorGradient(1, new Color4(sc * 1.9, sc * 1.85, sc * 1.8, 0));
    smoke.addDragGradient(0, 0.4);
    smoke.addDragGradient(1, 0.6);
    smoke.minAngularSpeed = -0.25;
    smoke.maxAngularSpeed = 0.25;
    this.burst(smoke, Math.round(22 * s), 7.5, 120);
  }
}
