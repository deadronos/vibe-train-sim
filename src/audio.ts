// All sound is synthesised in Web Audio, so the project ships no audio files.

/** The player's sound choices. Levels run from 0 to 1. */
export interface SoundSettings {
  muted: boolean;
  volume: number;
  engine: number;
  rail: number;
  horn: number;
  squeal: boolean;
}

export const DEFAULT_SOUND: SoundSettings = {
  muted: false,
  volume: 0.8,
  engine: 1,
  rail: 1,
  horn: 1,
  squeal: true,
};
const MASTER = 0.56; // Full volume; the default setting gives the 0.45 the mix was tuned at
const BUS_FADE = 0.05; // Seconds; settings changes glide rather than click
const CURVE_SQUEAL_RADIUS = 140; // m; only sharp curves and turnouts produce flange rub
const MIN_CURVE_RADIUS = 55;
const JOINT_SPACING = 18; // m between welded/jointed rail clicks
const CAB_MASTER_CUTOFF = 1800; // Hz inside enclosed cab view
const OPEN_MASTER_CUTOFF = 5200; // Hz exterior listening ceiling

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
  cab?: boolean;
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
  masterCutoff: number;
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

  const engineFreq = 36 + notch * 5.2 + load * 7 + Math.min(16, speed * 0.36);
  const subFreq = engineFreq * 0.5;
  const engineCutoff = 165 + notch * 52 + load * 165;
  const engineGain = (0.05 + notchFrac * 0.115 + load * 0.065) * nearby;

  const turboAmt = Math.max(0, (notch - 1.5) / 6.5);
  const turboFreq = 320 + notch * 68 + load * 90;
  const turboGain = turboAmt * (0.004 + load * 0.007) * nearby;

  const rollGain = Math.min(0.19, speed * 0.0078) * nearby;
  const bridgeGain = input.onBridge && speed > 1 ? Math.min(0.25, speed * 0.011) * nearby : 0;

  let flangeGain = 0;
  let flangeFreq = 1080;
  if (input.minRadius < CURVE_SQUEAL_RADIUS && speed > 2.0) {
    const tight = clamp01((CURVE_SQUEAL_RADIUS - input.minRadius) / (CURVE_SQUEAL_RADIUS - MIN_CURVE_RADIUS));
    const speedFactor = clamp01((speed - 2.0) / 10);
    // Bandpass pink noise needs slight compensation compared to rolling noise, while staying well below piercing levels.
    flangeGain = (0.008 + tight * 0.024) * speedFactor * nearby;
    flangeFreq = 1050 + tight * 260 + Math.min(140, speed * 5);
  }

  let brakeSquealGain = 0;
  let brakeSquealFreq = 820;
  if (input.airBrake > 0.12 && speed > 0.25 && speed < 11) {
    const low = clamp01((speed - 0.25) / 1.5);
    const high = clamp01((11 - speed) / 6);
    brakeSquealGain = Math.min(1, input.airBrake) * low * high * 0.025 * nearby;
    brakeSquealFreq = 780 + Math.min(1, speed / 11) * 320;
  }

  const brakeDelta = Math.abs(input.brakeDemand - input.airBrake);
  const brakeHissGain =
    (brakeDelta > 0.02 || input.emergency ? Math.min(0.085, brakeDelta * 0.08 + (input.emergency ? 0.04 : 0)) : 0) *
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
    masterCutoff: input.cab ? CAB_MASTER_CUTOFF : OPEN_MASTER_CUTOFF,
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

/** Fills a loopable pink-filtered noise buffer (-3 dB/oct roll-off) so rail roll and air avoid white static hiss. */
function fillPinkNoise(data: Float32Array) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.14;
    b6 = w * 0.115926;
    data[i] = Math.max(-1, Math.min(1, pink));
  }
}

function makeDriveCurve(): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(1.7 * x);
  }
  return curve;
}

