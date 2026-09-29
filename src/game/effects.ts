import type { InstancedMesh, Mesh, Scene, ShadowGenerator } from "@babylonjs/core";
import { GRENADE, UNITS } from "../config";
import { createExplosionTemplates, createGrenadeTemplate, type ExplosionTemplates } from "../world/models";
import type { Game } from "./game";
import type { Unit } from "./unit";

/** Delay between the start of the throw animation and the grenade leaving the hand. */
const RELEASE = 0.42;

interface Grenade {
  thrower: Unit;
  tx: number;
  tz: number;
  /** Counts down to release, then flight time. */
  delay: number;
  t: number;
  flight: number;
  sx: number; sy: number; sz: number; ty: number; apex: number;
  mesh: InstancedMesh | null;
}

type PuffKind = "flash" | "smoke" | "debris" | "spark" | "ring" | "dust";

/** One animated piece of an explosion. `delay` staggers its start (hidden until then). */
interface Puff {
  kind: PuffKind;
  mesh: InstancedMesh;
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
interface Scorch { mesh: InstancedMesh; t: number; size: number }

/** Grenades in flight, explosions and their leftovers. */
export class Effects {
  private readonly grenadeTpl: Mesh;
  private readonly tpl: ExplosionTemplates;
  private readonly grenades: Grenade[] = [];
  private readonly puffs: Puff[] = [];
  private readonly scorches: Scorch[] = [];
  /** Called for every explosion (sound, screen feedback). */
  onExplosion: ((x: number, z: number, size: number) => void) | null = null;

  constructor(scene: Scene, shadows: ShadowGenerator, private readonly game: Game) {
    this.grenadeTpl = createGrenadeTemplate(scene);
    this.tpl = createExplosionTemplates(scene);
    shadows.addShadowCaster(this.grenadeTpl);
    shadows.addShadowCaster(this.tpl.smoke);
    shadows.addShadowCaster(this.tpl.darkSmoke);
    shadows.addShadowCaster(this.tpl.debris);
  }

  throwGrenade(thrower: Unit, tx: number, tz: number) {
    this.grenades.push({ thrower, tx, tz, delay: RELEASE, t: 0, flight: 0, sx: 0, sy: 0, sz: 0, ty: 0, apex: 0, mesh: null });
  }

  /** Blast at (x, z): damages every unit in range, friend or foe, plus buildings. */
  explode(x: number, z: number, damage: number, radius: number, by: Unit | null, size = 1) {
    const g = this.game;
    for (const u of g.units) {
      if (!u.alive || u.vehicle) continue;
      const d = Math.hypot(u.x - x, u.z - z) - (u.isVehicle ? u.radius * 0.5 : 0);
      if (d > radius) continue;
      const falloff = 1 - 0.6 * Math.max(0, d) / radius;
      g.damage(u, damage * falloff, by);
    }
    for (const b of g.buildings) {
      if (b.alive && Math.hypot(b.x - x, b.z - z) - b.radius < radius) g.damage(b, damage * 0.7, by);
    }
    this.spawnBlast(x, z, size);
    this.onExplosion?.(x, z, size);
  }

  private add(kind: PuffKind, tpl: Mesh, x: number, y: number, z: number, o: Partial<Puff> & { life: number; size: number }) {
    const mesh = tpl.createInstance(kind);
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
  private spawnBlast(x: number, z: number, size: number) {
    const T = this.tpl;
    const y = this.game.terrain.heightAt(x, z);
    const r = () => Math.random();

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

    const sc = this.tpl.scorch.createInstance("scorch");
    sc.position.set(x, y + 0.12, z);
    sc.rotation.y = Math.random() * Math.PI;
    this.scorches.push({ mesh: sc, t: 0, size: (1.1 + Math.random() * 0.4) * size });
  }

  update(dt: number) {
    const g = this.game;
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
        gr.ty = g.terrain.heightAt(gr.tx, gr.tz) + 0.15;
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
        this.explode(gr.tx, gr.tz, UNITS.grenadier.damage, GRENADE.radius, gr.thrower.alive ? gr.thrower : null);
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
          m.scaling.set(p.size * (0.5 + k * 1.3) * (1 - k * k), p.size * 0.55 * (1 - k), p.size * (0.5 + k * 1.3) * (1 - k * k));
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
          const grow = 0.3 + Math.sqrt(k) * 1.35;
          const thin = k > 0.6 ? 1 - ((k - 0.6) / 0.4) ** 2 : 1;
          m.scaling.setAll(p.size * grow * thin);
          break;
        }
      }
    }

    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.t += dt;
      const fade = s.t > 20 ? Math.max(0, 1 - (s.t - 20) / 5) : 1;
      if (fade <= 0) {
        s.mesh.dispose();
        this.scorches.splice(i, 1);
        continue;
      }
      const grow = Math.min(1, s.t / 0.15);
      s.mesh.scaling.set(s.size * grow * fade, 1, s.size * grow * fade);
    }
  }
}
