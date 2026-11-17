import type { Dir, Network, Piece, Side } from './network';
import type { Stop, Train } from './train';
import { DWELL, LEG_ALLOWANCE, LEG_PACE, STOP_SLACK, untilTime } from './train';
import type { AheadPiece } from './walk';
import { walkTrack } from './walk';

/** Position d metres behind the head, following the trail. */
export function behind(net: Network, t: Train, d: number) {
  let i = t.trail.length - 1;
  let piece = t.trail[i];
  let geo = net.geom.get(piece.seg)!;
  let avail = piece.dir > 0 ? t.headS : geo.length - t.headS;
  let rem = d;
  while (rem > avail && i > 0) {
    rem -= avail;
    i--;
    piece = t.trail[i];
    geo = net.geom.get(piece.seg)!;
    avail = geo.length;
    if (rem <= avail) {
      const s = piece.dir > 0 ? geo.length - rem : rem;
      return net.sampleOn(piece.seg, s, piece.dir);
    }
  }
  const baseS = i === t.trail.length - 1 ? t.headS : piece.dir > 0 ? geo.length : 0;
  const s = baseS - piece.dir * rem;
  const p = net.sampleOn(piece.seg, Math.max(0, Math.min(geo.length, s)), piece.dir);
  // Keep the unclamped distance, as before: callers past the end of the trail rely on it.
  p.s = s;
  return p;
}

export function headPose(net: Network, t: Train) {
  return behind(net, t, 0);
}

export function rememberHead(net: Network, t: Train) {
  const h = headPose(net, t);
  t.lastPos = { x: h.x, z: h.z, hx: h.tx * h.dir, hz: h.tz * h.dir };
}

export function pruneTrail(net: Network, t: Train) {
  let need = t.length + 5;
  const last = t.trail[t.trail.length - 1];
  const lastGeo = net.geom.get(last.seg)!;
  need -= last.dir > 0 ? t.headS : lastGeo.length - t.headS;
  let keepFrom = t.trail.length - 1;
  while (need > 0 && keepFrom > 0) {
    keepFrom--;
    need -= net.geom.get(t.trail[keepFrom].seg)!.length;
  }
  if (keepFrom > 0) t.trail.splice(0, keepFrom);
}

/** The segment a train takes at a node: its planned route first, then the switch. */
export function pickSegment(net: Network, t: Train | null, seg: number, node: number, side: Side): number | undefined {
  if (t && t.ai && t.route.length) {
    for (let i = 0; i < t.route.length - 1; i++) {
      if (t.route[i].seg === seg) {
        const nx = t.route[i + 1].seg;
        if (net.attached(node, side).includes(nx)) return nx;
      }
    }
  }
  return net.selected(node, side);
}

/** Walks the track ahead of the head along the route the train would take. */
export function walkTrainAhead<T>(
  net: Network,
  t: Train,
  range: number,
  visit: (p: AheadPiece) => T | null | undefined,
  maxSteps = Infinity,
): T | null {
  const h = t.trail[t.trail.length - 1];
  const start = h.dir > 0 ? -t.headS : t.headS - net.geom.get(h.seg)!.length;
  return walkTrack(
    net,
    (seg, node, side) => pickSegment(net, t, seg, node, side),
    h.seg,
    h.dir,
    start,
    range,
    maxSteps,
    visit,
  );
}

/** Cheapest forward path to a station node. Occupied track costs extra so trains prefer a free loop. */
export function findRoute(
  net: Network,
  t: Train,
  nodeId: number,
  segClaims: Map<number, number>,
  crossingClaims: Map<string, number>,
): Piece[] | null {
  const start = t.trail[t.trail.length - 1];
  const key = (p: Piece) => `${p.seg}/${p.dir}`;
  const dist = new Map<string, number>([[key(start), 0]]);
  const prev = new Map<string, Piece | null>([[key(start), null]]);
  const open: Piece[] = [start];
  while (open.length) {
    open.sort((a, b) => dist.get(key(a))! - dist.get(key(b))!);
    const cur = open.shift()!;
    const e = net.exit(cur.seg, cur.dir);
    if (e.node === nodeId) {
      const out: Piece[] = [];
      let p: Piece | null = cur;
      while (p) {
        out.unshift(p);
        p = prev.get(key(p)) ?? null;
      }
      return out;
    }
    const base = dist.get(key(cur))!;
    for (const opt of e.options) {
      const nxt: Piece = { seg: opt, dir: net.entryDir(opt, e.node, e.side) };
      const claimed = segClaims.get(opt);
      let penalty = claimed !== undefined && claimed !== t.id ? 4000 : 0;
      for (const c of net.crossingsOn(opt)) {
        const cc = crossingClaims.get(c.id);
        if (cc !== undefined && cc !== t.id) {
          penalty += 2000;
          break;
        }
      }
      const cost = base + net.geom.get(opt)!.length + penalty;
      const k = key(nxt);
      if (!dist.has(k) || cost < dist.get(k)!) {
        dist.set(k, cost);
        prev.set(k, cur);
        open.push(nxt);
      }
    }
  }
  return null;
}

