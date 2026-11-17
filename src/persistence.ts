// Moves a world to and from save data, browser storage and files. Needs no WebGL, so tests can run it directly.
import type { SoundSettings } from './audio';
import { DEFAULT_SOUND } from './audio';
import { Network } from './rail/network';
import { Sim, Train } from './rail/sim';
import type { SaveData } from './saveData';
import { parseSave } from './saveData';
import { Heightfield } from './world/heightfield';
import type { PlacedItem } from './world/scenery';

/** auto starts at high and lowers resolution, then effects, while frames run slow. */
export type Quality = 'auto' | 'high' | 'low';
export type Rules = 'relaxed' | 'strict';

export const SAVE_KEY = 'vibe-train-sim/map-v1';
// A save that fails validation is moved here so nothing the player made is thrown away.
const BACKUP_KEY = 'vibe-train-sim/map-v1-backup';
const QUALITY_KEY = 'vibe-train-sim/quality';
const SOUND_KEY = 'vibe-train-sim/sound';
const RULES_KEY = 'vibe-train-sim/rules';
const BEST_PREFIX = 'vibe-train-sim/best/';

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
      times: t.schedule.map((_, i) => t.times[i] ?? null),
      arrivals: t.schedule.map((_, i) => t.arrivals[i] ?? null),
      turns: t.schedule.map((_, i) => t.turns[i] ?? false),
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
    t.times = j.times ?? j.schedule.map(() => null);
    t.arrivals = j.arrivals ?? j.schedule.map(() => null);
    t.turns = j.turns ?? j.schedule.map(() => false);
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
    const q = localStorage.getItem(QUALITY_KEY);
    return q === 'high' || q === 'low' ? q : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeQuality(q: Quality) {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* The choice simply lasts for this page only. */
  }
}

/** Reads sound settings, falling back to the default for anything missing or out of range. */
export function readSound(): SoundSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null');
  } catch {
    /* Blocked storage or a bad value: use the defaults. */
  }
  return parseSound(raw);
}

export function parseSound(raw: unknown): SoundSettings {
  const out = { ...DEFAULT_SOUND };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.muted === 'boolean') out.muted = r.muted;
  for (const k of ['volume', 'engine', 'rail', 'horn'] as const) {
    const v = r[k];
    if (typeof v === 'number' && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}

export function writeSound(s: SoundSettings) {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(s));
  } catch {
    /* The choice simply lasts for this page only. */
  }
}

export function readRules(): Rules {
  try {
    return localStorage.getItem(RULES_KEY) === 'strict' ? 'strict' : 'relaxed';
  } catch {
    return 'relaxed';
  }
}

export function writeRules(r: Rules) {
  try {
    localStorage.setItem(RULES_KEY, r);
  } catch {
    /* The choice simply lasts for this page only. */
  }
}

/** Records a driving score for a landscape, returning the best before this one, or null if there was none. */
export function recordBest(map: string, score: number): number | null {
  try {
    const raw = localStorage.getItem(BEST_PREFIX + map);
    const best = raw === null ? null : Number(raw);
    const previous = best !== null && Number.isFinite(best) ? best : null;
    if (previous === null || score > previous) localStorage.setItem(BEST_PREFIX + map, String(score));
    return previous;
  } catch {
    return null;
  }
}
