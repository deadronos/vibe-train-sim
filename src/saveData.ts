// Save format and validation. Kept free of Three.js and the DOM so tests can run it without WebGL.
import type { Network } from './rail/network';
import type { Car, CarType } from './rail/sim';
import type { PlacedItem, SceneryType } from './render/scatter';
import type { Preset } from './world/heightfield';
import { RES } from './world/heightfield';

export interface SaveData {
  v: 1;
  preset: Preset;
  seed: number;
  edits: number[];
  net: ReturnType<Network['toJSON']>;
  placed: PlacedItem[];
  hours: number;
  drivenId: number | null;
  trains: {
    id: number;
    name: string;
    cars: Car[];
    schedule: number[];
    schedIdx: number;
    ai: boolean;
    x: number;
    z: number;
    hx: number;
    hz: number;
  }[];
}

export type ParseResult = { ok: true; data: SaveData } | { ok: false; reason: string };

// Typed as records so adding a union member without listing it here fails to compile.
const PRESETS: Record<Preset, true> = { alpine: true, plains: true, desert: true, islands: true };
const SCENERY: Record<SceneryType, true> = {
  tree_pine: true,
  tree_oak: true,
  tree_birch: true,
  rock_a: true,
  rock_b: true,
  house_a: true,
  house_b: true,
  house_c: true,
};
const CAR_TYPES: Record<CarType, true> = { loco_diesel: true, coach: true, wagon_box: true, wagon_tank: true };
const BRIDGES = ['auto', 'force', 'none'];

class Bad extends Error {}
const fail = (what: string): never => {
  throw new Bad(what);
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, what: string) => (typeof x === 'number' && Number.isFinite(x) ? x : fail(what));
const int = (x: unknown, what: string) => (Number.isInteger(x) ? (x as number) : fail(what));
const str = (x: unknown, what: string) => (typeof x === 'string' ? x : fail(what));
const bool = (x: unknown, what: string) => (typeof x === 'boolean' ? x : fail(what));
const side = (x: unknown, what: string) => (x === 1 || x === -1 ? x : fail(what));
const arr = (x: unknown, what: string): unknown[] => (Array.isArray(x) ? x : fail(what));
const obj = (x: unknown, what: string) => (isObj(x) ? x : fail(what));
const oneOf = (x: unknown, allowed: object | string[], what: string) =>
  typeof x === 'string' && (Array.isArray(allowed) ? allowed.includes(x) : Object.hasOwn(allowed, x)) ? x : fail(what);

function checkNet(raw: unknown) {
  const net = obj(raw, 'the track network is missing');
  const nextId = int(net.nextId, 'the track network has no next id');
  const nodeIds = new Set<number>();
  const nodes = arr(net.nodes, 'the list of track points is missing').map((n) => {
    const o = obj(n, 'a track point is not an object');
    const id = int(o.id, 'a track point has no id');
    if (nodeIds.has(id)) fail(`track point ${id} appears twice`);
    nodeIds.add(id);
    for (const k of ['x', 'y', 'z', 'dx', 'dz']) num(o[k], `track point ${id} has a bad ${k}`);
    if (Math.hypot(o.dx as number, o.dz as number) < 1e-6) fail(`track point ${id} has no direction`);
    obj(o.sw, `track point ${id} has no switch list`);
    obj(o.signals, `track point ${id} has no signal list`);
    for (const s of Object.values(o.signals as object)) {
      if (s !== undefined)
        bool(obj(s, `track point ${id} has a bad signal`).hold, `track point ${id} has a bad signal`);
    }
    return o;
  });
  const segIds = new Set<number>();
  for (const s of arr(net.segs, 'the list of track pieces is missing')) {
    const o = obj(s, 'a track piece is not an object');
    const id = int(o.id, 'a track piece has no id');
    if (segIds.has(id)) fail(`track piece ${id} appears twice`);
    segIds.add(id);
    for (const k of ['a', 'b']) {
      if (!nodeIds.has(o[k] as number)) fail(`track piece ${id} points to a track point that does not exist`);
    }
    side(o.sa, `track piece ${id} has a bad side`);
    side(o.sb, `track piece ${id} has a bad side`);
    oneOf(o.bridge, BRIDGES, `track piece ${id} has a bad bridge setting`);
  }
  for (const o of nodes) {
    for (const v of Object.values(o.sw as object)) {
      if (v !== undefined && !segIds.has(v as number))
        fail(`track point ${String(o.id)} has a switch set to a missing piece`);
    }
  }
  for (const id of [...nodeIds, ...segIds]) if (id >= nextId) fail('the track network has a bad next id');
  const stationIds = new Set<number>();
  for (const s of arr(net.stations, 'the list of stations is missing')) {
    const o = obj(s, 'a station is not an object');
    const id = int(o.id, 'a station has no id');
    stationIds.add(id);
    str(o.name, `station ${id} has no name`);
    if (!nodeIds.has(o.nodeId as number)) fail(`station ${id} points to a track point that does not exist`);
    side(o.platformSide, `station ${id} has a bad platform side`);
    if (num(o.length, `station ${id} has a bad length`) <= 0) fail(`station ${id} has a bad length`);
  }
  return stationIds;
}

