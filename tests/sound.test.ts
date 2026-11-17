import { describe, expect, it } from 'vitest';

import {
  computeTrainAudioParams,
  countJunctionBogieCrossings,
  crossedRailJoint,
  DEFAULT_SOUND,
  detectAirRelease,
  type TrainAudioInput,
} from '../src/audio';
import { parseSound } from '../src/persistence';
import { Network } from '../src/rail/network';
import { collectJunctionDists, Sim, STEP, tractiveLoad, Train } from '../src/rail/sim';

const baseInput = (over: Partial<TrainAudioInput> = {}): TrainAudioInput => ({
  speed: 15,
  throttle: 0,
  powerLoad: 0,
  airBrake: 0,
  brakeDemand: 0,
  dynamic: 0,
  emergency: false,
  minRadius: Infinity,
  onBridge: false,
  nearby: 1,
  ...over,
});

describe('sound settings', () => {
  it('uses the defaults when nothing is saved', () => {
    expect(parseSound(null)).toEqual(DEFAULT_SOUND);
    expect(parseSound('loud')).toEqual(DEFAULT_SOUND);
  });

  it('keeps saved values', () => {
    const saved = { muted: true, volume: 0.3, engine: 0, rail: 0.5, horn: 1, squeal: false };
    expect(parseSound(saved)).toEqual(saved);
  });

  it('defaults squeal to true when upgrading older saved sound settings', () => {
    const legacy = { muted: true, volume: 0.3, engine: 0, rail: 0.5, horn: 1 };
    expect(parseSound(legacy)).toEqual({ ...legacy, squeal: true });
  });

  it('replaces only the values that are missing or out of range', () => {
    const s = parseSound({ muted: 'yes', volume: 4, engine: -1, rail: 0.2, squeal: 'no' });
    expect(s).toEqual({ ...DEFAULT_SOUND, rail: 0.2 });
  });
});

describe('train audio synthesis model', () => {
  it('steps diesel notches, boosts filtered turbo purr and responds to tractive load', () => {
    const idle = computeTrainAudioParams(baseInput({ speed: 0, throttle: 0, powerLoad: 0 }));
    const notch4Light = computeTrainAudioParams(baseInput({ speed: 12, throttle: 0.5, powerLoad: 0.2 }));
    const notch8Heavy = computeTrainAudioParams(baseInput({ speed: 12, throttle: 1, powerLoad: 1 }));

    expect(idle.notch).toBe(0);
    expect(idle.turboGain).toBe(0);
    expect(notch4Light.notch).toBe(4);
    expect(notch8Heavy.notch).toBe(8);
    expect(notch8Heavy.engineFreq).toBeGreaterThan(notch4Light.engineFreq);
    expect(notch8Heavy.engineCutoff).toBeGreaterThan(notch4Light.engineCutoff);
    expect(notch8Heavy.turboGain).toBeGreaterThan(notch4Light.turboGain);
    expect(notch8Heavy.turboFreq).toBeLessThanOrEqual(1050);
    expect(notch8Heavy.turboGain).toBeLessThanOrEqual(0.015);
    expect(notch8Heavy.engineGain).toBeGreaterThan(idle.engineGain);
  });

  it('keeps flange and brake squeal in warmer bands and quiets gentle mainline curves', () => {
    const squeal = computeTrainAudioParams(baseInput({ speed: 4, airBrake: 0.8, brakeDemand: 0.8 }));
    const fastBrake = computeTrainAudioParams(baseInput({ speed: 24, airBrake: 0.8, brakeDemand: 0.8 }));
    const hiss = computeTrainAudioParams(baseInput({ speed: 14, airBrake: 0.1, brakeDemand: 0.9 }));
    const tightCurve = computeTrainAudioParams(baseInput({ speed: 12, minRadius: 85 }));
    const gentleCurve = computeTrainAudioParams(baseInput({ speed: 12, minRadius: 180 }));
    const straight = computeTrainAudioParams(baseInput({ speed: 12, minRadius: 800 }));
    const bridge = computeTrainAudioParams(baseInput({ speed: 16, onBridge: true }));
    const inCab = computeTrainAudioParams(baseInput({ speed: 16, cab: true }));

    expect(squeal.brakeSquealGain).toBeGreaterThan(0.005);
    expect(squeal.brakeSquealGain).toBeLessThanOrEqual(0.03);
    expect(squeal.brakeSquealFreq).toBeLessThanOrEqual(1200);
    expect(fastBrake.brakeSquealGain).toBe(0);
    expect(hiss.brakeHissGain).toBeGreaterThan(0.02);
    expect(tightCurve.flangeGain).toBeGreaterThan(0.01);
    expect(tightCurve.flangeGain).toBeLessThanOrEqual(0.04);
    expect(tightCurve.flangeFreq).toBeLessThanOrEqual(1600);
    expect(gentleCurve.flangeGain).toBe(0);
    expect(straight.flangeGain).toBe(0);
    expect(bridge.bridgeGain).toBeGreaterThan(0.1);
    expect(straight.bridgeGain).toBe(0);
    expect(inCab.masterCutoff).toBeLessThan(tightCurve.masterCutoff);
  });

  it('detects pneumatic air release on stopping and brake release', () => {
    expect(detectAirRelease(1.2, 0.7, 0.1, 0.7, 0.7)).toBe('stop');
    expect(detectAirRelease(0, 0.7, 0, 0.1, 0)).toBe('release');
    expect(detectAirRelease(10, 0.5, 9.5, 0.5, 0.5)).toBeNull();
  });

  it('triggers junction clatter from real network nodes and bogie offsets rather than a fixed timer', () => {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const j = net.addNode(100, 10, 0, 1, 0);
    const c = net.addNode(220, 10, 0, 1, 0);
    const d = net.addNode(210, 10, 60, 0.85, 0.52);
    const s1 = net.addSegment(a.id, 1, j.id, -1);
    net.addSegment(j.id, 1, c.id, -1);
    net.addSegment(j.id, 1, d.id, -1);

    const sim = new Sim(net);
    const train = new Train(1, 'Test', [{ type: 'loco_diesel', flip: false }]);
    train.ai = false;
    sim.trains.push(train);
    sim.place(train, s1.id, 88, 1);

    const dists: number[] = [];
    const bogies = [3.6, 16.4];
    let totalJunctionHits = 0;
    let prevOdom = train.odometer;
    train.throttle = 0.8;

    for (let k = 0; k < 180; k++) {
      sim.update(STEP);
      const ds = train.odometer - prevOdom;
      prevOdom = train.odometer;
      collectJunctionDists(net, train, dists);
      totalJunctionHits += countJunctionBogieCrossings(dists, ds, bogies);
    }

    expect(train.odometer).toBeGreaterThan(25);
    expect(totalJunctionHits).toBe(2);
    expect(tractiveLoad(train)).toBeGreaterThan(0);
    expect(crossedRailJoint(17.5, 18.2)).toBe(true);
    expect(crossedRailJoint(18.2, 18.2)).toBe(false);
  });
});
