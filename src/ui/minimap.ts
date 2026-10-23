import { Matrix, Plane, type Engine, type Scene } from "@babylonjs/core";
import { MAP_HALF, PLAYER } from "../config";
import type { FogOfWar } from "../game/fog";
import type { Game, PingKind } from "../game/game";
import { toWorld, type MapLayout, type RGB } from "../world/layout";
import type { TreeInfo } from "../world/scenery";
import type { Terrain } from "../world/terrain";
import type { RtsCamera } from "./rtsCamera";

const BG_RES = 220;

/**
 * What a mark on the radar looks like, by kind: colour, the size of the ring at its start and end (canvas px), how
 * long it lasts (s), how many rings follow one another, and whether it shows outside the player's sight (things that
 * concern his own holdings and the mission; the rest only shows where he can see it).
 */
const PING: Record<PingKind, { color: string; r0: number; r1: number; life: number; rings: number; always: boolean }> = {
  attack: { color: "255, 70, 55", r0: 6, r1: 26, life: 1.3, rings: 1, always: false },
  hit: { color: "255, 245, 215", r0: 4, r1: 15, life: 0.8, rings: 1, always: false },
  killOwn: { color: "255, 70, 55", r0: 6, r1: 33, life: 1.8, rings: 2, always: false },
  killEnemy: { color: "110, 170, 255", r0: 6, r1: 30, life: 1.6, rings: 2, always: false },
  explosion: { color: "255, 160, 50", r0: 6, r1: 36, life: 1.2, rings: 1, always: false },
  capture: { color: "110, 170, 255", r0: 12, r1: 63, life: 3.6, rings: 3, always: true },
  lost: { color: "255, 70, 55", r0: 12, r1: 63, life: 3.6, rings: 3, always: true },
  threat: { color: "255, 175, 60", r0: 12, r1: 51, life: 3.2, rings: 3, always: true },
  base: { color: "255, 70, 55", r0: 12, r1: 57, life: 2.8, rings: 2, always: true },
  planted: { color: "255, 215, 90", r0: 9, r1: 45, life: 2.4, rings: 2, always: true },
  destroyed: { color: "255, 160, 50", r0: 12, r1: 69, life: 3.4, rings: 3, always: true },
  spotted: { color: "255, 70, 55", r0: 9, r1: 54, life: 2.8, rings: 3, always: true },
};

/** A mark on the radar: where, what, and for how long it has been showing. */
interface Ping { x: number; z: number; kind: PingKind; t: number; life: number; r1: number; color: string; rings: number }

