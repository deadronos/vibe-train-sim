import { describe, expect, it } from 'vitest';

import { EMPTY_FREIGHT, FREIGHT, PASSENGER, SHUTTLE } from '../src/rail/demoMap';
import { LINE_VMAX, Network } from '../src/rail/network';
import type { Dir } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';
import type { Car } from '../src/rail/vehicles';

const KINDS: [string, () => Car[]][] = [
  ['express', PASSENGER],
  ['local', SHUTTLE],
  ['freight', FREIGHT],
  ['empties', EMPTY_FREIGHT],
];

function onTrack(net: Network, seg: number, s: number, dir: Dir, cars: Car[] = SHUTTLE()) {
  const sim = new Sim(net);
  const t = new Train(1, 'T', cars);
  t.ai = false;
  sim.trains.push(t);
  sim.place(t, seg, s, dir);
  return { sim, t };
}

function straight(rise = 0) {
  const net = new Network();
  const a = net.addNode(-9000, 500, 0, 1, 0);
  const b = net.addNode(9000, 500 + rise, 0, 1, 0);
  return { net, seg: net.addSegment(a.id, 1, b.id, -1).id };
}

/** A straight kilometre, then a tight curve with a lower limit. */
function curveAhead() {
  const net = new Network();
  const a = net.addNode(0, 10, 0, 1, 0);
  const b = net.addNode(1000, 10, 0, 1, 0);
  const c = net.addNode(1250, 10, 250, 0, 1);
  const s1 = net.addSegment(a.id, 1, b.id, -1).id;
  const s2 = net.addSegment(b.id, 1, c.id, -1).id;
  return { net, s1, s2, b };
}

describe("driver's desk", () => {
  it.each(KINDS)('predicts where a %s train stops at full brake', (_, cars) => {
    for (const rise of [0, -180]) {
      const { net, seg } = straight(rise);
      const { sim, t } = onTrack(net, seg, 2000, 1, cars());
      t.speed = 25;
      const predicted = sim.deskInfo(t).brakingDistance;
      const start = t.headS;
      t.brake = 1;
      t.dynamic = 1;
      for (let i = 0; i < 30 * 400 && t.speed > 0; i++) sim.update(1 / 30);
      const actual = t.headS - start;
      expect(Math.abs(predicted - actual) / actual).toBeLessThan(0.08);
    }
  });

  it('counts brake already applied, so a braking train needs less room', () => {
    const { net, seg } = straight();
    const { sim, t } = onTrack(net, seg, 2000, 1, FREIGHT());
    t.speed = 20;
    const released = sim.deskInfo(t).brakingDistance;
    t.airBrake = 1;
    expect(sim.deskInfo(t).brakingDistance).toBeLessThan(released);
  });

  it('needs no room when standing', () => {
    const { net, seg } = straight();
    const { sim, t } = onTrack(net, seg, 2000, 1);
    expect(sim.deskInfo(t).brakingDistance).toBe(0);
  });

  it('shows the lower limit of a curve ahead and how far away it starts', () => {
    const { net, s1, s2 } = curveAhead();
    const { sim, t } = onTrack(net, s1, 300, 1);
    const info = sim.deskInfo(t);
    expect(info.limit).toBeCloseTo(Math.min(LINE_VMAX, t.topSpeed), 3);
    expect(info.nextLimit).not.toBeNull();
    expect(info.nextLimit!.speed).toBeCloseTo(net.geom.get(s2)!.vmax, 3);
    expect(info.nextLimit!.dist).toBeCloseTo(net.geom.get(s1)!.length - 300, 0);
  });

  it('shows no lower limit when the line ahead is as fast, or the curve is behind', () => {
    const { net, s1 } = curveAhead();
    expect(onTrack(net, s1, 300, -1).sim.deskInfo(onTrack(net, s1, 300, -1).t).nextLimit).toBeNull();
    const plain = straight();
    const { sim, t } = onTrack(plain.net, plain.seg, 2000, 1);
    expect(sim.deskInfo(t).nextLimit).toBeNull();
  });

  it('caps the limit at the train’s own top speed', () => {
    const { net, seg } = straight();
    const { sim, t } = onTrack(net, seg, 2000, 1, FREIGHT());
    expect(sim.deskInfo(t).limit).toBeCloseTo(t.topSpeed, 3);
  });

  it('reads the gradient ahead in the direction of travel', () => {
    const { net, seg } = straight(90); // 1 in 200
    expect(onTrack(net, seg, 4000, 1).sim.deskInfo(onTrack(net, seg, 4000, 1).t).gradient).toBeCloseTo(0.005, 3);
    const down = onTrack(net, seg, 4000, -1);
    expect(down.sim.deskInfo(down.t).gradient).toBeCloseTo(-0.005, 3);
  });

  it('reads the gradient up to the end of the line when that is close', () => {
    const { net, seg } = straight(90);
    const length = net.geom.get(seg)!.length;
    const { sim, t } = onTrack(net, seg, length - 100, 1);
    expect(sim.deskInfo(t).gradient).toBeCloseTo(0.005, 3);
  });
});

describe('looking ahead', () => {
  it('finds the next signal, station and junction along the route', () => {
    const { net, s1, b } = curveAhead();
    const branchEnd = net.addNode(1300, 10, -200, 1, 0);
    net.addSegment(b.id, 1, branchEnd.id, -1);
    net.split(s1, 700).signals[1] = { hold: false };
    const { sim, t } = onTrack(net, s1, 200, 1);
    sim.interlock();
    expect(sim.signalAhead(t)!.dist).toBeCloseTo(500, 0);
    const j = sim.nextJunction(t, 1000)!;
    expect(j.dist).toBeCloseTo(800, 0);
    expect(j.options).toHaveLength(2);
    expect(sim.nextJunction(t, 800)).toBeNull();
    expect(sim.stationAhead(t)).toBeNull();
  });
});
