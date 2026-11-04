import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { History } from '../src/history';
import {
  backupStoredSave,
  buildWorld,
  captureSave,
  readQuality,
  readSave,
  restoreEdit,
  restoreTrains,
  writeQuality,
  writeSave,
} from '../src/persistence';
import { buildDemoNetwork, populateDemoTrains } from '../src/rail/demoMap';
import { Sim } from '../src/rail/sim';
import type { PlacedItem } from '../src/render/scatter';
import type { SaveData } from '../src/saveData';
import { parseSave } from '../src/saveData';
import { Heightfield } from '../src/world/heightfield';

const SAVE_KEY = 'vibe-train-sim/map-v1';
const BACKUP_KEY = 'vibe-train-sim/map-v1-backup';

const PLACED: PlacedItem[] = [
  { type: 'tree_pine', x: 10, z: -20, rot: 0.5, scale: 1.2 },
  { type: 'house_b', x: -300, z: 250, rot: 2, scale: 1 },
];

function world() {
  const hf = new Heightfield('plains', 3);
  hf.brush('raise', 400, 400, 80, 1);
  hf.brush('lower', -500, 300, 50, 1);
  const { net, stations } = buildDemoNetwork(hf);
  hf.grade(net);
  const sim = new Sim(net);
  populateDemoTrains(sim, stations);
  for (let i = 0; i < 600; i++) sim.update(0.1);
  // Values a fresh train wouldn't have, so a field that isn't restored shows up.
  sim.trains[0].schedIdx = 1;
  sim.trains[0].ai = false;
  return { hf, net, sim, placed: PLACED, hours: 17.5, drivenId: sim.trains[1].id as number | null };
}

function load(d: SaveData) {
  const { hf, net } = buildWorld(d);
  hf.grade(net);
  const sim = new Sim(net);
  const driven = restoreTrains(sim, d);
  return { hf, net, sim, driven, placed: d.placed, hours: d.hours, drivenId: driven?.id ?? null };
}

// Loading renormalises headings, which moves them around the 15th decimal place.
const rounded = (d: SaveData['net']) =>
  JSON.parse(JSON.stringify(d), (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v)) as unknown;

function expectSameTrains(a: SaveData, b: SaveData) {
  expect(b.trains).toHaveLength(a.trains.length);
  a.trains.forEach((t, i) => {
    const u = b.trains[i];
    expect({ id: u.id, name: u.name, cars: u.cars, schedule: u.schedule, schedIdx: u.schedIdx, ai: u.ai }).toEqual({
      id: t.id,
      name: t.name,
      cars: t.cars,
      schedule: t.schedule,
      schedIdx: t.schedIdx,
      ai: t.ai,
    });
    // Loading snaps a train to the nearest sampled point on the track, so it can move by up to half a sample.
    expect(Math.hypot(u.x - t.x, u.z - t.z)).toBeLessThan(3);
    expect(u.hx * t.hx + u.hz * t.hz).toBeGreaterThan(0.99);
  });
}

describe('saving and loading a full world', () => {
  it('passes its own validation', () => {
    expect(parseSave(JSON.stringify(captureSave(world()))).ok).toBe(true);
  });

  it('gives the same network, terrain edits, scenery and trains', () => {
    const w = world();
    const before = captureSave(w);
    const r = parseSave(JSON.stringify(before));
    if (!r.ok) throw new Error(r.reason);
    const loaded = load(r.data);
    const after = captureSave(loaded);

    expect(after.preset).toBe('plains');
    expect(after.seed).toBe(3);
    expect(after.hours).toBe(17.5);
    expect(after.drivenId).toBe(w.drivenId);
    expect(loaded.driven?.id).toBe(w.drivenId);
    expect(rounded(after.net)).toEqual(rounded(before.net));
    expect(after.placed).toEqual(PLACED);
    expectSameTrains(before, after);

    expect(before.edits.length).toBeGreaterThan(0);
    // Edits are stored to the nearest 0.02 m, and anything smaller is left out.
    for (let k = 0; k < w.hf.base.length; k += 13)
      expect(Math.abs(loaded.hf.base[k] - w.hf.base[k])).toBeLessThanOrEqual(0.03);
  });

  it('draws the same graded terrain after loading', () => {
    const w = world();
    const loaded = load(captureSave(w));
    for (let k = 0; k < w.hf.h.length; k += 13) expect(Math.abs(loaded.hf.h[k] - w.hf.h[k])).toBeLessThanOrEqual(0.1);
  });

  it('stores no terrain edits for an untouched map', () => {
    expect(new Heightfield('alpine', 2).exportEdits()).toEqual([]);
  });

  it('drops a train whose track no longer exists rather than failing', () => {
    const d = captureSave(world());
    const lost = { ...d.trains[0], x: 1e6, z: 1e6 };
    const loaded = load({
      ...d,
      net: { ...d.net, nodes: [], segs: [], stations: [] },
      trains: [lost],
      drivenId: lost.id,
    });
    expect(loaded.sim.trains).toEqual([]);
    expect(loaded.driven).toBeNull();
  });
});

