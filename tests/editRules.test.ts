import { describe, expect, it } from 'vitest';

import { History } from '../src/history';
import { SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';

function line(gap = 400) {
  const net = new Network();
  const a = net.addNode(0, 10, 0, 1, 0);
  const b = net.addNode(gap, 10, 0, 1, 0);
  const c = net.addNode(gap * 2, 10, 0, 1, 0);
  net.addSegment(a.id, 1, b.id, -1);
  net.addSegment(b.id, 1, c.id, -1);
  return { net, a, b, c };
}

describe('track rules when changing points', () => {
  it('accepts a gentle line', () => {
    const { net, b } = line();
    expect(net.problemAt(b.id)).toBeNull();
  });

  it('flags a point raised too steeply', () => {
    const { net, b } = line();
    net.moveNode(b.id, b.x, 50, b.z); // 40 m over 400 m is 10%
    expect(net.problemAt(b.id)).toMatch(/Too steep/);
  });

  it('flags a point dragged into a tight kink', () => {
    const { net, b } = line();
    net.moveNode(b.id, 40, 10, 120);
    expect(net.problemAt(b.id)).toMatch(/Curve too tight/);
  });

  it('turns a heading and rebuilds the track, and turning back restores it', () => {
    const { net, b } = line(40);
    const before = net.geom.get(net.attached(b.id, 1)[0])!.minRadius;
    net.turnNode(b.id, (60 * Math.PI) / 180);
    expect(b.dz).toBeCloseTo(-Math.sin(Math.PI / 3), 5);
    expect(net.problemAt(b.id)).toMatch(/Curve too tight/);
    net.turnNode(b.id, (-60 * Math.PI) / 180);
    expect(b.dx).toBeCloseTo(1, 5);
    expect(net.geom.get(net.attached(b.id, 1)[0])!.minRadius).toBeCloseTo(before, 0);
    expect(net.problemAt(b.id)).toBeNull();
  });
});

describe('placing trains', () => {
  it('finds a train placed on top of another, and not one placed clear of it', () => {
    const { net } = line();
    const sim = new Sim(net);
    const seg = net.attached(net.nodes.keys().next().value!, 1)[0];
    const first = new Train(1, 'A', SHUTTLE());
    sim.trains.push(first);
    sim.place(first, seg, 300, 1);
    const onTop = new Train(2, 'B', SHUTTLE());
    sim.trains.push(onTop);
    sim.place(onTop, seg, 290, -1);
    expect(sim.touching(onTop)).toBe(first);
    sim.trains.pop();
    const clear = new Train(3, 'C', SHUTTLE());
    sim.trains.push(clear);
    sim.place(clear, seg, 100, -1);
    expect(sim.touching(clear)).toBeNull();
  });
});

describe('undo history', () => {
  it('discards a refused edit without leaving anything to redo', () => {
    const h = new History();
    expect(h.canUndo).toBe(false);
    h.push('a');
    h.push('b');
    expect(h.discard()).toBe('b');
    expect(h.canRedo).toBe(false);
    expect(h.undo('now')).toBe('a');
    expect(h.canRedo).toBe(true);
    expect(h.canUndo).toBe(false);
  });
});
