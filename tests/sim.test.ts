import { describe, expect, it } from 'vitest';
import { Network } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';
import { buildDemoNetwork, populateDemoTrains, SHUTTLE } from '../src/rail/demoMap';
import { Heightfield } from '../src/world/heightfield';

function line() {
  const net = new Network();
  const a = net.addNode(0, 10, 0, 1, 0);
  const b = net.addNode(500, 10, 0, 1, 0);
  const c = net.addNode(1000, 10, 0, 1, 0);
  const s1 = net.addSegment(a.id, 1, b.id, -1);
  const s2 = net.addSegment(b.id, 1, c.id, -1);
  return { net, a, b, c, s1, s2 };
}

describe('network', () => {
  it('builds nearly straight geometry at the right length', () => {
    const { net, s1 } = line();
    expect(net.geom.get(s1.id)!.length).toBeCloseTo(500, 0);
  });

  it('turns a side with two segments into a throwable junction', () => {
    const { net, b, s2 } = line();
    const d = net.addNode(900, 10, 300, 0.7, 0.7);
    const branch = net.addSegment(b.id, 1, d.id, -1);
    expect(net.isJunction(b.id)).toBe(true);
    expect(net.selected(b.id, 1)).toBe(s2.id);
    net.throwSwitch(b.id, 1);
    expect(net.selected(b.id, 1)).toBe(branch.id);
  });

  it('keeps connectivity through a split', () => {
    const { net, s1 } = line();
    const before = net.segs.size;
    const n = net.split(s1.id, 200);
    expect(net.segs.size).toBe(before + 1);
    expect(n.x).toBeCloseTo(200, 0);
    expect(net.exit(s1.id, 1).node).toBe(n.id);
    expect(net.attached(n.id, 1).length).toBe(1);
  });

  it('round-trips through JSON', () => {
    const { net, b } = line();
    b.signals[1] = { hold: true };
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.segs.size).toBe(net.segs.size);
    expect(copy.nodes.get(b.id)!.signals[1]!.hold).toBe(true);
  });

  it('removes orphan nodes and stations with a deleted segment', () => {
    const { net, c, s2, b } = line();
    net.stations.push({ id: 99, name: 'X', nodeId: c.id, platformSide: 1, length: 100 });
    net.removeSegment(s2.id);
    expect(net.nodes.has(c.id)).toBe(false);
    expect(net.stations.length).toBe(0);
    expect(net.nodes.has(b.id)).toBe(true);
  });
});

describe('signals', () => {
  it('holds a train at red and releases it when the hold clears', () => {
    const { net, b, s1 } = line();
    b.signals[1] = { hold: true };
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, s1.id, 100, 1);
    for (let i = 0; i < 60 * 30; i++) sim.update(1 / 30);
    const stopped = sim.head(t);
    expect(t.speed).toBeLessThan(0.3);
    expect(stopped.seg).toBe(s1.id);
    expect(stopped.x).toBeLessThan(500);
    expect(stopped.x).toBeGreaterThan(440);
    expect(sim.aspects.get(`${b.id}:1`)).toBe('red');
    b.signals[1]!.hold = false;
    for (let i = 0; i < 30 * 30; i++) sim.update(1 / 30);
    expect(sim.head(t).x).toBeGreaterThan(500);
  });

  it('shows red for occupied blocks and yellow before a red', () => {
    const { net, a, b, c, s2 } = line();
    a.signals[1] = { hold: false };
    b.signals[1] = { hold: false };
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, s2.id, 300, 1);
    sim.update(0.2);
    sim.update(0.2);
    expect(sim.aspects.get(`${b.id}:1`)).toBe('red');
    expect(sim.aspects.get(`${a.id}:1`)).toBe('yellow');
    void c;
  });

  it('reports a player passing a held signal', () => {
    const { net, b, s1 } = line();
    b.signals[1] = { hold: true };
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    t.ai = false;
    t.throttle = 1;
    sim.trains.push(t);
    sim.place(t, s1.id, 200, 1);
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e.kind);
    for (let i = 0; i < 60 * 30; i++) sim.update(1 / 30);
    expect(events).toContain('spad');
  });

  it('stops at a dead end instead of running through', () => {
    const { net, s2, c } = line();
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, s2.id, 100, 1);
    for (let i = 0; i < 120 * 30; i++) sim.update(1 / 30);
    expect(t.speed).toBeLessThan(0.3);
    expect(sim.head(t).x).toBeLessThanOrEqual(c.x);
    expect(sim.head(t).x).toBeGreaterThan(c.x - 30);
  });
});

