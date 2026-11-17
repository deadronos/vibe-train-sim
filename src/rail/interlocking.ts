import type { Dir, Network, Side } from './network';
import { LINE_VMAX, signalType } from './network';
import { pickSegment, walkTrainAhead } from './routing';
import type { Train } from './train';
import type { Aspect, SignalIndication, SignalRoute } from './walk';
import { keyOf, walkTrack } from './walk';

export interface Occupancy {
  train: number;
  sMin: number;
  sMax: number;
}

export interface InterlockState {
  aspects: Map<string, Aspect>;
  indications: Map<string, SignalIndication>;
  nodeClaims: Map<number, number>;
  segClaims: Map<number, number>;
  crossingClaims: Map<string, number>;
  occ: Map<number, Occupancy[]>;
  segDirs: Map<number, Set<Dir>>;
  shuntSegs: Map<number, number>;
}

export interface BlockWalk {
  segs: number[];
  dirs: Dir[];
  nodes: number[];
  crossings: string[];
  end: { node: number; side: Side } | null;
  deadEnd: boolean;
}

/** Walks a block from a signal to the next stopping signal or dead end, skipping distant repeaters. */
export function walkBlock(net: Network, startNode: number, startSide: Side, t: Train | null): BlockWalk {
  const segs: number[] = [];
  const dirs: Dir[] = [];
  const nodes: number[] = [startNode];
  const crossingSet = new Set<string>();
  let end: { node: number; side: Side } | null = null;
  let deadEnd = false;
  const pick = (seg: number, node: number, side: Side) => pickSegment(net, t, seg, node, side);
  const firstSeg = pick(-1, startNode, startSide);
  if (firstSeg === undefined) return { segs, dirs, nodes, crossings: [], end, deadEnd: true };
  walkTrack(
    net,
    pick,
    firstSeg,
    net.entryDir(firstSeg, startNode, startSide),
    0,
    Infinity,
    200,
    ({ seg, dir, exit }) => {
      segs.push(seg);
      dirs.push(dir);
      for (const c of net.crossingsOn(seg)) crossingSet.add(c.id);
      const exitDef = net.nodes.get(exit.node)!.signals[exit.side];
      if (exitDef && signalType(exitDef) !== 'distant') {
        end = { node: exit.node, side: exit.side };
        return true;
      }
      nodes.push(exit.node);
      if (pick(seg, exit.node, exit.side) === undefined) {
        deadEnd = true;
        return true;
      }
      return undefined;
    },
  );
  return { segs, dirs, nodes, crossings: [...crossingSet], end, deadEnd };
}

export function blockFree(
  state: InterlockState,
  b: { segs: number[]; nodes: number[]; crossings: string[] },
  trainId: number | null,
) {
  for (const s of b.segs) {
    const c = state.segClaims.get(s);
    if (c !== undefined && c !== trainId) return false;
    const sh = state.shuntSegs.get(s);
    if (sh !== undefined && sh !== trainId) return false;
    for (const o of state.occ.get(s) ?? []) if (o.train !== trainId) return false;
  }
  for (const n of b.nodes) {
    const c = state.nodeClaims.get(n);
    if (c !== undefined && c !== trainId) return false;
  }
  for (const cid of b.crossings) {
    const c = state.crossingClaims.get(cid);
    if (c !== undefined && c !== trainId) return false;
  }
  return true;
}

/**
 * Calling-on / shunt move: allows entering a block occupied by a standing or same-direction train,
 * while rejecting opposing moves, active opposing claims, and conflicting level crossings.
 */
