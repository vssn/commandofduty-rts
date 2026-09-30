import { FreeCamera, Tools, Vector3, type Engine, type Scene } from "@babylonjs/core";
import { ENEMY, PLAYER, type UnitType } from "../config";
import type { Game } from "../game/game";
import type { Unit } from "../game/unit";
import { toWorld } from "../world/layout";
import { Searchlight, type StreetLights } from "../world/lighting";

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
  night: { setNight: (on: boolean) => void; streetLights: StreetLights },
): Promise<{ conquest: string; skirmish: string; commandos: string }> {
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
  // player: two manned jeeps up front, a long firing line of riflemen, grenadiers and a medic behind
  const foe = place("rifleman", ENEMY, 2, 20, Math.PI);
  for (const [lx, lz, h] of [[-4, 5, 0.25], [6, 3.5, -0.15]] as const) {
    const jeep = place("jeep", PLAYER, lx, lz, h);
    game.board(place("rifleman", PLAYER, lx, lz - 2, 0), jeep);
    jeep.target = foe;
  }
  const line: [number, number, Unit["stance"], UnitType][] = [
    [-11, -1, "prone", "rifleman"], [-8, -2, "kneel", "rifleman"], [-5.5, -1.5, "stand", "grenadier"], [-3, -2.6, "prone", "rifleman"],
    [-0.5, -2, "kneel", "rifleman"], [2, -2.8, "stand", "rifleman"], [4.5, -1.8, "kneel", "grenadier"], [7, -2.5, "prone", "rifleman"],
    [9.5, -1.6, "kneel", "rifleman"], [12, -2.4, "stand", "rifleman"], [-6, -6, "kneel", "rifleman"], [1, -6.5, "stand", "rifleman"], [8, -6, "kneel", "rifleman"],
  ];
  for (const [lx, lz, st, type] of line) {
    const u = place(type, PLAYER, lx, lz, 0.1 + (Math.random() - 0.5) * 0.2, st);
    u.target = foe; // weapons shouldered
  }
  place("medic", PLAYER, -2, -5, 0.4, "kneel");
  // enemy: a line of soldiers and a jeep across the field
  const enemies: [number, number, Unit["stance"]][] = [[-9, 21, "kneel"], [-5, 22, "prone"], [-1, 20.5, "stand"], [5, 21.5, "kneel"], [9, 20, "prone"], [13, 22, "kneel"], [-12, 23, "stand"]];
  for (const [lx, lz, st] of enemies) place(lx === -1 ? "grenadier" : "rifleman", ENEMY, lx, lz, Math.PI, st).target = foe;
  place("jeep", ENEMY, 16, 25, Math.PI + 0.4);
  // let the poses settle (knees bent, prone, weapons up) without running the battle
  for (let i = 0; i < 12; i++) for (const u of temp) if (!u.vehicle) u.postMove(0.1, game);
  // an artillery barrage in different stages: an old smoke column, bursts in the enemy line, a fresh
  // fireball right in front of our own line
  const boom = (lx: number, lz: number, size: number, age: number) => {
    game.effects.explode(at.x + lx, at.z + lz, 0, 0.1, null, size);
    game.effects.update(age);
  };
  boom(-8, 26, 1.8, 1.4);
  boom(10, 24, 1.6, 0.5);
  boom(1, 19, 2.0, 0.25);
  boom(-3, 11, 1.7, 0.09);
  const skirmish = await shoot(
    new Vector3(at.x - 8, y(at.x, at.z) + 9.5, at.z - 19),
    new Vector3(at.x + 1, y(at.x, at.z + 8), at.z + 11),
    0.78,
  );

  // --- Commandos (at night): over the agent's shoulder towards a guarded watchtower, a searchlight
  // beam sweeping the ground just past him
  for (const u of temp) {
    u.view.dispose();
    u.ring.dispose();
    const i = game.units.indexOf(u);
    if (i >= 0) game.units.splice(i, 1);
  }
  temp.length = 0;
  game.effects.update(60);
  const tower = game.outposts.find((o) => o.kind === "tower") ?? game.outposts[0];
  const spot = (lx: number, lz: number) => ({ x: tower.x + lx, z: tower.z + lz });
  const put = (type: UnitType, team: 0 | 1, p: { x: number; z: number }, heading: number, stance: Unit["stance"] = "stand") => {
    const f = game.nav.freePoint(p.x, p.z, type === "jeep" ? 1 : 0);
    const u = game.spawnUnit(type, team, f.x, f.z);
    u.heading = u.turret = heading;
    u.stance = stance;
    temp.push(u);
    return u;
  };
  const guard = put("rifleman", ENEMY, spot(1.5, -2), 2.6);
  put("rifleman", ENEMY, spot(-2.5, 1), 0.6);
  put("jeep", ENEMY, spot(6, 3), 1.9);
  const agent = put("agent", PLAYER, spot(0, -15), 0, "kneel");
  agent.heading = Math.atan2(guard.x - agent.x, guard.z - agent.z);
  agent.target = guard;
  for (let i = 0; i < 12; i++) for (const u of temp) if (!u.vehicle) u.postMove(0.1, game);
  const fx = Math.sin(agent.heading), fz = Math.cos(agent.heading);
  // searchlight right of the tower; its beam crosses the picture and its spot lands in the grass
  // ahead of the agent, a little to his left - he is kneeling just outside it
  const rx = fz, rz = -fx; // agent's right
  const lampAt = game.nav.freePoint(guard.x + rx * 6 - fx * 1, guard.z + rz * 6 - fz * 1);
  const searchlight = new Searchlight(scene, game.terrain, game.shadows, lampAt.x, lampAt.z, 3.4);
  searchlight.aim(agent.x + fx * 6.5 - rx * 3, agent.z + fz * 6.5 - rz * 3);
  night.setNight(true);
  night.streetLights.setOn(true);
  scene.imageProcessingConfiguration.exposure = 1.35; // a touch brighter than in game, for the artwork
  // over-the-shoulder view: behind and right of the kneeling agent, looking past him at the tower
  const eye = { x: agent.x - fx * 4.2 + rx * 1.4, z: agent.z - fz * 4.2 + rz * 1.4 };
  const look = { x: agent.x + fx * 11, z: agent.z + fz * 11 };
  const commandos = await shoot(
    new Vector3(eye.x, agent.y + 3.6, eye.z),
    new Vector3(look.x, agent.y + 0.2, look.z),
    0.82,
  );
  night.setNight(false);
  night.streetLights.setOn(false);
  searchlight.dispose();

  // clean up: temporary units, the explosion and the camera
  for (const u of temp) {
    u.view.dispose();
    u.ring.dispose();
    const i = game.units.indexOf(u);
    if (i >= 0) game.units.splice(i, 1);
  }
  game.effects.update(60);
  cam.dispose();
  return { conquest, skirmish, commandos };
}
