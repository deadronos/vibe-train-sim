import { describe, expect, it } from 'vitest';

import { buildDemoNetwork, populateDemoTrains } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim } from '../src/rail/sim';
import type { Preset } from '../src/world/heightfield';
import { BRIDGE_GAP, Heightfield, WATER_LEVEL } from '../src/world/heightfield';

const PRESETS: Preset[] = ['alpine', 'plains', 'desert', 'islands'];

describe('terrain generation', () => {
  it.each(PRESETS)('%s gives the same terrain for the same seed', (preset) => {
    expect(new Heightfield(preset, 7).base).toEqual(new Heightfield(preset, 7).base);
  });

  it.each(PRESETS)('%s gives different terrain for another seed', (preset) => {
    expect(new Heightfield(preset, 7).base).not.toEqual(new Heightfield(preset, 8).base);
  });
});

describe('grading', () => {
  it.each(PRESETS)('%s seats the ground under rail, leaving bridges alone', (preset) => {
    const hf = new Heightfield(preset, 1);
    const { net } = buildDemoNetwork(hf);
    hf.grade(net);
    let graded = 0;
    for (const seg of net.segs.values()) {
      const g = net.geom.get(seg.id)!;
      for (let i = 0; i < g.n; i += 2) {
        const [x, y, z] = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
        if (hf.isBridgeSample(seg, x, y, z)) continue;
        graded++;
        // Nearby stamps blend together, so allow for what the grid and a neighbouring sample can add.
        expect(Math.abs(hf.height(x, z) - (y - 0.68))).toBeLessThan(1.5);
      }
    }
    expect(graded).toBeGreaterThan(0);
  });

  it('leaves the ground alone under a bridge but raises it under an embankment', () => {
    const lay = (bridge: 'force' | 'none') => {
      const hf = new Heightfield('plains', 1);
      const [x0, z0] = [400, 400];
      const y = hf.baseAt(x0, z0) + 30;
      const net = new Network();
      const a = net.addNode(x0 - 150, y, z0, 1, 0);
      const b = net.addNode(x0 + 150, y, z0, 1, 0);
      net.addSegment(a.id, 1, b.id, -1, bridge);
      hf.grade(net);
      return { hf, gap: y - 0.68 - hf.height(x0, z0), rise: hf.height(x0, z0) - hf.baseAt(x0, z0) };
    };
    expect(Math.abs(lay('force').rise)).toBeLessThan(0.01);
    expect(lay('none').gap).toBeLessThan(0.5);
  });

  it('gives the same result when repeated', () => {
    const hf = new Heightfield('alpine', 1);
    const { net } = buildDemoNetwork(hf);
    hf.grade(net);
    const first = hf.h.slice();
    hf.grade(net);
    expect(hf.h).toEqual(first);
  });

  it('never changes the brush layer, and removing all track restores it', () => {
    const hf = new Heightfield('plains', 1);
    hf.brush('raise', 100, 100, 60, 1);
    const base = hf.base.slice();
    const { net } = buildDemoNetwork(hf);
    hf.grade(net);
    expect(hf.base).toEqual(base);
    expect(hf.h).not.toEqual(base);
    hf.grade(new Network());
    for (let k = 0; k < base.length; k += 97) expect(Math.abs(hf.h[k] - base[k])).toBeLessThanOrEqual(0.001);
  });

  it('flags what changed for the renderer, and nothing when nothing changed', () => {
    const hf = new Heightfield('plains', 1);
    const { net } = buildDemoNetwork(hf);
    hf.dirty = null;
    hf.grade(net);
    expect(hf.dirty).not.toBeNull();
    hf.dirty = null;
    hf.grade(net);
    expect(hf.dirty).toBeNull();
  });

  it.each(PRESETS)(
    '%s incremental grading matches full grading after brush, track, bridge, and station edits',
    (preset) => {
      const hf = new Heightfield(preset, 3);
      const { net } = buildDemoNetwork(hf);
      hf.grade(net);

      // 1. Brush near track and away from track
      const firstNode = [...net.nodes.values()][1];
      hf.brush('raise', firstNode.x, firstNode.z, 55, 0.8);
      hf.grade(net);

      // 2. Move a node
      const moving = [...net.nodes.values()][3];
      net.moveNode(moving.id, moving.x + 12, moving.y + 4, moving.z - 8);
      hf.grade(net);

      // 3. Toggle a segment's bridge mode
      const firstSeg = [...net.segs.values()][0];
      firstSeg.bridge = firstSeg.bridge === 'force' ? 'none' : 'force';
      hf.grade(net);

      // 4. Add & remove a station, add & remove a branch segment
      const branchStart = [...net.nodes.values()][4];
      const branchEnd = net.addNode(branchStart.x + 180, branchStart.y + 3, branchStart.z + 180, 1, 1);
      const branchSeg = net.addSegment(branchStart.id, 1, branchEnd.id, -1);
      hf.grade(net);

      const extraStation = {
        id: net.id(),
        name: 'Temp',
        nodeId: branchEnd.id,
        platformSide: 1 as const,
        length: 100,
      };
      net.stations.push(extraStation);
      hf.grade(net);

      net.stations = net.stations.filter((s) => s !== extraStation);
      net.removeSegment(branchSeg.id);
      hf.grade(net);

      // Compare against a fresh Heightfield graded from scratch with the exact same base & network.
      const ref = new Heightfield(preset, 3);
      ref.base.set(hf.base);
      ref.grade(net);

      for (let k = 0; k < hf.h.length; k++) {
        expect(Math.abs(hf.h[k] - ref.h[k])).toBeLessThan(0.002);
      }
    },
  );

  it('keeps dirty bounds local during a local brush edit on a large network', () => {
    const hf = new Heightfield('plains', 2);
    const { net } = buildDemoNetwork(hf);
    hf.grade(net);
    hf.dirty = null;

    hf.brush('raise', -1100, -1100, 50, 1);
    hf.grade(net);
    expect(hf.dirty).not.toBeNull();
    const [i0, j0, i1, j1] = hf.dirty!;
    // Brush at (-1100, -1100) only touches cells in the low quadrant, leaving distant quadrants clean.
    expect(i1).toBeLessThan(160);
    expect(j1).toBeLessThan(160);
    expect(i0).toBeLessThan(i1);
    expect(j0).toBeLessThan(j1);
  });
});

