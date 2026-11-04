import { describe, expect, it } from 'vitest';

import { captureSave } from '../src/persistence';
import { buildDemoNetwork, populateDemoTrains } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim } from '../src/rail/sim';
import { parseSave } from '../src/saveData';
import type { SaveData } from '../src/saveData';
import { Heightfield } from '../src/world/heightfield';

function starterSave(): SaveData {
  const hf = new Heightfield('alpine', 1);
  const { net, stations } = buildDemoNetwork(hf);
  const sim = new Sim(net);
  populateDemoTrains(sim, stations);
  return captureSave({
    hf,
    net,
    sim,
    placed: [{ type: 'tree_pine', x: 1, z: 2, rot: 0.5, scale: 1 }],
    hours: 12,
    drivenId: sim.trains[0].id,
  });
}

const parse = (d: unknown) => parseSave(JSON.stringify(d));
const mutate = (fn: (d: SaveData) => void) => {
  const d = JSON.parse(JSON.stringify(starterSave()));
  fn(d);
  return parse(d);
};

describe('parseSave', () => {
  it('accepts a real save and the result loads into a network', () => {
    const r = parse(starterSave());
    expect(r.ok).toBe(true);
    expect(r.ok && Network.fromJSON(r.data.net).nodes.size).toBeGreaterThan(0);
  });

  it('accepts an empty map', () => {
    expect(
      mutate((d) =>
        Object.assign(d, { net: { nextId: 1, nodes: [], segs: [], stations: [] }, trains: [], drivenId: null }),
      ).ok,
    ).toBe(true);
  });

  it('rejects truncated text', () => {
    const text = JSON.stringify(starterSave());
    const r = parseSave(text.slice(0, text.length / 2));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('cut off') });
  });

  it('rejects the corrupt save that used to stop the game starting', () => {
    expect(parseSave('{"v":1,"preset":"alpine","seed":1}').ok).toBe(false);
  });

  it('rejects things that are not maps', () => {
    for (const t of ['null', '[]', '42', '"x"', '{}']) expect(parseSave(t).ok).toBe(false);
  });

  it.each([
    ['preset', (d: SaveData) => (d.preset = 'moon' as never)],
    ['seed as text', (d: SaveData) => (d.seed = '1' as never)],
    ['seed as NaN-like', (d: SaveData) => (d.seed = null as never)],
    ['odd edits', (d: SaveData) => (d.edits = [5] as never)],
    ['edit index', (d: SaveData) => (d.edits = [-1, 2] as never)],
    ['node x as text', (d: SaveData) => (d.net.nodes[0].x = '5' as never)],
    ['segment to missing node', (d: SaveData) => (d.net.segs[0].a = 99999 as never)],
    ['bad side', (d: SaveData) => (d.net.segs[0].sa = 0 as never)],
    ['bad bridge', (d: SaveData) => (d.net.segs[0].bridge = 'tunnel' as never)],
    ['station at missing node', (d: SaveData) => (d.net.stations[0].nodeId = 99999 as never)],
    ['switch to missing piece', (d: SaveData) => (d.net.nodes[0].sw = { '1': 99999 } as never)],
    ['scenery type', (d: SaveData) => (d.placed[0].type = 'ufo' as never)],
    ['car type', (d: SaveData) => (d.trains[0].cars[0].type = 'rocket' as never)],
    ['schedule station', (d: SaveData) => (d.trains[0].schedule = [99999] as never)],
    ['driven train', (d: SaveData) => (d.drivenId = 99999 as never)],
    ['train x', (d: SaveData) => (d.trains[0].x = 'far' as never)],
    ['trains not a list', (d: SaveData) => (d.trains = {} as never)],
    ['version', (d: SaveData) => (d.v = 2 as never)],
  ])('rejects a wrong %s', (_name, fn) => {
    const r = mutate(fn);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/\S/) });
  });
});
