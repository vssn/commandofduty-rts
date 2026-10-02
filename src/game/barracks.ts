import type { Mesh } from "@babylonjs/core";
import { BARRACKS_HP, type Team } from "../config";
import { toWorld, type V2 } from "../world/layout";

/**
 * Demolition of a destroyed barracks: [seconds after destruction, local x, local z, blast size].
 * A chain of blasts tears through the building, the big one in the middle brings it down.
 */
const BLASTS: [number, number, number, number][] = [
  [0, 0, 0, 2.2],
  [0.3, 3.5, 2.5, 1.8],
  [0.55, -3.5, -2.5, 1.9],
  [0.8, 0, 0, 3.2],
  [1.05, -4, 3, 1.7],
  [1.3, 4, -3, 2.0],
];
/** When the building caves in (seconds after destruction). */
const COLLAPSE = 0.8;
import type { Game } from "./game";
import { Production } from "./production";
import type { Target } from "./unit";

export class Barracks implements Target {
  readonly kind = "building" as const;
  hp = BARRACKS_HP;
  maxHp = BARRACKS_HP;
  alive = true;
  radius = 6.5;
  aimY = 3;
  y: number;
  selected = false;
  readonly production = new Production(["rifleman", "grenadier"]);
  readonly spawn: V2;
  rally: V2;
  private readonly startRally: V2;
  /** Seconds since the barracks was destroyed. */
  private sinkT = 0;
  private blasts = 0;

  constructor(
    readonly team: Team,
    readonly x: number,
    readonly z: number,
    readonly rot: number,
    readonly mesh: Mesh,
    readonly ring: Mesh,
    y: number,
  ) {
    this.y = y;
    mesh.position.set(x, y, z);
    mesh.rotation.y = rot;
    ring.position.set(x, y + 0.7, z);
    ring.isVisible = false;
    this.spawn = toWorld(x, z, rot, 0, 7.5);
    this.rally = toWorld(x, z, rot, 0, 16);
    this.startRally = this.rally;
  }

  /** Back to the start of a game: intact, idle, default rally point. */
  reset() {
    this.hp = this.maxHp;
    this.alive = true;
    this.selected = false;
    this.sinkT = 0;
    this.production.clear();
    this.rally = this.startRally;
    this.blasts = 0;
    this.mesh.setEnabled(true);
    this.ring.setEnabled(true);
    this.mesh.position.y = this.y;
    this.mesh.rotation.set(0, this.rot, 0);
    this.mesh.scaling.setAll(1);
    this.ring.isVisible = false;
  }

  update(dt: number, g: Game) {
    if (!this.alive) {
      // blown up: a chain of explosions, the walls shake, then the building caves in to a heap of rubble
      this.sinkT += dt;
      const t = this.sinkT;
      while (this.blasts < BLASTS.length && t >= BLASTS[this.blasts][0]) {
        const [, lx, lz, size] = BLASTS[this.blasts++];
        const p = toWorld(this.x, this.z, this.rot, lx, lz);
        g.effects.explode(p.x, p.z, 0, 0.1, null, size);
      }
      if (t < COLLAPSE) {
        this.mesh.rotation.z = Math.sin(t * 40) * 0.015 * (t / COLLAPSE);
        this.mesh.rotation.x = Math.cos(t * 33) * 0.01 * (t / COLLAPSE);
      } else {
        const k = Math.min(1, (t - COLLAPSE) / 0.45);
        const e = k * k;
        this.mesh.scaling.set(1 + e * 0.12, 1 - e * 0.8, 1 + e * 0.12);
        this.mesh.rotation.set(e * 0.05, this.rot, e * -0.07);
        this.mesh.position.y = this.y - e * 0.25;
      }
      return;
    }
    this.ring.isVisible = this.selected;
    this.production.update(dt, g, this.team, this.spawn, this.rally);
  }

  destroy() {
    this.alive = false;
    this.selected = false;
    this.ring.isVisible = false;
    this.production.clear();
  }
}
