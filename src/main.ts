import { Engine, Scene } from "@babylonjs/core";
import "./style.css";
import { COMMANDOS, ENEMY, MAP_HALF, PLAYER, type GameMode } from "./config";
import { AudioSystem, MUSIC_LEVELS, VOLUME_LEVELS } from "./audio/audio";
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
import { createProps } from "./world/props";
import { Birds } from "./world/birds";
import { createDirtTracks } from "./world/dirtTracks";
import { MuzzleFlashes } from "./game/muzzleFlash";
import { FogRenderer } from "./world/fogRender";
import { PbrMode } from "./world/pbr";
import { RealisticTerrain } from "./world/terrainPbr";
import { RealisticCrops, RealisticHedges, RealisticTrees } from "./world/floraPbr";
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
const realHedges = new RealisticHedges(scene, env.shadows);
const hedges = createHedges(scene, layout, terrain, env.shadows, realHedges);
// the realistic graphics mode has its own field plants and trees, placed exactly like the classic ones
const realCrops = new RealisticCrops(scene, env.shadows);
createCrops(scene, layout, terrain, realCrops);
createHouses(scene, layout, terrain, env.shadows, nav);
const realTrees = new RealisticTrees(scene, env.shadows);
const trees = createVegetation(scene, layout, terrain, env.shadows, realTrees);
// street lamps stand in every mode; they are only switched on for the night mission
const streetLights = createStreetLights(scene, layout, terrain, env.shadows, nav);
// trees and hedges are solid: nobody walks or drives through them. The tree radius covers the low
// canopy, so soldiers don't poke their heads through the foliage; jeeps can't enter the woods at all.
for (const t of trees) if (Math.abs(t.x) < MAP_HALF && Math.abs(t.z) < MAP_HALF) nav.blockCircle(t.x, t.z, 0.9);
for (const h of hedges) nav.blockRect(h.x, h.z, h.hw, h.hd, h.rot, 0);
// containers, cabins, cars, garages, fences and farm machinery (placed on ground that is still free;
// the solid ones block movement)
const props = createProps(scene, layout, terrain, env.shadows, nav);
const birds = new Birds(scene, terrain, trees);
// farm tracks with ruts, a grassy middle strip and puddles
const tracks = createDirtTracks(scene, layout, terrain, nav);
// muzzle flashes that light up the surroundings in the night mission
const muzzle = new MuzzleFlashes(scene, terrain);
const game = new Game(scene, terrain, nav, layout, env.shadows);
// fire fights in the fog stay hidden, as for the tracers
game.onMuzzle = (x, y, z, kind) => (!game.canSee || game.canSee(x, z)) && muzzle.flash(x, y, z, kind);
game.cover = new CoverMap(
  layout,
  trees,
  hedges,
  // the sandbag walls of the barracks compound give cover on both sides
  [
    ...game.buildings.map((b) => ({ x: b.x, z: b.z, hw: COMPOUND.hw, hd: COMPOUND.hd, rot: b.rot })),
    ...layout.outposts.map((o) => ({ x: o.x, z: o.z, hw: 2.5, hd: 2.5, rot: o.rot })),
    // containers, cabins, vehicles and machinery give cover too
    ...props.filter((p) => p.height >= 1.4),
  ],
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
for (const o of layout.outposts) if (o.kind === "radar") fog.blockCircle(o.x, o.z, 2.6, 7.4); // the radome
for (const p of props) if (p.height >= 2.4) fog.blockRect(p.x, p.z, p.hw, p.hd, p.rot, p.height); // containers, garages
game.sightBonusOf = (u) => fog.sightBonus(u);
game.canSee = (x, z) => fog.isVisible(x, z);

const cam = new RtsCamera(scene, terrain);
scene.activeCamera = cam.camera;
cam.jumpTo(layout.playerBase.x, layout.playerBase.z + 14);

const fogRender = new FogRenderer(scene, cam.camera, fog, () => env.haze, env.sun.direction, () => cam.distance);
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
let ai = new EnemyAI(game);

// ------------------------------------------------------------------ background battle
// Behind the main menu both sides are run by the AI, silently, like a background video. It
// restarts when one side has won; choosing a mode resets the battlefield to the opening position.
let menuAis = [new EnemyAI(game, PLAYER, 25), new EnemyAI(game, ENEMY, 25)];
let menuRestartT = 0;
const startBackgroundBattle = () => {
  game.reset();
  game.credits[PLAYER] = game.credits[ENEMY] = 2500; // more troops, livelier fighting
  menuAis = [new EnemyAI(game, PLAYER, 25), new EnemyAI(game, ENEMY, 25)];
};
audio.quiet = true;
// the fog of war only exists for the player; in the menu both sides see everything
game.canSee = null;

// ------------------------------------------------------------------ main menu
// While the menu is open the battle is paused and the camera drifts slowly over the map.
let inMenu = true;
let menuT = 0;
// volume sliders (main menu and pause menu): music, effects and announcer
const volumeSliders = (pre: string) => ["menu", "pause"].map((m) => document.getElementById(`${m}-${pre}`) as HTMLInputElement);
const setFill = (sl: HTMLInputElement, level: number, levels: number) => {
  sl.value = String(level);
  sl.style.setProperty("--fill", `${(level / (levels - 1)) * 100}%`);
};
const VOLUME_CONTROLS = [
  { sliders: volumeSliders("music"), attr: "data-music-value", levels: MUSIC_LEVELS, get: () => audio.musicLevel, set: (v: number) => audio.setMusicLevel(v) },
  { sliders: volumeSliders("sfx"), attr: "data-sfx-value", levels: VOLUME_LEVELS, get: () => audio.sfxLevel, set: (v: number) => audio.setSfxLevel(v) },
  { sliders: volumeSliders("announcer"), attr: "data-announcer-value", levels: VOLUME_LEVELS, get: () => audio.announcerLevel, set: (v: number) => audio.setAnnouncerLevel(v) },
];
const syncAudioUi = () => {
  for (const c of VOLUME_CONTROLS) {
    for (const sl of c.sliders) setFill(sl, c.get(), c.levels.length);
    for (const el of document.querySelectorAll<HTMLElement>(`[${c.attr}]`)) el.textContent = c.levels[c.get()].name;
  }
};
syncAudioUi();
for (const c of VOLUME_CONTROLS) {
  for (const sl of c.sliders) {
    sl.addEventListener("input", () => {
      c.set(Number(sl.value));
      syncAudioUi();
    });
  }
}
// the M key keeps the sliders in step
hud.onAudioChange = syncAudioUi;

// ------------------------------------------------------------------ graphics: classic / PBR
const pbr = new PbrMode(scene, env.sun, env.hemi, env.shadows, [
  new RealisticTerrain(scene, terrain, () => tracks.footpaths, () => ({ trees, layout })), realTrees, realCrops, realHedges,
  // cars, tractors and trailers, the base buildings and the outposts get their detailed models
  { enable: () => props.setDetail(true), disable: () => props.setDetail(false) },
  { enable: () => game.setBaseDetail(true), disable: () => game.setBaseDetail(false) },
  { enable: () => game.outposts.forEach((o) => o.setDetail(true)), disable: () => game.outposts.forEach((o) => o.setDetail(false)) },
  // the realistic ground draws the farm tracks and footpaths itself (irregular edges, ruts, gravel, trampled earth)
  { enable: () => { tracks.trackBands.setEnabled(false); tracks.pathBands.setEnabled(false); }, disable: () => { tracks.trackBands.setEnabled(true); tracks.pathBands.setEnabled(true); } },
  { enable: () => game.effects.real.enable(), disable: () => game.effects.real.disable() },
]);
/** Day / night for the environment and - after it - the PBR lighting. */
function setNight(on: boolean) {
  muzzle.enabled = on;
  muzzle.clear();
  env.setNight(on);
  pbr.setLighting();
  game.effects.real.night = on;
}
const GRAPHICS_KEY = "cod.graphics";
const syncGraphicsUi = () => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-graphics]")) el.textContent = `Grafik: ${pbr.active ? "Realistisch (PBR)" : "Klassisch"}`;
  // the menus get a brushed-metal look in the realistic mode
  document.body.classList.toggle("gfx-real", pbr.active);
};
/** On touch devices the realistic mode renders at most 1.5 device pixels per CSS pixel (the ground's fragment shader is the load). */
const PBR_TOUCH_MAX_DPR = 1.5;
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
const setGraphics = (realistic: boolean) => {
  pbr.setEnabled(realistic);
  const dpr = window.devicePixelRatio || 1;
  engine.setHardwareScalingLevel(1 / (realistic && isTouchDevice ? Math.min(dpr, PBR_TOUCH_MAX_DPR) : dpr));
  try {
    localStorage.setItem(GRAPHICS_KEY, realistic ? "pbr" : "classic");
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
  syncGraphicsUi();
};
for (const el of document.querySelectorAll<HTMLElement>("[data-graphics]")) el.addEventListener("click", () => setGraphics(!pbr.active));
syncGraphicsUi();
document.getElementById("menu-controls")!.addEventListener("click", () => {
  const help = document.getElementById("menu-help")!;
  help.hidden = !help.hidden;
});
hud.bindArtillery(input);
hud.bindBuild(input);
hud.bindCommandos(input);

// ------------------------------------------------------------------ no browser zoom on phones
// Double taps and pinches must never zoom or shift the page (iOS ignores user-scalable=no).
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  // a second tap within 300 ms would be a double-tap zoom: swallow the browser default (the
  // game still gets its pointer events, so double-tap selection keeps working). Buttons are left
  // alone so quick repeated taps (e.g. training two soldiers) still click.
  const now = performance.now();
  const onButton = (e.target as Element | null)?.closest?.("button, a, input, select");
  if (!onButton && now - lastTouchEnd < 300 && e.cancelable) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
// if the page got scrolled anyway (e.g. by the on-screen keyboard), snap it back
window.addEventListener("scroll", () => window.scrollTo(0, 0));

// ------------------------------------------------------------------ fullscreen
// (iPhones have no Fullscreen API for pages: the button is hidden there)
type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void>; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const fsDoc = document as FsDoc;
const isFullscreen = () => !!(fsDoc.fullscreenElement ?? fsDoc.webkitFullscreenElement);
if (!(fsDoc.fullscreenEnabled || fsDoc.webkitFullscreenEnabled)) document.body.classList.add("no-fullscreen");
const toggleFullscreen = () => {
  const root = document.documentElement as FsEl;
  const done = isFullscreen()
    ? (fsDoc.exitFullscreen?.() ?? fsDoc.webkitExitFullscreen?.())
    : (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
  Promise.resolve(done).catch(() => {});
};
const menuFullscreen = document.getElementById("menu-fullscreen")!;
const syncFullscreen = () => {
  document.body.classList.toggle("fullscreen", isFullscreen());
  menuFullscreen.textContent = isFullscreen() ? "Vollbild ausschalten" : "Vollbild einschalten";
  engine.resize();
  overlay.resize();
};
document.addEventListener("fullscreenchange", syncFullscreen);
document.addEventListener("webkitfullscreenchange", syncFullscreen);
document.getElementById("btn-fullscreen")!.addEventListener("click", toggleFullscreen);
menuFullscreen.addEventListener("click", toggleFullscreen);
window.addEventListener("keydown", (e) => {
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen();
});

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

// ------------------------------------------------------------------ pause menu
// Esc or the "Menü" button stops the game: audio settings, continue, or back to the main menu.
let paused = false;
const pauseEl = document.getElementById("pause")!;
const quitBtn = document.getElementById("pause-quit")!;
const setPaused = (on: boolean) => {
  if (inMenu || (on && game.result)) on = false;
  paused = on;
  pauseEl.hidden = !on;
  document.body.classList.toggle("paused", on);
  input.enabled = hud.enabled = !on && !inMenu;
  input.setPad(0, 0);
  quitBtn.textContent = "Zum Hauptmenü";
  delete quitBtn.dataset.confirm;
  if (on) syncAudioUi();
};
document.getElementById("btn-pause")!.addEventListener("click", () => setPaused(!paused));
document.getElementById("pause-resume")!.addEventListener("click", () => setPaused(false));
quitBtn.addEventListener("click", () => {
  // the battle is lost when leaving: ask once more
  if (!quitBtn.dataset.confirm) {
    quitBtn.dataset.confirm = "1";
    quitBtn.textContent = "Wirklich beenden? Erneut klicken";
    return;
  }
  returnToMenu();
});
// capture phase: runs before the game's own key handling; a pending targeting mode is cancelled
// there first, otherwise Escape opens / closes the pause menu
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || inMenu) return;
  if (!paused && input.targeting) return;
  e.stopPropagation();
  setPaused(!paused);
}, { capture: true });