export function callingOnAllowed(
  net: Network,
  trains: Train[],
  state: InterlockState,
  b: { segs: number[]; dirs: Dir[]; nodes: number[]; crossings: string[] },
  trainId: number | null,
): boolean {
  if (!b.segs.length) return false;
  if (blockFree(state, b, trainId)) return true;
  const blockSegSet = new Set(b.segs);
  for (const n of b.nodes) {
    const c = state.nodeClaims.get(n);
    if (c !== undefined && c !== trainId) {
      // Allow a claim on a terminal/forward node held solely by a train already occupying this block.
      const inBlock = b.segs.some((s) => (state.occ.get(s) ?? []).some((o) => o.train === c));
      if (!inBlock) return false;
    }
  }
  for (const cid of b.crossings) {
    const c = state.crossingClaims.get(cid);
    if (c === undefined || c === trainId) continue;
    const crossing = net.crossings.find((x) => x.id === cid);
    if (!crossing) return false;
    const otherSeg = blockSegSet.has(crossing.seg1) ? crossing.seg2 : crossing.seg1;
    if (!blockSegSet.has(otherSeg) || (state.occ.get(otherSeg)?.some((o) => o.train === c) ?? false)) return false;
  }
  for (let i = 0; i < b.segs.length; i++) {
    const s = b.segs[i];
    const dir = b.dirs[i];
    const shuntHolder = state.shuntSegs.get(s);
    if (shuntHolder !== undefined && shuntHolder !== trainId) return false;
    const occs = state.occ.get(s) ?? [];
    const claimedBy = state.segClaims.get(s);
    if (claimedBy !== undefined && claimedBy !== trainId && !occs.some((o) => o.train === claimedBy)) return false;
    const dirs = state.segDirs.get(s);
    if (dirs && dirs.has(-dir as Dir)) {
      if (!occs.length) return false;
      for (const o of occs) {
        if (o.train === trainId) continue;
        const other = trains.find((tr) => tr.id === o.train);
        if (!other) return false;
        const piece = other.trail.find((p) => p.seg === s);
        if (piece && piece.dir !== dir) {
          if (other.speed >= 0.25 || other.throttle > 0 || other.grants.length > 0) return false;
        }
      }
    }
  }
  return true;
}

/** Describes the first facing junction protected by a block, if any. */
export function routeInfo(
  net: Network,
  startNode: number,
  startSide: Side,
  block: { segs: number[]; dirs: Dir[] },
): SignalRoute | null {
  if (!block.segs.length) return null;
  let jNode = -1;
  let jSide: Side = 1;
  let selected = -1;
  if (net.attached(startNode, startSide).length > 1) {
    jNode = startNode;
    jSide = startSide;
    selected = block.segs[0];
  } else {
    for (let i = 0; i < block.segs.length - 1; i++) {
      const e = net.exit(block.segs[i], block.dirs[i]);
      if (e.options.length > 1) {
        jNode = e.node;
        jSide = e.side;
        selected = block.segs[i + 1];
        break;
      }
    }
  }
  if (jNode < 0) return null;
  const options = net.attached(jNode, jSide);
  const n = net.nodes.get(jNode)!;
  const hx = n.dx * jSide;
  const hz = n.dz * jSide;
  let primary = options[0];
  let bestStraight = -Infinity;
  let bestVmax = -1;
  const dirVec = (segId: number) => {
    const geo = net.geom.get(segId)!;
    const d = net.entryDir(segId, jNode, jSide);
    const dist = Math.min(30, geo.length * 0.5);
    const p = net.sample(segId, d > 0 ? dist : geo.length - dist);
    const vx = p.x - n.x;
    const vz = p.z - n.z;
    const l = Math.hypot(vx, vz) || 1;
    return { cx: vx / l, cz: vz / l, vmax: geo.vmax };
  };
  for (const opt of options) {
    const v = dirVec(opt);
    const straight = hx * v.cx + hz * v.cz;
    if (straight > bestStraight + 0.015 || (Math.abs(straight - bestStraight) <= 0.015 && v.vmax > bestVmax)) {
      bestStraight = straight;
      bestVmax = v.vmax;
      primary = opt;
    }
  }
  const sel = dirVec(selected);
  const diverging = selected !== primary || bestStraight < 0.96;
  const rightDot = hx * sel.cz - hz * sel.cx;
  const dir: SignalRoute['dir'] = diverging ? (rightDot >= 0 ? 'right' : 'left') : 'straight';
  let speed = LINE_VMAX;
  for (const sid of block.segs) speed = Math.min(speed, net.geom.get(sid)!.vmax);
  return {
    diverging,
    dir,
    index: Math.max(0, options.indexOf(selected)),
    count: options.length,
    speed,
  };
}

function claimSeg(net: Network, state: InterlockState, seg: number, dir: Dir, trainId: number) {
  if (!state.segClaims.has(seg)) state.segClaims.set(seg, trainId);
  let dirs = state.segDirs.get(seg);
  if (!dirs) {
    dirs = new Set();
    state.segDirs.set(seg, dirs);
  }
  dirs.add(dir);
  for (const c of net.crossingsOn(seg)) {
    if (!state.crossingClaims.has(c.id)) state.crossingClaims.set(c.id, trainId);
  }
}