describe('undo and redo of a whole map', () => {
  // The same steps as Game.pushUndo, Game.undo and Game.redo, without the renderers.
  function editor() {
    const w = world();
    const history = new History();
    let state = { ...w };
    const snap = () => JSON.stringify(captureSave(state));
    const restore = (json: string) => {
      const d = JSON.parse(json) as SaveData;
      const { net, sim, driven } = restoreEdit(state.hf, d);
      state = { ...state, net, sim, placed: [...d.placed], drivenId: driven?.id ?? null };
    };
    return {
      get state() {
        return state;
      },
      snap,
      push: () => history.push(snap()),
      undo: () => {
        const s = history.undo(snap());
        if (s !== null) restore(s);
      },
      redo: () => {
        const s = history.redo(snap());
        if (s !== null) restore(s);
      },
    };
  }

  it('reverses a track edit and a terrain edit, then applies them again', () => {
    const e = editor();
    // A capture shares objects with the live network, so copy it as Game does before editing.
    const copy = () => JSON.parse(e.snap()) as SaveData;
    const { net: net0, edits: edits0 } = copy();
    const trains0 = copy();

    e.push();
    const seg = [...e.state.net.segs.values()][0];
    e.state.net.split(seg.id, e.state.net.geom.get(seg.id)!.length / 2);
    e.state.sim.syncTrack();
    e.state.hf.brush('raise', 900, -900, 60, 1);
    const { net: net1, edits: edits1 } = copy();
    expect(net1).not.toEqual(net0);
    expect(edits1).not.toEqual(edits0);

    e.undo();
    expect(rounded(captureSave(e.state).net)).toEqual(rounded(net0));
    expect(captureSave(e.state).edits).toEqual(edits0);
    expectSameTrains(trains0, captureSave(e.state));

    e.redo();
    expect(rounded(captureSave(e.state).net)).toEqual(rounded(net1));
    expect(captureSave(e.state).edits).toEqual(edits1);
  });

  it('gets back terrain grading when undoing a track removal', () => {
    const e = editor();
    const h0 = e.state.hf.h.slice();
    e.push();
    const seg = [...e.state.net.segs.values()][0];
    e.state.net.removeSegment(seg.id);
    e.state.sim.syncTrack();
    e.state.hf.grade(e.state.net);
    expect(e.state.hf.h).not.toEqual(h0);
    e.undo();
    for (let k = 0; k < h0.length; k += 13) expect(Math.abs(e.state.hf.h[k] - h0[k])).toBeLessThanOrEqual(0.1);
  });

  it('brings back scenery', () => {
    const e = editor();
    e.push();
    e.state.placed = [];
    e.undo();
    expect(e.state.placed).toEqual(PLACED);
  });
});

describe('browser storage', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads back what it wrote', () => {
    const d = captureSave(world());
    writeSave(d);
    expect(readSave()).toEqual({ saved: JSON.parse(JSON.stringify(d)), recovered: false });
  });

  it('finds nothing on a first visit', () => {
    expect(readSave()).toEqual({ saved: null, recovered: false });
  });

  it('moves a corrupt save to the backup instead of deleting it', () => {
    store.set(SAVE_KEY, '{"v":1,');
    expect(readSave()).toEqual({ saved: null, recovered: true });
    expect(store.has(SAVE_KEY)).toBe(false);
    expect(store.get(BACKUP_KEY)).toBe('{"v":1,');
  });

  it('can back up a save that passed validation but would not build', () => {
    store.set(SAVE_KEY, 'stored');
    backupStoredSave();
    expect(store.has(SAVE_KEY)).toBe(false);
    expect(store.get(BACKUP_KEY)).toBe('stored');
  });

  it('copes with blocked storage', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(readSave()).toEqual({ saved: null, recovered: false });
    expect(() => backupStoredSave()).not.toThrow();
    expect(readQuality()).toBe('high');
    expect(() => writeQuality('low')).not.toThrow();
    expect(() => writeSave(captureSave(world()))).toThrow('blocked');
  });

  it('remembers the graphics quality, defaulting to high', () => {
    expect(readQuality()).toBe('high');
    writeQuality('low');
    expect(readQuality()).toBe('low');
  });
});
