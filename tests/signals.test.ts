import { describe, expect, it } from 'vitest';

import { SHUTTLE } from '../src/rail/demoMap';
import { computeSpeedSigns, CROSSING_CLEARANCE, Network, speedBoardKmh } from '../src/rail/network';
import type { SimEvent } from '../src/rail/sim';
import { keyOf, SHUNT_VMAX, Sim, STEP, Train, WARN_ACK_SECONDS } from '../src/rail/sim';

function straightLine(lengths = [400, 400, 400]) {
  const net = new Network();
  let x = 0;
  const nodes = [net.addNode(x, 10, 0, 1, 0)];
  for (const len of lengths) {
    x += len;
    nodes.push(net.addNode(x, 10, 0, 1, 0));
  }
  const segs = nodes.slice(1).map((n, i) => net.addSegment(nodes[i].id, 1, n.id, -1));
  return { net, nodes, segs };
}

const run = (sim: Sim, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / STEP); i++) sim.update(STEP);
};

describe('signal types', () => {
  it('distant signal previews the next main signal without blocking a section', () => {
    const { net, nodes, segs } = straightLine([400, 400, 400]);
    // Distant at nodes[1], main at nodes[2] (held red).
    nodes[1].signals[1] = { hold: false, type: 'distant' };
    nodes[2].signals[1] = { hold: true, type: 'main' };
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, segs[0].id, 100, 1);
    sim.interlock();

    expect(sim.aspects.get(keyOf(nodes[2].id, 1))).toBe('red');
    expect(sim.aspects.get(keyOf(nodes[1].id, 1))).toBe('yellow');
    // AI passes the yellow distant signal without stopping at it, and stops at the red main signal.
    run(sim, 50);
    expect(sim.head(t).x).toBeGreaterThan(450);
    expect(sim.head(t).x).toBeLessThan(800);
    expect(t.score.spads).toBe(0);

    // Clearing the main signal turns the distant green.
    nodes[2].signals[1].hold = false;
    sim.interlock();
    expect(sim.aspects.get(keyOf(nodes[1].id, 1))).toBe('green');
  });

  it('shows route direction and diverging yellow aspect when taking a slower turnout', () => {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(400, 10, 0, 1, 0);
    const c = net.addNode(800, 10, 0, 1, 0);
    const e = net.addNode(1200, 10, 0, 1, 0);
    const d = net.addNode(620, 10, 220, 0.5, 0.866);
    const s1 = net.addSegment(a.id, 1, b.id, -1);
    net.addSegment(b.id, 1, c.id, -1);
    net.addSegment(c.id, 1, e.id, -1);
    const branch = net.addSegment(b.id, 1, d.id, -1);
    b.signals[1] = { hold: false, type: 'main' };
    c.signals[1] = { hold: false, type: 'main' };

    const sim = new Sim(net);
    sim.interlock();
    const straightInd = sim.indications.get(keyOf(b.id, 1))!;
    expect(straightInd.aspect).toBe('green');
    expect(straightInd.route?.diverging).toBe(false);
    expect(straightInd.route?.dir).toBe('straight');

    // Throw points onto the sharp right-hand turnout.
    net.throwSwitch(b.id, 1);
    expect(net.selected(b.id, 1)).toBe(branch.id);
    sim.interlock();
    const divInd = sim.indications.get(keyOf(b.id, 1))!;
    expect(divInd.route?.diverging).toBe(true);
    expect(divInd.route?.dir).toBe('right');
    expect(divInd.route?.index).toBe(1);
    expect(divInd.aspect).toBe('yellow');
    void s1;
  });

  it('allows a train into an occupied platform under a calling-on signal at restricted speed', () => {
    const { net, nodes, segs } = straightLine([400, 300]);
    const st = { id: net.id(), name: 'Terminus', nodeId: nodes[2].id, platformSide: 1 as const, length: 140 };
    net.stations.push(st);
    nodes[1].signals[1] = { hold: false, type: 'shunt' };

    const sim = new Sim(net);
    const parked = new Train(1, 'Parked', SHUTTLE());
    const incoming = new Train(2, 'Incoming', SHUTTLE());
    parked.ai = false; // Standing at the platform
    sim.trains.push(parked, incoming);
    sim.place(parked, segs[1].id, 260, 1);
    sim.place(incoming, segs[0].id, 100, 1);
    sim.interlock();

    const ind = sim.indications.get(keyOf(nodes[1].id, 1))!;
    expect(ind.type).toBe('shunt');
    expect(ind.callingOn).toBe(true);
    expect(ind.aspect).toBe('yellow');

    const events: SimEvent[] = [];
    sim.onEvent = (e) => events.push(e);
    run(sim, 60);

    expect(events.some((e) => e.kind === 'collision')).toBe(false);
    expect(sim.head(incoming).seg).toBe(segs[1].id);
    expect(incoming.restricted).toBe(true);
    expect(sim.deskInfo(incoming).limit).toBeLessThanOrEqual(SHUNT_VMAX + 0.01);
  });

  it('blocks a calling-on signal when an opposing train is moving toward it', () => {
    const { net, nodes, segs } = straightLine([400, 400]);
    nodes[1].signals[1] = { hold: false, type: 'shunt' };
    const sim = new Sim(net);
    const opposing = new Train(1, 'Opposing', SHUTTLE());
    opposing.ai = false;
    sim.trains.push(opposing);
    sim.place(opposing, segs[1].id, 300, -1);
    opposing.speed = 8;
    sim.interlock();

    const ind = sim.indications.get(keyOf(nodes[1].id, 1))!;
    expect(ind.aspect).toBe('red');
    expect(ind.callingOn).toBe(false);
  });

  it('clears restricted shunt speed at a subsequent main signal and preserves it in state', () => {
    const { net, nodes, segs } = straightLine([400, 400, 400]);
    nodes[1].signals[1] = { hold: false, type: 'shunt' };
    nodes[2].signals[1] = { hold: false, type: 'main' };
    const sim = new Sim(net);
    const t = new Train(1, 'Shunter', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, segs[0].id, 300, 1);
    sim.interlock();
    run(sim, 25);
    expect(t.restricted).toBe(true);
    const saved = sim.captureState(t);
    expect(saved.restricted).toBe(true);
    run(sim, 60);
    expect(sim.head(t).x).toBeGreaterThan(800);
    expect(t.restricted).toBe(false);
  });
});

