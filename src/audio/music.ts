/**
 * Procedurally generated, looping war-drama score built entirely from Web Audio oscillators and noise.
 * D minor, i–VI–iv–V (Dm, Bb, Gm, A), two bars per chord. A 32-bar cycle builds up:
 *   bars 0–7   strings + timpani
 *   bars 8–15  + driving bass ostinato
 *   bars 16–31 + snare march and brass stabs, horn melody in bars 24–31
 */

const BPM = 84;
const STEP = 60 / BPM / 4; // sixteenth note
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

const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export class MusicGenerator {
  private readonly bus: GainNode;
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;

  constructor(private readonly ctx: AudioContext, out: AudioNode, private readonly noise: AudioBuffer) {
    this.bus = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    this.bus.connect(out);
    this.bus.connect(reverb).connect(wet).connect(out);
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
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
  }

  private playStep(step: number, t: number) {
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
