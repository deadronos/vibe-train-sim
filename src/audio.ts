// All sound is synthesised in Web Audio, so the project ships no audio files.

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
const CURVE_SQUEAL_RADIUS = 220; // m; curves tighter than this produce flange squeal
const MIN_CURVE_RADIUS = 55;
const JOINT_SPACING = 18; // m between welded/jointed rail clicks

export interface TrainAudioInput {
  speed: number;
  throttle: number;
  powerLoad: number;
  airBrake: number;
  brakeDemand: number;
  dynamic: number;
  emergency: boolean;
  minRadius: number;
  onBridge: boolean;
  nearby: number;
}

export interface TrainAudioParams {
  notch: number;
  engineFreq: number;
  subFreq: number;
  engineCutoff: number;
  engineGain: number;
  turboFreq: number;
  turboGain: number;
  rollGain: number;
  bridgeGain: number;
  flangeGain: number;
  flangeFreq: number;
  brakeSquealGain: number;
  brakeSquealFreq: number;
  brakeHissGain: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Pure mapping from train physics/track state to Web Audio synthesis parameters. */
export function computeTrainAudioParams(input: TrainAudioInput): TrainAudioParams {
  const nearby = clamp01(input.nearby);
  const throttle = clamp01(input.throttle);
  const load = clamp01(input.powerLoad);
  const speed = Math.max(0, input.speed);
  const notch = Math.round(throttle * 8);
  const notchFrac = notch / 8;

  const engineFreq = 38 + notch * 6.5 + load * 8 + Math.min(20, speed * 0.45);
  const subFreq = engineFreq * 0.5;
  const engineCutoff = 210 + notch * 72 + load * 240;
  const engineGain = (0.045 + notchFrac * 0.11 + load * 0.065) * nearby;

  const turboAmt = Math.max(0, (notch - 1.5) / 6.5);
  const turboFreq = 620 + notch * 165 + load * 240;
  const turboGain = turboAmt * (0.02 + load * 0.032) * nearby;

  const rollGain = Math.min(0.18, speed * 0.0075) * nearby;
  const bridgeGain = input.onBridge && speed > 1 ? Math.min(0.24, speed * 0.011) * nearby : 0;

  let flangeGain = 0;
  let flangeFreq = 3100;
  if (input.minRadius < CURVE_SQUEAL_RADIUS && speed > 2.0) {
    const tight = clamp01((CURVE_SQUEAL_RADIUS - input.minRadius) / (CURVE_SQUEAL_RADIUS - MIN_CURVE_RADIUS));
    const speedFactor = clamp01((speed - 2.0) / 10);
    flangeGain = (0.025 + tight * 0.095) * speedFactor * nearby;
    flangeFreq = 2950 + tight * 550 + Math.min(350, speed * 12);
  }

  let brakeSquealGain = 0;
  let brakeSquealFreq = 2250;
  if (input.airBrake > 0.12 && speed > 0.25 && speed < 12) {
    const low = clamp01((speed - 0.25) / 1.5);
    const high = clamp01((12 - speed) / 6.5);
    brakeSquealGain = Math.min(1, input.airBrake) * low * high * 0.085 * nearby;
    brakeSquealFreq = 2150 + Math.min(1, speed / 12) * 550;
  }

  const brakeDelta = Math.abs(input.brakeDemand - input.airBrake);
  const brakeHissGain =
    (brakeDelta > 0.02 || input.emergency ? Math.min(0.16, brakeDelta * 0.14 + (input.emergency ? 0.08 : 0)) : 0) *
    nearby;

  return {
    notch,
    engineFreq,
    subFreq,
    engineCutoff,
    engineGain,
    turboFreq,
    turboGain,
    rollGain,
    bridgeGain,
    flangeGain,
    flangeFreq,
    brakeSquealGain,
    brakeSquealFreq,
    brakeHissGain,
  };
}

/** Detects pneumatic air-release moments when stopping under brakes or venting full brake release. */
export function detectAirRelease(
  prevSpeed: number,
  prevAirBrake: number,
  speed: number,
  airBrake: number,
  brakeDemand: number,
): 'stop' | 'release' | null {
  if (prevSpeed > 0.45 && speed <= 0.15 && (airBrake > 0.08 || brakeDemand > 0.08)) return 'stop';
  if (prevAirBrake > 0.45 && airBrake <= 0.15 && brakeDemand < 0.1) return 'release';
  return null;
}

/** Counts how many bogies crossed any real junction node behind the train head during step `ds`. */
export function countJunctionBogieCrossings(
  nodeDists: readonly number[],
  ds: number,
  bogieOffsets: readonly number[],
): number {
  if (ds <= 0 || !nodeDists.length || !bogieOffsets.length) return 0;
  let hits = 0;
  for (let i = 0; i < nodeDists.length; i++) {
    const nd = nodeDists[i];
    const prevNd = nd - ds;
    for (let j = 0; j < bogieOffsets.length; j++) {
      const bd = bogieOffsets[j];
      if (prevNd < bd && bd <= nd) hits++;
    }
  }
  return hits;
}

/** True when cumulative distance crossed an 18 m rail joint boundary. */
export function crossedRailJoint(prevOdom: number, curOdom: number, spacing = JOINT_SPACING): boolean {
  if (curOdom <= prevOdom) return false;
  return Math.floor(curOdom / spacing) > Math.floor(prevOdom / spacing);
}

export class SimAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private railBus!: GainNode;
  private hornBus!: GainNode;