/** Radar in the sidebar: pre-rendered terrain plus live units and camera frustum. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private dragging = false;
  /** Player's fog of war, drawn over the radar once assigned. */
  fog: FogOfWar | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  private noise: HTMLCanvasElement | null = null;
  private readonly pings: Ping[] = [];
  private lastDraw = performance.now();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    terrain: Terrain,
    layout: MapLayout,
    trees: TreeInfo[],
    private readonly game: Game,
    private readonly cam: RtsCamera,
    private readonly scene: Scene,
    private readonly engine: Engine,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.bg = this.renderBackground(terrain, layout, trees);

    canvas.addEventListener("pointerdown", (e) => {
      if (!this.online) return; // no radar, no map
      const p = this.toWorld(e);
      if (e.button === 0) {
        this.dragging = true;
        canvas.setPointerCapture(e.pointerId);
        this.cam.jumpTo(p.x, p.z);
      } else if (e.button === 2 && this.game.selection.size) {
        this.game.commandMove(this.game.selection, this.game.nav.freePoint(p.x, p.z));
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const p = this.toWorld(e);
      this.cam.jumpTo(p.x, p.z);
    });
    canvas.addEventListener("pointerup", () => (this.dragging = false));
    game.onPing = (x, z, kind) => this.ping(x, z, kind);
  }

  /**
   * Marks something that happens at (x, z): rings spreading out from the spot. What is not the player's own business
   * only shows where he can see it right now; a mark just like it (same kind, close by, a moment ago) is not added
   * again, so a fire fight is a few pulses and not a flood.
   */
  ping(x: number, z: number, kind: PingKind) {
    const def = PING[kind];
    if (!def.always && this.fog && !this.fog.isVisible(x, z)) return;
    if (this.pings.some((p) => p.kind === kind && p.t < 0.7 && Math.hypot(p.x - x, p.z - z) < 7)) return;
    this.pings.push({ x, z, kind, t: 0, life: def.life, r1: def.r1, color: def.color, rings: def.rings });
    if (this.pings.length > 60) this.pings.shift();
  }

  /**
   * The start of a commandos mission: the targets (outposts to blow up, or the embassies) and the explosive caches
   * light up on the radar, a few strong pulses in a row, so the player knows where to go.
   */
  flashObjectives() {
    const cm = this.game.commandos;
    if (!cm) return;
    const spots: { x: number; z: number; color: string }[] = [];
    if (cm.kind === "documents") for (const e of cm.embassies) spots.push({ x: e.villa.x, z: e.villa.z, color: "255, 235, 140" });
    else for (const o of this.game.outposts) if (!o.destroyed) spots.push({ x: o.x, z: o.z, color: "255, 70, 55" });
    for (const c of cm.caches) if (!c.taken) spots.push({ x: c.x, z: c.z, color: "255, 215, 60" });
    // (rings of moderate size: with a dozen targets they must not run into one another)
    for (const sp of spots) this.pings.push({ x: sp.x, z: sp.z, kind: "capture", t: 0, life: 6, r1: 38, color: sp.color, rings: 3 });
  }

  /** Draws the marks (rings spreading from the spot, fading as they grow) and drops the ones that have run out. */
  private drawPings() {
    const ctx = this.ctx, now = performance.now(), dt = Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.t += dt;
      if (p.t >= p.life) { this.pings.splice(i, 1); continue; }
      const [x, y] = this.map(p.x, p.z);
      const def = PING[p.kind], r0 = def.r0;
      const k = p.t / p.life;
      for (let n = 0; n < p.rings; n++) {
        // the rings follow each other over the first two thirds of the time, each one growing and fading
        const start = (n / p.rings) * 0.6, kk = (k - start) / (1 - start);
        if (kk <= 0 || kk >= 1) continue;
        const rad = r0 + (p.r1 - r0) * (1 - Math.pow(1 - kk, 2));
        ctx.strokeStyle = `rgba(${p.color}, ${(1 - kk) * 0.9})`;
        ctx.lineWidth = 6 - kk * 3;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      // the spot itself glows for the first moments
      if (k < 0.35) {
        ctx.fillStyle = `rgba(${p.color}, ${(1 - k / 0.35) * 0.85})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + (1 - k / 0.35) * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private toWorld(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    return { x: -MAP_HALF + u * MAP_HALF * 2, z: MAP_HALF - v * MAP_HALF * 2 };
  }

  private map(x: number, z: number): [number, number] {
    const S = this.canvas.width;
    return [((x + MAP_HALF) / (MAP_HALF * 2)) * S, ((MAP_HALF - z) / (MAP_HALF * 2)) * S];
  }

  private renderBackground(terrain: Terrain, layout: MapLayout, trees: TreeInfo[]): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = c.height = BG_RES;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(BG_RES, BG_RES);
    const col: RGB = [0, 0, 0];
    const step = (MAP_HALF * 2) / BG_RES;
    for (let py = 0; py < BG_RES; py++) {
      for (let px = 0; px < BG_RES; px++) {
        const x = -MAP_HALF + (px + 0.5) * step, z = MAP_HALF - (py + 0.5) * step;
        const h = terrain.heightAt(x, z);
        const gx = terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z);
        const gz = terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1);
        const slope = Math.min(1, Math.hypot(gx, gz) * 0.35);
        terrain.colorAt(x, z, h, slope, col);
        const shade = Math.min(1.3, Math.max(0.7, 1 + (-gx + gz) * 0.12));
        const i = (px + py * BG_RES) * 4;
        img.data[i] = Math.min(255, col[0] * shade * 255);
        img.data[i + 1] = Math.min(255, col[1] * shade * 255);
        img.data[i + 2] = Math.min(255, col[2] * shade * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const k = BG_RES / (MAP_HALF * 2);
    const m = (x: number, z: number): [number, number] => [(x + MAP_HALF) * k, (MAP_HALF - z) * k];
    for (const t of trees) {
      if (Math.abs(t.x) > MAP_HALF || Math.abs(t.z) > MAP_HALF) continue;
      const [x, y] = m(t.x, t.z);
      ctx.fillStyle = `rgb(${t.color.map((v) => Math.round(v * 200)).join(",")})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#d8d2c4";
    for (const h of layout.houses) {
      ctx.beginPath();
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = toWorld(h.x, h.z, h.rot, (lx * h.w) / 2, (lz * h.d) / 2);
        ctx.lineTo(...m(p.x, p.z));
      }
      ctx.fill();
    }
    return c;
  }

  /** False while the player holds no radar tower: the map shows static instead. */
  private get online(): boolean {
    return this.game.hasRadar(PLAYER);
  }

  /** Radar off: grey static with a hint where to get the map back. */
  private drawOffline() {
    const ctx = this.ctx, S = this.canvas.width;
    // coarse static, rendered small and scaled up
    if (!this.noise) {
      this.noise = document.createElement("canvas");
      this.noise.width = this.noise.height = 110;
    }
    const nctx = this.noise.getContext("2d")!;
    const img = nctx.createImageData(110, 110);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 18 + Math.random() * 34;
      img.data[i] = v;
      img.data[i + 1] = v * 1.05;
      img.data[i + 2] = v * 0.9;
      img.data[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.noise, 0, 0, S, S);
    // a slowly rolling scan bar
    const y = ((performance.now() / 12) % (S + 60)) - 30;
    const grad = ctx.createLinearGradient(0, y - 30, 0, y + 30);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.08)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 30, S, 60);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(10, 11, 8, 0.75)";
    ctx.fillRect(0, S / 2 - 46, S, 92);
    ctx.fillStyle = "#e9b53c";
    ctx.font = `bold ${Math.round(S * 0.075)}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
    ctx.fillText("KEIN RADAR", S / 2, S / 2 - 6);
    ctx.fillStyle = "#cfcab3";
    ctx.font = `${Math.round(S * 0.05)}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
    ctx.fillText("Radarturm einnehmen", S / 2, S / 2 + 28);
  }

  draw() {
    const ctx = this.ctx, S = this.canvas.width;
    if (!this.online) {
      this.drawOffline();
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bg, 0, 0, S, S);
    // fog of war: unexplored areas black, explored ones dimmed (drawn from a small grey-scale image)
    if (this.fog) {
      const f = this.fog, n = f.n;
      if (!this.fogCanvas) {
        this.fogCanvas = document.createElement("canvas");
        this.fogCanvas.width = this.fogCanvas.height = n;
      }
      const fctx = this.fogCanvas.getContext("2d")!;
      const img = fctx.createImageData(n, n);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          // minimap rows go north (+z) to south, fog rows go south to north
          const o = (i + (n - 1 - j) * n) * 4;
          img.data[o] = 8; img.data[o + 1] = 9; img.data[o + 2] = 6;
          img.data[o + 3] = Math.round((1 - f.values[i + j * n]) * 235);
        }
      }
      fctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogCanvas, 0, 0, S, S);
    }

    for (const b of this.game.buildings) {
      if (!b.alive || (this.fog && b.team !== PLAYER && !this.fog.isExplored(b.x, b.z))) continue;
      const [x, y] = this.map(b.x, b.z);
      ctx.fillStyle = b.team === PLAYER ? "#4d8dff" : "#ff4436";
      ctx.strokeStyle = b.selected ? "#fff" : "#000";
      ctx.lineWidth = 2;
      ctx.fillRect(x - 11, y - 8, 22, 16);
      ctx.strokeRect(x - 11, y - 8, 22, 16);
    }
    for (const o of this.game.outposts) {
      const [x, y] = this.map(o.x, o.z);
      ctx.fillStyle = o.destroyed ? "#3a3a36" : o.owner === null ? "#e8e4d4" : o.owner === PLAYER ? "#4d8dff" : "#ff4436";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 8, y);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 8, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // commandos: explosive caches, always marked (a yellow crate with a pulsing ring)
    const caches = this.game.commandos?.caches ?? [];
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    for (const c of caches) {
      if (c.taken) continue;
      const [x, y] = this.map(c.x, c.z);
      ctx.strokeStyle = `rgba(255, 210, 90, ${0.35 + pulse * 0.5})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 10 + pulse * 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffd25a";
      ctx.strokeStyle = "#000";
      ctx.fillRect(x - 6, y - 5, 12, 10);
      ctx.strokeRect(x - 6, y - 5, 12, 10);
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 1);
      ctx.lineTo(x + 6, y - 1);
      ctx.stroke();
    }
    // commandos (city): the embassies with the documents - a pulsing ring and a small white envelope
    for (const e of this.game.commandos?.embassies ?? []) {
      if (e.taken) continue;
      const [x, y] = this.map(e.villa.x, e.villa.z);
      ctx.strokeStyle = `rgba(255, 235, 140, ${0.35 + pulse * 0.5})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 10 + pulse * 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#f6f1de";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.fillRect(x - 7, y - 5, 14, 10);
      ctx.strokeRect(x - 7, y - 5, 14, 10);
      ctx.beginPath();
      ctx.moveTo(x - 7, y - 5);
      ctx.lineTo(x, y + 1);
      ctx.lineTo(x + 7, y - 5);
      ctx.stroke();
    }
    // commandos: the extraction point, once open (blue smoke: a pulsing blue ring with a flare)
    const ex = this.game.commandos?.extraction;
    if (ex) {
      const [x, y] = this.map(ex.x, ex.z);
      const pp = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = `rgba(110, 170, 255, ${0.4 + pp * 0.55})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 9 + pp * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#5fa0ff";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("E", x, y + 0.5);
    }
    for (const u of this.game.units) {
      if (!u.alive || u.vehicle || u.fogHidden) continue;
      const [x, y] = this.map(u.x, u.z);
      const r = u.isVehicle ? 5 : 3;
      ctx.fillStyle = u.selected ? "#ffffff" : u.team === PLAYER ? "#7fb2ff" : "#ff5a48";
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    this.drawPings();

    // camera footprint on the ground
    const cam = this.cam.camera;
    const view = this.engine.getRenderingCanvas()!;
    const cw = view.clientWidth, ch = view.clientHeight;
    const plane = new Plane(0, 1, 0, -this.cam.focus.y);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [sx, sy] of [[0, 0], [cw, 0], [cw, ch], [0, ch]]) {
      const ray = this.scene.createPickingRay(sx, sy, Matrix.Identity(), cam);
      const d = ray.intersectsPlane(plane);
      if (d === null) continue;
      const p = ray.origin.add(ray.direction.scale(d));
      ctx.lineTo(...this.map(p.x, p.z));
    }
    ctx.closePath();
    ctx.stroke();
  }
}
