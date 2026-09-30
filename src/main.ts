import { Engine, Scene } from "@babylonjs/core";
import "./style.css";
import { COMMANDOS, MAP_HALF, type GameMode } from "./config";
import { AudioSystem } from "./audio/audio";
import { EnemyAI } from "./game/ai";
import { CommandosMission } from "./game/commandos";
import { FogOfWar } from "./game/fog";
import { CoverMap } from "./game/cover";
import { Game } from "./game/game";
import { NavGrid } from "./game/nav";
import { installDefaultCursor } from "./ui/cursors";
import { Hud } from "./ui/hud";
import { renderModeArt } from "./ui/modeArt";
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
import { createStreetLights } from "./world/lighting";
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
// street lamps stand in every mode; they are only switched on for the night mission
const streetLights = createStreetLights(scene, layout, terrain, env.shadows, nav);
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
// (with their heights: from high ground one can look over them)
for (const t of trees) if (Math.abs(t.x) < MAP_HALF && Math.abs(t.z) < MAP_HALF) fog.blockCircle(t.x, t.z, 1.3, t.conifer ? 7 : 6);
for (const h of layout.houses) {
  fog.blockRect(h.x, h.z, h.w / 2, h.d / 2, h.rot, h.h + h.roofH);
  if (h.church) {
    const tp = toWorld(h.x, h.z, h.rot, 0, h.d / 2 + 1.6);
    fog.blockRect(tp.x, tp.z, 1.7, 1.7, h.rot, 18);
  }
}
for (const b of game.buildings) fog.blockRect(b.x, b.z, 6, 4, b.rot, 7);
for (const o of layout.outposts) if (o.kind === "workshop") fog.blockRect(o.x, o.z, 3.5, 3, o.rot, 5.3);
game.sightBonusOf = (u) => fog.sightBonus(u);
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
hud.locate = (o) => {
  const p = overlay.project(o.x, o.y + 4, o.z);
  if (!p) return null;
  // off-screen outposts: fly towards the edge of the view in their direction
  const r = overlay.canvas.getBoundingClientRect();
  return { x: r.left + Math.min(Math.max(p.x, 0), r.width), y: r.top + Math.min(Math.max(p.y, 0), r.height) };
};
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
hud.bindArtillery(input);
hud.bindBuild(input);
hud.bindCommandos(input);

// ------------------------------------------------------------------ touch controls
// Phones have no right mouse button and no hover: taps become commands (see InputController.tap),
// arrow buttons pan the map, and stop / deselect / cancel get their own buttons.
const enableTouchUi = () => document.body.classList.add("touch-ui");
if (window.matchMedia("(pointer: coarse)").matches) enableTouchUi();
window.addEventListener("pointerdown", (e) => e.pointerType === "touch" && enableTouchUi(), { passive: true });
for (const btn of document.querySelectorAll<HTMLButtonElement>("#touch-ui .pad")) {
  const [x, z] = btn.dataset.pan!.split(",").map(Number);
  const release = () => {
    input.setPad(0, 0);
    btn.classList.remove("held");
  };
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    input.setPad(x, z);
    try {
      btn.setPointerCapture(e.pointerId); // keep receiving "up" even if the finger slides off
    } catch {
      /* not capturable (e.g. synthetic event) - pointerup/cancel still release */
    }
    btn.classList.add("held");
  });
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
}
const tapBtn = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener("click", fn);
tapBtn("t-zoom-in", () => cam.zoom(-1.5));
tapBtn("t-zoom-out", () => cam.zoom(1.5));
tapBtn("t-stop", () => game.commandStop(game.selection));
tapBtn("t-deselect", () => {
  input.setTargeting(null);
  game.clearSelection();
});
tapBtn("t-cancel", () => input.setTargeting(null));
const cancelBtn = document.getElementById("t-cancel")!;
const prevTargeting = input.onTargetingChange;
input.onTargetingChange = () => {
  prevTargeting?.();
  cancelBtn.hidden = !input.targeting;
};