  private engine!: OscillatorNode;
  private engine2!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private turboOsc!: OscillatorNode;
  private turboGain!: GainNode;

  private rollGain!: GainNode;
  private bridgeGain!: GainNode;
  private flangeOsc1!: OscillatorNode;
  private flangeOsc2!: OscillatorNode;
  private flangeGain!: GainNode;
  private brakeOsc!: OscillatorNode;
  private brakeSquealGain!: GainNode;
  private brakeHissGain!: GainNode;

  private hornGain!: GainNode;
  private warnTimer = 0;
  private noise!: AudioBuffer;
  private prevSpeed = 0;
  private prevAirBrake = 0;
  private prevOdom = 0;
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

    // Diesel prime mover: dual oscillators through dynamic load-controlled lowpass + turbo whine.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 280;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine2 = ctx.createOscillator();
    this.engine2.type = 'square';
    this.engine.connect(this.engineFilter);
    this.engine2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.engineBus);
    this.engine.start();
    this.engine2.start();

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'triangle';
    this.turboOsc.frequency.value = 800;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.engineBus);
    this.turboOsc.start();

    // Shared 2-second white-noise loop for rolling, bridge boom and brake hiss.
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

    // Hollow bridge deck resonance (resonant low-mid bandpass).
    const bridgeFilter = ctx.createBiquadFilter();
    bridgeFilter.type = 'bandpass';
    bridgeFilter.frequency.value = 155;
    bridgeFilter.Q.value = 4.2;
    this.bridgeGain = ctx.createGain();
    this.bridgeGain.gain.value = 0;
    roll.connect(bridgeFilter);
    bridgeFilter.connect(this.bridgeGain);
    this.bridgeGain.connect(this.railBus);

    // Pneumatic brake air hiss.
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 2600;
    hissFilter.Q.value = 1.6;
    this.brakeHissGain = ctx.createGain();
    this.brakeHissGain.gain.value = 0;
    roll.connect(hissFilter);
    hissFilter.connect(this.brakeHissGain);
    this.brakeHissGain.connect(this.railBus);
    roll.start();

    // Tight-curve wheel flange squeal (beating high-frequency sine pair).
    this.flangeGain = ctx.createGain();
    this.flangeGain.gain.value = 0;
    this.flangeGain.connect(this.railBus);
    this.flangeOsc1 = ctx.createOscillator();
    this.flangeOsc1.type = 'sine';
    this.flangeOsc1.frequency.value = 3100;
    this.flangeOsc2 = ctx.createOscillator();
    this.flangeOsc2.type = 'sine';
    this.flangeOsc2.frequency.value = 3340;
    const f1g = ctx.createGain();
    f1g.gain.value = 0.55;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.45;
    this.flangeOsc1.connect(f1g);
    this.flangeOsc2.connect(f2g);
    f1g.connect(this.flangeGain);
    f2g.connect(this.flangeGain);
    this.flangeOsc1.start();
    this.flangeOsc2.start();

    // Low-speed brake shoe squeal.
    this.brakeOsc = ctx.createOscillator();
    this.brakeOsc.type = 'sine';
    this.brakeOsc.frequency.value = 2250;
    this.brakeSquealGain = ctx.createGain();
    this.brakeSquealGain.gain.value = 0;
    this.brakeOsc.connect(this.brakeSquealGain);
    this.brakeSquealGain.connect(this.railBus);
    this.brakeOsc.start();

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

  private clack(strength: number, delay: number, freq = 1300) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(Math.max(0.002, strength), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    src.connect(f);
    f.connect(g);
    g.connect(this.railBus);
    src.start(t, Math.random());
    src.stop(t + 0.085);
  }

  /** Pneumatic air-exhaust burst when halting or venting brakes. */
  playAirRelease(strength: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || strength <= 0.01) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2100;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(strength, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    src.connect(f);
    f.connect(g);
    g.connect(this.railBus);
    src.start(t, Math.random());
    src.stop(t + 0.45);
  }

  /** Metallic frog & switch-blade double clatter when bogies cross a real junction node. */
  playJunctionClatter(speed: number, nearby: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || nearby <= 0.01) return;
    const s = Math.max(1, speed);
    const axleGap = Math.min(0.18, 1.9 / s);
    const amp = Math.min(0.28, 0.1 + s * 0.006) * nearby;
    this.clack(amp, 0, 950);
    this.clack(amp * 0.85, axleGap * 0.5, 1750);
    this.clack(amp * 0.75, axleGap, 1050);
  }

  /** Heavy metallic impact + crunch on collision or buffer-stop hit. */
  playImpact(kind: 'collision' | 'buffer', speed: number, nearby: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || nearby <= 0.01) return;
    const scale = Math.max(0.35, Math.min(1, speed / 15)) * nearby;
    const t = ctx.currentTime;

    const thud = ctx.createOscillator();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(kind === 'collision' ? 115 : 95, t);
    thud.frequency.exponentialRampToValueAtTime(32, t + 0.34);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.45 * scale, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    thud.connect(tg);
    tg.connect(this.railBus);
    thud.start(t);
    thud.stop(t + 0.4);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 950;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.38 * scale, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(f);
    f.connect(ng);
    ng.connect(this.railBus);
    src.start(t, Math.random());
    src.stop(t + 0.48);
  }

  /** Resets edge-triggered state when switching trains or stopping. */
  resetTrainTracking(speed: number, airBrake: number, odom: number) {
    this.prevSpeed = speed;
    this.prevAirBrake = airBrake;
    this.prevOdom = odom;
  }

  /** Follows the driven train; volume drops with camera distance from it. Call with nearby 0 to fade out. */
  update(
    input: TrainAudioInput,
    curOdom: number,
    junctionNodeDists: readonly number[],
    bogieOffsets: readonly number[],
  ) {
    if (!this.ctx || this.ctx.state !== 'running') {
      this.prevSpeed = input.speed;
      this.prevAirBrake = input.airBrake;
      this.prevOdom = curOdom;
      return;
    }

    const p = computeTrainAudioParams(input);
    const t = this.ctx.currentTime;
    this.engine.frequency.setTargetAtTime(p.engineFreq, t, 0.16);
    this.engine2.frequency.setTargetAtTime(p.subFreq, t, 0.16);
    this.engineFilter.frequency.setTargetAtTime(p.engineCutoff, t, 0.16);
    this.engineGain.gain.setTargetAtTime(p.engineGain, t, 0.16);
    this.turboOsc.frequency.setTargetAtTime(p.turboFreq, t, 0.2);
    this.turboGain.gain.setTargetAtTime(p.turboGain, t, 0.2);

    this.rollGain.gain.setTargetAtTime(p.rollGain, t, 0.15);
    this.bridgeGain.gain.setTargetAtTime(p.bridgeGain, t, 0.12);
    this.flangeOsc1.frequency.setTargetAtTime(p.flangeFreq, t, 0.08);
    this.flangeOsc2.frequency.setTargetAtTime(p.flangeFreq * 1.078, t, 0.08);
    this.flangeGain.gain.setTargetAtTime(p.flangeGain, t, 0.08);
    this.brakeOsc.frequency.setTargetAtTime(p.brakeSquealFreq, t, 0.08);
    this.brakeSquealGain.gain.setTargetAtTime(p.brakeSquealGain, t, 0.08);
    this.brakeHissGain.gain.setTargetAtTime(p.brakeHissGain, t, 0.08);

    if (input.nearby > 0.01) {
      const release = detectAirRelease(
        this.prevSpeed,
        this.prevAirBrake,
        input.speed,
        input.airBrake,
        input.brakeDemand,
      );
      if (release) this.playAirRelease((release === 'stop' ? 0.18 : 0.13) * input.nearby);

      const ds = curOdom - this.prevOdom;
      if (ds > 0 && ds < 20 && input.speed > 0.5) {
        const jHits = countJunctionBogieCrossings(junctionNodeDists, ds, bogieOffsets);
        if (jHits > 0) this.playJunctionClatter(input.speed, input.nearby);
        else if (crossedRailJoint(this.prevOdom, curOdom) && input.speed > 1.5) {
          this.clack(0.14 * input.nearby, 0);
          this.clack(0.1 * input.nearby, Math.min(0.16, 2.6 / input.speed));
        }
      }
    }

    this.prevSpeed = input.speed;
    this.prevAirBrake = input.airBrake;
    this.prevOdom = curOdom;
  }
}
