// Moves a world to and from save data, browser storage and files. Needs no WebGL, so tests can run it directly.
import { Network } from './rail/network';
import { Sim, Train } from './rail/sim';
import type { PlacedItem } from './render/scatter';
import type { SaveData } from './saveData';
import { parseSave } from './saveData';
import { Heightfield } from './world/heightfield';

export type Quality = 'high' | 'low';

const SAVE_KEY = 'vibe-train-sim/map-v1';
// A save that fails validation is moved here so nothing the player made is thrown away.
const BACKUP_KEY = 'vibe-train-sim/map-v1-backup';
const QUALITY_KEY = 'vibe-train-sim/quality';

export interface WorldState {
  hf: Heightfield;
  net: Network;
  sim: Sim;
  placed: PlacedItem[];
  hours: number;
  drivenId: number | null;
}

export function captureSave(w: WorldState): SaveData {
  const trains = w.sim.trains.map((t) => {
    const h = w.sim.head(t);
    return {
      id: t.id,
      name: t.name,
      cars: t.cars,
      schedule: t.schedule,
      schedIdx: t.schedIdx,
      ai: t.ai,
      x: h.x,
      z: h.z,
      hx: h.tx * h.dir,
      hz: h.tz * h.dir,
      state: w.sim.captureState(t),
    };
  });
  return {
    v: 2,
    preset: w.hf.preset,
    seed: w.hf.seed,
    edits: w.hf.exportEdits(),
    net: w.net.toJSON(),
    placed: w.placed,
    hours: w.hours,
    drivenId: w.drivenId,
    trains,
  };
}

/** Builds terrain and track from a save. Throws if they can't be built, before anything is replaced. */
export function buildWorld(data: SaveData): { hf: Heightfield; net: Network } {
  const hf = new Heightfield(data.preset, data.seed);
  hf.importEdits(data.edits);
  hf.h.set(hf.base);
  return { hf, net: Network.fromJSON(data.net) };
}

/** Places the saved trains, dropping any with no track left, and returns the driven one. */
export function restoreTrains(sim: Sim, data: SaveData): Train | null {
  for (const j of data.trains) {
    const t = new Train(j.id, j.name, j.cars);
    t.schedule = j.schedule;
    t.schedIdx = j.schedIdx;
    t.ai = j.ai;
    sim.trains.push(t);
    if (j.state && sim.restoreState(t, j.state)) continue;
    // A save from before full state, or track that has changed: put the train on the nearest track, stopped.
    if (sim.replace(t, j.x, j.z, j.hx, j.hz)) sim.plan(t, false);
    else sim.trains.pop();
  }
  return sim.trains.find((t) => t.id === data.drivenId) ?? null;
}

/** Puts a snapshot back on the current terrain, which undo keeps rather than regenerating. */
export function restoreEdit(hf: Heightfield, data: SaveData): { net: Network; sim: Sim; driven: Train | null } {
  hf.importEdits(data.edits);
  const net = Network.fromJSON(data.net);
  const sim = new Sim(net);
  hf.grade(net);
  return { net, sim, driven: restoreTrains(sim, data) };
}

/** Throws if browser storage is full or blocked. */
export function writeSave(data: SaveData) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

function keepBackup(raw: string | null) {
  try {
    if (raw) localStorage.setItem(BACKUP_KEY, raw);
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* Storage is blocked or full, so there is nowhere to keep it. */
  }
}

/** Reads the stored map. One that fails validation moves to the backup, and recovered reports it. */
export function readSave(): { saved: SaveData | null; recovered: boolean } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    return { saved: null, recovered: false };
  }
  if (!raw) return { saved: null, recovered: false };
  const r = parseSave(raw);
  if (r.ok) return { saved: r.data, recovered: false };
  console.warn(`Ignoring the saved map: ${r.reason}`);
  keepBackup(raw);
  return { saved: null, recovered: true };
}

/** For a save that passed validation but still couldn't be built. */
export function backupStoredSave() {
  try {
    keepBackup(localStorage.getItem(SAVE_KEY));
  } catch {
    /* Storage is blocked, so there is nowhere to keep it. */
  }
}

export function downloadMap(data: SaveData) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vibe-train-map.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function readQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'high';
  } catch {
    return 'high';
  }
}

export function writeQuality(q: Quality) {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* The choice simply lasts for this page only. */
  }
}
