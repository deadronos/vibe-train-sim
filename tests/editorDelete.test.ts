import { describe, expect, it } from 'vitest';

import { pickDeleteTarget } from '../src/editor/tools/delete';
import type { EditorHost } from '../src/editor/tools/tool';
import { Network } from '../src/rail/network';
import { Sim } from '../src/rail/sim';
import { Heightfield } from '../src/world/heightfield';
import type { PlacedItem, SceneryExclusion } from '../src/world/scenery';

function makeHost(placed: PlacedItem[] = [], generated: PlacedItem[] = []): EditorHost {
  const hf = new Heightfield('plains', 1);
  const net = new Network();
  const sim = new Sim(net);
  return {
    renderer: null as never,
    camera: null as never,
    scene: null as never,
    editing: true,
    net,
    hf,
    sim,
    driven: null,
    placedScenery: placed,
    generatedScenery: generated,
    pushUndo() {},
    commitEdit() {},
    abandonEdit() {},
    addPlacedScenery() {},
    placedSceneryNear(x, z, r) {
      let best = -1;
      let bd = r * r;
      placed.forEach((p, i) => {
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    },
    removePlacedScenery() {},
    generatedSceneryNear(x, z, r) {
      let best: PlacedItem | null = null;
      let bd = r * r;
      for (const g of generated) {
        const d = (g.x - x) ** 2 + (g.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = g;
        }
      }
      return best;
    },
    addSceneryExclusion(_ex: SceneryExclusion) {},
    addTrain() {
      return null;
    },
    removeTrain() {},
    toast() {},
    syncEditor() {},
    syncTrains() {},
  };
}

describe('delete hit testing', () => {
  it('picks only the closer signal side when a node has signals in both directions', () => {
    const host = makeHost();
    const a = host.net.addNode(-100, 20, 0, 1, 0);
    const b = host.net.addNode(0, 20, 0, 1, 0);
    const c = host.net.addNode(100, 20, 0, 1, 0);
    host.net.addSegment(a.id, 1, b.id, -1);
    host.net.addSegment(b.id, 1, c.id, -1);
    b.signals[1] = { hold: false, type: 'main' };
    b.signals[-1] = { hold: false, type: 'distant' };

    // Side +1 signal stands at (-3, y, +2.9); side -1 stands at (+3, y, -2.9).
    const hitPlus = pickDeleteTarget(host, { x: -3, y: 20, z: 3 });
    expect(hitPlus).toMatchObject({ kind: 'signal', side: 1 });

    const hitMinus = pickDeleteTarget(host, { x: 3, y: 20, z: -3 });
    expect(hitMinus).toMatchObject({ kind: 'signal', side: -1 });
  });

  it('hits placed scenery, generated scenery, and track consistently', () => {
    const placed: PlacedItem[] = [{ type: 'house_a', x: 50, z: 50, rot: 0, scale: 1 }];
    const generated: PlacedItem[] = [{ type: 'tree_pine', x: -80, z: -80, rot: 0, scale: 1 }];
    const host = makeHost(placed, generated);

    const hitHouse = pickDeleteTarget(host, { x: 51, y: 20, z: 50 });
    expect(hitHouse?.kind).toBe('placed');
    expect(hitHouse?.label).toBe('cottage');

    const hitTree = pickDeleteTarget(host, { x: -80, y: 20, z: -81 });
    expect(hitTree?.kind).toBe('generated');
    expect(hitTree?.label).toBe('pine tree');
  });
});
