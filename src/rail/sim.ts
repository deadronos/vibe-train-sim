// Train physics, block signalling with route locking, and timetable AI. Contains no rendering code.
import type { Dir, Network, Piece, Side } from './network';

export type Aspect = 'red' | 'yellow' | 'green';
export type CarType = 'loco_diesel' | 'coach' | 'wagon_box' | 'wagon_tank';

export const CAR_LENGTH: Record<CarType, number> = { loco_diesel: 20, coach: 23, wagon_box: 16, wagon_tank: 14 };
const CAR_MASS: Record<CarType, number> = { loco_diesel: 90, coach: 42, wagon_box: 38, wagon_tank: 50 }; // tonnes
const GAP = 0.8;
const G = 9.81;
const SERVICE_BRAKE = 0.75;
const FULL_BRAKE = SERVICE_BRAKE * 1.25;
const PLAN_BRAKE = 0.55; // AI plans softer than the brake can deliver
const PLAN_MARGIN = 0.7; // Share of the deceleration left on a descent that the AI relies on
const MIN_PLAN_BRAKE = 0.1;
const POWER = 2800; // kW per locomotive
const TRACTIVE = 300; // kN per locomotive

export interface Car {
  type: CarType;
  flip: boolean;
}

export const keyOf = (node: number, side: Side) => `${node}:${side}`;

export interface SimEvent {
  kind: 'spad' | 'collision' | 'buffer' | 'arrive';
  train: number;
  text: string;
}

interface Occupancy {
  train: number;
  sMin: number;
  sMax: number;
}

export interface NextSignal {
  key: string;
  node: number;
  side: Side;
  dist: number;
}

export class Train {
  id: number;
  name: string;
  cars: Car[];
  trail: Piece[] = [];
  headS = 0;
  speed = 0;
  throttle = 0;
  brake = 0;
  ai = true;
  schedule: number[] = []; // Station ids; empty = every station
  schedIdx = 0;
  route: Piece[] = [];
  targetStation: number | null = null;
  dwell = 0;
  stopRemain = -1; // Distance to run after the head passes the station node
  stuck = 0;
  crashCooldown = 0;
  grants: string[] = [];
  next: NextSignal | null = null;
  limit = 33.3; // Current speed limit, m/s
  score = { spads: 0, stops: 0 };
  statusText = '';
  /** Last known head position, used to re-seat the train when track under it is deleted. */
  lastPos: { x: number; z: number; hx: number; hz: number } | null = null;

  constructor(id: number, name: string, cars: Car[]) {
    this.id = id;
    this.name = name;
    this.cars = cars;
  }

  get length() {
    let l = 0;
    for (const c of this.cars) l += CAR_LENGTH[c.type] + GAP;
    return l - GAP;
  }

  get mass() {
    let m = 0;
    for (const c of this.cars) m += CAR_MASS[c.type];
    return m;
  }

  get locos() {
    return Math.max(1, this.cars.filter((c) => c.type === 'loco_diesel').length);
  }
}

export class Sim {
  net: Network;
  trains: Train[] = [];
  onEvent: (e: SimEvent) => void = () => {};
  /** Signal key -> aspect, refreshed by the interlocking tick. */
  aspects = new Map<string, Aspect>();
  /** Node ids locked by an active route, keyed to the train holding them. */
  nodeClaims = new Map<number, number>();
  segClaims = new Map<number, number>();
  occ = new Map<number, Occupancy[]>();
  private interlockTimer = 0;

  constructor(net: Network) {
    this.net = net;
  }