export function rebuildOccupancy(net: Network, trains: Train[], occ: Map<number, Occupancy[]>) {
  occ.clear();
  for (const t of trains) {
    let rem = t.length;
    for (let i = t.trail.length - 1; i >= 0 && rem > 0; i--) {
      const p = t.trail[i];
      const L = net.geom.get(p.seg)!.length;
      const front = i === t.trail.length - 1 ? t.headS : p.dir > 0 ? L : 0;
      const avail = p.dir > 0 ? front : L - front;
      const used = Math.min(rem, avail);
      const back = front - p.dir * used;
      const list = occ.get(p.seg) ?? [];
      list.push({ train: t.id, sMin: Math.min(front, back), sMax: Math.max(front, back) });
      occ.set(p.seg, list);
      rem -= used;
    }
  }
}

function setRouteSwitches(net: Network, block: { segs: number[]; nodes: number[] }) {
  for (let i = 1; i < block.segs.length; i++) {
    const prev = net.segs.get(block.segs[i - 1])!;
    const cur = net.segs.get(block.segs[i])!;
    const shared = prev.a === cur.a || prev.b === cur.a ? cur.a : cur.b;
    const side = cur.a === shared ? cur.sa : cur.sb;
    net.nodes.get(shared)!.sw[side] = block.segs[i];
  }
  if (block.segs.length) {
    const first = net.segs.get(block.segs[0])!;
    const n = block.nodes[0];
    net.nodes.get(n)!.sw[first.a === n ? first.sa : first.sb] = block.segs[0];
  }
}

/** Claims track from the head through every granted signal and records the next ungranted stopping signal. */
function walkClaims(net: Network, state: InterlockState, t: Train) {
  let grantIdx = 0;
  t.next = null;
  walkTrainAhead(net, t, 6000, ({ seg, dir, end, exit }) => {
    if (end >= 6000) return null;
    claimSeg(net, state, seg, dir, t.id);
    const def = net.nodes.get(exit.node)!.signals[exit.side];
    if (def && signalType(def) !== 'distant') {
      const key = keyOf(exit.node, exit.side);
      if (t.grants[grantIdx] === key && !def.hold) {
        grantIdx++;
      } else {
        t.grants.length = Math.min(t.grants.length, grantIdx);
        t.next = { key, node: exit.node, side: exit.side, dist: end };
        return true;
      }
    }
    if (!state.nodeClaims.has(exit.node)) state.nodeClaims.set(exit.node, t.id);
    return undefined;
  });
  t.grants.length = Math.min(t.grants.length, grantIdx);
}

