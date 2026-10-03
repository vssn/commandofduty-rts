import type { Vector3 } from "@babylonjs/core";
import { ARTILLERY, ENEMY, PLAYER } from "../config";
import type { Game, GameEvent } from "../game/game";
import { MusicGenerator, type MusicTheme } from "./music";

const ANNOUNCE: Partial<Record<GameEvent, string>> = {
  unitReady: "Einheit bereit",
  unitLost: "Einheit verloren",
  noCredits: "Unzureichende Mittel",
  baseAttacked: "Unsere Basis wird angegriffen",
  artillery: "Artillerie unterwegs",
  spotted: "Wir wurden entdeckt",
  outpostDestroyed: "Stellung gesprengt",
  targetEliminated: "Ziel ausgeschaltet",
  cloaked: "Tarnung aktiv",
  chargePlanted: "Ladung platziert",
  enemySearching: "Sie suchen die Gegend ab",
  tracked: "Man folgt unserer Spur",
  cacheFound: "Sprengstoff aufgenommen",
  timeWarning: "Noch eine Minute",
  dronesLaunched: "Feindliche Drohnen gestartet",
  droneDown: "Drohne ausgeschaltet",
  enemyArtillery: "Artilleriebeschuss",
  unitsAttacked: "Wir werden angegriffen",
  win: "Mission erfüllt",
  lose: "Mission gescheitert",
};
/** Loudness of the spoken announcements (0..1). */
const ANNOUNCER_VOLUME = 0.45;
/** Commandos ambience: reach (m) and peak loudness of the loudspeakers at the enemy outposts and of the drones. */
const PA_RANGE = 70;
const PA_LEVEL = 0.07;
const DRONE_RANGE = 55;
const DRONE_LEVEL = 0.05;
/** Minimum seconds between two identical announcements. */
const REPEAT_GAP = 5;

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function save(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** Music volume steps of the menu slider: 0 = off … 4 = full. */
export const MUSIC_LEVELS = [
  { name: "Aus", gain: 0 },
  { name: "Leise", gain: 0.14 },
  { name: "Mittel", gain: 0.27 },
  { name: "Laut", gain: 0.45 },
  { name: "Voll", gain: 0.65 },
];
const DEFAULT_MUSIC_LEVEL = 3;

/** Volume steps of the effects and announcer sliders (same labels as the music slider); "Voll" = original loudness. */
export const VOLUME_LEVELS = [
  { name: "Aus", gain: 0 },
  { name: "Leise", gain: 0.2 },
  { name: "Mittel", gain: 0.4 },
  { name: "Laut", gain: 0.7 },
  { name: "Voll", gain: 1 },
];
const DEFAULT_VOLUME_LEVEL = VOLUME_LEVELS.length - 1;

/** Stored volume step; falls back to the old on/off switch `legacyKey` of the effects button. */
function loadVolume(key: string, legacyKey = "cod.sfx"): number {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return Math.min(VOLUME_LEVELS.length - 1, Math.max(0, Number(v) | 0));
  } catch {
    /* storage unavailable */
  }
  return load(legacyKey, true) ? DEFAULT_VOLUME_LEVEL : 0;
}

function saveVolume(key: string, level: number) {
  try {
    localStorage.setItem(key, String(level));
  } catch {
    /* storage unavailable */
  }
}

function loadLevel(): number {
  try {
    const v = localStorage.getItem("cod.musicLevel");
    if (v !== null) return Math.min(MUSIC_LEVELS.length - 1, Math.max(0, Number(v) | 0));
  } catch {
    /* storage unavailable */
  }
  return load("cod.music", true) ? DEFAULT_MUSIC_LEVEL : 0;
}

/**
 * All sound: generated music, quiet positional gunfire and spoken event announcements.
 * The AudioContext is created on the first user gesture (browser autoplay policy).
 */