  // ------------------------------------------------------------ placement
  /** Places a train with its head at (seg, s) heading dir, shifting forward if there is no room behind. */
  place(t: Train, seg: number, s: number, dir: Dir) {
    const net = this.net;
    t.speed = 0;
    t.route = [];
    t.grants = [];
    t.dwell = 0;
    t.stopRemain = -1;
    t.targetStation = null;
    t.schedIdx %= Math.max(1, t.schedule.length || 1);
    const L = t.length + 2;
    // Walk backward from the head to find how much track exists behind.
    const buildBack = (segId: number, sAt: number, d: Dir) => {
      const pieces: Piece[] = [{ seg: segId, dir: d }];
      let have = d > 0 ? sAt : net.geom.get(segId)!.length - sAt;
      let cur: Piece = pieces[0];
      let guard = 0;
      while (have < L && guard++ < 50) {
        const back = net.exit(cur.seg, -cur.dir as Dir);
        const prevSeg = net.selected(back.node, back.side);
        if (prevSeg === undefined) break;
        const prevDirOut = net.entryDir(prevSeg, back.node, back.side);
        const prev: Piece = { seg: prevSeg, dir: -prevDirOut as Dir };
        pieces.unshift(prev);
        have += net.geom.get(prevSeg)!.length;
        cur = prev;
      }
      return { pieces, have };
    };
    const { pieces, have } = buildBack(seg, s, dir);
    t.trail = pieces;
    t.headS = s;
    if (have < L) {
      // Dead end close behind: slide the head forward along the track.
      this.advance(t, L - have, true);
    }
    this.prune(t);
    t.next = null;
  }

  /** Moves a train back onto the nearest track after edits; returns false when no track exists. */
  replace(t: Train, x: number, z: number, hdgX: number, hdgZ: number): boolean {
    const near = this.net.nearest(x, z, 1e9);
    if (!near) return false;
    const p = this.net.sample(near.seg, near.s);
    const dir: Dir = p.tx * hdgX + p.tz * hdgZ >= 0 ? 1 : -1;
    this.place(t, near.seg, near.s, dir);
    return true;
  }

