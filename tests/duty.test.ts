import { describe, expect, it } from 'vitest';

import { SHUTTLE } from '../src/rail/demoMap';
import { clock, Duty, OVERSPEED_MARGIN, PENALTY } from '../src/rail/duty';
import { Network } from '../src/rail/network';
import type { SimEvent } from '../src/rail/sim';
import { Sim, STEP, Train } from '../src/rail/sim';

/** A straight line of 500 m sections with a station at the second node and another at the end. */
function railway() {
  const net = new Network();
  const nodes = [0, 500, 1000, 1500].map((x) => net.addNode(x, 10, 0, 1, 0));
  const segs = nodes.slice(1).map((n, i) => net.addSegment(nodes[i].id, 1, n.id, -1).id);
  const first = { id: net.id(), name: 'Ashby', nodeId: nodes[1].id, platformSide: 1 as const, length: 140 };
  const last = { id: net.id(), name: 'Bourne', nodeId: nodes[3].id, platformSide: 1 as const, length: 140 };
  net.stations.push(first, last);
  const sim = new Sim(net);
  const events: SimEvent[] = [];
  sim.onEvent = (e) => events.push(e);
  return { net, sim, segs, first, last, events };
}

/** A player train due at Ashby, with its head s metres along section seg (0 is the section into Ashby). */
function driving(seg: number, s: (t: Train) => number, speed = 0) {
  const r = railway();
  const t = new Train(1, 'T', SHUTTLE());
  r.sim.trains.push(t);
  r.sim.place(t, r.segs[seg], s(t), 1);
  t.ai = false;
  t.speed = speed;
  t.targetStation = r.first.id;
  t.duty = new Duty();
  return { ...r, t };
}

const run = (sim: Sim, seconds: number) => {
  for (let i = 0; i < seconds / STEP; i++) sim.update(STEP);
};

describe('driving a service by hand', () => {
  it('counts a stop with the train in the platform, opens the doors, then sets the next stop', () => {
    const { sim, t, events, last } = driving(1, (tr) => tr.length / 2);
    run(sim, 0.2);
    expect(events.map((e) => e.kind)).toContain('stop');
    expect(t.duty!.stops).toBe(1);
    expect(t.duty!.total).toBe(150);
    expect(t.dwell).toBeGreaterThan(0);
    // Doors open: power does nothing.
    t.throttle = 1;
    run(sim, 2);
    expect(t.speed).toBe(0);
    run(sim, 25);
    expect(events.at(-1)!.kind).toBe('depart');
    expect(t.targetStation).toBe(last.id);
    expect(t.duty!.due).not.toBeNull();
  });

  it('scores a stop off the mark lower', () => {
    const { sim, t } = driving(1, (tr) => tr.length / 2 + 20);
    run(sim, 0.2);
    expect(t.duty!.stops).toBe(1);
    expect(t.duty!.total).toBeLessThan(150);
    expect(t.duty!.total).toBeGreaterThanOrEqual(100);
  });

  it('asks the driver to draw forward when the train is short of the platform', () => {
    // Head 30 m short of the station point: the tail is off the platform.
    const { sim, t, events } = driving(0, () => 470);
    run(sim, 0.2);
    expect(events).toHaveLength(0);
    expect(t.status.kind).toBe('draw_forward');
  });

  it('counts a miss when the train leaves its stop behind', () => {
    const { sim, t, events, last } = driving(1, (tr) => tr.length + 60);
    t.passedStop = true;
    run(sim, 0.2);
    expect(events[0].kind).toBe('missed');
    expect(t.duty!.total).toBe(-PENALTY.missed);
    expect(t.targetStation).toBe(last.id);
  });

  it('leaves the head having crossed the station point marked as passed', () => {
    const { sim, t } = driving(0, () => 495, 10);
    run(sim, 1.5);
    expect(t.passedStop).toBe(true);
  });
});

describe('strict rules', () => {
  it('brakes a train going well over the limit, and only under strict rules', () => {
    for (const strict of [false, true]) {
      const { sim, t, events } = driving(1, () => 200);
      sim.strict = strict;
      t.targetStation = null;
      run(sim, 0.1);
      t.speed = t.limit + 5;
      run(sim, 0.1);
      expect(t.tripped).toBe(strict);
      expect(events.some((e) => e.kind === 'protection')).toBe(strict);
    }
  });

  it('damages a train that hits the buffer stop hard, and recovery lets it move again', () => {
    const { sim, t, events } = driving(2, () => 480, 12);
    sim.strict = true;
    t.targetStation = null;
    run(sim, 3);
    expect(t.damaged).toBe(true);
    expect(events.some((e) => e.kind === 'damage')).toBe(true);
    expect(t.duty!.total).toBeLessThanOrEqual(-PENALTY.damage);
    sim.recover(t);
    expect(t.damaged).toBe(false);
  });

  it('keeps damage across a save', () => {
    const { sim, t } = driving(1, () => 200);
    t.damaged = true;
    const state = sim.captureState(t);
    const u = new Train(2, 'U', SHUTTLE());
    sim.trains.push(u);
    expect(sim.restoreState(u, state)).toBe(true);
    expect(u.damaged).toBe(true);
  });
});

describe('duty score', () => {
  it('charges time well over the limit and reports each spell once', () => {
    const d = new Duty();
    d.overspeed(1, 20 + OVERSPEED_MARGIN - 0.1, 20);
    expect(d.points).toBe(0);
    for (let i = 0; i < 4; i++) d.overspeed(1, 25, 20);
    d.overspeed(1, 19, 20);
    expect(d.total).toBe(-12);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].text).toMatch(/72 km\/h limit for 4 s, up to 90 km\/h/);
  });

  it('takes punctuality off a late stop', () => {
    const d = new Duty();
    d.startLeg(0, 100);
    expect(d.stop('Ashby', 0, 100)).toBe(150);
    d.startLeg(0, 100);
    expect(d.stop('Ashby', 0, 160)).toBe(130);
    expect(d.lines[1].text).toMatch(/1:00 late/);
  });

  it('formats times as minutes and seconds', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(-3)).toBe('0:00');
  });
});