/** Leaves the menu and starts a battle in the chosen mode. */
function startGame(mode: GameMode) {
  audio.setTheme(mode === "base" ? "conquest" : mode);
  if (mode === "skirmish") {
    game.setupSkirmish();
    document.body.classList.add("mode-skirmish");
  } else if (mode === "commandos") {
    const mission = new CommandosMission(game);
    mission.setup();
    // the mission plays at night: moonlight, street lamps on, searchlights at the outposts
    env.setNight();
    streetLights.setOn(true);
    mission.streetPools = streetLights.pools;
    game.commandos = mission;
    const b = game.playerBarracks; // removed in this mode: nothing blocks the view there any more
    fog.clearRect(b.x, b.z, 7, 5, b.rot);
    document.body.classList.add("mode-commandos");
  }
  inMenu = false;
  document.body.classList.remove("in-menu", "menu-choose");
  // the sidebar is back, so the 3D view got narrower
  engine.resize();
  overlay.resize();
  if (game.commandos) {
    const a = game.commandos.agent;
    cam.jumpTo(a.x, a.z + 6);
  } else {
    cam.jumpTo(layout.playerBase.x, layout.playerBase.z + 14);
  }
  input.enabled = hud.enabled = true;
  fogRender.strength = 1;
  const intro = {
    base: ["Mission beginnt", "Mission beginnt"],
    skirmish: ["Gefecht beginnt – kein Nachschub", "Gefecht beginnt"],
    commandos: [`Sprenge ${COMMANDOS.targets} feindliche Stellungen – bleib unentdeckt`, "Agent im Einsatz"],
  }[mode];
  hud.toast(intro[0]);
  audio.announce(intro[1], true);
}
// "Neues Spiel" opens the mode selection: two large cards, "Eroberung" (base building) and "Gefecht"
const menuMain = document.getElementById("menu-main")!, menuModes = document.getElementById("menu-modes")!;
const showModes = (on: boolean) => {
  menuMain.hidden = on;
  menuModes.hidden = !on;
  document.body.classList.toggle("menu-choose", on);
  if (on) document.getElementById("menu-help")!.hidden = true;
};
document.getElementById("menu-new")!.addEventListener("click", () => showModes(true));
document.getElementById("menu-back")!.addEventListener("click", () => showModes(false));
document.getElementById("mode-conquest")!.addEventListener("click", () => startGame("base"));
document.getElementById("mode-skirmish")!.addEventListener("click", () => startGame("skirmish"));
document.getElementById("mode-commandos")!.addEventListener("click", () => startGame("commandos"));
// while the artwork renders, the fly-over must not move the sun (the shadow frustum follows it)
let renderingArt = true;
renderModeArt(engine, scene, game, env.followFocus, { setNight: env.setNight, streetLights }).finally(() => (renderingArt = false)).then(
  (art) => {
    (document.getElementById("mode-img-conquest") as HTMLImageElement).src = art.conquest;
    (document.getElementById("mode-img-skirmish") as HTMLImageElement).src = art.skirmish;
    (document.getElementById("mode-img-commandos") as HTMLImageElement).src = art.commandos;
  },
  (e) => console.warn("mode art failed", e),
);

let dt = 0;
scene.onBeforeRenderObservable.add(() => {
  dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  if (inMenu) {
    // cinematic fly-over along a slow loop across the battlefield
    menuT += dt;
    cam.jumpTo(Math.sin(menuT * 0.035) * 60 - 10, Math.cos(menuT * 0.024) * 55 - 5);
    cam.update(dt);
    if (!renderingArt) env.followFocus(cam.focus);
    return;
  }
  input.update(dt);
  cam.update(dt);
  env.followFocus(cam.focus);
  game.update(dt);
  if (game.commandos) game.commandos.update(dt);
  else ai.update(dt);
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
Object.assign(window, { game, scene, cam, audio, ai, fog });
