import { Matrix, Plane, type Engine, type Scene } from "@babylonjs/core";
import { MAP_HALF, PLAYER } from "../config";
import type { FogOfWar } from "../game/fog";
import type { Game } from "../game/game";
import { toWorld, type MapLayout, type RGB } from "../world/layout";
import type { TreeInfo } from "../world/scenery";
import type { Terrain } from "../world/terrain";
import type { RtsCamera } from "./rtsCamera";

const BG_RES = 220;

/** Radar in the sidebar: pre-rendered terrain plus live units and camera frustum. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private dragging = false;
  /** Player's fog of war, drawn over the radar once assigned. */
  fog: FogOfWar | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;

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

  draw() {
    const ctx = this.ctx, S = this.canvas.width;
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
      ctx.fillStyle = o.owner === null ? "#e8e4d4" : o.owner === PLAYER ? "#4d8dff" : "#ff4436";
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
    for (const u of this.game.units) {
      if (!u.alive || u.vehicle || u.fogHidden) continue;
      const [x, y] = this.map(u.x, u.z);
      const r = u.isVehicle ? 5 : 3;
      ctx.fillStyle = u.selected ? "#ffffff" : u.team === PLAYER ? "#7fb2ff" : "#ff5a48";
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

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