describe('lineside speed boards', () => {
  it('places main and advance warning boards for speed reductions and custom limits', () => {
    const { net, segs } = straightLine([500, 400, 400]);
    segs[1].speedLimit = 60 / 3.6;
    net.rebuild(segs[1].id);

    const signs = computeSpeedSigns(net);
    // Entering segs[1] (120 -> 60 km/h) produces a 60 board on segs[1] and a 250 m advance board on segs[0].
    const mainDrop = signs.find((s) => s.seg === segs[1].id && s.dir === 1 && !s.advance);
    const advDrop = signs.find((s) => s.seg === segs[0].id && s.dir === 1 && s.advance);
    expect(mainDrop?.kmh).toBe(60);
    expect(advDrop?.kmh).toBe(60);
    expect(advDrop!.s).toBeCloseTo(250, 0);
    // Resuming 120 km/h entering segs[2].
    const resume = signs.find((s) => s.seg === segs[2].id && s.dir === 1 && !s.advance);
    expect(resume?.kmh).toBe(speedBoardKmh(33.3));

    // Splitting a segment preserves its custom speed limit.
    const mid = net.split(segs[1].id, 200);
    const segAfter = net.segs.get(net.attached(mid.id, 1)[0])!;
    expect(segAfter.speedLimit).toBeCloseTo(60 / 3.6, 5);
  });
});

