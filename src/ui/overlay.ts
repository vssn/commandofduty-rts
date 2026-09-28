import { Engine, Matrix, Vector3, Viewport, type Camera } from "@babylonjs/core";
import { ARTILLERY, COMMANDOS, PLAYER } from "../config";
import { ORDER_LINE_LIFE, type Game } from "../game/game";
import type { Unit } from "../game/unit";

export interface ScreenRect { x0: number; y0: number; x1: number; y1: number }

function hpColor(k: number): string {
  return k > 0.6 ? "#5ee060" : k > 0.3 ? "#f2c440" : "#ef4a3c";
}

/**
 * 2D canvas on top of the 3D view: health bars, tracers, rally line and the drag rectangle.
 * Also provides world -> screen projection for screen-space picking.
 */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly viewProj = new Matrix();
  private viewport = new Viewport(0, 0, 1, 1);
  private readonly tmp = new Vector3();
  private readonly out = new Vector3();
  dragRect: ScreenRect | null = null;
  /** Impact area preview while choosing an artillery target. */
  targetPreview: { x: number; z: number; r: number; ok: boolean } | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly engine: Engine,
    private readonly camera: Camera,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
  }

  resize() {
    this.canvas.width = this.engine.getRenderWidth();
    this.canvas.height = this.engine.getRenderHeight();
  }

  /** Device pixels per CSS pixel. */
  get scale(): number {
    return this.engine.getRenderWidth() / Math.max(1, this.canvas.clientWidth);
  }

  /** Captures the camera matrices of the frame that was just rendered. */
  capture() {
    this.camera.getViewMatrix().multiplyToRef(this.camera.getProjectionMatrix(), this.viewProj);
    this.viewport = this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
  }

  /** Projects to device pixels. Returns null when behind the camera. */
  private projectDev(x: number, y: number, z: number): Vector3 | null {
    this.tmp.set(x, y, z);
    Vector3.ProjectToRef(this.tmp, Matrix.IdentityReadOnly, this.viewProj, this.viewport, this.out);
    if (this.out.z < 0 || this.out.z > 1) return null;
    return this.out;
  }

  /** Projects to CSS pixels relative to the canvas. */
  project(x: number, y: number, z: number): { x: number; y: number } | null {
    const p = this.projectDev(x, y, z);
    if (!p) return null;
    const s = this.scale;
    return { x: p.x / s, y: p.y / s };
  }

  unitScreenPos(u: Unit) {
    return this.project(u.x, u.y + 1.2, u.z);
  }

  draw(game: Game) {
    const ctx = this.ctx, s = this.scale;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // tracers & muzzle flashes
    ctx.lineCap = "round";
    const sees = game.canSee;
    for (const t of game.tracers) {
      if (sees && !sees(t.ax, t.az) && !sees(t.bx, t.bz)) continue; // fire fights in the fog stay hidden
      const a = this.projectDev(t.ax, t.ay, t.az);
      if (!a) continue;
      const ax = a.x, ay = a.y;
      const b = this.projectDev(t.bx, t.by, t.bz);
      if (!b) continue;
      const alpha = 1 - t.t / 0.09;
      const mg = t.kind === "mg" || t.kind === "sniper";
      // heavy MG: thicker orange tracer and a bigger star-shaped muzzle flash
      ctx.strokeStyle = mg ? `rgba(255, 170, 70, ${alpha})` : `rgba(255, 228, 140, ${alpha})`;
      ctx.lineWidth = (t.kind === "sniper" ? 3.2 : mg ? 2.4 : 1.6) * s;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 240, 180, ${alpha})`;
      ctx.beginPath();
      if (mg) {
        for (let i = 0; i < 8; i++) {
          const r = (i % 2 ? 2.5 : 7) * s, a2 = (i / 8) * Math.PI * 2 + Math.random();
          ctx.lineTo(ax + Math.cos(a2) * r, ay + Math.sin(a2) * r);
        }
      } else {
        ctx.arc(ax, ay, 3.2 * s, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // order lines: unit -> commanded destination / target, fading out
    for (const l of game.orderLines) {
      const u = l.unit;
      const from = this.project(u.x, u.y + 0.25, u.z);
      const tx = l.target ? l.target.x : l.x, tz = l.target ? l.target.z : l.z;
      const ty = l.target ? l.target.y + 0.25 : game.terrain.heightAt(tx, tz) + 0.25;
      const to = this.project(tx, ty, tz);
      if (!from || !to) continue;
      const alpha = 1 - l.t / ORDER_LINE_LIFE;
      const rgb = l.target ? "255, 90, 70" : "120, 255, 140";
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.85})`;
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(from.x * s, from.y * s);
      ctx.lineTo(to.x * s, to.y * s);
      ctx.stroke();
      ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(to.x * s, to.y * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // rally point of the selected barracks
    const sb = game.selectedBuilding;
    if (sb && sb.alive) {
      const a = this.project(sb.spawn.x, sb.y + 0.5, sb.spawn.z);
      const ry = game.terrain.heightAt(sb.rally.x, sb.rally.z);
      const b = this.project(sb.rally.x, ry + 0.3, sb.rally.z);
      const top = this.project(sb.rally.x, ry + 3.2, sb.rally.z);
      if (a && b && top) {
        ctx.setLineDash([6 * s, 5 * s]);
        ctx.strokeStyle = "rgba(120, 255, 140, 0.9)";
        ctx.lineWidth = 1.5 * s;
        ctx.beginPath();
        ctx.moveTo(a.x * s, a.y * s);
        ctx.lineTo(b.x * s, b.y * s);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(b.x * s, b.y * s);
        ctx.lineTo(top.x * s, top.y * s);
        ctx.stroke();
        ctx.fillStyle = "rgba(120, 255, 140, 0.95)";
        ctx.beginPath();
        ctx.moveTo(top.x * s, top.y * s);
        ctx.lineTo(top.x * s + 12 * s, top.y * s + 4 * s);
        ctx.lineTo(top.x * s, top.y * s + 8 * s);
        ctx.fill();
      }
    }

    // outposts: capture progress (paused and blinking while contested)
    for (const o of game.outposts) {
      if (o.progress <= 0 || o.capturer === null) continue;
      if (sees && o.owner !== PLAYER && o.capturer !== PLAYER && !sees(o.x, o.z)) continue;
      const p = this.projectDev(o.x, o.y + 8.5, o.z);
      if (!p) continue;
      const w = 70 * s, h = 6 * s, x = Math.round(p.x - w / 2), y = Math.round(p.y);
      ctx.fillStyle = "rgba(10, 12, 10, 0.8)";
      ctx.fillRect(x - s, y - s, w + 2 * s, h + 2 * s);
      const blink = o.contested && Math.floor(performance.now() / 250) % 2 === 0;
      ctx.fillStyle = o.capturer === PLAYER ? (blink ? "#9fc2ff" : "#4d8dff") : blink ? "#ff9d90" : "#ef4a3c";
      ctx.fillRect(x, y, w * o.progress, h);
      ctx.font = `${11 * s}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(o.contested ? `${o.name} – umkämpft` : o.name, p.x, y - 4 * s);
    }

    // health bars
    for (const b of game.buildings) {
      if (!b.alive || (sees && b.team !== PLAYER && !sees(b.x, b.z))) continue;
      const p = this.projectDev(b.x, b.y + 10, b.z);
      if (p) this.bar(p.x, p.y, 90 * s, 6 * s, b.hp / b.maxHp, 10, b.selected, b.team === PLAYER);
    }
    for (const u of game.units) {
      if (!u.alive || u.vehicle || u.fogHidden) continue;
      const jeep = u.isVehicle;
      const p = this.projectDev(u.x, u.y + (jeep ? 3.9 : 3.1), u.z);
      if (!p) continue;
      const w = (jeep ? 44 : 26) * s;
      this.bar(p.x, p.y, w, 4 * s, u.hp / u.maxHp, jeep ? 8 : 5, u.selected, u.team === PLAYER);
      if (jeep && u.team === PLAYER) {
        // MG crew indicator: filled when a gunner is aboard
        const x = Math.round(p.x + w / 2 + 4 * s), y = Math.round(p.y - 2 * s);
        ctx.fillStyle = u.gunner ? "#5ee060" : "rgba(10,12,10,0.75)";
        ctx.strokeStyle = u.gunner ? "#1d3a1c" : "#9a9679";
        ctx.lineWidth = s;
        ctx.fillRect(x, y, 5 * s, 5 * s);
        ctx.strokeRect(x, y, 5 * s, 5 * s);
      }
    }

    // artillery: impact area preview while targeting, countdown over ordered strikes
    const tp = this.targetPreview;
    if (tp) this.groundCircle(game, tp.x, tp.z, tp.r, tp.ok ? "255, 80, 60" : "170, 170, 160", true);
    for (const st of game.artillery.active) {
      if (sees && st.team !== PLAYER && !sees(st.x, st.z)) continue;
      const left = ARTILLERY.delay - st.t;
      const p = this.project(st.x, game.terrain.heightAt(st.x, st.z) + 2.5, st.z);
      if (!p) continue;
      ctx.font = `bold ${13 * s}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
      ctx.textAlign = "center";
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = "rgba(10, 10, 8, 0.85)";
      ctx.fillStyle = st.team === PLAYER ? "#ffd27a" : "#ff6a50";
      const label = left > 0 ? `Einschlag in ${left.toFixed(1)} s` : "Einschlag!";
      ctx.strokeText(label, p.x * s, p.y * s);
      ctx.fillText(label, p.x * s, p.y * s);
    }

    // commandos: fuse countdowns, planting progress, cloak
    const cm = game.commandos;
    if (cm) {
      const label = (text: string, x: number, y: number, color: string) => {
        ctx.font = `bold ${12 * s}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
        ctx.textAlign = "center";
        ctx.lineWidth = 3 * s;
        ctx.strokeStyle = "rgba(10, 10, 8, 0.85)";
        ctx.fillStyle = color;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      };
      for (const c of cm.planted) {
        const p = this.project(c.x, game.terrain.heightAt(c.x, c.z) + 2.2, c.z);
        if (!p) continue;
        const blink = Math.floor(c.fuse * (c.fuse < 2 ? 6 : 2)) % 2 === 0;
        ctx.fillStyle = blink ? "#ff3a2a" : "#5a1410";
        ctx.beginPath();
        ctx.arc(p.x * s, (p.y + 8) * s, 3.5 * s, 0, Math.PI * 2);
        ctx.fill();
        label(`Sprengung in ${Math.max(0, c.fuse).toFixed(1)} s`, p.x * s, p.y * s, "#ff8a5a");
      }
      const a = cm.agent;
      // reach of the scoped rifle around the selected agent (gold when loaded, grey while reloading)
      if (a.alive && a.selected) this.groundCircle(game, a.x, a.z, COMMANDOS.sniper.range, cm.sniperCooldown > 0 ? "150, 150, 140" : "233, 181, 60", false);
      if (a.alive && cm.pending && cm.pending.progress > 0) {
        const p = this.project(a.x, a.y + 3.6, a.z);
        if (p) {
          const w = 60 * s, x = p.x * s - w / 2, y = p.y * s;
          ctx.fillStyle = "rgba(10, 12, 10, 0.8)";
          ctx.fillRect(x - s, y - s, w + 2 * s, 5 * s + 2 * s);
          ctx.fillStyle = "#e9b53c";
          ctx.fillRect(x, y, w * Math.min(1, cm.pending.progress), 5 * s);
          label("Ladung wird angebracht", p.x * s, y - 4 * s, "#e9d9a0");
        }
      }
      if (a.alive && a.cloaked) {
        this.groundCircle(game, a.x, a.z, 1.4, "140, 220, 255", false);
        const p = this.project(a.x, a.y + 3.4, a.z);
        if (p) label(`Getarnt ${a.cloakT.toFixed(1)} s`, p.x * s, p.y * s, "#9fe3ff");
      }
    }

    // drag rectangle
    const r = this.dragRect;
    if (r) {
      const x = Math.min(r.x0, r.x1) * s, y = Math.min(r.y0, r.y1) * s;
      const w = Math.abs(r.x1 - r.x0) * s, h = Math.abs(r.y1 - r.y0) * s;
      ctx.fillStyle = "rgba(120, 255, 140, 0.08)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(140, 255, 150, 0.9)";
      ctx.lineWidth = 1 * s;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
  }

  /** Circle on the terrain (follows the hills), optionally filled. */
  private groundCircle(game: Game, cx: number, cz: number, r: number, rgb: string, fill: boolean) {
    const ctx = this.ctx, s = this.scale;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const p = this.project(x, game.terrain.heightAt(x, z) + 0.2, z);
      if (!p) continue;
      if (started) ctx.lineTo(p.x * s, p.y * s);
      else { ctx.moveTo(p.x * s, p.y * s); started = true; }
    }
    if (!started) return;
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = `rgba(${rgb}, 0.13)`;
      ctx.fill();
    }
    ctx.setLineDash([8 * s, 5 * s]);
    ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
    ctx.lineWidth = 2 * s;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private bar(cx: number, cy: number, w: number, h: number, k: number, segments: number, selected: boolean, own: boolean) {
    const ctx = this.ctx, s = this.scale;
    const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
    ctx.fillStyle = "rgba(10, 12, 10, 0.75)";
    ctx.fillRect(x - s, y - s, w + 2 * s, h + 2 * s);
    const gap = Math.max(1, s);
    const sw = (w - gap * (segments - 1)) / segments;
    const filled = k * segments;
    ctx.fillStyle = hpColor(k);
    for (let i = 0; i < segments; i++) {
      const f = Math.min(1, Math.max(0, filled - i));
      if (f <= 0) break;
      ctx.fillRect(x + i * (sw + gap), y, sw * f, h);
    }
    if (selected) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = s;
      ctx.strokeRect(x - 1.5 * s, y - 1.5 * s, w + 3 * s, h + 3 * s);
    } else if (!own) {
      ctx.fillStyle = "#e0402e";
      ctx.fillRect(x - 4 * s, y, 2 * s, h);
    }
  }
}
