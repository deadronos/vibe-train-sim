import { describe, expect, it } from 'vitest';

import { EMPTY_FREIGHT, FREIGHT, PASSENGER, SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';
import type { Car } from '../src/rail/vehicles';

function straight(rise = 0) {
  const net = new Network();
  const a = net.addNode(-9000, 500, 0, 1, 0);
  const b = net.addNode(9000, 500 + rise, 0, 1, 0);
  return { net, seg: net.addSegment(a.id, 1, b.id, -1) };
}

function driven(cars: Car[], speed: number, set: (t: Train) => void) {
  const { net, seg } = straight();
  const sim = new Sim(net);
  const t = new Train(1, 'T', cars);
  t.ai = false;
  sim.trains.push(t);
  sim.place(t, seg.id, 2000, 1);
  t.speed = speed;
  set(t);
  return { sim, t };
}

function stop(cars: Car[], speed: number, set: (t: Train) => void) {
  const { sim, t } = driven(cars, speed, set);
  const start = t.headS;
  let time = 0;
  while (t.speed > 0 && time < 400) {
    sim.update(1 / 30);
    time += 1 / 30;
  }
  return { time, dist: t.headS - start };
}

const service = (t: Train) => {
  t.brake = 1;
};

describe('brakes depend on the train', () => {
  it('stops a freight train clearly later than a passenger train', () => {
    const express = stop(PASSENGER(), 25, service);
    const freight = stop(FREIGHT(), 25, service);
    expect(freight.dist).toBeGreaterThan(express.dist * 1.5);
    expect(freight.time).toBeGreaterThan(express.time * 1.3);
  });

  it('stops an empty freight train sooner than a loaded one', () => {
    expect(stop(EMPTY_FREIGHT(), 25, service).dist).toBeLessThan(stop(FREIGHT(), 25, service).dist);
  });

  it('takes time to build up, and longer on a longer train', () => {
    const build = (cars: Car[]) => {
      const { sim, t } = driven(cars, 25, service);
      let time = 0;
      while (t.airBrake < 1 && time < 30) {
        sim.update(1 / 30);
        time += 1 / 30;
      }
      return time;
    };
    expect(build(SHUTTLE())).toBeGreaterThan(1);
    expect(build(FREIGHT())).toBeGreaterThan(build(SHUTTLE()));
    const { sim, t } = driven(SHUTTLE(), 25, service);
    sim.update(1 / 30);
    expect(t.airBrake).toBeLessThan(0.1);
  });

  it('releases more slowly than it applies', () => {
    const { sim, t } = driven(FREIGHT(), 25, service);
    let apply = 0;
    while (t.airBrake < 1) {
      sim.update(1 / 30);
      apply += 1 / 30;
    }
    t.brake = 0;
    let release = 0;
    while (t.airBrake > 0) {
      sim.update(1 / 30);
      release += 1 / 30;
    }
    expect(release).toBeGreaterThan(apply);
  });

  it('stops shorter on the emergency brake, which also cuts the power', () => {
    const emergency = stop(FREIGHT(), 25, (t) => {
      t.emergency = true;
      t.throttle = 1;
    });
    expect(emergency.dist).toBeLessThan(stop(FREIGHT(), 25, service).dist);
  });

  it('slows the train on the engine brake alone, but it fades at walking pace', () => {
    const coast = driven(FREIGHT(), 20, () => {});
    const engine = driven(FREIGHT(), 20, (t) => (t.dynamic = 1));
    for (let i = 0; i < 300; i++) {
      coast.sim.update(1 / 30);
      engine.sim.update(1 / 30);
    }
    expect(engine.t.speed).toBeLessThan(coast.t.speed - 2);
    expect(engine.t.airBrake).toBe(0);
    expect(engine.t.dynamicDecel(0.5)).toBeLessThan(engine.t.dynamicDecel(10) / 2);
  });

  it('weakens the friction brake at speed', () => {
    const t = new Train(1, 'T', PASSENGER());
    expect(t.airDecel(40)).toBeLessThan(t.airDecel(5));
  });
});

describe('the autopilot brakes for its own train', () => {
  it('starts braking earlier in a freight train than in an express', () => {
    const speedNearSignal = (cars: Car[]) => {
      const { net, seg } = straight();
      const sig = net.split(seg.id, 8000);
      sig.signals[1] = { hold: true };
      const sim = new Sim(net);
      const t = new Train(1, 'T', cars);
      sim.trains.push(t);
      sim.place(t, seg.id, 1000, 1);
      while (sig.x - sim.head(t).x > 250) sim.update(1 / 30);
      return t.speed;
    };
    expect(speedNearSignal(FREIGHT())).toBeLessThan(speedNearSignal(PASSENGER()) - 2);
  });

  describe.each([
    ['express', PASSENGER],
    ['local', SHUTTLE],
    ['freight', FREIGHT],
    ['empty freight', EMPTY_FREIGHT],
  ] as const)('%s', (_name, cars) => {
    it('stops just short of a red signal', () => {
      const { net, seg } = straight();
      const sig = net.split(seg.id, 6000);
      sig.signals[1] = { hold: true };
      const sim = new Sim(net);
      const t = new Train(1, 'T', cars());
      sim.trains.push(t);
      sim.place(t, seg.id, 1000, 1);
      const events: string[] = [];
      sim.onEvent = (e) => events.push(e.kind);
      let top = 0;
      for (let i = 0; i < 400 * 30; i++) {
        sim.update(1 / 30);
        top = Math.max(top, t.speed);
      }
      expect(top).toBeGreaterThan(20);
      expect(events).not.toContain('spad');
      expect(t.speed).toBeLessThan(0.3);
      const gap = sig.x - sim.head(t).x;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(30);
    });

    it('stops at a station with the train alongside the platform', () => {
      const { net, seg } = straight();
      const node = net.split(seg.id, 6000);
      net.stations.push({ id: net.id(), name: 'End', nodeId: node.id, platformSide: 1, length: 300 });
      const sim = new Sim(net);
      const t = new Train(1, 'T', cars());
      sim.trains.push(t);
      sim.place(t, seg.id, 1000, 1);
      sim.plan(t, false);
      const arrivals: number[] = [];
      sim.onEvent = (e) => {
        if (e.kind === 'arrive') arrivals.push(sim.head(t).x);
      };
      for (let i = 0; i < 400 * 30 && !arrivals.length; i++) sim.update(1 / 30);
      expect(arrivals).toHaveLength(1);
      // The middle of the train stops at the station node.
      expect(Math.abs(arrivals[0] - t.length / 2 - node.x)).toBeLessThan(5);
    });

    it('stops at a red signal on the steepest descent the editor allows', () => {
      const { net, seg } = straight(-1260);
      const sig = net.split(seg.id, 6000);
      sig.signals[1] = { hold: true };
      const sim = new Sim(net);
      const t = new Train(1, 'T', cars());
      sim.trains.push(t);
      sim.place(t, seg.id, 2000, 1);
      const events: string[] = [];
      sim.onEvent = (e) => events.push(e.kind);
      for (let i = 0; i < 500 * 30; i++) sim.update(1 / 30);
      expect(events).not.toContain('spad');
      expect(t.speed).toBeLessThan(0.3);
      expect(sig.x - sim.head(t).x).toBeGreaterThan(0);
    });
  });
});
