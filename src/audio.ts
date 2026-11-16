// All sound is synthesised, so the project ships no audio files.

/** The player's sound choices. Levels run from 0 to 1. */
export interface SoundSettings {
  muted: boolean;
  volume: number;
  engine: number;
  rail: number;
  horn: number;
}

export const DEFAULT_SOUND: SoundSettings = { muted: false, volume: 0.8, engine: 1, rail: 1, horn: 1 };
const MASTER = 0.56; // Full volume; the default setting gives the 0.45 the mix was tuned at
const BUS_FADE = 0.05; // Seconds; settings changes glide rather than click

export class SimAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private railBus!: GainNode;
  private hornBus!: GainNode;
  private engine!: OscillatorNode;
  private engine2!: OscillatorNode;
  private engineGain!: GainNode;
  private rollGain!: GainNode;
  private hornGain!: GainNode;
  private clackTimer = 0;
  private warnTimer = 0;
  private noise!: AudioBuffer;
  settings: SoundSettings = { ...DEFAULT_SOUND };

  get muted() {
    return this.settings.muted;
  }

  /** True once a click or key press has let the browser start sound. */
  get started() {
    return this.ctx !== null;
  }

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.engineBus = bus();
    this.railBus = bus();
    this.hornBus = bus();
    this.apply(true);
    // Frames stop in a hidden tab, so the last levels would otherwise drone on.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine2 = ctx.createOscillator();
    this.engine2.type = 'square';
    this.engine.connect(filter);
    this.engine2.connect(filter);
    filter.connect(this.engineGain);
    this.engineGain.connect(this.engineBus);
    this.engine.start();
    this.engine2.start();

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const roll = ctx.createBufferSource();
    roll.buffer = this.noise;
    roll.loop = true;
    const rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass';
    rollFilter.frequency.value = 520;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    roll.connect(rollFilter);
    rollFilter.connect(this.rollGain);
    this.rollGain.connect(this.railBus);
    roll.start();

    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.hornBus);
    for (const f of [311, 370, 466]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.11;
      o.connect(g);
      g.connect(this.hornGain);
      o.start();
    }
  }

  setMuted(m: boolean) {
    this.set({ muted: m });
  }

  set(change: Partial<SoundSettings>) {
    this.settings = { ...this.settings, ...change };
    this.apply(false);
  }

  private apply(now: boolean) {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    const level = (g: GainNode, v: number) => {
      if (now) g.gain.value = v;
      else g.gain.setTargetAtTime(v, t, BUS_FADE);
    };
    level(this.master, s.muted ? 0 : s.volume * MASTER);
    level(this.engineBus, s.engine);
    level(this.railBus, s.rail);
    level(this.hornBus, s.horn);
  }

  horn(on: boolean) {
    if (!this.ctx) return;
    this.hornGain.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.04);
  }

  private beep(freq: number, delay: number, duration: number, peak: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Repeats a two-tone cab warning chime while a safety alert awaits acknowledgement. */
  updateWarning(dt: number, active: boolean) {
    if (!active) {
      this.warnTimer = 0;
      return;
    }
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.warnTimer -= dt;
    if (this.warnTimer <= 0) {
      this.warnTimer = 1.15;
      this.beep(780, 0, 0.16, 0.24);
      this.beep(585, 0.14, 0.22, 0.24);
    }
  }

  playTrip() {
    this.beep(980, 0, 0.12, 0.28);
    this.beep(740, 0.13, 0.12, 0.28);
    this.beep(520, 0.26, 0.24, 0.28);
  }

  private clack(strength: number, delay: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1300;
    src.connect(f);
    f.connect(g);
    g.connect(this.railBus);
    src.start(t, Math.random());
    src.stop(t + 0.08);
  }

  /** Follows the driven train; volume drops with camera distance from it. Call with nearby 0 to fade out. */
  update(dt: number, speed: number, throttle: number, nearby: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const rpm = 42 + throttle * 58 + speed * 0.6;
    this.engine.frequency.setTargetAtTime(rpm, t, 0.25);
    this.engine2.frequency.setTargetAtTime(rpm * 0.5, t, 0.25);
    this.engineGain.gain.setTargetAtTime((0.05 + throttle * 0.13) * nearby, t, 0.2);
    this.rollGain.gain.setTargetAtTime(Math.min(0.2, speed * 0.008) * nearby, t, 0.2);
    if (speed > 1.5) {
      // Rail joints every 18 m.
      this.clackTimer -= dt * speed;
      if (this.clackTimer <= 0) {
        this.clackTimer = 18;
        // Both wheelsets of a bogie cross the joint, so the second clack follows the first.
        this.clack(0.16 * nearby, 0);
        this.clack(0.11 * nearby, Math.min(0.16, 2.6 / speed));
      }
    }
  }
}
