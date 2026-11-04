import { describe, expect, it } from 'vitest';

import { SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';
import type { Car, CarType } from '../src/rail/vehicles';

const consist = (...types: CarType[]): Car[] => types.map((type) => ({ type, flip: false }));
const LONG = (): Car[] => consist('loco_freight', ...(Array(20).fill('wagon_box') as CarType[]));

describe('gravity along the whole train', () => {
  // A short rise with level track either side. Speed is held so only the grade force changes.
  function swingOverRise(cars: Car[]) {
    const net = new Network();
    const xs = [0, 1900, 1960, 2020, 2080, 4000];
    const ys = [100, 100, 100, 104, 104, 104];
    const nodes = xs.map((x, i) => net.addNode(x, ys[i], 0, 1, 0));
    const segs = nodes.slice(1).map((n, i) => net.addSegment(nodes[i].id, 1, n.id, -1));
    const sim = new Sim(net);
    const t = new Train(1, 'T', cars);
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, segs[0].id, 1000, 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      t.speed = 25;
      sim.update(1 / 30);
      const a = (t.speed - 25) * 30;
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    return hi - lo;
  }

  it('spreads a sharp change of grade along a long train', () => {
    const short = swingOverRise(consist('loco_freight'));
    const long = swingOverRise(LONG());
    // Taken at the head alone, a long train would feel the rise as sharply as a single locomotive.
    expect(short).toBeGreaterThan(0.4);
    expect(long).toBeLessThan(short / 3);
  });
});

describe('climbing', () => {
  function climb(cars: Car[], grade: number) {
    const net = new Network();
    const a = net.addNode(0, 0, 0, 1, 0);
    const b = net.addNode(4000, 4000 * grade, 0, 1, 0);
    const seg = net.addSegment(a.id, 1, b.id, -1);
    const sim = new Sim(net);
    const t = new Train(1, 'T', cars);
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, seg.id, 800, 1);
    t.speed = 15;
    t.throttle = 1;
    for (let i = 0; i < 120 * 30; i++) sim.update(1 / 30);
    return { sim, t };
  }

  it('stalls a heavy train on a steep climb', () => {
    const { t } = climb(consist('loco_light', 'wagon_tank', 'wagon_tank', 'wagon_tank', 'wagon_tank'), 0.07);
    expect(t.speed).toBe(0);
  });

  it('lets a train with enough power get up the same climb', () => {
    const { t } = climb(SHUTTLE(), 0.07);
    expect(t.speed).toBeGreaterThan(3);
  });
});

describe('curve resistance', () => {
  function coast(radiusOffset: number) {
    const net = new Network();
    // A quarter circle when the offset is non-zero, a straight line of the same length otherwise.
    const r = 150;
    const a = net.addNode(0, 100, 0, 1, 0);
    const b = radiusOffset ? net.addNode(r, 100, r, 0, 1) : net.addNode((Math.PI * r) / 2, 100, 0, 1, 0);
    const seg = net.addSegment(a.id, 1, b.id, -1);
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, seg.id, net.geom.get(seg.id)!.length * 0.5, 1);
    t.speed = 12;
    for (let i = 0; i < 30; i++) sim.update(1 / 30);
    return t.speed;
  }

  it('slows a train more in a curve than on a straight', () => {
    expect(coast(1)).toBeLessThan(coast(0) - 0.01);
  });
});

describe('adhesion', () => {
  function start(cars: Car[], ai: boolean) {
    const net = new Network();
    const a = net.addNode(0, 100, 0, 1, 0);
    const b = net.addNode(3000, 100, 0, 1, 0);
    const seg = net.addSegment(a.id, 1, b.id, -1);
    const sim = new Sim(net);
    const t = new Train(1, 'T', cars);
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, seg.id, 500, 1);
    t.throttle = 1;
    t.speed = 1;
    sim.update(1 / 30);
    t.ai = ai;
    return { sim, t };
  }

  it('slips the wheels of a strong locomotive at full power from a standstill, and warns', () => {
    const { t } = start(consist('loco_freight', 'wagon_tank'), false);
    expect(t.tractiveForce(1)).toBeGreaterThan(t.adhesionLimit);
    expect(t.slipping).toBe(true);
  });

  it('accelerates a slipping train less than one held at the limit', () => {
    const slip = start(consist('loco_freight', 'wagon_tank'), false);
    const held = start(consist('loco_freight', 'wagon_tank'), false);
    held.t.throttle = (held.t.adhesionLimit / held.t.tractiveForce(1)) * 0.98;
    const v = [slip.t.speed, held.t.speed];
    slip.sim.update(1 / 30);
    held.sim.update(1 / 30);
    expect(held.t.speed - v[1]).toBeGreaterThan(slip.t.speed - v[0]);
    expect(held.t.slipping).toBe(false);
  });

  it('stops slipping once speed brings the force under the limit', () => {
    const { sim, t } = start(consist('loco_freight', 'wagon_tank'), false);
    for (let i = 0; i < 60 * 30; i++) sim.update(1 / 30);
    expect(t.slipping).toBe(false);
  });

  it('never slips under the autopilot', () => {
    const { sim, t } = start(consist('loco_freight', 'wagon_tank'), true);
    sim.update(1 / 30);
    expect(t.slipping).toBe(false);
  });
});