describe('bridge decisions', () => {
  function seg(bridge: 'auto' | 'force' | 'none') {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(100, 10, 0, 1, 0);
    return net.addSegment(a.id, 1, b.id, -1, bridge);
  }
  const hf = new Heightfield('plains', 1);
  const x = 400;
  const z = 400;
  const ground = hf.baseAt(x, z);

  it('bridges only when rail is high above the ground in auto', () => {
    expect(ground).toBeGreaterThan(WATER_LEVEL + 0.8);
    expect(hf.isBridgeSample(seg('auto'), x, ground + BRIDGE_GAP + 0.5, z)).toBe(true);
    expect(hf.isBridgeSample(seg('auto'), x, ground + BRIDGE_GAP - 0.5, z)).toBe(false);
  });

  it('follows a forced setting whatever the height', () => {
    expect(hf.isBridgeSample(seg('force'), x, ground, z)).toBe(true);
    expect(hf.isBridgeSample(seg('none'), x, ground + 50, z)).toBe(false);
  });

  it('bridges over water even at a small gap', () => {
    const wet = new Heightfield('plains', 1);
    wet.base.fill(WATER_LEVEL);
    expect(wet.isBridgeSample(seg('auto'), x, WATER_LEVEL + 1, z)).toBe(true);
  });
});

describe('every landscape runs the starter railway', () => {
  it.each(PRESETS)('%s runs five minutes with no collisions and trains moving', (preset) => {
    const hf = new Heightfield(preset, 1);
    const { net, stations } = buildDemoNetwork(hf);
    hf.grade(net);
    const sim = new Sim(net);
    populateDemoTrains(sim, stations);
    const problems: string[] = [];
    sim.onEvent = (e) => {
      if (e.kind === 'collision' || e.kind === 'buffer') problems.push(e.text);
    };
    for (let i = 0; i < 5 * 60 * 10; i++) sim.update(0.1);
    expect(problems).toEqual([]);
    expect(sim.trains.length).toBeGreaterThan(0);
    for (const t of sim.trains) expect(t.score.stops, `${t.name} made no stops`).toBeGreaterThan(0);
  });
});
