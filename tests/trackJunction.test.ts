import { describe, expect, it } from 'vitest';

import { Network } from '../src/rail/network';
import { computeJunctionMetrics } from '../src/render/track';

describe('computeJunctionMetrics', () => {
  it('sorts diverging branches left-to-right and locates heel, frog and junction trim distances', () => {
    const net = new Network();
    const n0 = net.addNode(0, 10, 0, 1, 0);
    const n1 = net.addNode(160, 10, 0, 1, 0);
    const nLeft = net.addNode(150, 10, -45, 0.9, -0.43);
    const nRight = net.addNode(150, 10, 45, 0.9, 0.43);

    // Add right branch first, then straight, then left to verify sorting doesn't depend on insertion order.
    const segR = net.addSegment(n0.id, 1, nRight.id, -1);
    const segM = net.addSegment(n0.id, 1, n1.id, -1);
    const segL = net.addSegment(n0.id, 1, nLeft.id, -1);

    const m = computeJunctionMetrics(net, n0, 1);
    expect(m).not.toBeNull();
    expect(m!.branches.map((b) => b.segId)).toEqual([segL.id, segM.id, segR.id]);
    expect(m!.sToe).toBeGreaterThan(0);
    expect(m!.sHeel).toBeGreaterThanOrEqual(4.5);
    expect(m!.sHeel).toBeLessThanOrEqual(10.5);
    expect(m!.frogs.length).toBe(2);
    expect(m!.frogs[0].sFrog).toBeGreaterThan(m!.sHeel);
    expect(m!.sJuncEnd).toBeGreaterThan(m!.frogs[0].sFrog);
  });

  it('returns null for a non-junction node side', () => {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(100, 10, 0, 1, 0);
    net.addSegment(a.id, 1, b.id, -1);
    expect(computeJunctionMetrics(net, a, 1)).toBeNull();
  });
});