export class SimAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private masterFilter!: BiquadFilterNode;
  private engineBus!: GainNode;
  private railBus!: GainNode;
  private squealBus!: GainNode;
  private hornBus!: GainNode;

  private engine!: OscillatorNode;
  private engine2!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private turboOsc!: OscillatorNode;
  private turboFilter!: BiquadFilterNode;
  private turboGain!: GainNode;

  private rollGain!: GainNode;
  private bridgeGain!: GainNode;
  private flangeFilter!: BiquadFilterNode;
  private flangeGain!: GainNode;
  private brakeFilter!: BiquadFilterNode;
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
    this.masterFilter = ctx.createBiquadFilter();
    this.masterFilter.type = 'lowpass';
    this.masterFilter.frequency.value = OPEN_MASTER_CUTOFF;
    this.masterFilter.Q.value = 0.65;
    this.master.connect(this.masterFilter);
    this.masterFilter.connect(ctx.destination);
    const bus = (target: AudioNode = this.master) => {
      const g = ctx.createGain();
      g.connect(target);
      return g;
    };
    this.engineBus = bus();
    this.railBus = bus();
    this.squealBus = bus(this.railBus);
    this.hornBus = bus();
    this.apply(true);
    // Frames stop in a hidden tab, so the last levels would otherwise drone on.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });

    // Diesel prime mover: warm soft-clipped dual oscillators + dynamic lowpass + filtered sine turbine purr.
    const drive = ctx.createWaveShaper();
    drive.curve = makeDriveCurve();
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 210;
    this.engineFilter.Q.value = 0.85;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine2 = ctx.createOscillator();
    this.engine2.type = 'square';
    this.engine.connect(drive);
    this.engine2.connect(drive);
    drive.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.engineBus);
    this.engine.start();
    this.engine2.start();

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 420;
    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.frequency.value = 500;
    this.turboFilter.Q.value = 1.6;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboFilter);
    this.turboFilter.connect(this.turboGain);
    this.turboGain.connect(this.engineBus);
    this.turboOsc.start();

    // Shared 2-second pink-noise loop for deep rolling rumble, bridge boom, brake hiss, and filtered rub squeals.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    fillPinkNoise(this.noise.getChannelData(0));
    const roll = ctx.createBufferSource();
    roll.buffer = this.noise;
    roll.loop = true;

    const rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass';
    rollFilter.frequency.value = 280;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    roll.connect(rollFilter);
    rollFilter.connect(this.rollGain);
    this.rollGain.connect(this.railBus);

    // Hollow bridge deck resonance (warm low-mid bandpass).
    const bridgeFilter = ctx.createBiquadFilter();
    bridgeFilter.type = 'bandpass';
    bridgeFilter.frequency.value = 125;
    bridgeFilter.Q.value = 3.8;
    this.bridgeGain = ctx.createGain();
    this.bridgeGain.gain.value = 0;
    roll.connect(bridgeFilter);
    bridgeFilter.connect(this.bridgeGain);
    this.bridgeGain.connect(this.railBus);

    // Pneumatic brake air hiss.
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1150;
    hissFilter.Q.value = 0.9;
    this.brakeHissGain = ctx.createGain();
    this.brakeHissGain.gain.value = 0;
    roll.connect(hissFilter);
    hissFilter.connect(this.brakeHissGain);
    this.brakeHissGain.connect(this.railBus);

    // Narrow bandpass pink noise + slow stick-slip LFO modulation replaces harsh pure-sine squeals.
    const modulatedBand = (freq: number, q: number, lfoHz: number) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = q;
      const flutter = ctx.createGain();
      flutter.gain.value = 0.65;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = lfoHz;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.35;
      lfo.connect(lfoDepth);
      lfoDepth.connect(flutter.gain);
      lfo.start();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      roll.connect(filter);
      filter.connect(flutter);
      flutter.connect(gain);
      gain.connect(this.squealBus);
      return { filter, gain };
    };

    const flange = modulatedBand(1080, 16, 5.4);
    this.flangeFilter = flange.filter;
    this.flangeGain = flange.gain;

    const brake = modulatedBand(820, 14, 4.1);
    this.brakeFilter = brake.filter;
    this.brakeSquealGain = brake.gain;

    roll.start();

    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = 'lowpass';
    hornFilter.frequency.value = 1050;
    hornFilter.Q.value = 0.7;
    this.hornGain.connect(hornFilter);
    hornFilter.connect(this.hornBus);
    for (const f of [277, 349, 415]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.12;
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
    level(this.squealBus, s.squeal ? 1 : 0);
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
      this.beep(640, 0, 0.16, 0.16);
      this.beep(480, 0.14, 0.22, 0.16);
    }
  }

  playTrip() {
    this.beep(720, 0, 0.12, 0.18);
    this.beep(540, 0.13, 0.12, 0.18);
    this.beep(400, 0.26, 0.24, 0.18);
  }

  private clack(strength: number, delay: number, freq = 680) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(Math.max(0.002, strength), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 1.4;
    src.connect(f);
    f.connect(g);
    g.connect(this.railBus);
    src.start(t, Math.random());
    src.stop(t + 0.095);
  }

  /** Pneumatic air-exhaust burst when halting or venting brakes. */
  playAirRelease(strength: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || strength <= 0.01) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 950;
    f.Q.value = 0.9;
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
    this.clack(amp, 0, 460);
    this.clack(amp * 0.85, axleGap * 0.5, 820);
    this.clack(amp * 0.75, axleGap, 540);
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
    f.frequency.value = 720;
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
    this.masterFilter.frequency.setTargetAtTime(p.masterCutoff, t, 0.14);
    this.engine.frequency.setTargetAtTime(p.engineFreq, t, 0.16);
    this.engine2.frequency.setTargetAtTime(p.subFreq, t, 0.16);
    this.engineFilter.frequency.setTargetAtTime(p.engineCutoff, t, 0.16);
    this.engineGain.gain.setTargetAtTime(p.engineGain, t, 0.16);
    this.turboOsc.frequency.setTargetAtTime(p.turboFreq, t, 0.2);
    this.turboFilter.frequency.setTargetAtTime(p.turboFreq, t, 0.2);
    this.turboGain.gain.setTargetAtTime(p.turboGain, t, 0.2);

    this.rollGain.gain.setTargetAtTime(p.rollGain, t, 0.15);
    this.bridgeGain.gain.setTargetAtTime(p.bridgeGain, t, 0.12);
    this.flangeFilter.frequency.setTargetAtTime(p.flangeFreq, t, 0.08);
    this.flangeGain.gain.setTargetAtTime(p.flangeGain, t, 0.08);
    this.brakeFilter.frequency.setTargetAtTime(p.brakeSquealFreq, t, 0.08);
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
      if (release) this.playAirRelease((release === 'stop' ? 0.15 : 0.11) * input.nearby);

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
