import { MeshBuilder, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import { ARTILLERY, type Team } from "../config";
import { createRing } from "../world/models";
import type { Game } from "./game";

interface Shell { x: number; z: number; t: number; mesh: InstancedMesh | null }
interface Strike { team: Team; x: number; z: number; t: number; shells: Shell[]; marker: InstancedMesh }

/** Seconds a shell is visible falling before it hits. */
const FALL = 0.55;
const FALL_HEIGHT = 45;

/**
 * Artillery strikes bought with credits: after a short delay a salvo of shells comes down around
 * the target point and every impact is a large explosion (friendly fire included).
 */
export class Artillery {
  private readonly strikes: Strike[] = [];
  private readonly cooldown: [number, number] = [0, 0];
  private readonly shellTpl: Mesh;
  private readonly markerTpl: Mesh;
  /** Called when a strike has been ordered (sound: incoming whistle). */
  onOrder: ((team: Team, x: number, z: number) => void) | null = null;

  constructor(scene: Scene, private readonly game: Game) {
    this.shellTpl = MeshBuilder.CreateCylinder("shell", { height: 1.4, diameterTop: 0.05, diameterBottom: 0.32, tessellation: 6 }, scene);
    this.shellTpl.rotation.x = Math.PI; // nose down
    this.shellTpl.bakeCurrentTransformIntoVertices();
    this.shellTpl.isVisible = false;
    this.shellTpl.isPickable = false;
    this.markerTpl = createRing(scene, "artilleryMarker", ARTILLERY.spread * 2, 0.22, [1, 0.28, 0.2]);
    this.markerTpl.isVisible = false;
  }

  /** Seconds until `team` may order again (0 = ready). */
  cooldownOf(team: Team): number {
    return Math.max(0, this.cooldown[team]);
  }

  canOrder(team: Team): boolean {
    return this.cooldownOf(team) <= 0 && this.game.credits[team] >= ARTILLERY.cost;
  }

  /** Orders a strike on (x, z); the caller checks line of sight. Returns false if not possible. */
  order(team: Team, x: number, z: number): boolean {
    if (!this.canOrder(team)) return false;
    this.game.credits[team] -= ARTILLERY.cost;
    this.cooldown[team] = ARTILLERY.cooldown;
    const shells: Shell[] = [];
    for (let i = 0; i < ARTILLERY.shells; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * ARTILLERY.spread;
      shells.push({ x: x + Math.cos(a) * r, z: z + Math.sin(a) * r, t: -(ARTILLERY.delay + i * ARTILLERY.interval * (0.7 + Math.random() * 0.6)), mesh: null });
    }
    const marker = this.markerTpl.createInstance("strikeMarker");
    marker.position.set(x, this.game.terrain.heightAt(x, z) + 0.35, z);
    this.strikes.push({ team, x, z, t: 0, shells, marker });
    this.onOrder?.(team, x, z);
    return true;
  }

  /** Strikes currently on their way (for the overlay countdown). */
  get active(): readonly { team: Team; x: number; z: number; t: number }[] {
    return this.strikes;
  }

  update(dt: number) {
    for (const team of [0, 1] as Team[]) this.cooldown[team] -= dt;
    const g = this.game;
    for (let s = this.strikes.length - 1; s >= 0; s--) {
      const strike = this.strikes[s];
      strike.t += dt;
      // target marker pulses until the salvo is over
      const pulse = 1 + Math.sin(strike.t * 9) * 0.04;
      strike.marker.scaling.set(pulse, 1, pulse);
      for (let i = strike.shells.length - 1; i >= 0; i--) {
        const sh = strike.shells[i];
        sh.t += dt;
        if (sh.t < -FALL) continue;
        const ground = g.terrain.heightAt(sh.x, sh.z);
        if (!sh.mesh) sh.mesh = this.shellTpl.createInstance("shell");
        const k = Math.min(1, (sh.t + FALL) / FALL);
        sh.mesh.position.set(sh.x, ground + FALL_HEIGHT * (1 - k * k), sh.z);
        if (sh.t >= 0) {
          sh.mesh.dispose();
          strike.shells.splice(i, 1);
          g.effects.explode(sh.x, sh.z, ARTILLERY.damage, ARTILLERY.blastRadius, null, 1.5);
        }
      }
      if (!strike.shells.length) {
        strike.marker.dispose();
        this.strikes.splice(s, 1);
      }
    }
  }
}