  // ------------------------------------------------------------ geometry queries
  /** Position d metres behind the head, following the trail. */
  behind(t: Train, d: number) {
    const net = this.net;
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
        return { seg: piece.seg, s, dir: piece.dir, ...net.sample(piece.seg, s) };
      }
    }
    const baseS = i === t.trail.length - 1 ? t.headS : piece.dir > 0 ? geo.length : 0;
    const s = baseS - piece.dir * rem;
    return { seg: piece.seg, s, dir: piece.dir, ...net.sample(piece.seg, Math.max(0, Math.min(geo.length, s))) };
  }

  head(t: Train) {
    return this.behind(t, 0);
  }

  /** Front and rear bogie positions of a car, ordered along the consist. */
  carPose(t: Train, index: number) {
    let d = 0;
    for (let i = 0; i < index; i++) d += CAR_LENGTH[t.cars[i].type] + GAP;
    const len = CAR_LENGTH[t.cars[index].type];
    return { front: this.behind(t, d + len * 0.18), rear: this.behind(t, d + len * 0.82) };
  }

  /** Rise per metre in the direction of travel, so negative on a descent. */
  private slope(t: Train) {
    const h = this.head(t);
    return h.ty * h.dir;
  }

  /** Deceleration the AI can count on here: gravity eats into the brakes on a descent. */
  private planBrake(t: Train) {
    const available = (FULL_BRAKE + G * this.slope(t)) * PLAN_MARGIN;
    return Math.max(MIN_PLAN_BRAKE, Math.min(PLAN_BRAKE, available));
  }

  private prune(t: Train) {
    const net = this.net;
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

  // ------------------------------------------------------------ routing
  /** The segment a train takes at a node: its planned route first, then the switch. */
  pick(t: Train | null, seg: number, node: number, side: Side): number | undefined {
    if (t && t.ai && t.route.length) {
      for (let i = 0; i < t.route.length - 1; i++) {
        if (t.route[i].seg === seg) {
          const nx = t.route[i + 1].seg;
          if (this.net.attached(node, side).includes(nx)) return nx;
        }
      }
    }
    return this.net.selected(node, side);
  }

  /** Cheapest forward path to a station node. Occupied track costs extra so trains prefer a free loop. */
  findRoute(t: Train, nodeId: number): Piece[] | null {
    const net = this.net;
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
        const claimed = this.segClaims.get(opt);
        const penalty = claimed !== undefined && claimed !== t.id ? 4000 : 0;
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

  private stationOrder(t: Train) {
    const all = this.net.stations.map((s) => s.id);
    const ids = t.schedule.filter((id) => all.includes(id));
    return ids.length ? ids : all;
  }

  /** Chooses the next station and a route to it, reversing at a terminus when only that works. */
  plan(t: Train, advance: boolean) {
    const order = this.stationOrder(t);
    t.route = [];
    t.targetStation = null;
    if (!order.length) return;
    if (advance) t.schedIdx = (t.schedIdx + 1) % order.length;
    for (const allowReverse of [false, true]) {
      for (let k = 0; k < order.length; k++) {
        const idx = (t.schedIdx + k) % order.length;
        const st = this.net.stations.find((s) => s.id === order[idx])!;
        const route = this.findRoute(t, st.nodeId);
        if (route) {
          t.schedIdx = idx;
          t.route = route;
          t.targetStation = st.id;
          return;
        }
      }
      if (!allowReverse && t.speed < 0.2) this.reverse(t);
      else return;
    }
  }

  /** Swaps the head and tail of a stopped train. */
  reverse(t: Train): boolean {
    if (t.speed > 0.3) return false;
    const tail = this.behind(t, t.length);
    const pieces: Piece[] = [];
    let collecting = false;
    for (let i = 0; i < t.trail.length; i++) {
      if (t.trail[i].seg === tail.seg) collecting = true;
      if (collecting) pieces.push(t.trail[i]);
    }
    t.trail = (pieces.length ? pieces : t.trail).reverse().map((p) => ({ seg: p.seg, dir: -p.dir as Dir }));
    t.headS = tail.s;
    t.cars = t.cars.reverse().map((c) => ({ type: c.type, flip: !c.flip }));
    t.grants = [];
    t.route = [];
    t.next = null;
    t.stopRemain = -1;
    t.speed = 0;
    return true;
  }

  // ------------------------------------------------------------ interlocking
  /** Walks a block from a signal to the next signal or dead end, following the given train's route. */
  private walkBlock(startNode: number, startSide: Side, t: Train | null) {
    const net = this.net;
    const segs: number[] = [];
    const nodes: number[] = [startNode];
    let end: { node: number; side: Side } | null = null;
    let deadEnd = false;
    const firstSeg = this.pick(t, -1, startNode, startSide);
    if (firstSeg === undefined) return { segs, nodes, end, deadEnd: true };
    let seg = firstSeg;
    let dir = net.entryDir(seg, startNode, startSide);
    const seen = new Set<number>();
    while (!seen.has(seg) && seen.size < 200) {
      seen.add(seg);
      segs.push(seg);
      const e = net.exit(seg, dir);
      if (net.nodes.get(e.node)!.signals[e.side]) {
        end = { node: e.node, side: e.side };
        break;
      }
      nodes.push(e.node);
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) {
        deadEnd = true;
        break;
      }
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
    }
    return { segs, nodes, end, deadEnd };
  }

  private blockFree(b: { segs: number[]; nodes: number[] }, trainId: number | null) {
    for (const s of b.segs) {
      const c = this.segClaims.get(s);
      if (c !== undefined && c !== trainId) return false;
      for (const o of this.occ.get(s) ?? []) if (o.train !== trainId) return false;
    }
    for (const n of b.nodes) {
      const c = this.nodeClaims.get(n);
      if (c !== undefined && c !== trainId) return false;
    }
    return true;
  }

  private rebuildOccupancy() {
    this.occ.clear();
    for (const t of this.trains) {
      const net = this.net;
      let rem = t.length;
      for (let i = t.trail.length - 1; i >= 0 && rem > 0; i--) {
        const p = t.trail[i];
        const L = net.geom.get(p.seg)!.length;
        const front = i === t.trail.length - 1 ? t.headS : p.dir > 0 ? L : 0;
        const avail = p.dir > 0 ? front : L - front;
        const used = Math.min(rem, avail);
        const back = front - p.dir * used;
        const list = this.occ.get(p.seg) ?? [];
        list.push({ train: t.id, sMin: Math.min(front, back), sMax: Math.max(front, back) });
        this.occ.set(p.seg, list);
        rem -= used;
      }
    }
  }

  /** Refreshes claims, grants routes to approaching trains and computes every signal aspect. */
  interlock() {
    const net = this.net;
    this.rebuildOccupancy();
    this.segClaims.clear();
    this.nodeClaims.clear();
    for (const t of this.trains) {
      for (const [seg, list] of this.occ) if (list.some((o) => o.train === t.id)) this.segClaims.set(seg, t.id);
    }
    // Existing grants keep priority over new requests.
    for (const t of this.trains) this.walkClaims(t);
    for (const t of this.trains) {
      if (!t.next || t.crashCooldown > 0) continue;
      const stopping = (t.speed * t.speed) / (2 * this.planBrake(t));
      if (t.next.dist > stopping + 220) continue;
      const node = net.nodes.get(t.next.node)!;
      const def = node.signals[t.next.side];
      if (!def || def.hold) continue;
      const block = this.walkBlock(t.next.node, t.next.side, t);
      if (this.blockFree(block, t.id)) {
        t.grants.push(t.next.key);
        this.setRouteSwitches(t, block);
        this.walkClaims(t);
      }
    }
    // Aspects.
    this.aspects.clear();
    const grantedKeys = new Map<string, Train>();
    for (const t of this.trains) for (const k of t.grants) grantedKeys.set(k, t);
    for (const node of net.nodes.values()) {
      for (const sideStr of Object.keys(node.signals)) {
        const side = Number(sideStr) as Side;
        const def = node.signals[side];
        if (!def) continue;
        const key = keyOf(node.id, side);
        if (def.hold) {
          this.aspects.set(key, 'red');
          continue;
        }
        const holder = grantedKeys.get(key) ?? null;
        const block = this.walkBlock(node.id, side, holder);
        if (!holder && !this.blockFree(block, null)) {
          this.aspects.set(key, 'red');
          continue;
        }
        let onward = !block.deadEnd;
        if (block.end) {
          const nextDef = net.nodes.get(block.end.node)!.signals[block.end.side]!;
          const nextBlock = this.walkBlock(block.end.node, block.end.side, holder);
          if (nextDef.hold || !this.blockFree(nextBlock, holder?.id ?? null)) onward = false;
        }
        this.aspects.set(key, onward ? 'green' : 'yellow');
      }
    }
  }

  private setRouteSwitches(t: Train, block: { segs: number[]; nodes: number[] }) {
    const net = this.net;
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

  /** Claims track from the head through every granted signal and records the next ungranted signal. */
  private walkClaims(t: Train) {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    const geo = net.geom.get(h.seg)!;
    let d = h.dir > 0 ? geo.length - t.headS : t.headS;
    let seg = h.seg;
    let dir = h.dir;
    const seen = new Set<number>();
    let grantIdx = 0;
    t.next = null;
    while (d < 6000 && !seen.has(seg)) {
      seen.add(seg);
      if (!this.segClaims.has(seg)) this.segClaims.set(seg, t.id);
      const e = net.exit(seg, dir);
      const def = net.nodes.get(e.node)!.signals[e.side];
      if (def) {
        const key = keyOf(e.node, e.side);
        if (t.grants[grantIdx] === key && !def.hold) {
          grantIdx++;
        } else {
          t.grants.length = Math.min(t.grants.length, grantIdx);
          t.next = { key, node: e.node, side: e.side, dist: d };
          break;
        }
      }
      if (!this.nodeClaims.has(e.node)) this.nodeClaims.set(e.node, t.id);
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) break;
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
      d += net.geom.get(seg)!.length;
    }
    t.grants.length = Math.min(t.grants.length, grantIdx);
  }

  switchLocked(node: number) {
    return this.nodeClaims.has(node);
  }

  // ------------------------------------------------------------ motion
  private advance(t: Train, ds: number, silent = false) {
    const net = this.net;
    let rem = ds;
    let guard = 0;
    while (rem > 1e-6 && guard++ < 50) {
      const p = t.trail[t.trail.length - 1];
      const L = net.geom.get(p.seg)!.length;
      const toEnd = p.dir > 0 ? L - t.headS : t.headS;
      if (rem < toEnd) {
        t.headS += p.dir * rem;
        rem = 0;
        break;
      }
      rem -= toEnd;
      t.headS = p.dir > 0 ? L : 0;
      const e = net.exit(p.seg, p.dir);
      const nxt = this.pick(t, p.seg, e.node, e.side);
      if (nxt === undefined) {
        if (!silent && t.speed > 1.5) {
          this.onEvent({
            kind: 'buffer',
            train: t.id,
            text: `${t.name} hit the buffer stop at ${Math.round(t.speed * 3.6)} km/h`,
          });
        }
        t.speed = 0;
        break;
      }
      if (!silent) this.crossNode(t, e.node, e.side, p.seg);
      const dir = net.entryDir(nxt, e.node, e.side);
      t.trail.push({ seg: nxt, dir });
      t.headS = dir > 0 ? 0 : net.geom.get(nxt)!.length;
    }
    if (!silent && ds > 0 && t.stopRemain >= 0) t.stopRemain = Math.max(0, t.stopRemain - (ds - rem));
    this.prune(t);
  }

  private crossNode(t: Train, node: number, side: Side, fromSeg: number) {
    const net = this.net;
    const n = net.nodes.get(node)!;
    const key = keyOf(node, side);
    if (n.signals[side]) {
      if (t.grants[0] === key) {
        t.grants.shift();
      } else if (this.aspects.get(key) === 'red') {
        t.score.spads++;
        this.onEvent({ kind: 'spad', train: t.id, text: `${t.name} passed a signal at danger` });
      }
    }
    // Trailing moves pull the points over behind the train.
    const arrival = -side as Side;
    if (net.attached(node, arrival).length > 1) {
      const claim = this.nodeClaims.get(node);
      if (claim === undefined || claim === t.id) n.sw[arrival] = fromSeg;
    }
    const st = net.stations.find((s) => s.nodeId === node);
    if (st && t.ai && st.id === t.targetStation) t.stopRemain = Math.max(1, t.length / 2);
  }

  private collectLimits(t: Train) {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    let seg = h.seg;
    let dir = h.dir;
    let geo = net.geom.get(seg)!;
    let toEnd = dir > 0 ? geo.length - t.headS : t.headS;
    let dist = 0; // Distance from head to the start of this piece (0 for the current one)
    const planBrake = this.planBrake(t);
    const range = Math.max(400, (t.speed * t.speed) / (2 * planBrake) + 300);
    let allowed = geo.vmax;
    let stopAt = Infinity;
    let stationAt = Infinity;
    let bufferAt = Infinity;
    if (t.stopRemain >= 0) stationAt = t.stopRemain;
    const seen = new Set<number>();
    let current = true;
    const lineLimit = geo.vmax;
    while (dist < range && !seen.has(seg)) {
      seen.add(seg);
      if (!current) {
        allowed = Math.min(allowed, Math.sqrt(geo.vmax ** 2 + 2 * planBrake * dist));
      }
      for (const o of this.occ.get(seg) ?? []) {
        if (o.train === t.id) continue;
        const gap = dir > 0 ? (current ? o.sMin - t.headS : o.sMin) : current ? t.headS - o.sMax : geo.length - o.sMax;
        if (gap >= -2 || !current) stopAt = Math.min(stopAt, dist + Math.max(gap, 0) - 25);
      }
      const e = net.exit(seg, dir);
      const end = dist + toEnd;
      const nodeDef = net.nodes.get(e.node)!;
      const def = nodeDef.signals[e.side];
      const key = keyOf(e.node, e.side);
      if (def && !t.grants.includes(key)) {
        stopAt = Math.min(stopAt, end - 8);
        break;
      }
      const st = net.stations.find((s) => s.nodeId === e.node);
      if (st && st.id === t.targetStation && t.stopRemain < 0 && t.ai) {
        stationAt = Math.min(stationAt, end + Math.max(1, t.length / 2));
      }
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) {
        bufferAt = end - 4;
        break;
      }
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
      geo = net.geom.get(seg)!;
      dist = end;
      toEnd = geo.length;
      current = false;
    }
    if (bufferAt < stationAt) stationAt = bufferAt;
    stopAt = Math.min(stopAt, bufferAt, stationAt);
    return { allowed, stopAt, stationAt, lineLimit, planBrake };
  }

  private driveAI(t: Train, dt: number) {
    if (t.dwell > 0) {
      t.dwell -= dt;
      t.throttle = 0;
      t.brake = 1;
      t.statusText = 'At platform';
      if (t.dwell <= 0) {
        t.stopRemain = -1;
        this.plan(t, true);
      }
      return;
    }
    if (t.targetStation === null && !t.route.length && this.net.stations.length) this.plan(t, false);
    const lim = this.collectLimits(t);
    t.limit = lim.lineLimit;
    let target = lim.allowed;
    if (lim.stopAt !== Infinity)
      target = Math.min(target, Math.sqrt(2 * lim.planBrake * Math.max(0, lim.stopAt - 0.5)));
    if (lim.stopAt <= 0.6) target = 0;
    const diff = target - t.speed;
    // Without this share the train settles at a creep on a descent, where gravity balances a light brake.
    const hold = Math.max(0, -G * this.slope(t)) / FULL_BRAKE;
    if (diff > 0.3) {
      t.throttle = Math.min(1, diff * 0.45);
      t.brake = 0;
    } else if (diff < -0.1) {
      t.throttle = 0;
      t.brake = Math.min(1, hold - diff * 0.7 + 0.2);
    } else {
      t.throttle = 0;
      t.brake = target < 0.2 ? 1 : hold;
    }
    // Arrival.
    if (t.speed < 0.25 && lim.stationAt <= 2.5) {
      t.dwell = 22;
      t.score.stops++;
      const st = this.net.stations.find((s) => s.id === t.targetStation);
      if (st) this.onEvent({ kind: 'arrive', train: t.id, text: `${t.name} arrived at ${st.name}` });
      t.stuck = 0;
      t.brake = 1;
      return;
    }
    // Waiting: try a different route, then back away so opposing trains can never lock each other out.
    if (t.speed < 0.15 && target < 0.3) {
      t.statusText = 'Waiting at signal';
      t.stuck += dt;
      if (t.stuck > 20 && t.stuck - dt <= 20 && t.targetStation !== null) {
        const st = this.net.stations.find((s) => s.id === t.targetStation);
        const r = st ? this.findRoute(t, st.nodeId) : null;
        if (r) t.route = r;
      }
      if (t.stuck > 70) {
        if (this.inDeadlock(t)) {
          t.stuck = 0;
          this.reverse(t);
          this.plan(t, false);
        } else {
          t.stuck = 45; // Plain queueing: look again shortly.
        }
      }
    } else {
      t.stuck = 0;
      t.statusText = t.targetStation
        ? `Next stop: ${this.net.stations.find((s) => s.id === t.targetStation)?.name ?? ''}`
        : 'Running';
    }
  }

  /** True when the track ahead is held by a train that is also stuck. The younger train gives way. */
  private inDeadlock(t: Train) {
    if (!t.next) return false;
    const def = this.net.nodes.get(t.next.node)!.signals[t.next.side];
    if (!def || def.hold) return false; // A held signal is the player's decision, not a deadlock.
    const block = this.walkBlock(t.next.node, t.next.side, t);
    for (const seg of block.segs) {
      const holder = this.segClaims.get(seg);
      const other = this.trains.find((o) => o.id === holder);
      if (other && other !== t && other.stuck > 15 && other.dwell <= 0 && t.id > other.id) return true;
    }
    return false;
  }

  private physics(t: Train, dt: number) {
    const slope = this.slope(t);
    const m = t.mass; // tonnes -> force in kN gives m/s^2
    const v = Math.max(t.speed, 0.5);
    const force = Math.min(TRACTIVE * t.locos, (POWER * t.locos) / v) * t.throttle;
    const drag = 0.012 * G * m + 0.0035 * m * t.speed + 0.012 * t.speed * t.speed;
    let a = force / m - G * slope;
    const resist = drag / m + t.brake * FULL_BRAKE;
    if (t.speed > 0 || a > resist) {
      a -= resist;
    } else {
      a = 0; // Held stationary by the brakes.
    }
    t.speed = Math.max(0, t.speed + a * dt);
    if (t.speed > 0) this.advance(t, t.speed * dt);
  }

  private collisions(dt: number) {
    for (const t of this.trains) if (t.crashCooldown > 0) t.crashCooldown -= dt;
    for (let i = 0; i < this.trains.length; i++) {
      for (let j = i + 1; j < this.trains.length; j++) {
        const A = this.trains[i];
        const B = this.trains[j];
        if (A.crashCooldown > 0 || B.crashCooldown > 0) continue;
        const pa = [this.behind(A, 0), this.behind(A, A.length)];
        const pb = [this.behind(B, 0), this.behind(B, B.length)];
        const reach = A.length + B.length;
        if (Math.hypot(pa[0].x - pb[0].x, pa[0].z - pb[0].z) > reach + 10) continue;
        let hit = false;
        for (let da = 0; da <= A.length && !hit; da += 6) {
          const a = this.behind(A, da);
          for (let db = 0; db <= B.length; db += 6) {
            const b = this.behind(B, db);
            if (Math.hypot(a.x - b.x, a.z - b.z) < 3.2 && Math.abs(a.y - b.y) < 3.5) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          const fast = Math.max(A.speed, B.speed);
          this.onEvent({
            kind: 'collision',
            train: A.id,
            text: `${A.name} and ${B.name} collided at ${Math.round(fast * 3.6)} km/h`,
          });
          for (const t of [A, B]) {
            t.speed = 0;
            t.crashCooldown = 12;
            if (t.ai) {
              this.reverse(t);
              this.plan(t, false);
            } else {
              t.throttle = 0;
              t.brake = 1;
            }
          }
        }
      }
    }
  }

  update(dt: number) {
    if (!this.trains.length) {
      this.interlockTimer += dt;
      if (this.interlockTimer > 0.25) {
        this.interlockTimer = 0;
        this.interlock();
      }
      return;
    }
    const h = Math.min(dt, 0.1);
    this.interlockTimer += h;
    if (this.interlockTimer > 0.15) {
      this.interlockTimer = 0;
      this.interlock();
    }
    for (const t of this.trains) {
      if (t.ai) this.driveAI(t, h);
      else this.updatePlayerLimit(t);
      this.physics(t, h);
    }
    this.collisions(h);
  }

  private updatePlayerLimit(t: Train) {
    const lim = this.collectLimits(t);
    t.limit = lim.lineLimit;
    t.statusText = '';
  }

  /** The next junction ahead that the driver can throw, within the given range. */
  nextJunction(t: Train, range = 800) {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    let seg = h.seg;
    let dir = h.dir;
    let geo = net.geom.get(seg)!;
    let d = dir > 0 ? geo.length - t.headS : t.headS;
    const seen = new Set<number>();
    while (d < range && !seen.has(seg)) {
      seen.add(seg);
      const e = net.exit(seg, dir);
      if (e.options.length > 1) {
        return { node: e.node, side: e.side, dist: d, selected: net.selected(e.node, e.side)!, options: e.options };
      }
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) return null;
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
      geo = net.geom.get(seg)!;
      d += geo.length;
    }
    return null;
  }

  /** Next signal for the HUD, walking past granted ones so the repeater shows what matters. */
  signalAhead(t: Train) {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    let seg = h.seg;
    let dir = h.dir;
    let geo = net.geom.get(seg)!;
    let d = dir > 0 ? geo.length - t.headS : t.headS;
    const seen = new Set<number>();
    while (d < 4000 && !seen.has(seg)) {
      seen.add(seg);
      const e = net.exit(seg, dir);
      if (net.nodes.get(e.node)!.signals[e.side]) {
        return { dist: d, aspect: this.aspects.get(keyOf(e.node, e.side)) ?? 'green', node: e.node, side: e.side };
      }
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) return null;
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
      geo = net.geom.get(seg)!;
      d += geo.length;
    }
    return null;
  }

  stationAhead(t: Train) {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    let seg = h.seg;
    let dir = h.dir;
    let geo = net.geom.get(seg)!;
    let d = dir > 0 ? geo.length - t.headS : t.headS;
    const seen = new Set<number>();
    while (d < 5000 && !seen.has(seg)) {
      seen.add(seg);
      const e = net.exit(seg, dir);
      const st = net.stations.find((s) => s.nodeId === e.node);
      if (st) return { name: st.name, dist: d };
      const nx = this.pick(t, seg, e.node, e.side);
      if (nx === undefined) return null;
      dir = net.entryDir(nx, e.node, e.side);
      seg = nx;
      geo = net.geom.get(seg)!;
      d += geo.length;
    }
    return null;
  }
}
