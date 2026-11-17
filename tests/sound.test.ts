import { describe, expect, it } from 'vitest';

import {
  computeAmbienceParams,
  computeTrainAudioParams,
  countJunctionBogieCrossings,
  crossedRailJoint,
  DEFAULT_SOUND,
  detectAirRelease,
  dopplerPitch,
  type AmbienceInput,
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

describe('train Doppler pitch', () => {
  const listener = { x: 0, y: 0, z: 0 };
  const velocity = { x: 25, y: 0, z: 0 };
  const still = { x: 0, y: 0, z: 0 };

  it('raises approaching pitch and lowers receding pitch', () => {
    expect(dopplerPitch({ x: -40, y: 0, z: 5 }, velocity, listener, still)).toBeGreaterThan(1);
    expect(dopplerPitch({ x: 40, y: 0, z: 5 }, velocity, listener, still)).toBeLessThan(1);
  });

  it('uses the camera velocity and the line from the camera to the train', () => {
    const source = { x: 0, y: 0, z: 5 };
    expect(dopplerPitch(source, velocity, listener, still)).toBe(1);
    expect(dopplerPitch({ x: 5, y: 0, z: 5 }, velocity, listener, velocity)).toBe(1);
    expect(dopplerPitch({ x: 5, y: 0, z: 5 }, still, listener, velocity)).toBeGreaterThan(1);
  });

  it('stays neutral at the listener and bounded during fast-forward', () => {
    expect(dopplerPitch(listener, velocity, listener, still)).toBe(1);
    expect(dopplerPitch({ x: -10, y: 0, z: 0 }, { ...velocity, x: 400 }, listener, still)).toBeLessThan(1.25);
  });
});

describe('sound settings', () => {
  it('uses the defaults when nothing is saved', () => {
    expect(parseSound(null)).toEqual(DEFAULT_SOUND);
    expect(parseSound('loud')).toEqual(DEFAULT_SOUND);
  });

  it('keeps saved values', () => {
    const saved = { muted: true, volume: 0.3, engine: 0, rail: 0.5, horn: 1, ambience: 0.6, squeal: false };
    expect(parseSound(saved)).toEqual(saved);
  });

  it('defaults squeal and ambience when upgrading older saved sound settings', () => {
    const legacy = { muted: true, volume: 0.3, engine: 0, rail: 0.5, horn: 1 };
    expect(parseSound(legacy)).toEqual({ ...legacy, ambience: 1, squeal: true });
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

const baseAmbience = (over: Partial<AmbienceInput> = {}): AmbienceInput => ({
  preset: 'plains',
  cameraY: 20,
  groundY: 16,
  nearWaterY: 16,
  riverDist: 400,
  night: 0,
  cab: false,
  ...over,
});

describe('world ambience model', () => {
  it('increases wind with altitude and differs across landscapes', () => {
    const lowPlains = computeAmbienceParams(baseAmbience({ preset: 'plains', cameraY: 18, groundY: 14 }));
    const highAlpine = computeAmbienceParams(baseAmbience({ preset: 'alpine', cameraY: 180, groundY: 170 }));
    const islands = computeAmbienceParams(baseAmbience({ preset: 'islands', cameraY: 14, groundY: 8 }));

    expect(highAlpine.windGain).toBeGreaterThan(lowPlains.windGain * 2);
    expect(highAlpine.windFreq).toBeGreaterThan(lowPlains.windFreq);
    expect(islands.windGain).toBeGreaterThan(lowPlains.windGain);
  });

  it('activates river and coastal water sounds from WATER_LEVEL and river distance', () => {
    const dry = computeAmbienceParams(baseAmbience({ riverDist: 300, groundY: 20, nearWaterY: 20 }));
    const byRiver = computeAmbienceParams(baseAmbience({ riverDist: 18, cameraY: 10, groundY: -1, nearWaterY: -2 }));
    const highAboveRiver = computeAmbienceParams(
      baseAmbience({ riverDist: 18, cameraY: 90, groundY: -1, nearWaterY: -2 }),
    );
    const byCoast = computeAmbienceParams(
      baseAmbience({ preset: 'islands', riverDist: 400, cameraY: 8, groundY: 2, nearWaterY: -3 }),
    );

    expect(dry.riverGain).toBe(0);
    expect(dry.coastGain).toBe(0);
    expect(byRiver.riverGain).toBeGreaterThan(0.03);
    expect(highAboveRiver.riverGain).toBe(0);
    expect(byCoast.coastGain).toBeGreaterThan(0.02);
    expect(byCoast.riverGain).toBe(0);
  });

  it('crossfades day birds to night crickets and attenuates inside the cab', () => {
    const day = computeAmbienceParams(baseAmbience({ preset: 'plains', night: 0 }));
    const night = computeAmbienceParams(baseAmbience({ preset: 'plains', night: 1 }));
    const desertDay = computeAmbienceParams(baseAmbience({ preset: 'desert', night: 0 }));
    const cabDay = computeAmbienceParams(baseAmbience({ preset: 'plains', night: 0, cab: true }));

    expect(day.birdLevel).toBeGreaterThan(0.01);
    expect(day.cricketLevel).toBe(0);
    expect(night.birdLevel).toBe(0);
    expect(night.cricketLevel).toBeGreaterThan(0.01);
    expect(desertDay.birdLevel).toBeLessThan(day.birdLevel);
    expect(cabDay.windGain).toBeLessThan(day.windGain);
    expect(cabDay.birdLevel).toBeLessThan(day.birdLevel);
  });
});