/** The train's stops in order with their departure times. With no schedule, every station without times. */
export function stops(net: Network, t: Train): Stop[] {
  const all = new Set(net.stations.map((s) => s.id));
  const listed = t.schedule
    .map((id, i) => ({ id, arr: t.arrivals[i] ?? null, dep: t.times[i] ?? null, turn: t.turns[i] ?? false }))
    .filter((s) => all.has(s.id));
  return listed.length ? listed : [...all].map((id) => ({ id, arr: null, dep: null, turn: false }));
}

/** Seconds a train at its current stop must still wait for its timetabled departure. */
export function departureWait(net: Network, t: Train, clock: number) {
  const dep = stops(net, t)[t.schedIdx]?.dep;
  return dep === null || dep === undefined ? 0 : Math.max(0, untilTime(dep, clock));
}

/** Swaps the head and tail of a stopped train. */
export function reverseTrain(net: Network, t: Train): boolean {
  if (t.speed > 0.3) return false;
  const tail = behind(net, t, t.length);
  const pieces: Piece[] = [];
  let collecting = false;
  for (let i = 0; i < t.trail.length; i++) {
    if (t.trail[i].seg === tail.seg) collecting = true;
    if (collecting) pieces.push(t.trail[i]);
  }
  t.trail = (pieces.length ? pieces : t.trail).reverse().map((p) => ({ seg: p.seg, dir: -p.dir as Dir }));
  t.headS = tail.s;
  t.cars = t.cars.reverse().map((c) => ({ ...c, flip: !c.flip }));
  t.grants = [];
  t.route = [];
  t.next = null;
  t.stopRemain = -1;
  t.speed = 0;
  t.restricted = false;
  t.warning = null;
  t.lastWarnKey = '';
  t.spadTripped = false;
  t.warnTripped = false;
  return true;
}

/** Chooses the next station and a route to it, reversing at a terminus when only that works. */
export function planRoute(
  net: Network,
  t: Train,
  advance: boolean,
  segClaims: Map<number, number>,
  crossingClaims: Map<string, number>,
) {
  const order = stops(net, t).map((s) => s.id);
  t.route = [];
  t.targetStation = null;
  if (!order.length) return;
  if (advance) t.schedIdx = (t.schedIdx + 1) % order.length;
  for (const allowReverse of [false, true]) {
    for (let k = 0; k < order.length; k++) {
      const idx = (t.schedIdx + k) % order.length;
      const st = net.stationById(order[idx])!;
      const route = findRoute(net, t, st.nodeId, segClaims, crossingClaims);
      if (route) {
        t.schedIdx = idx;
        t.route = route;
        t.targetStation = st.id;
        return;
      }
    }
    if (!allowReverse && t.speed < 0.2) reverseTrain(net, t);
    else return;
  }
}

/** Running time a timetable allows from here to the next stop along the planned route, or null with no route. */
export function legTime(net: Network, t: Train): number | null {
  if (!t.route.length) return null;
  let time = LEG_ALLOWANCE;
  for (const p of t.route) {
    const g = net.geom.get(p.seg);
    if (g) time += g.length / (Math.min(g.vmax, t.topSpeed) * LEG_PACE);
  }
  return time;
}

/** Seconds until the train is due at its next stop. Negative means it's already late. */
export function dueIn(net: Network, t: Train, clock: number): number | null {
  const stop = stops(net, t)[t.schedIdx];
  if (stop && t.targetStation === stop.id) {
    if (stop.arr !== null) return untilTime(stop.arr, clock);
    if (stop.dep !== null) return untilTime(stop.dep - DWELL, clock);
  }
  return legTime(net, t);
}

/** Metres from the head back to a node under the train, or null if the node isn't under it. */
export function nodeBehind(net: Network, t: Train, node: number) {
  const head = t.trail[t.trail.length - 1];
  let d = head.dir > 0 ? t.headS : net.geom.get(head.seg)!.length - t.headS;
  for (let i = t.trail.length - 1; i >= 0; i--) {
    const p = t.trail[i];
    const seg = net.segs.get(p.seg)!;
    if ((p.dir > 0 ? seg.a : seg.b) === node) return d <= t.length + STOP_SLACK ? d : null;
    if (i > 0) d += net.geom.get(t.trail[i - 1].seg)!.length;
  }
  return null;
}

/** Fills `out` with distances (metres behind the head) to every junction node currently under the train. */
export function collectJunctionDists(net: Network, t: Train, out: number[]) {
  out.length = 0;
  if (!t.trail.length) return;
  const head = t.trail[t.trail.length - 1];
  let d = head.dir > 0 ? t.headS : net.geom.get(head.seg)!.length - t.headS;
  const maxD = t.length + 2;
  for (let i = t.trail.length - 1; i >= 0; i--) {
    const p = t.trail[i];
    const seg = net.segs.get(p.seg)!;
    const node = p.dir > 0 ? seg.a : seg.b;
    if (d <= maxD && net.isJunction(node)) out.push(d);
    if (d > maxD) break;
    if (i > 0) d += net.geom.get(t.trail[i - 1].seg)!.length;
  }
}
