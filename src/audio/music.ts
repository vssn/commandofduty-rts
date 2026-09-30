/**
 * Procedurally generated, looping music built entirely from Web Audio oscillators and noise, with one
 * theme per screen (cross-faded when it changes):
 *
 * - menu: 120 bpm E-minor rock march – electro bass, distorted guitar, drum machine, marching boots
 * - conquest: war-drama score in D minor, i–VI–iv–V (Dm, Bb, Gm, A), two bars per chord; the 32-bar
 *   cycle builds up: strings + timpani, + bass ostinato (bar 8), + snare and brass (16), + horn melody (24)
 * - skirmish: slow, brooding A minor (Am, F, Dm, E) – pads, heartbeat drum, plucked arpeggios, cello line
 * - commandos: minimal thriller bed – low drone, ticking timer, muted pulse, heartbeat, dissonant swells, sonar pings
 */

export type MusicTheme = "menu" | "conquest" | "skirmish" | "commandos";
const BPM: Record<MusicTheme, number> = { menu: 120, conquest: 84, skirmish: 70, commandos: 96 };
const LOOKAHEAD = 0.2;

const CHORDS = [
  { root: 38, notes: [50, 53, 57] }, // Dm
  { root: 34, notes: [46, 50, 53] }, // Bb
  { root: 31, notes: [43, 46, 50] }, // Gm
  { root: 33, notes: [45, 49, 52] }, // A
];
const SNARE = [1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1];
/** Horn line per chord: [semitones above chord's first note, start step, length in steps] over two bars. */
const MELODY: [number, number, number][][] = [
  [[12, 0, 6], [15, 6, 2], [19, 8, 12], [17, 20, 4], [15, 24, 8]],
  [[12, 0, 6], [14, 6, 2], [15, 8, 8], [19, 16, 16]],
  [[12, 0, 8], [15, 8, 4], [19, 12, 4], [22, 16, 12], [19, 28, 4]],
  [[16, 0, 6], [19, 6, 2], [24, 8, 16], [22, 24, 8]],
];

// ---- menu: E minor, Em – C – G – D, two bars each
const MENU_CHORDS = [40, 36, 43, 38];
/** Lead guitar per chord, semitones above E4: [interval, start step, length] over two bars. */
const MENU_LEAD: [number, number, number][][] = [
  [[7, 0, 4], [10, 4, 2], [12, 6, 6], [10, 12, 2], [7, 14, 2], [5, 16, 8], [3, 24, 4], [0, 28, 4]],
  [[7, 0, 6], [12, 6, 2], [15, 8, 8], [12, 16, 4], [10, 20, 4], [7, 24, 8]],
  [[3, 0, 4], [7, 4, 4], [10, 8, 4], [12, 12, 4], [15, 16, 12], [12, 28, 4]],
  [[14, 0, 8], [12, 8, 4], [10, 12, 4], [8, 16, 4], [7, 20, 4], [10, 24, 8]],
];

// ---- skirmish: A minor, Am – F – Dm – E, two bars each
const SK_CHORDS = [
  { root: 45, notes: [57, 60, 64] }, // Am
  { root: 41, notes: [53, 57, 60] }, // F
  { root: 38, notes: [50, 53, 57] }, // Dm
  { root: 40, notes: [52, 56, 59] }, // E
];
/** Cello line per chord (absolute MIDI, start step, length) over two bars. */
const SK_CELLO: [number, number, number][][] = [
  [[57, 0, 12], [60, 12, 4], [59, 16, 8], [57, 24, 8]],
  [[53, 0, 8], [57, 8, 8], [60, 16, 12], [58, 28, 4]],
  [[57, 0, 8], [55, 8, 4], [53, 12, 4], [50, 16, 16]],
  [[52, 0, 8], [56, 8, 8], [59, 16, 8], [56, 24, 8]],
];