/**
 * Ends the current game and goes back to the main menu without reloading the page (fullscreen,
 * audio and settings stay): the mission is cleared away, night and fog reset, and the silent
 * background battle starts again.
 */
function returnToMenu() {
  paused = false;
  pauseEl.hidden = true;
  document.body.classList.remove("paused", "mode-skirmish", "mode-commandos");
  if (game.commandos) {
    game.commandos.dispose();
    setNight(false);
    streetLights.setOn(false);
    birds.setEnabled(true);
    tracks.setNight(false);
    // the commandos mode had cleared the player's compound out of the fog's blockers
    const b = game.playerBarracks;
    fog.blockRect(b.x, b.z, 6, 4, b.rot, 7);
  }
  hud.resetForMenu();
  input.reset();
  input.enabled = hud.enabled = false;
  fog.reset();
  fogRender.strength = 0;
  game.canSee = null; // in the menu both sides see everything
  audio.quiet = true;
  audio.setTheme("menu");
  inMenu = true;
  starting = false;
  menuRestartT = 0;
  document.body.classList.add("in-menu");
  showModes(false);
  // the sidebar is gone again: the 3D view is wider
  engine.resize();
  overlay.resize();
  startBackgroundBattle();
}
hud.onRestart = returnToMenu;

/** Leaves the menu and starts a battle in the chosen mode. */
function startGame(mode: GameMode) {
  // clear away the background battle: every mode starts from the opening position
  game.reset();
  ai = new EnemyAI(game);
  game.canSee = (x, z) => fog.isVisible(x, z);
  audio.quiet = false;
  audio.setTheme(mode === "base" ? "conquest" : mode);
  if (mode === "skirmish") {
    game.setupSkirmish();
    document.body.classList.add("mode-skirmish");
  } else if (mode === "commandos") {
    const mission = new CommandosMission(game);
    mission.setup();
    // the mission plays at night: moonlight, street lamps on, searchlights at the outposts
    setNight(true);
    streetLights.setOn(true);
    birds.setEnabled(false); // no birds at night
    tracks.setNight(true);
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
    cam.flyIn(a.x, a.z + 6);
  } else {
    cam.flyIn(layout.playerBase.x, layout.playerBase.z + 14);
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
const menuSettings = document.getElementById("menu-settings")!;
const showModes = (on: boolean) => {
  menuMain.hidden = on;
  menuModes.hidden = !on;
  menuSettings.hidden = true;
  document.body.classList.remove("menu-settings-open");
  document.body.classList.toggle("menu-choose", on);
  if (on) document.getElementById("menu-help")!.hidden = true;
};
// "Einstellungen": a sub-menu with music volume and graphics
const showSettings = (on: boolean) => {
  menuMain.hidden = on;
  menuSettings.hidden = !on;
  document.body.classList.toggle("menu-settings-open", on);
  if (on) document.getElementById("menu-help")!.hidden = true;
};
document.getElementById("menu-new")!.addEventListener("click", () => showModes(true));
document.getElementById("menu-back")!.addEventListener("click", () => showModes(false));
document.getElementById("menu-settings-open")!.addEventListener("click", () => showSettings(true));
document.getElementById("menu-settings-back")!.addEventListener("click", () => showSettings(false));
// The artwork is rendered from the live battlefield (temporary units, lights): a game may only start
// once it is done, otherwise its clean-up would hit the running game.
let starting = false;
const requestStart = (mode: GameMode) => {
  if (starting) return;
  starting = true;
  void artDone.catch(() => undefined).then(() => startGame(mode)); // also if the artwork failed
};
document.getElementById("mode-conquest")!.addEventListener("click", () => requestStart("base"));
document.getElementById("mode-skirmish")!.addEventListener("click", () => requestStart("skirmish"));
document.getElementById("mode-commandos")!.addEventListener("click", () => requestStart("commandos"));
// while the artwork renders, the fly-over must not move the sun (the shadow frustum follows it)
let renderingArt = true;
const artDone = renderModeArt(engine, scene, game, env.followFocus, { setNight, streetLights }).finally(() => {
  // the remembered graphics choice (after the mode art, which is drawn in the classic look)
  try {
    if (localStorage.getItem(GRAPHICS_KEY) === "pbr") setGraphics(true);
  } catch {
    /* no storage */
  }
  renderingArt = false;
  if (inMenu && !starting) startBackgroundBattle();
});
artDone.then(
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
  pbr.update();
  audio.update(dt, !paused && !hud.bannerShown);
  if (!paused && !hud.bannerShown) {
    birds.update(dt);
    tracks.update(dt);
    muzzle.update(dt);
  }
  if (inMenu) {
    // cinematic fly-over along a slow loop across the battlefield
    menuT += dt;
    cam.jumpTo(Math.sin(menuT * 0.035) * 60 - 10, Math.cos(menuT * 0.024) * 55 - 5);
    cam.update(dt);
    if (!renderingArt) {
      env.followFocus(cam.focus);
      game.update(dt);
      for (const a of menuAis) a.update(dt);
      if (game.result) {
        menuRestartT += dt;
        if (menuRestartT > 6) {
          menuRestartT = 0;
          startBackgroundBattle();
        }
      }
    }
    return;
  }
  if (paused || hud.bannerShown) {
    // frozen (pause menu or victory / defeat dialog): the picture stays, nothing moves
    if (hud.bannerShown) input.enabled = false;
    cam.update(0);
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

// optional FPS counter (setting is remembered)
const fpsEl = document.getElementById("fps-counter")!;
let showFps = false;
try {
  showFps = localStorage.getItem("cod.fps") === "1";
} catch {
  /* storage unavailable */
}
const syncFps = () => {
  fpsEl.hidden = !showFps;
  for (const el of document.querySelectorAll<HTMLElement>("[data-fps]")) el.textContent = `FPS anzeigen: ${showFps ? "an" : "aus"}`;
};
syncFps();
for (const el of document.querySelectorAll<HTMLElement>("[data-fps]")) {
  el.addEventListener("click", () => {
    showFps = !showFps;
    try {
      localStorage.setItem("cod.fps", showFps ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    syncFps();
  });
}
let fpsShown = 0;
engine.runRenderLoop(() => {
  scene.render();
  if (showFps) {
    const now = performance.now();
    if (now - fpsShown > 500) {
      fpsShown = now;
      fpsEl.textContent = `${Math.round(engine.getFps())} FPS`;
    }
  }
});
window.addEventListener("resize", () => {
  engine.resize();
  overlay.resize();
});
document.getElementById("loading")?.remove();

// handy for debugging in the console
Object.assign(window, { game, scene, cam, audio, ai, fog, pbr, startGame, returnToMenu });
