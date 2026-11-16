import { describe, expect, it } from 'vitest';

import { buildDemoNetwork, populateDemoTrains, SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { clockText, Sim, STEP, Train, untilTime } from '../src/rail/sim';
import { Heightfield } from '../src/world/heightfield';

const H = 3600;

function railway() {
  const net = new Network();
  const nodes = [0, 500, 1000, 1500].map((x) => net.addNode(x, 10, 0, 1, 0));
  const segs = nodes.slice(1).map((n, i) => net.addSegment(nodes[i].id, 1, n.id, -1).id);
  const first = { id: net.id(), name: 'Ashby', nodeId: nodes[1].id, platformSide: 1 as const, length: 140 };
  const last = { id: net.id(), name: 'Bourne', nodeId: nodes[3].id, platformSide: 1 as const, length: 140 };
  net.stations.push(first, last);
  const sim = new Sim(net);
  sim.clock = 8 * H;
  return { net, sim, segs, first, last };
}

/** A train standing at Ashby with its doors about to close, due to leave at the given time. */
function atPlatform(ai: boolean, dep: number | null) {
  const r = railway();
  const t = new Train(1, 'T', SHUTTLE());
  r.sim.trains.push(t);
  r.sim.place(t, r.segs[1], t.length / 2, 1);
  t.ai = ai;
  t.schedule = [r.first.id, r.last.id];
  t.times = [dep, null];
  t.schedIdx = 0;
  t.targetStation = r.first.id;
  t.dwell = 0.1;
  return { ...r, t };
}

const run = (sim: Sim, seconds: number) => {
  for (let i = 0; i < seconds / STEP; i++) sim.update(STEP);
};

describe('clock times', () => {
  it('measures time to a departure across midnight', () => {
    expect(untilTime(8 * H, 23 * H)).toBe(9 * H);
    expect(untilTime(23 * H, 1 * H)).toBe(-2 * H);
    expect(untilTime(9 * H, 8 * H)).toBe(H);
  });

  it('formats times of day', () => {
    expect(clockText(8 * H + 5 * 60)).toBe('08:05');
    expect(clockText(-60)).toBe('23:59');
  });
});

describe('timetabled departures', () => {
  for (const ai of [true, false]) {
    it(`holds ${ai ? 'an autopilot' : 'a player'} train until its departure time`, () => {
      const { sim, t, last } = atPlatform(ai, 8 * H + 60);
      run(sim, 2);
      expect(t.dwell).toBeGreaterThan(0);
      expect(t.statusText).toBe('Leaves at 08:01');
      expect(sim.departureWait(t)).toBe(60);
      sim.clock += 61;
      run(sim, 0.5);
      expect(t.targetStation).toBe(last.id);
    });
  }

  it('leaves at once when the departure time has passed or there is none', () => {
    for (const dep of [7 * H, null]) {
      const { sim, t, last } = atPlatform(true, dep);
      run(sim, 0.5);
      expect(t.targetStation).toBe(last.id);
    }
  });

  it('is due at a timetabled stop a dwell before it leaves, and late once that has passed', () => {
    const { sim, t, last } = atPlatform(false, null);
    t.times = [null, 8 * H + 300];
    t.schedIdx = 1;
    t.targetStation = last.id;
    expect(sim.dueIn(t)).toBeCloseTo(300 - 22, 5);
    sim.clock = 8 * H + 400;
    expect(sim.dueIn(t)).toBeLessThan(0);
  });

  it('falls back to an estimate from the route without a time', () => {
    const { sim, t } = atPlatform(false, null);
    sim.plan(t, true);
    expect(sim.dueIn(t)).toBeGreaterThan(40);
  });
});

describe('a timetabled starter railway', () => {
  it('never lets a train leave a stop early, and still runs without collisions', () => {
    const hf = new Heightfield('alpine', 1);
    const { net, stations } = buildDemoNetwork(hf);
    const sim = new Sim(net);
    populateDemoTrains(sim, stations);
    const start = 7 * H;
    sim.clock = start;
    // Every stop gets a departure five minutes after the one before, so trains have to wait at some of them.
    for (const t of sim.trains) {
      const stops = sim.stops(t);
      t.schedule = stops.map((s) => s.id);
      t.times = stops.map((_, k) => start + (k + 1) * 300);
      t.schedIdx = 0;
      sim.plan(t, false);
    }
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e.kind);
    const early: string[] = [];
    let waited = 0;
    for (let i = 0; i < 30 * 60 * 10; i++) {
      const before = sim.trains.map((t) => ({ idx: t.schedIdx, dwell: t.dwell }));
      sim.clock = start + i * 0.1;
      sim.update(0.1);
      sim.trains.forEach((t, k) => {
        if (t.statusText.startsWith('Leaves at')) waited++;
        // Leaving a platform moves the train on to its next stop.
        if (before[k].dwell > 0 && t.dwell <= 0 && t.schedIdx !== before[k].idx) {
          const dep = t.times[before[k].idx];
          if (dep !== null && untilTime(dep, sim.clock) > 0.2) early.push(`${t.name} left at ${clockText(sim.clock)}`);
        }
      });
    }
    expect(early).toEqual([]);
    expect(waited).toBeGreaterThan(0);
    expect(events).not.toContain('collision');
    for (const t of sim.trains) expect(t.score.stops, `${t.name} made too few stops`).toBeGreaterThan(3);
  });
});
