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