describe('train motion', () => {
  it('keeps the consist at its length through reversal', () => {
    const { net, s1 } = line();
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, s1.id, 200, 1);
    const tailBefore = sim.behind(t, t.length).x;
    const headBefore = sim.head(t).x;
    expect(sim.reverse(t)).toBe(true);
    expect(sim.head(t).x).toBeCloseTo(tailBefore, 0);
    expect(sim.behind(t, t.length).x).toBeCloseTo(headBefore, 0);
    expect(t.cars[0].flip).toBe(true);
  });

  it('slides forward when spawned against a dead end', () => {
    const { net, s1 } = line();
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, s1.id, 5, 1);
    expect(sim.head(t).x).toBeGreaterThan(t.length - 5);
  });

  it('follows the selected switch route', () => {
    const { net, b, s1 } = line();
    const d = net.addNode(900, 10, 300, 0.7, 0.7);
    const branch = net.addSegment(b.id, 1, d.id, -1);
    net.throwSwitch(b.id, 1);
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, s1.id, 300, 1);
    for (let i = 0; i < 60 * 30; i++) sim.update(1 / 30);
    expect(sim.head(t).seg).toBe(branch.id);
  });
});

describe('deadlock handling', () => {
  it('never reverses a train waiting at a held signal', () => {
    const { net, b, s1 } = line();
    b.signals[1] = { hold: true };
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    sim.trains.push(t);
    sim.place(t, s1.id, 100, 1);
    for (let i = 0; i < 300 * 10; i++) sim.update(0.1);
    expect(t.cars[0].flip).toBe(false);
    expect(sim.head(t).x).toBeGreaterThan(440);
  });

  it('resolves two trains meeting head-on between signals', () => {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(600, 10, 0, 1, 0);
    const c = net.addNode(1200, 10, 0, 1, 0);
    const d = net.addNode(1800, 10, 0, 1, 0);
    const s1 = net.addSegment(a.id, 1, b.id, -1);
    net.addSegment(b.id, 1, c.id, -1);
    const s3 = net.addSegment(c.id, 1, d.id, -1);
    b.signals[1] = { hold: false };
    c.signals[-1] = { hold: false };
    const sim = new Sim(net);
    const east = new Train(1, 'East', SHUTTLE());
    const west = new Train(2, 'West', SHUTTLE());
    sim.trains.push(east, west);
    sim.place(east, s1.id, 300, 1);
    sim.place(west, s3.id, 300, -1);
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e.kind);
    for (let i = 0; i < 300 * 10; i++) sim.update(0.1);
    expect(events).not.toContain('collision');
  });
});

describe('demo map', () => {
  it('runs 40 simulated minutes with every train still calling at stations and no collisions', () => {
    const hf = new Heightfield('alpine', 1);
    const { net, stations } = buildDemoNetwork(hf);
    const sim = new Sim(net);
    populateDemoTrains(sim, stations);
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e.kind + ':' + e.text);
    for (let i = 0; i < 40 * 60 * 10; i++) sim.update(0.1);
    expect(events.filter((e) => e.startsWith('collision'))).toEqual([]);
    expect(events.filter((e) => e.startsWith('buffer'))).toEqual([]);
    for (const t of sim.trains) {
      expect(t.score.stops, `${t.name} made too few stops`).toBeGreaterThan(8);
    }
    let worstRadius = Infinity;
    for (const g of net.geom.values()) worstRadius = Math.min(worstRadius, g.minRadius);
    expect(worstRadius).toBeGreaterThan(100);
  });
});