const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export class MusicGenerator {
  private readonly bus: GainNode;
  /** Cross-fade between themes. */
  private readonly fade: GainNode;
  private readonly drive: WaveShaperNode["curve"];
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;
  private pending: MusicTheme | null = null;
  private switchAt = 0;

  constructor(private readonly ctx: AudioContext, out: AudioNode, private readonly noise: AudioBuffer, private theme: MusicTheme = "menu") {
    this.bus = ctx.createGain();
    this.fade = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    this.fade.connect(out);
    this.bus.connect(this.fade);
    this.bus.connect(reverb).connect(wet).connect(this.fade);
    // soft-clipping curve for the electric guitar
    const n = 1024, k = 28;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.drive = curve;
  }

  /** Switches to another theme: the current one fades out, the new one starts from its first bar. */
  setTheme(theme: MusicTheme) {
    if (theme === (this.pending ?? this.theme)) return;
    if (this.timer === null) {
      this.theme = theme;
      this.step = 0;
      return;
    }
    const t = this.ctx.currentTime;
    this.fade.gain.cancelScheduledValues(t);
    this.fade.gain.setTargetAtTime(0, t, 0.25);
    this.pending = theme;
    this.switchAt = t + 1.0;
  }

  private get stepLen(): number {
    return 60 / BPM[this.theme] / 4; // sixteenth note
  }

  private impulse(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  start() {
    if (this.timer !== null) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 40);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private schedule() {
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      if (this.pending && this.nextTime >= this.switchAt) {
        this.theme = this.pending;
        this.pending = null;
        this.step = 0;
        this.fade.gain.cancelScheduledValues(this.nextTime);
        this.fade.gain.setTargetAtTime(1, this.nextTime, 0.3);
      }
      if (!this.pending) {
        if (this.theme === "menu") this.menuStep(this.step, this.nextTime);
        else if (this.theme === "skirmish") this.skirmishStep(this.step, this.nextTime);
        else if (this.theme === "commandos") this.commandosStep(this.step, this.nextTime);
        else this.conquestStep(this.step, this.nextTime);
      }
      this.nextTime += this.stepLen;
      this.step++;
    }
  }

  // ------------------------------------------------------------------ menu

  /** 16-bar cycle: drums, bass and boots from the start, guitar chugs from bar 4, lead guitar in bars 8–15. */
  private menuStep(step: number, t: number) {
    const STEP = this.stepLen;
    const bar = Math.floor(step / 16) % 16;
    const s = step % 16;
    const root = MENU_CHORDS[Math.floor(bar / 2) % 4];

    // drum machine: four-on-the-floor kick, backbeat snare, 8th hats
    if (s % 4 === 0) this.kick(t, 0.5);
    if (s === 4 || s === 12) this.snare(t, 0.09);
    if (s === 4 || s === 12) this.noiseHit(t, 0.04, "bandpass", 900, 0.14);
    if (s % 2 === 0) this.noiseHit(t, s % 4 === 2 ? 0.03 : 0.018, "highpass", 7500, 0.035);
    if (bar % 4 === 3 && s >= 12) this.snare(t, 0.05 + (s - 12) * 0.01); // fill

    // marching boots in the background: one step per beat, left/right slightly different
    if (s % 4 === 0) this.boot(t, (s / 4) % 2 === 0);

    // electro bass: driving 8ths with octave jumps and a squelchy filter
    if (s % 2 === 0) {
      const up = s === 6 || s === 14 || (s === 10 && bar % 2 === 1);
      this.electroBass(freq(root + (up ? 12 : 0)), t, s % 4 === 0 ? 0.11 : 0.08, STEP * 1.6);
    }

    // rhythm guitar: open power chords with palm-muted chugs in between
    if (bar >= 4) {
      const chord = [root + 12, root + 19, root + 24];
      if (s === 0) this.guitar(chord, t, STEP * 5.5, 0.05, false);
      else if (s === 10) this.guitar(chord, t, STEP * 3.5, 0.045, false);
      else if (s === 6 || s === 8 || s === 14) this.guitar(chord.slice(0, 2), t, STEP * 0.9, 0.04, true);
    }

    // lead guitar melody
    if (bar >= 8) {
      const local = (bar % 2) * 16 + s;
      for (const [iv, start, len] of MENU_LEAD[Math.floor(bar / 2) % 4]) {
        if (start === local) this.leadGuitar(freq(64 + iv), t, len * STEP);
      }
    }
  }

  private kick(t: number, level: number) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = this.env(t, level, 0.002, 0.02, 0.25);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.35);
  }

  /** A boot on gravel: low crunch plus a faint rattle of kit. */
  private boot(t: number, left: boolean) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = left ? 520 : 600;
    bp.Q.value = 1.4;
    const pan = ctx.createStereoPanner();
    pan.pan.value = left ? -0.25 : 0.25;
    const g = this.env(t, 0.05, 0.004, 0.02, 0.09);
    src.connect(bp).connect(g).connect(pan).connect(this.bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.15);
    this.noiseHit(t + 0.03, 0.008, "highpass", 4200, 0.05);
  }

  private electroBass(f: number, t: number, level: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 9;
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur * 0.8);
    const g = this.env(t, level, 0.004, dur * 0.4, dur * 0.5);
    lp.connect(g).connect(this.bus);
    for (const [type, mult, lvl] of [["sawtooth", 1, 1], ["square", 0.5, 0.6]] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** Distorted electric guitar: detuned saws through a soft clipper and a speaker-cabinet filter. */
  private guitar(notes: number[], t: number, dur: number, level: number, muted: boolean) {
    const ctx = this.ctx;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.drive;
    const cab = ctx.createBiquadFilter();
    cab.type = "lowpass";
    cab.frequency.value = muted ? 1100 : 3200;
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 850;
    mid.gain.value = 5;
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    const g = this.env(t, level, 0.003, Math.max(0.02, dur - 0.1), muted ? 0.05 : 0.25);
    pre.connect(shaper).connect(cab).connect(mid).connect(g).connect(this.bus);
    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = freq(n);
        o.detune.value = detune;
        o.connect(pre);
        o.start(t);
        o.stop(t + dur + 0.35);
      }
    }
  }

  private leadGuitar(f: number, t: number, dur: number) {
    const ctx = this.ctx;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.drive;
    const cab = ctx.createBiquadFilter();
    cab.type = "lowpass";
    cab.frequency.value = 3600;
    const pre = ctx.createGain();
    pre.gain.value = 0.7;
    const g = this.env(t, 0.035, 0.01, Math.max(0.05, dur - 0.15), 0.3);
    pre.connect(shaper).connect(cab).connect(g).connect(this.bus);
    // vibrato sets in after the attack
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.8;
    const vibAmt = ctx.createGain();
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.4, dur));
    vib.connect(vibAmt);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f * 0.97, t); // slight bend into the note
    o.frequency.linearRampToValueAtTime(f, t + 0.05);
    vibAmt.connect(o.frequency);
    o.connect(pre);
    o.start(t);
    o.stop(t + dur + 0.4);
    vib.start(t);
    vib.stop(t + dur + 0.4);
  }

  // ------------------------------------------------------------------ skirmish

  /** 16-bar cycle: pads and heartbeat, plucked arpeggios from bar 4, cello line in bars 8–15. */
  private skirmishStep(step: number, t: number) {
    const STEP = this.stepLen;
    const bar = Math.floor(step / 16) % 16;
    const s = step % 16;
    const chord = SK_CHORDS[Math.floor(bar / 2) % 4];
    if (s === 0 && bar % 2 === 0) this.pad(chord.notes, freq(chord.root), t, STEP * 32);
    // heartbeat drum: lub-dub on every bar
    if (s === 0) this.lowDrum(t, 0.3);
    if (s === 3) this.lowDrum(t, 0.18);
    // distant rumble every eight bars
    if (bar % 8 === 6 && s === 8) this.rumble(t, 0.05);
    if (bar >= 4 && s % 2 === 0) {
      const arp = [0, 1, 2, 1, 0, 2, 1, 2][s / 2];
      this.pluck(freq(chord.notes[arp] + 12), t, s === 0 ? 0.045 : 0.03);
    }
    if (bar >= 8) {
      const local = (bar % 2) * 16 + s;
      for (const [n, start, len] of SK_CELLO[Math.floor(bar / 2) % 4]) {
        if (start === local) this.cello(freq(n - 12), t, len * STEP);
      }
    }
  }

  private pad(notes: number[], bass: number, t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const g = this.env(t, 0.03, 2.2, dur - 3.2, 1.8);
    lp.connect(g).connect(this.bus);
    for (const f of [...notes.map(freq), bass]) {
      for (const [type, detune] of [["triangle", -6], ["sine", 6]] as [OscillatorType, number][]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 1.2);
      }
    }
  }

  private lowDrum(t: number, level: number) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
    const g = this.env(t, level, 0.006, 0.03, 0.5);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.7);
  }

  private rumble(t: number, level: number) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 160;
    const g = this.env(t, level, 0.6, 0.8, 2.5);
    src.connect(lp).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + 4.2);
  }

  /** Plucked string / soft piano: a sine with a decaying octave overtone. */
  private pluck(f: number, t: number, level: number) {
    const ctx = this.ctx;
    const g = this.env(t, level, 0.004, 0.02, 1.1);
    g.connect(this.bus);
    for (const [mult, lvl] of [[1, 1], [2, 0.35], [3, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * mult;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 1.3);
    }
  }

  private cello(f: number, t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    const body = ctx.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = 300;
    body.gain.value = 6;
    const g = this.env(t, 0.05, 0.25, Math.max(0.05, dur - 0.5), 0.5);
    lp.connect(body).connect(g).connect(this.bus);
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.8;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = f * 0.008;
    vib.connect(vibAmt);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    vibAmt.connect(o.frequency);
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.6);
    vib.start(t);
    vib.stop(t + dur + 0.6);
  }

  // ------------------------------------------------------------------ commandos

  /**
   * 16-bar cycle of tension without a tune: a drone, a ticking timer, a muted pulse from bar 4, a
   * heartbeat from bar 8, dissonant swells every four bars and the odd sonar ping.
   */
  private commandosStep(step: number, t: number) {
    const STEP = this.stepLen;
    const bar = Math.floor(step / 16) % 16;
    const s = step % 16;
    if (s === 0 && bar % 8 === 0) this.drone(t, STEP * 16 * 8);
    // ticking timer on 8ths, the beat a little louder
    if (s % 2 === 0) this.noiseHit(t, s % 4 === 0 ? 0.022 : 0.012, "highpass", 6500, 0.012);
    if (bar >= 4 && s % 4 === 0) this.pulse(freq(38), t, 0.06);
    if (bar >= 4 && s === 10 && bar % 2 === 1) this.pulse(freq(39), t, 0.05); // half-step rub
    if (bar >= 8 && (s === 0 || s === 2)) this.lowDrum(t, s === 0 ? 0.22 : 0.14);
    if (bar % 4 === 3 && s === 0) this.swell([62, 63, 69], t, STEP * 16);
    if ((bar === 2 || bar === 11) && s === 8) this.ping(t);
  }

  private drone(t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 240;
    lp.Q.value = 4;
    // the filter breathes slowly
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 120;
    lfo.connect(lfoAmt).connect(lp.frequency);
    const g = this.env(t, 0.07, 3, dur - 5, 3);
    lp.connect(g).connect(this.bus);
    for (const [f, type] of [[freq(26), "sawtooth"], [freq(38), "triangle"], [freq(38) * 1.004, "sawtooth"]] as [number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.5);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.5);
  }

  private pulse(f: number, t: number, level: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.15);
    const g = this.env(t, level, 0.005, 0.03, 0.16);
    o.connect(lp).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.25);
  }

  /** Dissonant cluster that swells up and cuts off, like a held breath. */
  private swell(notes: number[], t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(1600, t + dur * 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.bus);
    for (const n of notes) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq(n);
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  private ping(t: number) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 1320;
    const g = this.env(t, 0.03, 0.004, 0.01, 2.4);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 2.6);
  }

  // ------------------------------------------------------------------ conquest

  private conquestStep(step: number, t: number) {
    const STEP = this.stepLen;
    const bar = Math.floor(step / 16) % 32;
    const s = step % 16;
    const chord = CHORDS[Math.floor(bar / 2) % 4];
    const firstBarOfChord = bar % 2 === 0;
    const build = bar >= 8;
    const full = bar >= 16;

    if (s === 0 && firstBarOfChord) this.strings(chord.notes, t, STEP * 32);
    if (s === 0) this.timpani(freq(chord.root + 12), t, firstBarOfChord ? 0.55 : 0.35);
    if (full && (s === 8 || (bar % 4 === 3 && s >= 12))) this.timpani(freq(chord.root + 12), t, s === 8 ? 0.3 : 0.18);

    if (build && s % 2 === 0) {
      const up = s === 6 || s === 14;
      this.bass(freq(chord.root + (up ? 12 : 0)), t, s % 4 === 0 ? 0.13 : 0.09);
    }
    if (full && SNARE[s]) this.snare(t, s % 4 === 0 ? 0.09 : 0.05);
    if (full && s === 0) this.brass(chord.notes.map((n) => n + 12), t, firstBarOfChord ? 0.05 : 0.035);

    if (bar >= 24) {
      const local = (bar % 2) * 16 + s;
      for (const [iv, start, len] of MELODY[Math.floor(bar / 2) % 4]) {
        if (start === local) this.horn(freq(chord.notes[0] + iv), t, len * STEP);
      }
    }
  }

  private env(t: number, peak: number, attack: number, hold: number, release: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return g;
  }

  private strings(notes: number[], t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.linearRampToValueAtTime(1300, t + dur * 0.6);
    const g = this.env(t, 0.03, 0.9, dur - 1.2, 0.9);
    lp.connect(g).connect(this.bus);
    for (const n of [...notes, notes[0] - 12]) {
      for (const detune of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = freq(n);
        o.detune.value = detune;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.2);
      }
    }
  }

  private timpani(f: number, t: number, level: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f * 1.15, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.92, t + 0.4);
    const g = this.env(t, level, 0.005, 0.02, 1.3);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 1.5);
    this.noiseHit(t, level * 0.5, "lowpass", 500, 0.12);
  }

  private bass(f: number, t: number, level: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.2);
    const g = this.env(t, level, 0.008, 0.05, 0.2);
    o.connect(lp).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.35);
  }

  private snare(t: number, level: number) {
    this.noiseHit(t, level, "highpass", 1600, 0.11);
  }

  private noiseHit(t: number, level: number, type: BiquadFilterType, cutoff: number, decay: number) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    const g = this.env(t, level, 0.002, 0.005, decay);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  private brass(notes: number[], t: number, level: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.5);
    const g = this.env(t, level, 0.03, 0.25, 0.4);
    lp.connect(g).connect(this.bus);
    for (const n of notes) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq(n);
      o.connect(lp);
      o.start(t);
      o.stop(t + 0.8);
    }
  }

  private horn(f: number, t: number, dur: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1500;
    const g = this.env(t, 0.055, 0.12, Math.max(0.05, dur - 0.3), 0.35);
    lp.connect(g).connect(this.bus);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = f * 0.006;
    vib.connect(vibAmt);
    for (const type of ["triangle", "sawtooth"] as OscillatorType[]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      vibAmt.connect(o.frequency);
      const lvl = ctx.createGain();
      lvl.gain.value = type === "sawtooth" ? 0.35 : 1;
      o.connect(lvl).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.5);
    }
    vib.start(t);
    vib.stop(t + dur + 0.5);
  }
}
