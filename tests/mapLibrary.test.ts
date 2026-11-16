import { describe, expect, it } from 'vitest';

import { BACKUP_COUNT, MapLibrary, MemoryStorage } from '../src/mapLibrary';
import { captureSave } from '../src/persistence';
import { Network } from '../src/rail/network';
import { Sim } from '../src/rail/sim';
import type { SaveData } from '../src/saveData';
import { Heightfield } from '../src/world/heightfield';

function map(seed = 1): SaveData {
  const hf = new Heightfield('plains', seed);
  hf.brush('raise', 0, 0, 120, 1); // Terrain edits make the map, not the index, take up the space
  const net = new Network();
  return captureSave({ hf, net, sim: new Sim(net), placed: [], hours: 9, drivenId: null });
}

function clock() {
  let t = 1000;
  return () => (t += 1000);
}

describe('map library', () => {
  it('saves, lists, loads and removes named copies', () => {
    const lib = new MapLibrary(new MemoryStorage(), clock());
    expect(lib.saveCopy('  Valley line ', map(1)).ok).toBe(true);
    expect(lib.saveCopy('Coast', map(2)).ok).toBe(true);
    expect(lib.copies().map((c) => c.name)).toEqual(['Coast', 'Valley line']);
    const loaded = lib.load(lib.copies()[1]);
    expect(loaded.ok && loaded.data.seed).toBe(1);
    lib.remove(lib.copies()[0]);
    expect(lib.copies().map((c) => c.name)).toEqual(['Valley line']);
  });

  it('replaces a copy saved under the same name', () => {
    const lib = new MapLibrary(new MemoryStorage(), clock());
    lib.saveCopy('Line', map(1));
    lib.saveCopy('Line', map(2));
    expect(lib.copies()).toHaveLength(1);
    const loaded = lib.load(lib.copies()[0]);
    expect(loaded.ok && loaded.data.seed).toBe(2);
  });

  it('keeps only the newest backups', () => {
    const store = new MemoryStorage();
    const lib = new MapLibrary(store, clock());
    for (let i = 1; i <= BACKUP_COUNT + 2; i++) expect(lib.backup(`Map ${i}`, map(i))).toBe(true);
    const names = lib.backups().map((b) => b.name);
    expect(names).toEqual(Array.from({ length: BACKUP_COUNT }, (_, i) => `Map ${BACKUP_COUNT + 2 - i}`));
    // Dropped backups don't leave their data behind.
    expect(store.length).toBe(BACKUP_COUNT + 1);
  });

  it('drops older backups to make room when storage is full', () => {
    const size = JSON.stringify(map(1)).length;
    const lib = new MapLibrary(new MemoryStorage(size * 2.5), clock());
    expect(lib.backup('A', map(1))).toBe(true);
    expect(lib.backup('B', map(2))).toBe(true);
    expect(lib.backup('C', map(3))).toBe(true);
    expect(lib.backups().map((b) => b.name)).toEqual(['C', 'B']);
  });

  it('reports a full storage when saving a copy, without losing earlier copies', () => {
    const size = JSON.stringify(map(1)).length;
    const lib = new MapLibrary(new MemoryStorage(size * 1.5), clock());
    expect(lib.saveCopy('First', map(1)).ok).toBe(true);
    const r = lib.saveCopy('Second', map(2));
    expect(r.ok).toBe(false);
    expect(lib.copies().map((c) => c.name)).toEqual(['First']);
  });

  it('refuses an entry whose data has gone or is corrupt', () => {
    const store = new MemoryStorage();
    const lib = new MapLibrary(store, clock());
    lib.saveCopy('Line', map(1));
    const entry = lib.copies()[0];
    store.setItem(`vibe-train-sim/copy/${entry.id}`, '{"v":1}');
    expect(lib.load(entry).ok).toBe(false);
    store.removeItem(`vibe-train-sim/copy/${entry.id}`);
    expect(lib.load(entry).ok).toBe(false);
  });
});
