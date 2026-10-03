import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import type { Terrain } from "../world/terrain";

/** Classic fixed-angle RTS camera looking north, with smoothed zoom. */
export class RtsCamera {
  readonly camera: FreeCamera;
  readonly focus = new Vector3();
  private dist = 78;
  private targetDist = 78;
  private readonly pitch = 0.98; // ~56° down

  constructor(scene: Scene, private readonly terrain: Terrain) {
    this.camera = new FreeCamera("rtsCam", new Vector3(0, 60, -40), scene);
    this.camera.inputs.clear();
    this.camera.fov = 0.8;
    this.camera.minZ = 1;
    this.camera.maxZ = 900;
  }

  /** Running fly-in at the start of a game (see flyIn). */
  private intro: { t: number; dur: number; fx: number; fz: number; tx: number; tz: number; fromDist: number; toDist: number } | null = null;

  get distance() {
    return this.dist;
  }

  /**
   * Opening shot of a game: the camera starts higher up and a little further back and glides in
   * onto (x, z), braking smoothly at the end. Any zoom or scroll by the player takes over at once.
   */
  flyIn(x: number, z: number, dur = 2.4) {
    this.jumpTo(x, z);
    const tx = this.focus.x, tz = this.focus.z, toDist = this.targetDist;
    this.jumpTo(tx, tz - 28);
    this.intro = { t: 0, dur, fx: this.focus.x, fz: this.focus.z, tx, tz, fromDist: toDist * 2.1, toDist };
    this.dist = toDist * 2.1;
  }

  zoom(steps: number) {
    if (this.intro) {
      // the player zooms during the fly-in: stop it where it is
      this.targetDist = this.dist;
      this.intro = null;
    }
    this.targetDist = Math.min(125, Math.max(32, this.targetDist * (1 + steps * 0.12)));
  }

  pan(dx: number, dz: number) {
    this.jumpTo(this.focus.x + dx, this.focus.z + dz, false);
  }

  jumpTo(x: number, z: number, snapHeight = true) {
    if (this.intro) {
      this.targetDist = this.dist;
      this.intro = null;
    }
    const lim = MAP_HALF - 6;
    this.focus.x = Math.min(Math.max(x, -lim), lim);
    this.focus.z = Math.min(Math.max(z, -lim - 10), lim - 2);
    if (snapHeight) this.focus.y = this.terrain.heightAt(this.focus.x, this.focus.z);
  }

  update(dt: number) {
    const intro = this.intro;
    if (intro) {
      intro.t += dt;
      const u = Math.min(1, intro.t / intro.dur);
      const k = 1 - Math.pow(1 - u, 3); // fast at first, braking towards the end
      this.focus.x = intro.fx + (intro.tx - intro.fx) * k;
      this.focus.z = intro.fz + (intro.tz - intro.fz) * k;
      this.dist = intro.fromDist + (intro.toDist - intro.fromDist) * k;
      if (u >= 1) this.intro = null;
    } else {
      this.dist += (this.targetDist - this.dist) * Math.min(1, dt * 8);
    }
    const h = this.terrain.heightAt(this.focus.x, this.focus.z);
    this.focus.y += (h - this.focus.y) * Math.min(1, dt * 3);
    const p = this.pitch;
    this.camera.position.set(this.focus.x, this.focus.y + Math.sin(p) * this.dist, this.focus.z - Math.cos(p) * this.dist);
    this.camera.setTarget(this.focus);
  }
}
