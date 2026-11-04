// All sound is synthesised, so the project ships no audio files.
export class SimAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engine!: OscillatorNode;
  private engine2!: OscillatorNode;
  private engineGain!: GainNode;
  private rollGain!: GainNode;
  private hornGain!: GainNode;
  private clackTimer = 0;
  private noise!: AudioBuffer;
  muted = false;

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.45;
    this.master.connect(ctx.destination);

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
    this.engineGain.connect(this.master);
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
    this.rollGain.connect(this.master);
    roll.start();

    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.master);
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
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.45;
  }

  horn(on: boolean) {
    if (!this.ctx) return;
    this.hornGain.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.04);
  }

  private clack(strength: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1300;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.08);
  }

  /** Follows the driven train; volume drops with camera distance from it. */
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
        this.clack(0.16 * nearby);
        setTimeout(() => this.ctx && this.clack(0.11 * nearby), Math.min(160, 2600 / speed));
      }
    }
  }
}
