import type { Vector3 } from "@babylonjs/core";
import { ARTILLERY, PLAYER } from "../config";
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
  enemyArtillery: "Artilleriebeschuss",
  unitsAttacked: "Wir werden angegriffen",
  win: "Mission erfüllt",
  lose: "Mission gescheitert",
};
/** Loudness of the spoken announcements (0..1). */
const ANNOUNCER_VOLUME = 0.45;
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
  sfxOn = load("cod.sfx", true);
  /** True while the main menu's background battle runs: the game makes no sound, only music plays. */
  quiet = false;
  private ctx: AudioContext | null = null;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private noise!: AudioBuffer;
  private music: MusicGenerator | null = null;
  private theme: MusicTheme = "menu";
  private recentShots: number[] = [];
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
    this.sfxGain.gain.value = this.sfxOn ? 1 : 0;
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

  setSfx(on: boolean) {
    this.sfxOn = on;
    save("cod.sfx", on);
    if (this.ctx) this.sfxGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
    if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
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
    if (!this.sfxOn || !("speechSynthesis" in window)) return;
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
    u.volume = ANNOUNCER_VOLUME;
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
}
