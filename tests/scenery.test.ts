import { describe, expect, it } from 'vitest';

import { Network } from '../src/rail/network';
import { Heightfield } from '../src/world/heightfield';
import { generateScenery } from '../src/world/scenery';

describe('deterministic spatial scenery generation', () => {
  it('never reshuffles distant scenery when terrain height is edited locally', () => {
    const hfA = new Heightfield('alpine', 1);
    const hfB = new Heightfield('alpine', 1);
    const net = new Network();

    // Raise one corner high past the 165 m alpine tree-line threshold (which used to shift RNG state).
    hfB.brush('raise', 950, 950, 120, 120);

    const a = generateScenery(hfA, net, 1);
    const b = generateScenery(hfB, net, 1);

    const farKey = (items: typeof a) =>
      items
        .filter((item) => Math.hypot(item.x - 950, item.z - 950) > 150)
        .map(
          (item) =>
            `${item.type}:${item.x.toFixed(3)}:${item.z.toFixed(3)}:${item.rot.toFixed(3)}:${item.scale.toFixed(3)}`,
        );

    expect(farKey(a).length).toBeGreaterThan(100);
    expect(farKey(b)).toEqual(farKey(a));
  });

  it('thins scenery cleanly when density drops without moving surviving items', () => {
    const hf = new Heightfield('plains', 2);
    const net = new Network();
    const high = generateScenery(hf, net, 1);
    const low = generateScenery(hf, net, 0.4);
    const off = generateScenery(hf, net, 0);

    expect(off).toEqual([]);
    expect(low.length).toBeGreaterThan(0);
    expect(low.length).toBeLessThan(high.length);

    const highSet = new Set(high.map((item) => `${item.type}:${item.x.toFixed(4)}:${item.z.toFixed(4)}`));
    for (const item of low) {
      expect(highSet.has(`${item.type}:${item.x.toFixed(4)}:${item.z.toFixed(4)}`)).toBe(true);
    }
  });

  it('suppresses generated scenery inside circle and box exclusion zones', () => {
    const hf = new Heightfield('alpine', 1);
    const net = new Network();
    const all = generateScenery(hf, net, 1);
    const target = all[Math.floor(all.length / 2)];
    const other = all.find((item) => Math.hypot(item.x - target.x, item.z - target.z) > 20)!;

    const filteredCircle = generateScenery(hf, net, 1, [{ x: target.x, z: target.z, r: 1.5 }]);
    expect(filteredCircle.some((item) => item.x === target.x && item.z === target.z)).toBe(false);
    expect(filteredCircle.some((item) => item.x === other.x && item.z === other.z)).toBe(true);

    const filteredBox = generateScenery(hf, net, 1, [
      { minX: target.x - 2, minZ: target.z - 2, maxX: target.x + 2, maxZ: target.z + 2 },
    ]);
    expect(filteredBox.some((item) => item.x === target.x && item.z === target.z)).toBe(false);
    expect(filteredBox.some((item) => item.x === other.x && item.z === other.z)).toBe(true);
  });
});