describe('train protection warnings and SPAD stop', () => {
  it('warns on approaching yellow/red signal, lets driver acknowledge, or brakes if unacknowledged', () => {
    const { net, nodes, segs } = straightLine([600]);
    const mid = net.split(segs[0].id, 400);
    mid.signals[1] = { hold: true, type: 'main' };

    const sim = new Sim(net);
    sim.strict = true;
    const t = new Train(1, 'Driver', SHUTTLE());
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, segs[0].id, 250, 1);
    t.speed = 12;
    sim.interlock();

    // Advance slightly so warning triggers within 220 m.
    run(sim, 0.2);
    expect(t.warning).not.toBeNull();
    expect(t.warning!.acknowledged).toBe(false);

    // Acknowledge prevents brake intervention.
    sim.acknowledge(t);
    expect(t.warning!.acknowledged).toBe(true);
    run(sim, WARN_ACK_SECONDS + 0.5);
    expect(t.tripped).toBe(false);

    // Without acknowledge on a fresh train, unacknowledged warning trips the brakes.
    const sim2 = new Sim(net);
    sim2.strict = true;
    const t2 = new Train(2, 'Forgetful', SHUTTLE());
    t2.ai = false;
    sim2.trains.push(t2);
    sim2.place(t2, segs[0].id, 250, 1);
    t2.speed = 12;
    sim2.interlock();
    const ev2: SimEvent[] = [];
    sim2.onEvent = (e) => ev2.push(e);
    run(sim2, WARN_ACK_SECONDS + 0.5);
    expect(t2.tripped).toBe(true);
    expect(ev2.some((e) => e.kind === 'protection')).toBe(true);
    void nodes;
  });

  it('stops a train with emergency brake on SPAD under strict rules until reset', () => {
    const { net, segs } = straightLine([600]);
    const mid = net.split(segs[0].id, 300);
    mid.signals[1] = { hold: true, type: 'main' };

    const sim = new Sim(net);
    sim.strict = true;
    const t = new Train(1, 'Spad', SHUTTLE());
    t.ai = false;
    t.throttle = 1;
    sim.trains.push(t);
    sim.place(t, segs[0].id, 270, 1);
    t.speed = 15;
    sim.interlock();

    run(sim, 3);
    expect(t.score.spads).toBeGreaterThan(0);
    expect(t.spadTripped).toBe(true);
    expect(t.tripped).toBe(true);

    // Let emergency brakes bring it to a stand, then acknowledge/reset.
    t.throttle = 0;
    run(sim, 12);
    expect(t.speed).toBeLessThan(0.2);
    sim.acknowledge(t);
    expect(t.spadTripped).toBe(false);
    expect(t.tripped).toBe(false);
  });
});

