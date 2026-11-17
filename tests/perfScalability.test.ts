import { describe, expect, it } from 'vitest';

import { Network } from '../src/rail/network';
import { buildTerrainLodIndex, chunkXZDistance, selectLod, TERRAIN_LOD_STEPS } from '../src/render/terrain';
import { Heightfield, RES } from '../src/world/heightfield';

function makeGridNetwork(cols = 25, rows = 20, spacing = 110) {
  const net = new Network();
  const grid: ReturnType<Network['addNode']>[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c <= cols; c++) {
      const x = (c - cols / 2) * spacing;
      const z = (r - rows / 2) * spacing;
      row.push(net.addNode(x, 10, z, 1, 0));
    }
    grid.push(row);
  }
  const segs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      segs.push(net.addSegment(grid[r][c].id, 1, grid[r][c + 1].id, -1));
    }
  }
  return { net, grid, segs };
}

function bruteNearest(net: Network, x: number, z: number, maxDist: number) {
  let best: { seg: number; s: number; dist: number } | null = null;
  let bd = maxDist * maxDist;
  for (const [id, g] of net.geom) {
    for (let i = 0; i < g.n; i++) {
      const dx = g.pos[i * 3] - x;
      const dz = g.pos[i * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = { seg: id, s: i * g.step, dist: Math.sqrt(d) };
      }
    }
  }
  return best;
}

describe('Network spatial grid index', () => {
  it('matches brute-force nearest() and nearestNode() on a 500-segment network', () => {
    const { net, grid, segs } = makeGridNetwork(25, 20, 110);
    expect(net.segs.size).toBe(500);

    // Mutate topology: move a node, split a segment, remove a segment & node
    net.moveNode(grid[10][12].id, grid[10][12].x + 15, 14, grid[10][12].z + 18);
    net.split(segs[100].id, 55);
    net.removeSegment(segs[250].id);

    const probes = [
      [0, 0, 26],
      [-600, -400, 16],
      [750, 520, 40],
      [grid[10][12].x + 3, grid[10][12].z - 4, 26],
      [1450, 1450, 26],
      [120, -300, 1e9],
    ] as const;

    for (const [x, z, maxDist] of probes) {
      const got = net.nearest(x, z, maxDist);
      const want = bruteNearest(net, x, z, maxDist);
      expect(got?.seg ?? null).toBe(want?.seg ?? null);
      expect(got?.dist ?? 0).toBeCloseTo(want?.dist ?? 0, 5);

      const gotNode = net.nearestNode(x, z, maxDist);
      let wantNode = null;
      let bd = maxDist * maxDist;
      for (const n of net.nodes.values()) {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bd) {
          bd = d;
          wantNode = n;
        }
      }
      expect(gotNode?.id ?? null).toBe(wantNode?.id ?? null);
    }
  });

  it('keeps 500-segment nearest() and incremental move+grade fast', () => {
    const hf = new Heightfield('plains', 1);
    const { net, grid } = makeGridNetwork(25, 20, 110);
    hf.grade(net);

    const tNearest = performance.now();
    for (let i = 0; i < 200; i++) {
      net.nearest(-500 + (i % 20) * 50, -400 + Math.floor(i / 20) * 80, 26);
    }
    const nearestMs = performance.now() - tNearest;
    expect(nearestMs).toBeLessThan(100);

    const mid = grid[10][12];
    const tMove = performance.now();
    net.moveNode(mid.id, mid.x + 2, 12, mid.z + 2);
    hf.grade(net);
    const moveGradeMs = performance.now() - tMove;
    expect(moveGradeMs).toBeLessThan(100);
  });
});

