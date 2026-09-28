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

  get distance() {
    return this.dist;
  }

  zoom(steps: number) {
    this.targetDist = Math.min(125, Math.max(32, this.targetDist * (1 + steps * 0.12)));
  }

  pan(dx: number, dz: number) {
    this.jumpTo(this.focus.x + dx, this.focus.z + dz, false);
  }

  jumpTo(x: number, z: number, snapHeight = true) {
    const lim = MAP_HALF - 6;
    this.focus.x = Math.min(Math.max(x, -lim), lim);
    this.focus.z = Math.min(Math.max(z, -lim - 10), lim - 2);
    if (snapHeight) this.focus.y = this.terrain.heightAt(this.focus.x, this.focus.z);
  }

  update(dt: number) {
    this.dist += (this.targetDist - this.dist) * Math.min(1, dt * 8);
    const h = this.terrain.heightAt(this.focus.x, this.focus.z);
    this.focus.y += (h - this.focus.y) * Math.min(1, dt * 3);
    const p = this.pitch;
    this.camera.position.set(this.focus.x, this.focus.y + Math.sin(p) * this.dist, this.focus.z - Math.cos(p) * this.dist);
    this.camera.setTarget(this.focus);
  }
}
