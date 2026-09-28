import { FreeCamera, Tools, Vector3, type Engine, type Scene } from "@babylonjs/core";
import { ENEMY, PLAYER, type UnitType } from "../config";
import type { Game } from "../game/game";
import type { Unit } from "../game/unit";
import { toWorld } from "../world/layout";

const SIZE = { width: 640, height: 400 };

/**
 * Renders the two artworks of the mode selection from the live battlefield (before the game starts):
 * "Eroberung" shows the player's sandbagged barracks with its garrison, "Gefecht" a staged fire fight
 * with jeeps, kneeling soldiers and a shell exploding. Temporary units are removed afterwards.
 */
export async function renderModeArt(
  engine: Engine,
  scene: Scene,
  game: Game,
  followSun: (focus: Vector3) => void,
): Promise<{ conquest: string; skirmish: string }> {
  const cam = new FreeCamera("modeArtCam", Vector3.Zero(), scene);
  cam.minZ = 0.5;
  cam.maxZ = 600;
  const shoot = async (pos: Vector3, target: Vector3, fov: number) => {
    cam.position.copyFrom(pos);
    cam.setTarget(target);
    cam.fov = fov;
    followSun(target);
    await scene.whenReadyAsync();
    return Tools.CreateScreenshotUsingRenderTargetAsync(engine, cam, SIZE, "image/jpeg", 4);
  };
  const y = (x: number, z: number) => game.terrain.heightAt(x, z);

  // --- Eroberung: the fortified barracks from the front-left, garrison in front of the gate
  const b = game.playerBarracks;
  const front = toWorld(b.x, b.z, b.rot, 0, 6);
  const conquest = await shoot(
    new Vector3(b.x - 20, y(b.x, b.z) + 17, b.z + 28),
    new Vector3(front.x, y(front.x, front.z) + 1, front.z),
    0.72,
  );

  // --- Gefecht: a staged skirmish on open ground in front of the base
  const temp: Unit[] = [];
  const at = toWorld(b.x, b.z, b.rot, 6, 44);
  const place = (type: UnitType, team: 0 | 1, lx: number, lz: number, heading: number, stance: Unit["stance"] = "stand") => {
    const p = game.nav.freePoint(at.x + lx, at.z + lz, type === "jeep" ? 1 : 0);
    const u = game.spawnUnit(type, team, p.x, p.z);
    u.heading = u.turret = heading;
    u.stance = stance;
    temp.push(u);
    return u;
  };
  const jeepA = place("jeep", PLAYER, -3, 4, 0.25);
  const gunner = place("rifleman", PLAYER, -3, 2, 0);
  game.board(gunner, jeepA);
  place("jeep", PLAYER, 5, 1, -0.2);
  const foe = place("rifleman", ENEMY, 2, 18, Math.PI);
  for (const [lx, lz, s] of [[-7, -2, "kneel"], [-4.5, -3, "prone"], [-1, -2.5, "kneel"], [2.5, -3.2, "stand"], [6, -2.4, "kneel"], [9, -3, "prone"]] as const) {
    const u = place(lx === -1 ? "grenadier" : "rifleman", PLAYER, lx, lz, 0.1, s);
    u.target = foe; // weapons shouldered
  }
  jeepA.target = foe;
  // let the poses settle (knees bent, prone, weapons up) without running the battle
  for (let i = 0; i < 12; i++) for (const u of temp) if (!u.vehicle) u.postMove(0.1, game);
  game.effects.explode(at.x + 1, at.z + 13, 0, 0.1, null, 1.6);
  game.effects.update(0.12);
  const skirmish = await shoot(
    new Vector3(at.x - 6, y(at.x, at.z) + 5, at.z - 10),
    new Vector3(at.x + 1, y(at.x, at.z + 5) + 1.4, at.z + 6),
    0.72,
  );

  // clean up: temporary units, the explosion and the camera
  for (const u of temp) {
    u.view.dispose();
    u.ring.dispose();
    const i = game.units.indexOf(u);
    if (i >= 0) game.units.splice(i, 1);
  }
  game.effects.update(60);
  cam.dispose();
  return { conquest, skirmish };
}