describe('Network dirtyNodes, dirtyStationSigns, and throwSwitch', () => {
  it('does not bump version or dirtyNodes when throwing points', () => {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(200, 10, 0, 1, 0);
    const c = net.addNode(400, 10, 0, 1, 0);
    const d = net.addNode(380, 10, 120, 0.8, 0.6);
    net.addSegment(a.id, 1, b.id, -1);
    net.addSegment(b.id, 1, c.id, -1);
    net.addSegment(b.id, 1, d.id, -1);

    net.dirtyNodes.clear();
    const vBefore = net.version;
    net.throwSwitch(b.id, 1);
    expect(net.version).toBe(vBefore);
    expect(net.dirtyNodes.size).toBe(0);
  });

  it('tracks dirtyNodes locally on moveNode and markSignalDirty, and dirtyStationSigns on rename', () => {
    const { net, grid } = makeGridNetwork(6, 1, 200);
    const row = grid[0];
    row[1].signals[1] = { hold: false, type: 'main' };
    net.stations.push({ id: 99, name: 'Old', nodeId: row[5].id, platformSide: 1, length: 100 });
    net.dirtyNodes.clear();
    net.dirtyStationSigns.clear();

    // Moving row[4] touches row[3], row[4], row[5], not row[0] or row[1]
    net.moveNode(row[4].id, row[4].x + 2, 10, row[4].z);
    expect(net.dirtyNodes.has(row[4].id)).toBe(true);
    expect(net.dirtyNodes.has(row[3].id)).toBe(true);
    expect(net.dirtyNodes.has(row[5].id)).toBe(true);
    expect(net.dirtyNodes.has(row[0].id)).toBe(false);
    expect(net.dirtyNodes.has(row[1].id)).toBe(false);

    net.dirtyNodes.clear();
    const vBefore = net.version;
    net.markStationRenamed(99);
    expect(net.version).toBe(vBefore);
    expect(net.dirtyNodes.size).toBe(0);
    expect(net.dirtyStationSigns.has(99)).toBe(true);

    // Placing/changing a signal downstream of main signal at row[1] marks both nodes dirty
    net.dirtyNodes.clear();
    row[2].signals[1] = { hold: false, type: 'main' };
    net.markSignalDirty(row[2].id);
    expect(net.dirtyNodes.has(row[2].id)).toBe(true);
    expect(net.dirtyNodes.has(row[1].id)).toBe(true);
  });
});

describe('Terrain chunk LODs and skirts', () => {
  it('applies hysteresis around LOD distance thresholds', () => {
    const thresholds = [120, 420] as const;
    expect(selectLod(50, -1, thresholds, 30)).toBe(0);
    expect(selectLod(200, -1, thresholds, 30)).toBe(1);
    expect(selectLod(500, -1, thresholds, 30)).toBe(2);

    // Inside hysteresis deadband: stays at current LOD
    expect(selectLod(135, 0, thresholds, 30)).toBe(0);
    expect(selectLod(155, 0, thresholds, 30)).toBe(1);
    expect(selectLod(100, 1, thresholds, 30)).toBe(1);
    expect(selectLod(85, 1, thresholds, 30)).toBe(0);
  });

  it('computes XZ distance to chunk bounds accurately', () => {
    expect(chunkXZDistance(50, 50, 0, 0, 100, 100)).toBe(0);
    expect(chunkXZDistance(130, 50, 0, 0, 100, 100)).toBe(30);
    expect(chunkXZDistance(130, 140, 0, 0, 100, 100)).toBe(50);
  });

  it('builds valid terrain LOD index buffers with skirts for all steps', () => {
    const cells = RES / 8;
    for (const step of TERRAIN_LOD_STEPS) {
      const idx = buildTerrainLodIndex(cells, step);
      const m = cells / step;
      const n = m + 1;
      const vertCount = n * n + 4 * n;
      expect(idx.length).toBe((m * m * 2 + m * 4 * 2) * 3);
      for (let i = 0; i < idx.length; i++) {
        expect(idx[i]).toBeGreaterThanOrEqual(0);
        expect(idx[i]).toBeLessThan(vertCount);
      }
    }
  });
});
