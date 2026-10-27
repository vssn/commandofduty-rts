import { Mesh, VertexData, type AbstractMesh, type InstancedMesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { GRENADE, TANK, UNITS } from "../config";
import { createExplosionTemplates, createGrenadeTemplate, createShellTemplate, type ExplosionTemplates } from "../world/models";
import { RealisticBlasts } from "./blastFx";
import type { Game } from "./game";
import type { Unit } from "./unit";

/** Delay between the start of the throw animation and the grenade leaving the hand. */
const RELEASE = 0.42;

interface Grenade {
  thrower: Unit;
  tx: number;
  tz: number;
  /** The level aimed at: on a walkway (power station) the grenade lands on it, unless it misses it. */
  level: 0 | 1;
  /** Counts down to release, then flight time. */
  delay: number;
  t: number;
  flight: number;
  sx: number; sy: number; sz: number; ty: number; apex: number;
  mesh: InstancedMesh | null;
}

/**
 * A tank shell or a rocket in flight: from the muzzle to its point of impact (the target, or beside it for a
 * miss), where it bursts. `vs`: damage factor against vehicles, structures and buildings; both pierce the
 * tank's armour.
 */
interface Projectile {
  kind: "shell" | "rocket";
  mesh: InstancedMesh;
  sx: number; sy: number; sz: number;
  tx: number; ty: number; tz: number;
  t: number;
  flight: number;
  damage: number;
  radius: number;
  vs: number;
  size: number;
  by: Unit | null;
  trailT: number;
}

/** How an explosion treats armour: `vs` multiplies the damage to vehicles, structures and buildings; `pierce` hits a tank in full. */
export interface BlastArmour { vs: number; pierce: boolean }

type PuffKind = "flash" | "smoke" | "debris" | "spark" | "ring" | "dust";

/** One animated piece of an explosion. `delay` staggers its start (hidden until then). */
interface Puff {
  kind: PuffKind;
  mesh: AbstractMesh;
  t: number;
  delay: number;
  life: number;
  vx: number; vy: number; vz: number;
  /** Spin (rad/s) for debris and sparks. */
  spin: number;
  size: number;
  grounded: boolean;
}

/** Gravity for flung debris and sparks (world units / s²). */
const GRAVITY = 24;
interface Scorch { mesh: Mesh; t: number }

/** Scorch marks / craters stay fully visible for a moment, then fade out over a minute. */
const SCORCH_HOLD = 5;
const SCORCH_FADE = 60;

/** Grenades in flight, explosions and their leftovers. */
export class Effects {
  private readonly grenadeTpl: Mesh;
  private readonly shellTpl: Mesh;
  private readonly tpl: ExplosionTemplates;
  private readonly grenades: Grenade[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly puffs: Puff[] = [];
  private readonly scorches: Scorch[] = [];
  /** Particle explosions of the realistic graphics mode (switched on by the PBR mode). */
  readonly real: RealisticBlasts;
  /** Called for every explosion (sound, screen feedback). */
  onExplosion: ((x: number, z: number, size: number) => void) | null = null;

  /** Removes every grenade, explosion piece and scorch mark (new game). */
  clear() {
    for (const gr of this.grenades) gr.mesh?.dispose();
    for (const p of this.projectiles) p.mesh.dispose();
    this.projectiles.length = 0;
    for (const p of this.puffs) p.mesh.dispose();
    for (const s of this.scorches) s.mesh.dispose();
    this.grenades.length = this.puffs.length = this.scorches.length = 0;
    this.real.clear();
  }

  constructor(private readonly scene: Scene, private readonly shadows: ShadowGenerator, private readonly game: Game) {
    this.grenadeTpl = createGrenadeTemplate(scene);
    this.shellTpl = createShellTemplate(scene);
    this.tpl = createExplosionTemplates(scene);
    this.real = new RealisticBlasts(scene);
    shadows.addShadowCaster(this.grenadeTpl);
    shadows.addShadowCaster(this.shellTpl);
    shadows.addShadowCaster(this.tpl.smoke);
    shadows.addShadowCaster(this.tpl.darkSmoke);
    shadows.addShadowCaster(this.tpl.debris);
  }

  throwGrenade(thrower: Unit, tx: number, tz: number, level: 0 | 1 = 0) {
    // (scattered off the walkway it falls to the ground)
    if (level === 1 && this.game.decks?.height(tx, tz) == null) level = 0;
    this.grenades.push({ thrower, tx, tz, level, delay: RELEASE, t: 0, flight: 0, sx: 0, sy: 0, sz: 0, ty: 0, apex: 0, mesh: null });
    this.game.onArm?.(thrower.x, thrower.z);
  }

  /**
   * Fires a tank shell or a rocket from `from` to `to` (speed in m/s); it bursts there (see explode). Shells fly
   * fast in a flat arc, rockets straight and slower, trailing smoke.
   */
  launch(kind: "shell" | "rocket", from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number },
    speed: number, damage: number, radius: number, by: Unit | null, vs: number, size: number) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const mesh = this.shellTpl.createInstance(kind);
    mesh.isPickable = false;
    if (kind === "shell") mesh.scaling.set(0.5, 0.5, 0.9);
    else mesh.scaling.set(0.42, 0.42, 1.7);
    mesh.position.set(from.x, from.y, from.z);
    this.projectiles.push({ kind, mesh, sx: from.x, sy: from.y, sz: from.z, tx: to.x, ty: to.y, tz: to.z, t: 0, flight: Math.max(0.05, dist / speed), damage, radius, vs, size, by, trailT: 0 });
  }

  /**
   * Blast at (x, z): damages every unit in range, friend or foe, plus buildings. `y`: its height where
   * that is not the ground (on a walkway); then only what is at that height is hit, the walkway's slab
   * shields those under it (and the other way round). `armour`: see BlastArmour (default: a plain blast,
   * which the tank's armour mostly stops).
   */
  explode(x: number, z: number, damage: number, radius: number, by: Unit | null, size = 1, y?: number, armour?: BlastArmour) {
    const g = this.game;
    const at = y ?? g.terrain.heightAt(x, z);
    for (const u of g.units) {
      if (!u.alive || u.vehicle) continue;
      if (g.decks && Math.abs(u.y - at) > 3) continue;
      const d = Math.hypot(u.x - x, u.z - z) - (u.isVehicle ? u.radius * 0.5 : 0);
      if (d > radius) continue;
      const falloff = 1 - 0.6 * Math.max(0, d) / radius;
      let dmg = damage * falloff;
      if (u.isVehicle) dmg *= armour?.vs ?? 1;
      if (u.type === "tank" && !armour?.pierce) dmg *= TANK.blast;
      g.damage(u, dmg, by);
    }
    for (const b of g.buildings) {
      if (b.alive && Math.hypot(b.x - x, b.z - z) - b.radius < radius) g.damage(b, damage * 0.7 * (armour?.vs ?? 1), by);
    }
    this.spawnBlast(x, z, size, at);
    this.onExplosion?.(x, z, size);
    if (size >= 1) g.ping(x, z, "explosion");
  }

  private add(kind: PuffKind, tpl: Mesh, x: number, y: number, z: number, o: Partial<Puff> & { life: number; size: number }) {
    // smoke and dust thin out through their own visibility, so they are copies (sharing geometry
    // and material) rather than instances, which all share their template's visibility
    const fades = kind === "smoke" || kind === "dust";
    const mesh: AbstractMesh = fades ? tpl.clone(kind) : tpl.createInstance(kind);
    if (fades) {
      mesh.isVisible = true;
      if (kind === "smoke") this.shadows.addShadowCaster(mesh);
    }
    mesh.isPickable = false;
    mesh.position.set(x, y, z);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    mesh.scaling.setAll(0.001);
    this.puffs.push({ kind, mesh, t: 0, delay: 0, vx: 0, vy: 0, vz: 0, spin: 0, grounded: false, ...o });
  }

  /**
   * Layered blast: a staggered fireball with a white-hot core, a ground shockwave, dirt and debris
   * flung out in arcs, glowing sparks, earth dust crawling along the ground and a column of smoke
   * that rises and lingers for several seconds. `size` scales everything (grenade 1, shell 1.5, charge 2.4).
   */
  private spawnBlast(x: number, z: number, size: number, y: number) {
    const T = this.tpl;
    const r = () => Math.random();

    if (this.real.active) {
      // realistic mode: fire, smoke, dust and sparks as particles; clods and the scorch mark stay
      this.real.spawn(x, y, z, size);
      const clods = Math.round(8 * size);
      for (let i = 0; i < clods; i++) {
        const a = r() * Math.PI * 2, s = (3 + r() * 6) * Math.sqrt(size);
        this.add("debris", T.debris, x, y + 0.4, z, {
          life: 2.4 + r() * 1.2, size: 0.45 + r() * 0.7,
          vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: (6 + r() * 8) * Math.sqrt(size), spin: 6 + r() * 10,
        });
      }
      this.scorch(x, y, z, size);
      return;
    }

    // fireball: several blooms, slightly offset and staggered, plus the bright core
    for (let i = 0; i < 3; i++) {
      const a = r() * Math.PI * 2, d = i ? 0.5 * size : 0;
      this.add("flash", T.flash, x + Math.cos(a) * d, y + (0.7 + i * 0.35) * size, z + Math.sin(a) * d, {
        life: 0.45 + i * 0.1, size: (2.1 - i * 0.4) * size, delay: i * 0.05, vy: 1.5 * size,
      });
    }
    this.add("flash", T.core, x, y + 0.6 * size, z, { life: 0.22, size: 1.1 * size });

    // shockwave running along the ground
    this.add("ring", T.ring, x, y + 0.25, z, { life: 0.4, size: 4.5 * size });

    // debris and clods flung out in arcs
    const debris = Math.round(14 * size);
    for (let i = 0; i < debris; i++) {
      const a = r() * Math.PI * 2, s = (3 + r() * 6) * Math.sqrt(size);
      this.add("debris", T.debris, x, y + 0.4, z, {
        life: 2.4 + r() * 1.2, size: 0.6 + r() * 0.9,
        vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: (6 + r() * 8) * Math.sqrt(size), spin: 6 + r() * 10,
      });
    }
    // sparks: fast, glowing, short-lived
    const sparks = Math.round(10 * size);
    for (let i = 0; i < sparks; i++) {
      const a = r() * Math.PI * 2, s = (7 + r() * 9) * Math.sqrt(size);
      this.add("spark", T.spark, x, y + 0.8, z, {
        life: 0.45 + r() * 0.45, size: 0.7 + r() * 0.6,
        vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: 4 + r() * 9, spin: 14,
      });
    }
    // earth dust spreading low along the ground
    const dust = Math.round(7 * size);
    for (let i = 0; i < dust; i++) {
      const a = (i / dust) * Math.PI * 2 + r() * 0.5, s = (2.2 + r() * 2) * size;
      this.add("dust", T.dust, x + Math.cos(a) * 0.5, y + 0.4, z + Math.sin(a) * 0.5, {
        life: 1.8 + r() * 1.2, size: (0.8 + r() * 0.5) * size, vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: 0.3 + r() * 0.5, delay: 0.05,
      });
    }
    // smoke column: dark at the core, lighter around it; rises, spreads and lingers
    const smoke = Math.round(9 * size);
    for (let i = 0; i < smoke; i++) {
      const a = r() * Math.PI * 2, d = r() * 0.8 * size, s = 0.4 + r() * 0.9;
      const dark = i % 3 !== 2;
      this.add("smoke", dark ? T.darkSmoke : T.smoke, x + Math.cos(a) * d, y + 0.6 + r() * size, z + Math.sin(a) * d, {
        life: 3.5 + r() * 3, size: (0.6 + r() * 0.55) * size, delay: 0.08 + r() * 0.35,
        vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: 1.6 + r() * 1.6,
      });
    }

    this.scorch(x, y, z, size);
  }

  private scorch(x: number, y: number, z: number, size: number) {
    // the realistic mode leaves a crater (blackened bowl, thrown-up rim), the classic one a dark spot
    const tpl = this.real.active ? this.real.craterTemplate() : this.tpl.scorch;
    const radius = (1.1 + Math.random() * 0.4) * size * (this.real.active ? 1.35 : 1);
    this.scorches.push({ mesh: this.drape(tpl, x, y, z, radius), t: 0 });
  }

  /**
   * A round mark of `radius` lying on the ground: a disc of rings whose points follow the terrain
   * (so it neither floats over hollows nor cuts into slopes), with the template's material.
   */
  private drape(tpl: Mesh, x: number, y: number, z: number, radius: number): Mesh {
    const terrain = this.game.terrain;
    // up on a walkway the mark lies flat on it
    const raised = y - terrain.heightAt(x, z) > 1;
    const floor = (px: number, pz: number) => (raised ? y : terrain.heightAt(px, pz));
    const rings = 7, seg = 28, turn = Math.random() * Math.PI * 2;
    const pos: number[] = [0, floor(x, z) - y + 0.08, 0];
    const uv: number[] = [0.5, 0.5];
    const idx: number[] = [];
    for (let k = 1; k <= rings; k++) {
      const f = k / rings, r = radius * f;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const px = Math.cos(a) * r, pz = Math.sin(a) * r;
        pos.push(px, floor(x + px, z + pz) - y + 0.08, pz);
        uv.push(0.5 + Math.cos(a + turn) * f * 0.5, 0.5 + Math.sin(a + turn) * f * 0.5);
      }
    }
    const at = (k: number, s: number) => (k === 0 ? 0 : 1 + (k - 1) * seg + (s % seg));
    // wound so the faces (and normals) look up
    for (let s = 0; s < seg; s++) idx.push(0, at(1, s), at(1, s + 1));
    for (let k = 1; k < rings; k++) {
      for (let s = 0; s < seg; s++) {
        idx.push(at(k, s), at(k + 1, s + 1), at(k, s + 1));
        idx.push(at(k, s), at(k + 1, s), at(k + 1, s + 1));
      }
    }
    const nor: number[] = [];
    VertexData.ComputeNormals(pos, idx, nor);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nor;
    vd.uvs = uv;
    const m = new Mesh("scorch", this.scene);
    vd.applyToMesh(m);
    m.material = tpl.material;
    m.position.set(x, y, z);
    m.isPickable = false;
    m.receiveShadows = true;
    m.scaling.set(0.01, 1, 0.01);
    return m;
  }

  update(dt: number) {
    const g = this.game;
    this.real.update(dt);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.flight);
      // a shell drops a little over its flight (a flat arc), a rocket flies straight
      const arc = p.kind === "shell" ? Math.sin(k * Math.PI) * Math.min(1.2, p.flight * 4) : 0;
      const x = p.sx + (p.tx - p.sx) * k, y = p.sy + (p.ty - p.sy) * k + arc, z = p.sz + (p.tz - p.sz) * k;
      p.mesh.position.set(x, y, z);
      p.mesh.rotation.y = Math.atan2(p.tx - p.sx, p.tz - p.sz);
      p.mesh.rotation.x = -Math.atan2(p.ty - p.sy, Math.hypot(p.tx - p.sx, p.tz - p.sz));
      if (p.kind === "rocket") {
        // the rocket's trail: small grey puffs left behind, drifting up and thinning out
        p.trailT -= dt;
        if (p.trailT <= 0) {
          p.trailT = 0.05;
          this.add("smoke", this.tpl.smoke, x, y, z, { life: 1.3 + Math.random() * 0.6, size: 0.35 + Math.random() * 0.2, vy: 0.5 });
        }
      }
      if (k >= 1) {
        p.mesh.dispose();
        this.projectiles.splice(i, 1);
        this.explode(p.tx, p.tz, p.damage, p.radius, p.by && p.by.alive ? p.by : null, p.size, p.ty, { vs: p.vs, pierce: true });
      }
    }
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const gr = this.grenades[i];
      if (gr.delay > 0) {
        gr.delay -= dt;
        const th = gr.thrower;
        if (!th.alive) { this.grenades.splice(i, 1); continue; } // thrower died mid-throw
        if (gr.delay > 0) continue;
        // release from the hand, arc height grows with the throw distance
        gr.sx = th.x + Math.sin(th.heading) * 0.4;
        gr.sz = th.z + Math.cos(th.heading) * 0.4;
        gr.sy = th.y + 2.4;
        gr.ty = g.surfaceY(gr.tx, gr.tz, gr.level) + 0.15;
        const dist = Math.hypot(gr.tx - gr.sx, gr.tz - gr.sz);
        gr.flight = 0.55 + dist * 0.045;
        gr.apex = 1.5 + dist * 0.22;
        gr.mesh = this.grenadeTpl.createInstance("grenade");
        g.onThrow?.(th.x, th.z);
      }
      gr.t += dt;
      const k = Math.min(1, gr.t / gr.flight);
      const m = gr.mesh!;
      m.position.set(
        gr.sx + (gr.tx - gr.sx) * k,
        gr.sy + (gr.ty - gr.sy) * k + 4 * gr.apex * k * (1 - k),
        gr.sz + (gr.tz - gr.sz) * k,
      );
      m.rotation.x += dt * 14;
      m.rotation.z += dt * 9;
      if (k >= 1) {
        m.dispose();
        this.grenades.splice(i, 1);
        this.explode(gr.tx, gr.tz, UNITS.grenadier.damage, GRENADE.radius, gr.thrower.alive ? gr.thrower : null, 1, gr.ty - 0.15);
      }
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.t += dt;
      if (p.t < p.delay) continue;
      const age = p.t - p.delay;
      const k = age / p.life;
      if (k >= 1) {
        p.mesh.dispose();
        this.puffs.splice(i, 1);
        continue;
      }
      const m = p.mesh;
      switch (p.kind) {
        case "flash": {
          // fast bloom, then collapse while drifting up
          m.position.y += p.vy * dt;
          m.scaling.setAll(p.size * (k < 0.22 ? k / 0.22 : 1 - ((k - 0.22) / 0.78) * 0.92));
          break;
        }
        case "ring": {
          const s = p.size * (0.15 + Math.sqrt(k) * 0.85);
          m.scaling.set(s, 1 - k * 0.8, s);
          break;
        }
        case "debris":
        case "spark": {
          if (!p.grounded) {
            p.vy -= GRAVITY * dt;
            m.position.x += p.vx * dt;
            m.position.y += p.vy * dt;
            m.position.z += p.vz * dt;
            m.rotation.x += p.spin * dt;
            m.rotation.z += p.spin * 0.7 * dt;
            const ground = this.game.terrain.heightAt(m.position.x, m.position.z) + 0.08;
            if (m.position.y <= ground) {
              m.position.y = ground;
              // clods bounce once, then lie; sparks die on impact
              if (p.kind === "spark") p.life = age + 0.05;
              else if (p.vy < -6) { p.vy *= -0.3; p.vx *= 0.4; p.vz *= 0.4; }
              else p.grounded = true;
            }
          }
          // shrink away at the end of their life
          const fade = p.kind === "spark" ? 1 - k : k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
          m.scaling.setAll(p.size * Math.min(1, age * 12) * fade);
          break;
        }
        case "dust": {
          m.position.x += p.vx * dt;
          m.position.y += p.vy * dt;
          m.position.z += p.vz * dt;
          p.vx *= 1 - dt * 2.2;
          p.vz *= 1 - dt * 2.2;
          // keeps spreading and settles flatter while it becomes transparent
          m.scaling.set(p.size * (0.5 + k * 1.5), p.size * 0.55 * (1 - k * 0.5), p.size * (0.5 + k * 1.5));
          m.visibility = 1 - k * k;
          break;
        }
        case "smoke": {
          // billows up, slows down, spreads and slowly thins out
          m.position.x += p.vx * dt;
          m.position.y += p.vy * dt;
          m.position.z += p.vz * dt;
          p.vx *= 1 - dt * 0.9;
          p.vz *= 1 - dt * 0.9;
          p.vy *= 1 - dt * 0.35;
          m.rotation.y += dt * 0.3;
          // keeps growing while it drifts off, and thins out until it is gone
          const grow = 0.3 + Math.sqrt(k) * 1.6;
          m.scaling.setAll(p.size * grow);
          m.visibility = k < 0.3 ? 1 : Math.pow(1 - (k - 0.3) / 0.7, 1.5);
          break;
        }
      }
    }

    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.t += dt;
      // full size throughout; it fades out slowly instead of shrinking
      const fade = s.t > SCORCH_HOLD ? 1 - (s.t - SCORCH_HOLD) / SCORCH_FADE : 1;
      if (fade <= 0) {
        s.mesh.dispose();
        this.scorches.splice(i, 1);
        continue;
      }
      const grow = Math.min(1, s.t / 0.15);
      s.mesh.scaling.set(grow, 1, grow);
      s.mesh.visibility = fade;
    }
  }
}