export class AudioSystem {
  /** Music volume step (see MUSIC_LEVELS); 0 = music off. */
  musicLevel = loadLevel();
  /** Last audible step, restored when the music is switched back on (sidebar button, M key). */
  private lastMusicLevel = this.musicLevel || DEFAULT_MUSIC_LEVEL;
  /** Effects volume step (see VOLUME_LEVELS); 0 = effects off. */
  sfxLevel = loadVolume("cod.sfxLevel");
  /** Announcer volume step (see VOLUME_LEVELS); 0 = no spoken announcements. */
  announcerLevel = loadVolume("cod.announcerLevel");
  /** True while the main menu's background battle runs: the game makes no sound, only music plays. */
  quiet = false;
  private ctx: AudioContext | null = null;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private noise!: AudioBuffer;
  private music: MusicGenerator | null = null;
  private theme: MusicTheme = "menu";
  private recentShots: number[] = [];
  private recentImpacts: number[] = [];
  private lastGrunt = 0;
  private lastTick = 0;
  private lastDrum = 0;
  private lastSaid = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  /** False when no known female voice is installed; the fallback voice is then pitched up. */
  private femaleVoice = false;

  constructor(private readonly game: Game, private readonly listener: Vector3) {
    const unlock = () => this.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    game.onShot = (x, z, kind) => !this.quiet && (kind === "sniper" ? this.sniperShot(x, z) : this.shot(x, z, kind === "mg"));
    game.onThrow = (x, z) => !this.quiet && this.whoosh(x, z);
    game.onArmourShot = (x, z, hit, delay) => !this.quiet && (hit ? this.metalHit(x, z, delay) : this.whiz(x, z, delay));
    game.effects.onExplosion = (x, z, size) => !this.quiet && this.explosion(x, z, size);
    // incoming artillery: the whistle starts shortly before the first shell lands
    game.artillery.onOrder = (_team, x, z) => !this.quiet && window.setTimeout(() => this.whistle(x, z), Math.max(0, ARTILLERY.delay - 1.5) * 1000);
    game.on((ev, team, data) => {
      if (this.quiet) return;
      if (ev === "unitLost" && team === PLAYER) this.lossDrum();
      if (ev === "boarded" && team === PLAYER) this.clank();
      if (ev === "selected") this.grunt("select");
      else if (ev === "commanded") this.grunt("command");
      else if (ev === "captured" && data) {
        if (team === PLAYER) this.announce(data.outpost.kind === "radar" ? "Radar online" : "Stellung eingenommen");
      } else if (ev === "outpostThreatened" && data) {
        if (team === PLAYER) this.announce(`Achtung! Der Feind nimmt die Stellung ${data.outpost.name} ein`, true);
      } else if (ev === "outpostLost") {
        if (team === PLAYER) this.announce(data?.outpost.kind === "radar" ? "Radar ausgefallen" : "Stellung verloren");
      } else if (team === PLAYER && ANNOUNCE[ev]) {
        this.announce(ANNOUNCE[ev]!, ev === "win" || ev === "lose");
      }
    });

    if ("speechSynthesis" in window) {
      const pick = () => {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("de"));
        // the announcer is a female radio operator
        const preferred = ["Anna", "Petra", "Helena", "Katja", "Microsoft Katja", "Microsoft Hedda", "Hedda", "Google Deutsch", "Sandy", "Shelley"];
        const female = preferred.map((n) => voices.find((v) => v.name.startsWith(n))).find(Boolean);
        this.voice = female ?? voices[0] ?? null;
        this.femaleVoice = !!female;
      };
      pick();
      speechSynthesis.addEventListener("voiceschanged", pick);
    }
  }

  private unlock() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = MUSIC_LEVELS[this.musicLevel].gain;
    this.musicGain.connect(comp);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = VOLUME_LEVELS[this.sfxLevel].gain;
    this.sfxGain.connect(comp);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.music = new MusicGenerator(ctx, this.musicGain, this.noise, this.theme);
    if (this.musicOn) this.music.start();
  }

  /** Menu music or the soundtrack of the chosen mode (cross-fades if already playing). */
  setTheme(theme: MusicTheme) {
    this.theme = theme;
    this.music?.setTheme(theme);
  }

  get musicOn(): boolean {
    return this.musicLevel > 0;
  }

  /** On/off switch (sidebar, M key): off, or back to the last chosen volume. */
  setMusic(on: boolean) {
    this.setMusicLevel(on ? this.lastMusicLevel : 0);
  }

  /** Music volume step from the menu slider (0 = off). */
  setMusicLevel(level: number) {
    level = Math.min(MUSIC_LEVELS.length - 1, Math.max(0, Math.round(level)));
    this.musicLevel = level;
    if (level > 0) this.lastMusicLevel = level;
    try {
      localStorage.setItem("cod.musicLevel", String(level));
    } catch {
      /* storage unavailable */
    }
    if (!this.ctx) return;
    this.musicGain.gain.setTargetAtTime(MUSIC_LEVELS[level].gain, this.ctx.currentTime, 0.15);
    if (level > 0) this.music?.start();
    else window.setTimeout(() => !this.musicOn && this.music?.stop(), 1500);
  }

  get sfxOn(): boolean {
    return this.sfxLevel > 0;
  }

  /** Effects volume step from the menu slider (0 = off). */
  setSfxLevel(level: number) {
    level = Math.min(VOLUME_LEVELS.length - 1, Math.max(0, Math.round(level)));
    this.sfxLevel = level;
    saveVolume("cod.sfxLevel", level);
    if (this.ctx) this.sfxGain.gain.setTargetAtTime(VOLUME_LEVELS[level].gain, this.ctx.currentTime, 0.05);
  }

  /** Announcer volume step from the menu slider (0 = silent). */
  setAnnouncerLevel(level: number) {
    level = Math.min(VOLUME_LEVELS.length - 1, Math.max(0, Math.round(level)));
    this.announcerLevel = level;
    saveVolume("cod.announcerLevel", level);
    if (level === 0 && "speechSynthesis" in window) speechSynthesis.cancel();
  }

  /** Short rifle crack; quieter with distance to the camera focus, panned left/right. */
  /** Level and stereo pan for a sound at (x, z), relative to the camera focus. Null if inaudible. */
  private spatial(x: number, z: number, level: number, range = 110): { level: number; pan: StereoPannerNode } | null {
    const ctx = this.ctx!;
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const l = level * Math.pow(Math.max(0, 1 - d / range), 1.5);
    if (l < 0.004) return null;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (x - this.listener.x) / 50));
    pan.connect(this.sfxGain);
    return { level: l, pan };
  }

  /** Bullet striking metal (jeep, drone): a bright, inharmonic ping with a short clank. */
  private metalHit(x: number, z: number, delay: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const now = ctx.currentTime;
    this.recentImpacts = this.recentImpacts.filter((t) => now - t < 0.15);
    if (this.recentImpacts.length >= 3) return; // MG bursts: not every round gets its own ping
    const sp = this.spatial(x, z, 0.075);
    if (!sp) return;
    this.recentImpacts.push(now);
    const t = now + delay;
    const base = 1400 + Math.random() * 900;
    // a few inharmonic partials ring out like struck sheet metal
    for (const [mult, lvl, dec] of [[1, 1, 0.24], [1.47, 0.6, 0.17], [2.09, 0.42, 0.12], [2.76, 0.28, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(base * mult, t);
      o.frequency.exponentialRampToValueAtTime(base * mult * 0.97, t + dec);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(sp.level * lvl, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g).connect(sp.pan);
      o.start(t);
      o.stop(t + dec + 0.02);
    }
    // the clank: a short bright noise click and a dull knock of the panel
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(sp.level * 1.3, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    n.connect(hp).connect(ng).connect(sp.pan);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.05);
    const knock = ctx.createOscillator();
    knock.frequency.setValueAtTime(240, t);
    knock.frequency.exponentialRampToValueAtTime(140, t + 0.06);
    const kg = ctx.createGain();
    kg.gain.setValueAtTime(sp.level * 0.9, t);
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    knock.connect(kg).connect(sp.pan);
    knock.start(t);
    knock.stop(t + 0.08);
  }

  /** A bullet whizzing past: a narrow band of noise sweeping down in pitch and across the stereo field. */
  private whiz(x: number, z: number, delay: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const now = ctx.currentTime;
    this.recentImpacts = this.recentImpacts.filter((t) => now - t < 0.15);
    if (this.recentImpacts.length >= 3) return;
    const sp = this.spatial(x, z, 0.06);
    if (!sp) return;
    this.recentImpacts.push(now);
    const t = now + delay;
    const dur = 0.17 + Math.random() * 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 7;
    // Doppler: high while approaching, dropping as it passes
    bp.frequency.setValueAtTime(4300 + Math.random() * 900, t);
    bp.frequency.exponentialRampToValueAtTime(1200 + Math.random() * 300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(sp.level * 2.2, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const side = Math.random() < 0.5 ? -1 : 1;
    const p0 = sp.pan.pan.value;
    sp.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, p0 - side * 0.5)), t);
    sp.pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, p0 + side * 0.5)), t + dur);
    src.connect(bp).connect(g).connect(sp.pan);
    src.start(t, Math.random() * 0.6);
    src.stop(t + dur + 0.02);
  }

  /** Grenade explosion: noise burst with a deep sine thump and a rumbling tail. */
  private explosion(x: number, z: number, size: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const s = this.spatial(x, z, 0.22 * Math.min(1.5, size), 160);
    if (!s) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(s.level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(lp).connect(g).connect(s.pan);
    src.start(t, Math.random() * 0.2);
    src.stop(t + 1.15);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(s.level * 1.6, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(og).connect(s.pan);
    o.start(t);
    o.stop(t + 0.65);
  }

  /** Sharp, louder crack with a short echo for the agent's scoped rifle. */
  private sniperShot(x: number, z: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    for (const [delay, level] of [[0, 0.16], [0.18, 0.04], [0.36, 0.015]]) {
      const s = this.spatial(x, z, level, 160);
      if (!s) continue;
      const t = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(s.level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      src.connect(hp).connect(g).connect(s.pan);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.25);
    }
  }

  /** Descending whistle of incoming shells. */
  private whistle(x: number, z: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const s = this.spatial(x, z, 0.05, 200);
    if (!s) return;
    const t = ctx.currentTime;
    for (const [delay, f0] of [[0, 1500], [0.35, 1350]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(360, t + delay + 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(s.level, t + delay + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.5);
      o.connect(g).connect(s.pan);
      o.start(t + delay);
      o.stop(t + delay + 1.55);
    }
  }

  /** Soft whoosh of a thrown grenade. */
  private whoosh(x: number, z: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const s = this.spatial(x, z, 0.03);
    if (!s) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1600, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(s.level, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp).connect(g).connect(s.pan);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.32);
  }

  /** Metallic clank when a soldier climbs onto a jeep. */
  private clank() {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const t = ctx.currentTime;
    for (const [f, dt] of [[620, 0], [910, 0.09]]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = f;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f * 2;
      bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, t + dt);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.12);
      o.connect(bp).connect(g).connect(this.sfxGain);
      o.start(t + dt);
      o.stop(t + dt + 0.14);
    }
  }

  private shot(x: number, z: number, mg = false) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const now = ctx.currentTime;
    this.recentShots = this.recentShots.filter((t) => now - t < 0.12);
    if (this.recentShots.length >= (mg ? 4 : 3)) return; // don't pile up sounds in big fire fights
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const level = (mg ? 0.09 : 0.07) * Math.pow(Math.max(0, 1 - d / 110), 1.5);
    if (level < 0.004) return;
    this.recentShots.push(now);

    const t = now + Math.random() * 0.03;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (x - this.listener.x) / 50));
    pan.connect(this.sfxGain);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = mg ? 650 + Math.random() * 300 : 1100 + Math.random() * 900;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    src.connect(bp).connect(g).connect(pan);
    src.start(t, Math.random() * 0.8);
    src.stop(t + 0.16);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(150, t);
    thump.frequency.exponentialRampToValueAtTime(55, t + 0.08);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(level * 1.4, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    thump.connect(tg).connect(pan);
    thump.start(t);
    thump.stop(t + 0.12);
  }

  /**
   * Soldier acknowledgement, synthesised as a short nasal hum (glottal pulse through "m" formants):
   * select = "M-hm?" (two syllables, rising), command = "Hm!" (one short, falling, with breath onset).
   */
  private grunt(kind: "select" | "command") {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const now = ctx.currentTime;
    if (now - this.lastGrunt < 0.25) return;
    this.lastGrunt = now;
    // the commandos agent answers slower and a little deeper: calm, in command
    const agent = [...this.game.selection].some((u) => u.type === "agent");
    const slow = agent ? 1.3 : 1;
    const base = agent ? 94 + Math.random() * 8 : 105 + Math.random() * 30; // a different soldier each time
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(this.sfxGain);

    const voiced = (t: number, dur: number, f0: number, f1: number, level: number, breath: number, vowel: "m" | "a" = "m") => {
      const src = ctx.createOscillator();
      src.type = "sawtooth";
      src.frequency.setValueAtTime(f0, t);
      src.frequency.linearRampToValueAtTime(f1, t + dur);
      // nasal "m": strong low resonance, weak higher formants, closed mouth;
      // open "a": first formant ~700 Hz, second ~1200 Hz, brighter
      const open = vowel === "a";
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = open ? 2400 : 900;
      const f1n = ctx.createBiquadFilter();
      f1n.type = "peaking";
      f1n.frequency.value = open ? 700 : 260;
      f1n.gain.value = open ? 12 : 14;
      f1n.Q.value = 3;
      const f2n = ctx.createBiquadFilter();
      f2n.type = "peaking";
      f2n.frequency.value = open ? 1200 : 1100;
      f2n.gain.value = open ? 9 : 4;
      f2n.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.03);
      g.gain.setValueAtTime(level, t + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(lp).connect(f1n).connect(f2n).connect(g).connect(out);
      src.start(t);
      src.stop(t + dur + 0.02);
      if (breath > 0) {
        // "h" onset: short band-limited breath noise
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 1500;
        bp.Q.value = 0.7;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(breath, t - 0.05);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
        n.connect(bp).connect(ng).connect(out);
        n.start(t - 0.05, Math.random() * 0.5);
        n.stop(t + 0.03);
      }
    };

    /** Voiceless breath puff ("h") between syllables. */
    const breathPuff = (t: number, dur: number, level: number) => {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1300;
      bp.Q.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(level, t + 0.012);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(bp).connect(ng).connect(out);
      n.start(t, Math.random() * 0.5);
      n.stop(t + dur + 0.02);
    };

    const t = now + 0.02;
    // timing stretched by `slow` (offsets from the start and every duration)
    const syllable = (at: number, dur: number, f0: number, f1: number, level: number, breath: number, vowel: "m" | "a" = "m") =>
      voiced(t + (at - t) * slow, dur * slow, f0, f1, level, breath, vowel);
    const puff = (at: number, dur: number, level: number) => breathPuff(t + (at - t) * slow, dur * slow, level);
    if (kind === "select") {
      syllable(t, 0.13, base, base * 0.97, 0.06, 0);
      syllable(t + 0.2, 0.2, base * 1.02, base * 1.45, 0.07, 0.012);
      return;
    }
    // command acknowledged: a random one of several short, falling grunts
    switch (Math.floor(Math.random() * 4)) {
      case 0: // "Hm!"
        syllable(t + 0.05, 0.16, base * 1.3, base * 0.85, 0.08, 0.02);
        break;
      case 1: // "M-h-hm"
        syllable(t, 0.1, base * 1.05, base, 0.055, 0);
        puff(t + 0.12, 0.07, 0.02);
        syllable(t + 0.21, 0.17, base * 1.28, base * 0.84, 0.075, 0.015);
        break;
      case 2: // "Ah-hm"
        syllable(t, 0.15, base * 1.15, base * 1.02, 0.06, 0.008, "a");
        syllable(t + 0.21, 0.17, base * 1.22, base * 0.84, 0.075, 0.015);
        break;
      default: // "H-h-hm"
        puff(t, 0.07, 0.022);
        puff(t + 0.12, 0.07, 0.02);
        syllable(t + 0.24, 0.16, base * 1.3, base * 0.85, 0.08, 0.018);
    }
  }

  /** Very quiet counter click whenever the displayed credits go up (rate-limited). */
  creditTick() {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const t = ctx.currentTime;
    if (t - this.lastTick < 0.055) return;
    this.lastTick = t;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 2300 + Math.random() * 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.012, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    o.stop(t + 0.025);
  }

  /** Dull "ba-bum" (two low drum hits, the second deeper) when one of our soldiers dies. */
  private lossDrum() {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const now = ctx.currentTime;
    if (now - this.lastDrum < 0.4) return; // several losses at once share one drum
    this.lastDrum = now;
    const t = now + 0.01;
    for (const [dt, f, level, decay] of [[0, 95, 0.16, 0.18], [0.16, 62, 0.24, 0.45]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f * 1.6, t + dt);
      o.frequency.exponentialRampToValueAtTime(f, t + dt + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(level, t + dt + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + decay);
      o.connect(g).connect(this.sfxGain);
      o.start(t + dt);
      o.stop(t + dt + decay + 0.02);
      // soft felt beater: a little low-passed noise on the attack
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(level * 0.35, t + dt);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.05);
      n.connect(lp).connect(ng).connect(this.sfxGain);
      n.start(t + dt, Math.random() * 0.5);
      n.stop(t + dt + 0.06);
    }
  }

  /** Short two-note "tam-tam" confirming that a soldier was put into production. */
  buildConfirm() {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn) return;
    const t = ctx.currentTime + 0.01;
    for (const [f, dt, len] of [[392, 0, 0.09], [523.25, 0.11, 0.16]]) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(3200, t + dt);
      lp.frequency.exponentialRampToValueAtTime(900, t + dt + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.05, t + dt + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + len);
      lp.connect(g).connect(this.sfxGain);
      for (const [type, mul, lvl] of [["triangle", 1, 1], ["square", 2, 0.25]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mul;
        const og = ctx.createGain();
        og.gain.value = lvl;
        o.connect(og).connect(lp);
        o.start(t + dt);
        o.stop(t + dt + len + 0.02);
      }
    }
  }

  /** Radio chirp followed by a spoken message (Web Speech API, German voice if available). */
  announce(text: string, important = false) {
    if (this.announcerLevel === 0 || !("speechSynthesis" in window)) return;
    const now = performance.now() / 1000;
    if (now - (this.lastSaid.get(text) ?? -Infinity) < REPEAT_GAP) return;
    if (!important && speechSynthesis.pending) return; // keep the radio from lagging behind the action
    this.lastSaid.set(text, now);
    if (important) speechSynthesis.cancel();

    this.chirp();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "de-DE";
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.pitch = this.femaleVoice ? 1 : 1.5;
    u.volume = ANNOUNCER_VOLUME * VOLUME_LEVELS[this.announcerLevel].gain;
    speechSynthesis.speak(u);
  }

  private chirp() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [f, dt] of [[1400, 0], [1900, 0.07]]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.01, t + dt);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.06);
      o.connect(g).connect(this.sfxGain);
      o.start(t + dt);
      o.stop(t + dt + 0.07);
    }
  }
  // ---------------------------------------------------------------- ambience (commandos)

  /** Seconds until each enemy outpost makes its next announcement. */
  private paTimers = new Map<object, number>();
  /** Announcements that are playing: their distance gain follows the agent. */
  private paActive: { x: number; z: number; level: GainNode; pan: StereoPannerNode; end: number }[] = [];
  /** One running motor buzz per drone. */
  private droneVoices = new Map<object, { level: GainNode; pan: StereoPannerNode; nodes: AudioScheduledSourceNode[] }>();

  /** Where the listener is: the agent in the commandos mode, otherwise the camera focus. */
  private ear(): { x: number; z: number } {
    const a = this.game.commandos?.agent;
    return a && a.alive ? a : this.listener;
  }

  /**
   * Ambient sound of the commandos mode, called every frame: the public-address announcements of the
   * enemy outposts (a muffled, unintelligible voice with an echo) and the buzz of drones, both
   * quieter with distance. `active` is false while paused (everything fades out).
   */
  update(dt: number, active: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = this.game;
    const on = active && !this.quiet && this.sfxOn && !g.result;
    const ear = this.ear();
    const now = ctx.currentTime;

    // loudspeaker announcements
    if (on && g.commandos) {
      for (const o of g.outposts) {
        if (o.owner !== ENEMY || o.destroyed) continue;
        const d = Math.hypot(o.x - ear.x, o.z - ear.z);
        if (d > PA_RANGE) continue;
        const left = (this.paTimers.get(o) ?? 2 + Math.random() * 8) - dt;
        if (left > 0) this.paTimers.set(o, left);
        else {
          this.paTimers.set(o, 14 + Math.random() * 18);
          if (this.paActive.length < 2) this.paAnnouncement(o.x, o.z);
        }
      }
    }
    this.paActive = this.paActive.filter((a) => now < a.end);
    for (const a of this.paActive) {
      const d = Math.hypot(a.x - ear.x, a.z - ear.z);
      a.level.gain.setTargetAtTime(on ? PA_LEVEL * Math.pow(Math.max(0, 1 - d / PA_RANGE), 2) : 0, now, 0.1);
      a.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (a.x - ear.x) / 40)), now, 0.1);
    }

    // drones
    const seen = new Set<object>();
    if (on) {
      for (const u of g.units) {
        if (u.type !== "drone" || !u.alive) continue;
        const d = Math.hypot(u.x - ear.x, u.z - ear.z);
        let v = this.droneVoices.get(u);
        if (!v && d < DRONE_RANGE) v = this.startDroneVoice(u);
        if (!v) continue;
        seen.add(u);
        v.level.gain.setTargetAtTime(DRONE_LEVEL * Math.pow(Math.max(0, 1 - d / DRONE_RANGE), 1.6), now, 0.12);
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (u.x - ear.x) / 35)), now, 0.12);
      }
    }
    for (const [u, v] of this.droneVoices) {
      if (seen.has(u)) continue;
      v.level.gain.setTargetAtTime(0, now, 0.15);
      this.droneVoices.delete(u);
      window.setTimeout(() => {
        for (const n of v.nodes) n.stop();
        v.level.disconnect();
      }, 900);
    }
  }

  /**
   * An unintelligible announcement over a loudspeaker: a buzzing "voice" whose two formant bands jump
   * from vowel to vowel in a speech-like rhythm with short consonant hisses, squeezed through a
   * tinny speaker band with a little distortion, and a long, dull echo off the buildings.
   */
  private paAnnouncement(x: number, z: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.05;
    const syl = 9 + Math.floor(Math.random() * 8);
    const dur = syl * 0.19 + 0.5;

    // voice source with a falling sentence melody
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const f0 = 100 + Math.random() * 40;
    osc.frequency.setValueAtTime(f0, t0);
    for (let i = 0; i < syl; i++) osc.frequency.linearRampToValueAtTime(f0 * (0.92 + Math.random() * 0.3) * (1 - (0.18 * i) / syl), t0 + 0.12 + i * 0.19);

    // two formants that follow the vowels
    const vowels = [[700, 1200], [500, 1700], [300, 2300], [450, 900], [330, 1000], [600, 1500]];
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
    f1.type = f2.type = "bandpass";
    f1.Q.value = 5;
    f2.Q.value = 7;
    const g2 = ctx.createGain();
    g2.gain.value = 0.6;
    osc.connect(f1);
    osc.connect(f2);
    f2.connect(g2);
    // syllable envelope: a voiced burst, a short dip, now and then a longer pause between phrases
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    f1.connect(env);
    g2.connect(env);
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const hiss = ctx.createBiquadFilter();
    hiss.type = "highpass";
    hiss.frequency.value = 2800;
    const hissG = ctx.createGain();
    hissG.gain.setValueAtTime(0, t0);
    noise.connect(hiss).connect(hissG).connect(env);
    let t = t0 + 0.1;
    for (let i = 0; i < syl; i++) {
      const v = vowels[Math.floor(Math.random() * vowels.length)];
      f1.frequency.setTargetAtTime(v[0], t, 0.025);
      f2.frequency.setTargetAtTime(v[1], t, 0.025);
      hissG.gain.setValueAtTime(0.35, t - 0.04);
      hissG.gain.setValueAtTime(0, t + 0.03);
      env.gain.setTargetAtTime(0.9, t, 0.015);
      env.gain.setTargetAtTime(0.18, t + 0.11, 0.03);
      t += 0.19 + (Math.random() < 0.18 ? 0.25 : 0);
    }
    env.gain.setTargetAtTime(0, t, 0.05);

    // the loudspeaker: narrow band, a peak in the mids, slight overdrive
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 420;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = 1500;
    peak.gain.value = 7;
    peak.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / 128 - 1) * 2.2;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    env.connect(hp).connect(peak).connect(shaper).connect(lp);

    // echoes from the walls: two taps, the long one fed back through a dull filter
    const out = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = 1;
    lp.connect(dry).connect(out);
    for (const [delay, level, fb] of [[0.31, 0.5, 0.42], [0.57, 0.3, 0.3]]) {
      const d = ctx.createDelay(1.5);
      d.delayTime.value = delay;
      const wet = ctx.createGain();
      wet.gain.value = level;
      const back = ctx.createGain();
      back.gain.value = fb;
      const damp = ctx.createBiquadFilter();
      damp.type = "lowpass";
      damp.frequency.value = 1700;
      lp.connect(d);
      d.connect(damp).connect(wet).connect(out);
      damp.connect(back).connect(d);
    }
    const level = ctx.createGain();
    level.gain.value = 0;
    const pan = ctx.createStereoPanner();
    out.connect(level).connect(pan).connect(this.sfxGain);
    osc.start(t0);
    noise.start(t0);
    const end = t + 3.2;
    osc.stop(t + 0.3);
    noise.stop(t + 0.3);
    this.paActive.push({ x, z, level, pan, end });
    window.setTimeout(() => out.disconnect(), (end - ctx.currentTime + 0.5) * 1000);
  }

  /** The buzz of a small multicopter: four detuned motors, a thin whine and a flutter of propeller noise. */
  private startDroneVoice(owner: object) {
    const ctx = this.ctx!;
    const nodes: AudioScheduledSourceNode[] = [];
    const mix = ctx.createGain();
    mix.gain.value = 0.25;
    for (const f of [208, 214, 221, 229]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.connect(mix);
      o.start();
      nodes.push(o);
    }
    const whine = ctx.createOscillator();
    whine.type = "triangle";
    whine.frequency.value = 905;
    const wg = ctx.createGain();
    wg.gain.value = 0.05;
    whine.connect(wg).connect(mix);
    whine.start();
    nodes.push(whine);
    const body = ctx.createBiquadFilter();
    body.type = "bandpass";
    body.frequency.value = 600;
    body.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    mix.connect(body).connect(lp);
    // propeller wash
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const nb = ctx.createBiquadFilter();
    nb.type = "bandpass";
    nb.frequency.value = 3200;
    nb.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    n.connect(nb).connect(ng).connect(lp);
    n.start();
    nodes.push(n);
    // flutter: the whole buzz swells and ebbs about nine times a second
    const am = ctx.createGain();
    am.gain.value = 0.85;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 8 + Math.random() * 2;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.15;
    lfo.connect(lfoG).connect(am.gain);
    lfo.start();
    nodes.push(lfo);
    const level = ctx.createGain();
    level.gain.value = 0;
    const pan = ctx.createStereoPanner();
    lp.connect(am).connect(level).connect(pan).connect(this.sfxGain);
    const v = { level, pan, nodes };
    this.droneVoices.set(owner, v);
    return v;
  }

}