describe('level crossings and interlocking', () => {
  function crossingNetwork(heightDiff = 0) {
    const net = new Network();
    // Line 1: East-West along z = 0
    const w0 = net.addNode(-500, 10, 0, 1, 0);
    const w1 = net.addNode(-60, 10, 0, 1, 0);
    const w2 = net.addNode(60, 10, 0, 1, 0);
    const w3 = net.addNode(500, 10, 0, 1, 0);
    const ew1 = net.addSegment(w0.id, 1, w1.id, -1);
    const ewCross = net.addSegment(w1.id, 1, w2.id, -1);
    const ew3 = net.addSegment(w2.id, 1, w3.id, -1);
    w1.signals[1] = { hold: false, type: 'main' };
    w2.signals[-1] = { hold: false, type: 'main' };

    // Line 2: North-South along x = 0
    const y2 = 10 + heightDiff;
    const n0 = net.addNode(0, y2, -500, 0, 1);
    const n1 = net.addNode(0, y2, -60, 0, 1);
    const n2 = net.addNode(0, y2, 60, 0, 1);
    const n3 = net.addNode(0, y2, 500, 0, 1);
    const ns1 = net.addSegment(n0.id, 1, n1.id, -1);
    const nsCross = net.addSegment(n1.id, 1, n2.id, -1);
    const ns3 = net.addSegment(n2.id, 1, n3.id, -1);
    n1.signals[1] = { hold: false, type: 'main' };
    n2.signals[1] = { hold: false, type: 'main' };
    n2.signals[-1] = { hold: false, type: 'main' };

    return { net, w0, w1, w2, w3, ew1, ewCross, ew3, n0, n1, n2, n3, ns1, nsCross, ns3 };
  }

  it('detects at-grade crossings and ignores grade-separated bridges', () => {
    const flat = crossingNetwork(0);
    expect(flat.net.crossings).toHaveLength(1);
    expect(flat.net.crossings[0].x).toBeCloseTo(0, 1);
    expect(flat.net.crossings[0].z).toBeCloseTo(0, 1);

    const bridge = crossingNetwork(CROSSING_CLEARANCE + 1.5);
    expect(bridge.net.crossings).toHaveLength(0);
  });

  it('interlocks crossing lines so conflicting signals stay red and AI trains do not collide', () => {
    const { net, w1, w3, n1, n3, ew1, ewCross, ns1 } = crossingNetwork(0);
    net.stations.push(
      { id: net.id(), name: 'EastEnd', nodeId: w3.id, platformSide: 1, length: 120 },
      { id: net.id(), name: 'SouthEnd', nodeId: n3.id, platformSide: 1, length: 120 },
    );

    const sim = new Sim(net);
    const eastbound = new Train(1, 'Eastbound', SHUTTLE());
    const southbound = new Train(2, 'Southbound', SHUTTLE());
    eastbound.schedule = [net.stations[0].id];
    southbound.schedule = [net.stations[1].id];
    sim.trains.push(eastbound, southbound);
    // Eastbound is already on the crossing diamond; southbound approaches from the north.
    sim.place(eastbound, ewCross.id, 60, 1);
    sim.place(southbound, ns1.id, 300, 1);
    sim.interlock();

    expect(sim.aspects.get(keyOf(n1.id, 1))).toBe('red');
    expect(sim.crossingClaims.get(net.crossings[0].id)).toBe(eastbound.id);

    const events: SimEvent[] = [];
    sim.onEvent = (e) => events.push(e);
    run(sim, 60);
    expect(events.some((e) => e.kind === 'collision')).toBe(false);
    // Southbound gets green and reaches SouthEnd once Eastbound clears the diamond.
    expect(sim.aspects.get(keyOf(n1.id, 1))).not.toBe('red');
    expect(sim.head(southbound).z).toBeGreaterThan(60);

    // Also test both starting at equal distance before the diamond.
    const sim2 = new Sim(net);
    const a = new Train(1, 'A', SHUTTLE());
    const b = new Train(2, 'B', SHUTTLE());
    a.schedule = [net.stations[0].id];
    b.schedule = [net.stations[1].id];
    sim2.trains.push(a, b);
    sim2.place(a, ew1.id, 250, 1);
    sim2.place(b, ns1.id, 250, 1);
    const ev2: SimEvent[] = [];
    sim2.onEvent = (e) => ev2.push(e);
    run(sim2, 60);
    expect(ev2.some((e) => e.kind === 'collision')).toBe(false);
    expect(sim2.head(a).x).toBeGreaterThan(60);
    expect(sim2.head(b).z).toBeGreaterThan(60);
    void w1;
  });

  it('round-trips signal types, segment speed limits, and crossings through Network JSON', () => {
    const { net, w1, ew1, n1 } = crossingNetwork(0);
    w1.signals[1] = { hold: false, type: 'shunt' };
    ew1.speedLimit = 50 / 3.6;
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.crossings).toHaveLength(1);
    expect(copy.nodes.get(w1.id)!.signals[1]!.type).toBe('shunt');
    expect(copy.segs.get(ew1.id)!.speedLimit).toBeCloseTo(50 / 3.6, 5);

    // Calling-on signal stays red when the crossing line occupies/claims the diamond.
    const sim = new Sim(net);
    const nsTrain = new Train(1, 'NS', SHUTTLE());
    sim.trains.push(nsTrain);
    sim.place(nsTrain, net.attached(n1.id, 1)[0], 60, 1);
    sim.interlock();
    expect(sim.aspects.get(keyOf(w1.id, 1))).toBe('red');
    expect(sim.indications.get(keyOf(w1.id, 1))!.callingOn).toBe(false);
  });
});
