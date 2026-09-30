import type { Mesh } from "@babylonjs/core";
import { BARRACKS_HP, type Team } from "../config";
import { toWorld, type V2 } from "../world/layout";
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
  private sinkT = 0;

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
    this.mesh.setEnabled(true);
    this.mesh.position.y = this.y;
    this.mesh.rotation.z = 0;
    this.ring.isVisible = false;
  }

  update(dt: number, g: Game) {
    if (!this.alive) {
      this.sinkT += dt;
      this.mesh.position.y = this.y - this.sinkT * 1.6;
      this.mesh.rotation.z = Math.sin(this.sinkT * 7) * 0.02;
      if (this.sinkT > 5) this.mesh.setEnabled(false);
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