/** Refreshes claims, grants routes to approaching trains and computes every signal aspect. */
export function interlockNetwork(
  net: Network,
  trains: Train[],
  state: InterlockState,
  planBrakeFn: (t: Train) => number,
) {
  rebuildOccupancy(net, trains, state.occ);
  state.segClaims.clear();
  state.nodeClaims.clear();
  state.crossingClaims.clear();
  state.segDirs.clear();
  state.shuntSegs.clear();
  for (const t of trains) {
    const occupiedSegs = new Set<number>();
    for (const [seg, list] of state.occ) if (list.some((o) => o.train === t.id)) occupiedSegs.add(seg);
    for (const p of t.trail) if (occupiedSegs.has(p.seg)) claimSeg(net, state, p.seg, p.dir, t.id);
  }
  // Existing grants keep priority over new requests.
  for (const t of trains) walkClaims(net, state, t);
  for (const t of trains) {
    if (!t.next || t.crashCooldown > 0) continue;
    const stopping = (t.speed * t.speed) / (2 * planBrakeFn(t));
    if (t.next.dist > stopping + 220) continue;
    const node = net.nodes.get(t.next.node)!;
    const def = node.signals[t.next.side];
    if (!def || def.hold) continue;
    const type = signalType(def);
    const block = walkBlock(net, t.next.node, t.next.side, t);
    const ok = type === 'shunt' ? callingOnAllowed(net, trains, state, block, t.id) : blockFree(state, block, t.id);
    if (ok) {
      t.grants.push(t.next.key);
      setRouteSwitches(net, block);
      if (type === 'shunt') {
        for (const s of block.segs) {
          if ((state.occ.get(s)?.length ?? 0) > 0 && !state.shuntSegs.has(s)) state.shuntSegs.set(s, t.id);
        }
      }
      walkClaims(net, state, t);
    }
  }
  // Aspects and full indications. Two passes so distant signals reflect the main/shunt signals ahead.
  state.aspects.clear();
  state.indications.clear();
  const grantedKeys = new Map<string, Train>();
  for (const t of trains) for (const k of t.grants) grantedKeys.set(k, t);
  const distantQueue: { nodeId: number; side: Side; hold: boolean }[] = [];
  for (const node of net.nodes.values()) {
    for (const sideStr of Object.keys(node.signals)) {
      const side = Number(sideStr) as Side;
      const def = node.signals[side];
      if (!def) continue;
      const type = signalType(def);
      if (type === 'distant') {
        distantQueue.push({ nodeId: node.id, side, hold: def.hold });
        continue;
      }
      const key = keyOf(node.id, side);
      const holder = grantedKeys.get(key) ?? null;
      const block = walkBlock(net, node.id, side, holder);
      const route = routeInfo(net, node.id, side, block);
      if (def.hold) {
        state.aspects.set(key, 'red');
        state.indications.set(key, { type, aspect: 'red', callingOn: false, route });
        continue;
      }
      if (type === 'shunt') {
        const ok = holder !== null || callingOnAllowed(net, trains, state, block, null);
        const aspect: Aspect = ok ? 'yellow' : 'red';
        state.aspects.set(key, aspect);
        state.indications.set(key, { type, aspect, callingOn: ok, route });
        continue;
      }
      if (!holder && !blockFree(state, block, null)) {
        state.aspects.set(key, 'red');
        state.indications.set(key, { type, aspect: 'red', callingOn: false, route });
        continue;
      }
      let onward = !block.deadEnd;
      if (block.end) {
        const nextDef = net.nodes.get(block.end.node)!.signals[block.end.side]!;
        const nextType = signalType(nextDef);
        const nextBlock = walkBlock(net, block.end.node, block.end.side, holder);
        const nextFree = blockFree(state, nextBlock, holder?.id ?? null);
        if (
          nextDef.hold ||
          (nextType === 'shunt' ? !callingOnAllowed(net, trains, state, nextBlock, holder?.id ?? null) : !nextFree)
        )
          onward = false;
        // Warn approaching drivers with yellow before a calling-on move into an occupied section.
        if (nextType === 'shunt' && !nextFree) onward = false;
      }
      if (onward && route?.diverging) {
        const incoming = net.attached(node.id, -side as Side);
        const approachVmax = incoming.length
          ? Math.max(...incoming.map((id) => net.geom.get(id)?.vmax ?? LINE_VMAX))
          : LINE_VMAX;
        if (route.speed < approachVmax - 2.5) onward = false;
      }
      const aspect: Aspect = onward ? 'green' : 'yellow';
      state.aspects.set(key, aspect);
      state.indications.set(key, { type, aspect, callingOn: false, route });
    }
  }
  for (const d of distantQueue) {
    const key = keyOf(d.nodeId, d.side);
    const block = walkBlock(net, d.nodeId, d.side, null);
    const route = routeInfo(net, d.nodeId, d.side, block);
    let aspect: Aspect = 'yellow';
    if (!d.hold && block.end) {
      const nextInd = state.indications.get(keyOf(block.end.node, block.end.side));
      if (nextInd && nextInd.aspect !== 'red' && !nextInd.callingOn) aspect = 'green';
    }
    state.aspects.set(key, aspect);
    state.indications.set(key, { type: 'distant', aspect, callingOn: false, route });
  }
}

/** True when the track ahead is held by a train that is also stuck. The younger train gives way. */
export function inDeadlock(net: Network, trains: Train[], state: InterlockState, t: Train) {
  if (!t.next) return false;
  const def = net.nodes.get(t.next.node)!.signals[t.next.side];
  if (!def || def.hold) return false; // A held signal is the player's decision, not a deadlock.
  const block = walkBlock(net, t.next.node, t.next.side, t);
  for (const seg of block.segs) {
    const holder = state.segClaims.get(seg);
    const other = trains.find((o) => o.id === holder);
    if (other && other !== t && other.stuck > 15 && other.dwell <= 0 && t.id > other.id) return true;
  }
  for (const cid of block.crossings) {
    const holder = state.crossingClaims.get(cid);
    const other = trains.find((o) => o.id === holder);
    if (other && other !== t && other.stuck > 15 && other.dwell <= 0 && t.id > other.id) return true;
  }
  return false;
}