function check(d: Record<string, unknown>): SaveData {
  if (d.v !== 1) fail('it was saved by a different version of the game');
  oneOf(d.preset, PRESETS, 'the landscape type is unknown');
  num(d.seed, 'the landscape seed is not a number');
  const edits = arr(d.edits, 'the terrain edits are missing');
  if (edits.length % 2) fail('the terrain edits are cut off');
  for (let i = 0; i < edits.length; i += 2) {
    const k = edits[i];
    if (!Number.isInteger(k) || (k as number) < 0 || (k as number) >= RES * RES) fail('a terrain edit is out of range');
    num(edits[i + 1], 'a terrain edit is not a number');
  }
  const stationIds = checkNet(d.net);
  for (const p of arr(d.placed, 'the scenery list is missing')) {
    const o = obj(p, 'a scenery item is not an object');
    oneOf(o.type, SCENERY, 'a scenery item has an unknown type');
    for (const k of ['x', 'z', 'rot', 'scale']) num(o[k], `a scenery item has a bad ${k}`);
  }
  num(d.hours, 'the time of day is not a number');
  const trainIds = new Set<number>();
  for (const t of arr(d.trains, 'the train list is missing')) {
    const o = obj(t, 'a train is not an object');
    const id = int(o.id, 'a train has no id');
    if (trainIds.has(id)) fail(`train ${id} appears twice`);
    trainIds.add(id);
    str(o.name, `train ${id} has no name`);
    const cars = arr(o.cars, `train ${id} has no cars`);
    if (!cars.length) fail(`train ${id} has no cars`);
    for (const c of cars) {
      const co = obj(c, `train ${id} has a bad car`);
      oneOf(co.type, CAR_TYPES, `train ${id} has a car of an unknown type`);
      bool(co.flip, `train ${id} has a bad car`);
    }
    for (const s of arr(o.schedule, `train ${id} has no timetable`)) {
      if (!stationIds.has(s as number)) fail(`train ${id} has a timetable stop at a station that does not exist`);
    }
    if (int(o.schedIdx, `train ${id} has a bad timetable position`) < 0)
      fail(`train ${id} has a bad timetable position`);
    bool(o.ai, `train ${id} has a bad driver setting`);
    for (const k of ['x', 'z', 'hx', 'hz']) num(o[k], `train ${id} has a bad position`);
  }
  if (d.drivenId !== null && !trainIds.has(d.drivenId as number)) fail('the driven train does not exist');
  return d as unknown as SaveData;
}

/** Validates a whole save so applying it cannot fail halfway. The reason is a plain-words fragment. */
export function parseSave(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the file is cut off or is not a map' };
  }
  try {
    if (!isObj(json)) throw new Bad('it is not a map');
    return { ok: true, data: check(json) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, reason: e.message };
    throw e;
  }
}
