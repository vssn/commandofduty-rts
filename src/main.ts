import { Engine, Scene } from "@babylonjs/core";
import "./style.css";
import { MAP_HALF } from "./config";
import { AudioSystem } from "./audio/audio";
import { EnemyAI } from "./game/ai";
import { FogOfWar } from "./game/fog";
import { CoverMap } from "./game/cover";
import { Game } from "./game/game";
import { NavGrid } from "./game/nav";
import { installDefaultCursor } from "./ui/cursors";
import { Hud } from "./ui/hud";
import { renderPortraits } from "./ui/portraits";
import { InputController } from "./ui/input";
import { Minimap } from "./ui/minimap";
import { Overlay } from "./ui/overlay";
import { RtsCamera } from "./ui/rtsCamera";
import { createCrops } from "./world/crops";
import { COMPOUND } from "./world/fortification";
import { createHedges } from "./world/hedges";
import { createEnvironment } from "./world/environment";
import { MapLayout, toWorld } from "./world/layout";
import { FogRenderer } from "./world/fogRender";
import { createHouses, createVegetation } from "./world/scenery";
import { Terrain } from "./world/terrain";

installDefaultCursor();
const canvas = document.getElementById("game") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: true }, true);
const scene = new Scene(engine);
scene.detachControl(); // input is handled by InputController; avoids picking on every pointer move
scene.skipPointerMovePicking = true;

const env = createEnvironment(scene);
const layout = new MapLayout();
const terrain = new Terrain(scene, layout);
const nav = new NavGrid();
const hedges = createHedges(scene, layout, terrain, env.shadows);
createCrops(scene, layout, terrain);
createHouses(scene, layout, terrain, env.shadows, nav);
const trees = createVegetation(scene, layout, terrain, env.shadows);
// trees and hedges are solid: nobody walks or drives through them. The tree radius covers the low
// canopy, so soldiers don't poke their heads through the foliage; jeeps can't enter the woods at all.
for (const t of trees) if (Math.abs(t.x) < MAP_HALF && Math.abs(t.z) < MAP_HALF) nav.blockCircle(t.x, t.z, 0.9);
for (const h of hedges) nav.blockRect(h.x, h.z, h.hw, h.hd, h.rot, 0);
const game = new Game(scene, terrain, nav, layout, env.shadows);
game.cover = new CoverMap(
  layout,
  trees,
  hedges,
  // the sandbag walls of the barracks compound give cover on both sides
  [...game.buildings.map((b) => ({ x: b.x, z: b.z, hw: COMPOUND.hw, hd: COMPOUND.hd, rot: b.rot })), ...layout.outposts.map((o) => ({ x: o.x, z: o.z, hw: 2.5, hd: 2.5, rot: o.rot }))],
);

// ------------------------------------------------------------------ fog of war
// trees and buildings block the view; hedges, fields and sandbags can be looked over
const fog = new FogOfWar(game);
for (const t of trees) if (Math.abs(t.x) < MAP_HALF && Math.abs(t.z) < MAP_HALF) fog.blockCircle(t.x, t.z, 1.3);
for (const h of layout.houses) {
  fog.blockRect(h.x, h.z, h.w / 2, h.d / 2, h.rot);
  if (h.church) {
    const tp = toWorld(h.x, h.z, h.rot, 0, h.d / 2 + 1.6);
    fog.blockRect(tp.x, tp.z, 1.7, 1.7, h.rot);
  }
}
for (const b of game.buildings) fog.blockRect(b.x, b.z, 6, 4, b.rot);
for (const o of layout.outposts) if (o.kind === "workshop") fog.blockRect(o.x, o.z, 3.5, 3, o.rot);
game.canSee = (x, z) => fog.isVisible(x, z);

const cam = new RtsCamera(scene, terrain);
scene.activeCamera = cam.camera;
cam.jumpTo(layout.playerBase.x, layout.playerBase.z + 14);

const fogRender = new FogRenderer(scene, cam.camera, fog);
fogRender.strength = 0; // no fog over the menu fly-over
const overlay = new Overlay(document.getElementById("overlay") as HTMLCanvasElement, engine, cam.camera);
const input = new InputController(canvas, scene, game, cam, overlay);
const minimap = new Minimap(document.getElementById("minimap") as HTMLCanvasElement, terrain, layout, trees, game, cam, scene, engine);
minimap.fog = fog;
const audio = new AudioSystem(game, cam.focus);
const hud = new Hud(game, audio);
renderPortraits(engine).then((images) => hud.setPortraits(images), (e) => console.warn("portraits failed", e));
const ai = new EnemyAI(game);

// ------------------------------------------------------------------ main menu
// While the menu is open the battle is paused and the camera drifts slowly over the map.
let inMenu = true;
let menuT = 0;
const menuSound = document.getElementById("menu-sound")!;
const syncMenuSound = () => (menuSound.textContent = `Ton: ${audio.musicOn || audio.sfxOn ? "an" : "aus"}`);
syncMenuSound();
menuSound.addEventListener("click", () => {
  const on = !(audio.musicOn || audio.sfxOn);
  audio.setMusic(on);
  audio.setSfx(on);
  syncMenuSound();
});
document.getElementById("menu-controls")!.addEventListener("click", () => {
  const help = document.getElementById("menu-help")!;
  help.hidden = !help.hidden;
});
document.getElementById("menu-start")!.addEventListener("click", () => {
  inMenu = false;
  document.body.classList.remove("in-menu");
  // the sidebar is back, so the 3D view got narrower
  engine.resize();
  overlay.resize();
  cam.jumpTo(layout.playerBase.x, layout.playerBase.z + 14);
  input.enabled = hud.enabled = true;
  fogRender.strength = 1;
  hud.toast("Mission beginnt");
  audio.announce("Mission beginnt", true);
});

let dt = 0;
scene.onBeforeRenderObservable.add(() => {
  dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  if (inMenu) {
    // cinematic fly-over along a slow loop across the battlefield
    menuT += dt;
    cam.jumpTo(Math.sin(menuT * 0.035) * 60 - 10, Math.cos(menuT * 0.024) * 55 - 5);
    cam.update(dt);
    env.followFocus(cam.focus);
    return;
  }
  input.update(dt);
  cam.update(dt);
  env.followFocus(cam.focus);
  game.update(dt);
  ai.update(dt);
  fog.update(dt);
  fogRender.update();
});
scene.onAfterRenderObservable.add(() => {
  if (inMenu) return;
  overlay.capture();
  overlay.draw(game);
  minimap.draw();
  hud.update(dt);
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => {
  engine.resize();
  overlay.resize();
});
document.getElementById("loading")?.remove();

// handy for debugging in the console
Object.assign(window, { game, scene, cam, audio, ai });
