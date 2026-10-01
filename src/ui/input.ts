import type { Scene } from "@babylonjs/core";
import { ARTILLERY, COMMANDOS, PLAYER, UNITS } from "../config";
import type { Barracks } from "../game/barracks";
import type { Game } from "../game/game";
import type { Unit } from "../game/unit";
import type { Overlay } from "./overlay";
import { CURSORS, type CursorKind } from "./cursors";
import type { RtsCamera } from "./rtsCamera";

export type Targeting = "artillery" | "sniper" | "charge" | "mgnest" | "bollard";

function isBuild(t: Targeting | null): t is "mgnest" | "bollard" {
  return t === "mgnest" || t === "bollard";
}

const EDGE = 14;
const DRAG_THRESHOLD = 6;
/** Fingers are less precise: a larger movement is needed before a tap becomes a drag. */
const TOUCH_DRAG_THRESHOLD = 14;
const PICK_RADIUS = 18;
const DOUBLE_CLICK_MS = 320;

/** Mouse & keyboard handling: selection, commands, edge scrolling, control groups. */
export class InputController {
  /** False while the main menu is shown. */
  enabled = false;
  /** Picking a target for an ordered action (skirmish artillery); left click confirms, right click / Esc cancels. */
  targeting: Targeting | null = null;
  /** Called when targeting starts or ends (HUD highlight). */
  onTargetingChange: (() => void) | null = null;
  private mouseX = -1;
  private mouseY = -1;
  private inWindow = false;
  private readonly keys = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  private lastClick = { t: 0, unit: null as Unit | null };
  private readonly groups = new Map<string, Unit[]>();
  private cursorKind: CursorKind | null = null;
  private cursorT = 0;
  /** The current/last pointer is a finger: taps also issue commands, no edge scrolling. */
  private touch = false;
  /** Camera pan from the on-screen arrow buttons (-1..1 per axis). */
  private readonly pad = { x: 0, z: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene,
    private readonly game: Game,
    private readonly cam: RtsCamera,
    private readonly overlay: Overlay,
  ) {
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.documentElement.addEventListener("mouseleave", () => (this.inWindow = false));
    window.addEventListener("blur", () => {
      this.inWindow = false;
      this.keys.clear();
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.enabled) this.cam.zoom(Math.sign(e.deltaY));
    }, { passive: false });
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key));
  }

  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent) {
    this.touch = e.pointerType === "touch";
    if (this.game.result || !this.enabled) return;
    const p = this.local(e);
    if (this.targeting) {
      if (e.button === 0) {
        // Shift keeps the build mode for placing several structures in a row
        if (this.confirmTarget(p.x, p.y) && !(e.shiftKey && isBuild(this.targeting))) this.setTargeting(null);
      } else if (e.button === 2) {
        this.setTargeting(null);
      }
      return;
    }
    if (e.button === 0) {
      this.dragStart = p;
      this.dragging = false;
    } else if (e.button === 2) {
      this.command(p.x, p.y);
    }
  }

  private onMove(e: PointerEvent) {
    this.touch = e.pointerType === "touch";
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.inWindow = !this.touch; // a finger resting near the edge must not scroll the map
    const p = this.local(e);
    if (this.dragStart) {
      const threshold = this.touch ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
      if (!this.dragging && Math.hypot(p.x - this.dragStart.x, p.y - this.dragStart.y) > threshold) this.dragging = true;
      if (this.dragging) this.overlay.dragRect = { x0: this.dragStart.x, y0: this.dragStart.y, x1: p.x, y1: p.y };
    }
    this.updateCursor(p.x, p.y);
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || !this.dragStart) return;
    const p = this.local(e);
    if (this.dragging) this.boxSelect(this.dragStart.x, this.dragStart.y, p.x, p.y, e.shiftKey);
    else this.click(p.x, p.y, e.shiftKey);
    this.dragStart = null;
    this.dragging = false;
    this.overlay.dragRect = null;
  }

  private onKey(e: KeyboardEvent) {
    if (!this.enabled) return;
    const g = this.game;
    this.keys.add(e.key);
    // Escape cancels a targeting mode; otherwise it opens the pause menu (handled in main)
    if (e.key === "Escape" && this.targeting) this.setTargeting(null);
    else if ((e.key === "a" || e.key === "A") && !e.ctrlKey && !e.metaKey && g.mode === "skirmish") {
      this.setTargeting(this.targeting ? null : "artillery");
    } else if (g.mode === "commandos" && !e.ctrlKey && !e.metaKey && (e.key === "x" || e.key === "X")) {
      g.commandos?.cloak();
    } else if (g.mode === "commandos" && !e.ctrlKey && !e.metaKey && (e.key === "c" || e.key === "C")) {
      this.setTargeting(this.targeting === "charge" ? null : "charge");
    }
    else if (g.mode === "base" && !e.ctrlKey && !e.metaKey && (e.key === "n" || e.key === "N")) this.toggleBuild("mgnest");
    else if (g.mode === "base" && !e.ctrlKey && !e.metaKey && (e.key === "b" || e.key === "B")) this.toggleBuild("bollard");
    else if (e.key === "s" || e.key === "S") g.commandStop(g.selection);
    else if (e.key === "h" || e.key === "H") {
      const b = g.playerBarracks;
      this.cam.jumpTo(b.x, b.z + 10);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      g.select(g.units.filter((u) => u.alive && u.team === PLAYER));
    } else if (/^[1-9]$/.test(e.key)) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups.set(e.key, [...g.selection]);
      } else {
        const grp = (this.groups.get(e.key) ?? []).filter((u) => u.alive);
        if (grp.length) {
          const again = grp.every((u) => g.selection.has(u)) && grp.length === g.selection.size;
          g.select(grp);
          if (again) {
            const cx = grp.reduce((s, u) => s + u.x, 0) / grp.length;
            const cz = grp.reduce((s, u) => s + u.z, 0) / grp.length;
            this.cam.jumpTo(cx, cz);
          }
        }
      }
    }
  }

  /** Nearest unit of `team` (or any enemy of the player when team is "enemy") under the cursor. */
  private unitAt(x: number, y: number, which: "own" | "enemy"): Unit | null {
    let best: Unit | null = null, bd = Infinity;
    for (const u of this.game.units) {
      if (!u.alive || u.vehicle || u.fogHidden || (which === "own") !== (u.team === PLAYER)) continue;
      const p = this.overlay.unitScreenPos(u);
      if (!p) continue;
      // vehicles are bigger on screen, so they get a larger pick radius (but soldiers win ties)
      const d = Math.hypot(p.x - x, p.y - y) - (u.isVehicle ? PICK_RADIUS * 0.8 : 0);
      if (d < PICK_RADIUS && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  private buildingAt(x: number, y: number): Barracks | null {
    const hit = this.scene.pick(x, y, (m) => !!m.metadata?.building);
    const b = hit?.pickedMesh?.metadata?.building as Barracks | undefined;
    return b && b.alive ? b : null;
  }

  private groundAt(x: number, y: number) {
    const hit = this.scene.pick(x, y, (m) => m === this.game.terrain.mesh);
    return hit?.hit && hit.pickedPoint ? { x: hit.pickedPoint.x, z: hit.pickedPoint.z } : null;
  }

  private click(x: number, y: number, shift: boolean) {
    if (this.touch) {
      this.tap(x, y);
      return;
    }
    const g = this.game;
    const u = this.unitAt(x, y, "own");
    const now = performance.now();
    if (u) {
      if (this.lastClick.unit === u && now - this.lastClick.t < DOUBLE_CLICK_MS) {
        // double click: all own units of the same type currently on screen
        g.select(g.units.filter((o) => o.alive && o.team === PLAYER && o.type === u.type && this.onScreen(o)), shift);
      } else if (shift) {
        g.toggle(u);
      } else {
        g.select([u]);
      }
      this.lastClick = { t: now, unit: u };
      return;
    }
    this.lastClick = { t: now, unit: null };
    const b = this.buildingAt(x, y);
    if (b && b.team === PLAYER) g.selectBuilding(b);
    else if (!shift) g.clearSelection();
  }

  /**
   * Touch has no right button: a tap selects when nothing is selected (or on an own unit), and
   * otherwise it is the command - move, attack, snipe, set the rally point, board a jeep.
   */
  private tap(x: number, y: number) {
    const g = this.game;
    const now = performance.now();
    const own = this.unitAt(x, y, "own");
    if (own) {
      if (own.hasMg && !own.gunner && !g.selection.has(own) && [...g.selection].some((u) => !u.isVehicle && u.armed)) {
        g.commandBoard(g.selection, own);
      } else if (!g.selection.has(own) && this.canHeal(own)) {
        g.commandHeal(g.selection, own);
      } else if (this.lastClick.unit === own && now - this.lastClick.t < DOUBLE_CLICK_MS * 1.3) {
        g.select(g.units.filter((o) => o.alive && o.team === PLAYER && o.type === own.type && this.onScreen(o)));
      } else {
        g.select([own]);
      }
      this.lastClick = { t: now, unit: own };
      return;
    }
    this.lastClick = { t: now, unit: null };
    const b = this.buildingAt(x, y);
    if (b && b.team === PLAYER && !g.selection.size) {
      g.selectBuilding(b);
      return;
    }
    if (g.selection.size || g.selectedBuilding) this.command(x, y);
  }

  /** On-screen arrow buttons: pan direction while held. */
  setPad(x: number, z: number) {
    this.pad.x = x;
    this.pad.z = z;
  }

  private onScreen(u: Unit): boolean {
    const p = this.overlay.unitScreenPos(u);
    return !!p && p.x >= 0 && p.y >= 0 && p.x <= this.canvas.clientWidth && p.y <= this.canvas.clientHeight;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const inside = this.game.units.filter((u) => {
      if (!u.alive || u.team !== PLAYER || u.vehicle) return false;
      const p = this.overlay.unitScreenPos(u);
      return !!p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    });
    if (inside.length || !shift) this.game.select(inside, shift);
  }

  /** Selected medics could treat this own unit (a wounded soldier on foot). */
  private canHeal(own: Unit): boolean {
    return !own.isVehicle && own.hp < own.maxHp && [...this.game.selection].some((u) => u.type === "medic" && u !== own);
  }

  private command(x: number, y: number) {
    const g = this.game;
    if (g.selection.size) {
      // soldiers onto an own unmanned jeep: one of them climbs aboard as the gunner
      const own = this.unitAt(x, y, "own");
      if (own && own.hasMg && !own.gunner && !g.selection.has(own)) {
        if (g.commandBoard(g.selection, own)) return;
      }
      // medics onto a wounded comrade; the rest of the selection moves along to him
      if (own && this.canHeal(own) && g.commandHeal(g.selection, own)) {
        const others = [...g.selection].filter((u) => u.type !== "medic");
        if (others.length) g.commandMove(others, { x: own.x, z: own.z }, false, false);
        return;
      }
      const enemy = this.unitAt(x, y, "enemy");
      if (enemy) return g.commandAttack(g.selection, enemy);
      const b = this.buildingAt(x, y);
      if (b && b.team !== PLAYER) return g.commandAttack(g.selection, b);
      const p = this.groundAt(x, y);
      if (p) g.commandMove(g.selection, p);
    } else if (g.selectedBuilding) {
      const p = this.groundAt(x, y);
      if (p) g.selectedBuilding.rally = g.nav.freePoint(p.x, p.z);
    }
  }

  /** Carries out the pending targeted action at the cursor; true if it was issued. */
  /** Starts (or ends) choosing a spot for a structure. */
  toggleBuild(type: "mgnest" | "bollard") {
    if (this.targeting === type) return this.setTargeting(null);
    if (this.game.credits[PLAYER] < UNITS[type].cost) {
      this.game.emit("noCredits", PLAYER);
      return;
    }
    this.setTargeting(type);
  }

  private confirmTarget(x: number, y: number): boolean {
    const g = this.game, m = g.commandos;
    if (isBuild(this.targeting)) {
      const at = this.groundAt(x, y);
      return !!at && !!g.placeStructure(this.targeting, PLAYER, at.x, at.z);
    }
    if (this.targeting === "artillery") {
      const at = this.groundAt(x, y);
      return !!at && g.orderArtillery(PLAYER, at.x, at.z);
    }
    if (!m) return false;
    if (this.targeting === "sniper") {
      const enemy = this.unitAt(x, y, "enemy");
      return !!enemy && m.snipe(enemy);
    }
    // charge: an enemy jeep under the cursor, otherwise an enemy outpost at the clicked spot
    const enemy = this.unitAt(x, y, "enemy");
    if (enemy?.isVehicle) return m.orderCharge(enemy);
    const at = this.groundAt(x, y);
    const post = at && m.outpostAt(at.x, at.z);
    return !!post && m.orderCharge(post);
  }

  setTargeting(mode: Targeting | null) {
    this.targeting = mode;
    if (!mode) this.overlay.targetPreview = null;
    if (!isBuild(mode)) this.overlay.buildPreview = null;
    this.onTargetingChange?.();
  }

  private updateCursor(x: number, y: number) {
    const g = this.game;
    if (this.targeting) {
      let kind: CursorKind = "artillery";
      if (isBuild(this.targeting)) {
        // footprint at the cursor: green where it may be placed (and can be paid), red otherwise
        const at = this.groundAt(x, y);
        const type = this.targeting;
        const pl = at && g.placement(type, PLAYER, at.x, at.z);
        this.overlay.buildPreview = at && pl ? { type, x: at.x, z: at.z, heading: pl.heading, ok: pl.ok && g.credits[PLAYER] >= UNITS[type].cost } : null;
        kind = "arrow";
      } else if (this.targeting === "artillery") {
        // preview of the impact area: red if the strike can be ordered there, grey if not
        const at = this.groundAt(x, y);
        this.overlay.targetPreview = at
          ? { x: at.x, z: at.z, r: ARTILLERY.spread, ok: (!g.canSee || g.canSee(at.x, at.z)) && g.artillery.canOrder(PLAYER) }
          : null;
      } else if (this.targeting === "sniper" && g.commandos) {
        // the rifle's reach around the agent
        const a = g.commandos.agent;
        this.overlay.targetPreview = { x: a.x, z: a.z, r: COMMANDOS.sniper.range, ok: g.commandos.sniperCooldown <= 0 };
        kind = this.unitAt(x, y, "enemy") ? "attack" : "arrow";
      } else {
        this.overlay.targetPreview = null;
        kind = "charge";
      }
      if (this.cursorKind !== kind) {
        this.cursorKind = kind;
        this.canvas.style.cursor = CURSORS[kind];
      }
      return;
    }
    const own = this.unitAt(x, y, "own");
    let kind: CursorKind = "arrow";
    if (this.unitAt(x, y, "enemy") || this.buildingAt(x, y)?.team === 1) kind = "attack";
    else if (g.selection.size && own?.hasMg && !own.gunner && own.buildT <= 0 && [...g.selection].some((u) => !u.isVehicle && u.armed)) kind = "board";
    else if (own && this.canHeal(own)) kind = "heal";
    else if (own) kind = "select";
    else if (g.selection.size) kind = "move";
    if (kind !== this.cursorKind) {
      this.cursorKind = kind;
      this.canvas.style.cursor = CURSORS[kind];
    }
  }

  /** Edge and keyboard scrolling; keeps the cursor in sync while units walk under a still mouse. */
  update(dt: number) {
    this.cursorT -= dt;
    if (this.cursorT <= 0 && this.inWindow && this.mouseX >= 0) {
      this.cursorT = 0.1;
      const r = this.canvas.getBoundingClientRect();
      const x = this.mouseX - r.left, y = this.mouseY - r.top;
      if (x >= 0 && y >= 0 && x <= r.width && y <= r.height) this.updateCursor(x, y);
    }
    let dx = 0, dz = 0;
    if (this.inWindow && this.mouseX >= 0) {
      if (this.mouseX < EDGE) dx = -1;
      else if (this.mouseX > window.innerWidth - EDGE) dx = 1;
      if (this.mouseY < EDGE) dz = 1;
      else if (this.mouseY > window.innerHeight - EDGE) dz = -1;
    }
    if (this.pad.x || this.pad.z) {
      dx = this.pad.x;
      dz = this.pad.z;
    }
    if (this.keys.has("ArrowLeft")) dx = -1;
    if (this.keys.has("ArrowRight")) dx = 1;
    if (this.keys.has("ArrowUp")) dz = 1;
    if (this.keys.has("ArrowDown")) dz = -1;
    if (dx || dz) {
      const l = Math.hypot(dx, dz);
      const speed = this.cam.distance * 1.15;
      this.cam.pan((dx / l) * speed * dt, (dz / l) * speed * dt);
    }
  }
}
