import { describe, expect, it } from 'vitest';

import { anchorAt, ANCHOR_NODE, ANCHOR_SEG, buildTrackSegment, previewTrackPlan } from '../src/editor/trackPlan';
import { CROSSING_CLEARANCE, MAX_GRADE, MIN_RADIUS, Network } from '../src/rail/network';
import { WATER_LEVEL } from '../src/world/heightfield';

function flatLine() {
  const net = new Network();
  const a = net.addNode(0, 10, 0, 1, 0);
  const b = net.addNode(200, 10, 0, 1, 0);
  const seg = net.addSegment(a.id, 1, b.id, -1);
  return { net, a, b, seg };
}

describe('track planning and anchors', () => {
  it('resolves anchors to node, segment, or elevated free point in order', () => {
    const { net, a, seg } = flatLine();
    const baseAt = () => 4;

    const nearNode = anchorAt(net, baseAt, { x: ANCHOR_NODE - 2, y: 0, z: 2 }, 5);
    expect(nearNode).toEqual({ kind: 'node', node: a.id });

    const nearSeg = anchorAt(net, baseAt, { x: 100, y: 0, z: ANCHOR_SEG - 2 }, 5);
    expect(nearSeg).toMatchObject({ kind: 'seg', seg: seg.id });
    if (nearSeg.kind !== 'seg') throw new Error('expected seg anchor');
    expect(nearSeg.x).toBeCloseTo(100, 0);
    expect(nearSeg.y).toBeCloseTo(10, 5);

    const free = anchorAt(net, baseAt, { x: 100, y: 0, z: 80 }, 6);
    expect(free).toEqual({
      kind: 'free',
      x: 100,
      y: Math.max(4 + 0.7, WATER_LEVEL + 3) + 6,
      z: 80,
    });
  });

  it('rejects chords shorter than 15 m', () => {
    const net = new Network();
    const plan = previewTrackPlan(
      net,
      { kind: 'free', x: 0, y: 10, z: 0 },
      { kind: 'free', x: 10, y: 10, z: 0 },
      false,
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Too short');
    expect(plan.curve).toBeNull();
  });

  it('rejects sharp turns, tight curves, and steep grades', () => {
    const { net, a } = flatLine();
    // Anchor at node `a` (heading (1, 0)): moving nearly perpendicular back toward z triggers sharp-turn refusal.
    const sharp = previewTrackPlan(net, { kind: 'node', node: a.id }, { kind: 'free', x: 0.5, y: 10, z: 80 }, false);
    expect(sharp.ok).toBe(false);
    expect(sharp.reason).toMatch(/Turn is too sharp/);

    // Chord of 30 m at 60° requires tight curvature below MIN_RADIUS.
    const tight = previewTrackPlan(net, { kind: 'node', node: a.id }, { kind: 'free', x: 15, y: 10, z: 26 }, false);
    expect(tight.ok).toBe(false);
    expect(tight.reason).toMatch(/Curve too tight/);
    expect(tight.reason).toContain(`${MIN_RADIUS} m`);

    // 25 m rise over 200 m (~12.5%) exceeds MAX_GRADE.
    const steep = previewTrackPlan(
      net,
      { kind: 'free', x: 0, y: 10, z: 100 },
      { kind: 'free', x: 200, y: 10 + 200 * (MAX_GRADE + 0.05), z: 100 },
      false,
    );
    expect(steep.ok).toBe(false);
    expect(steep.reason).toMatch(/Too steep/);
  });

  it('snaps free lines to 15 degree increments and computes crossing clearance hints', () => {
    const { net } = flatLine();
    const snapped = previewTrackPlan(
      net,
      { kind: 'free', x: 100, y: 10, z: -100 },
      { kind: 'free', x: 105, y: 10, z: 100 },
      true,
    );
    expect(snapped.ok).toBe(true);
    // Nearly due +Z aligns to exact +Z (90 deg).
    expect(snapped.d0x).toBeCloseTo(0, 5);
    expect(snapped.d0z).toBeCloseTo(1, 5);
    expect(snapped.reason).toMatch(/diamond crossing/);

    const tightBridge = previewTrackPlan(
      net,
      { kind: 'free', x: 100, y: 12.5, z: -100 },
      { kind: 'free', x: 100, y: 12.5, z: 100 },
      false,
    );
    expect(tightBridge.ok).toBe(true);
    expect(tightBridge.reason).toContain(`Tight clearance`);

    const clearBridge = previewTrackPlan(
      net,
      { kind: 'free', x: 100, y: 10 + CROSSING_CLEARANCE + 1, z: -100 },
      { kind: 'free', x: 100, y: 10 + CROSSING_CLEARANCE + 1, z: 100 },
      false,
    );
    expect(clearBridge.ok).toBe(true);
    expect(clearBridge.reason).toMatch(/Crosses over\/under track/);
  });

  it('builds track segments, splits existing segments cleanly, and refuses same-node joins', () => {
    const { net, a, b, seg } = flatLine();

    const start = { kind: 'free', x: 0, y: 10, z: 120 } as const;
    const end = { kind: 'free', x: 200, y: 10, z: 120 } as const;
    const plan = previewTrackPlan(net, start, end, false);
    const built = buildTrackSegment(net, start, end, plan);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected segment build to succeed');
    expect(built.nextStart?.kind).toBe('node');
    expect(net.segs.has(built.seg.id)).toBe(true);

    const sameNode = buildTrackSegment(
      net,
      { kind: 'node', node: a.id },
      { kind: 'node', node: a.id },
      previewTrackPlan(net, { kind: 'node', node: a.id }, { kind: 'node', node: b.id }, false),
    );
    expect(sameNode).toEqual({ ok: false, reason: 'A track cannot start and end at the same point' });

    const s1 = { kind: 'seg', seg: seg.id, s: 50, x: 50, y: 10, z: 0 } as const;
    const s2 = { kind: 'seg', seg: seg.id, s: 150, x: 150, y: 10, z: 0 } as const;
    const splitBuilt = buildTrackSegment(net, s1, s2, previewTrackPlan(net, s1, s2, false));
    expect(splitBuilt.ok).toBe(true);
    expect(net.segs.size).toBeGreaterThanOrEqual(4);
  });
});
