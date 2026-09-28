import type { InstancedMesh, Mesh, Scene, ShadowGenerator } from "@babylonjs/core";
import { GRENADE, UNITS } from "../config";
import { createExplosionTemplates, createGrenadeTemplate } from "../world/models";
import type { Game } from "./game";
import type { Unit } from "./unit";

/** Delay between the start of the throw animation and the grenade leaving the hand. */
const RELEASE = 0.32;

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

interface Puff { mesh: InstancedMesh; t: number; life: number; vx: number; vy: number; vz: number; size: number; flash: boolean }
interface Scorch { mesh: InstancedMesh; t: number; size: number }

/** Grenades in flight, explosions and their leftovers. */
export class Effects {
  private readonly grenadeTpl: Mesh;
  private readonly tpl: { flash: Mesh; smoke: Mesh; scorch: Mesh };
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

  private spawnBlast(x: number, z: number, size: number) {
    const y = this.game.terrain.heightAt(x, z);
    const flash = this.tpl.flash.createInstance("flash");
    flash.position.set(x, y + 0.8 * size, z);
    this.puffs.push({ mesh: flash, t: 0, life: 0.35, vx: 0, vy: 0, vz: 0, size: 2.2 * size, flash: true });
    const n = Math.round(6 * size);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.8 + Math.random() * 1.6;
      const m = this.tpl.smoke.createInstance("smoke");
      m.position.set(x + Math.cos(a) * 0.4, y + 0.5, z + Math.sin(a) * 0.4);
      m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      this.puffs.push({
        mesh: m, t: 0, life: 1.4 + Math.random() * 1.2,
        vx: Math.cos(a) * s, vy: 1.4 + Math.random() * 1.8, vz: Math.sin(a) * s,
        size: (0.7 + Math.random() * 0.6) * size, flash: false,
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
      const k = p.t / p.life;
      if (k >= 1) {
        p.mesh.dispose();
        this.puffs.splice(i, 1);
        continue;
      }
      if (p.flash) {
        // fireball: fast bloom, then collapse
        const s = p.size * (k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75 * 0.9);
        p.mesh.scaling.setAll(s);
      } else {
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vx *= 1 - dt * 1.5;
        p.vz *= 1 - dt * 1.5;
        p.vy *= 1 - dt * 0.8;
        p.mesh.scaling.setAll(p.size * (0.4 + Math.sqrt(k) * 1.1) * (1 - k * k));
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
