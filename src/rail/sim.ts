// Train physics, block signalling with route locking, and timetable AI. Contains no rendering code.
import type { Duty } from './duty';
import { PENALTY } from './duty';
import type { Dir, Exit, Network, Piece, Side, SignalType } from './network';
import { LINE_VMAX, signalType } from './network';
import type { Car } from './vehicles';
import { carBrake, carMass, VEHICLES } from './vehicles';

export type Aspect = 'red' | 'yellow' | 'green';
/** Speed cap (25 km/h) when proceeding past a calling-on / shunt signal. */
export const SHUNT_VMAX = 25 / 3.6;
/** Seconds the driver has to acknowledge a cab warning before protection brakes under strict rules. */
export const WARN_ACK_SECONDS = 4.0;
/** Seconds per simulation step. Results don't depend on how often frames arrive. */
export const STEP = 1 / 30;
const MAX_STEPS_PER_UPDATE = 32; // Beyond this a slow machine falls behind rather than stalling further
const GAP = 0.8;
const G = 9.81;
const EMERGENCY = 1.5; // Emergency brake force, as a multiple of full service braking
const PLAN_SHARE = 0.6; // AI plans softer than the service brake can deliver
const PLAN_MARGIN = 0.7; // Share of the deceleration left on a descent that the AI relies on
const MIN_PLAN_BRAKE = 0.1;
const ADHESION = 0.3; // Share of the weight on driven wheels that the rail can take as pulling force
const SLIP_GRIP = 0.75; // Share of that limit left once the wheels are slipping
const CURVE_RESISTANCE = 0.6; // Divided by radius in metres, as a share of weight
const DYNAMIC_FADE_SPEED = 2; // m/s; engine braking fades out below this
const LIMIT_LOOKAHEAD = 2500; // m; how far the desk looks for a lower limit
const GRADIENT_LOOKAHEAD = 300; // m; the stretch the desk's gradient reading covers
const DWELL = 22; // s at a platform
const STOP_SLACK = 4; // m a stopped train may stand beyond its platform and still count
const CRASH_SPEED = 15 / 3.6; // Under strict rules, hits faster than this damage the train
const LEG_PACE = 0.8; // Share of the line speed a timetable expects on average
const LEG_ALLOWANCE = 40; // s added to every leg for starting and stopping
export const DAY = 24 * 3600;
const LOG_STOPS = 40;

/** Seconds from now to a time of day, between -12 and +12 hours: negative means it has passed. */
export function untilTime(target: number, now: number) {
  return ((((target - now + DAY / 2) % DAY) + DAY) % DAY) - DAY / 2;
}

/** One stop of a train's timetable. Times are seconds of the day. */
export interface Stop {
  id: number;
  arr: number | null;
  dep: number | null;
  turn: boolean;
}

/** A time of day as 08:05. */
export function clockText(seconds: number) {
  const m = Math.floor((((seconds % DAY) + DAY) % DAY) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Rolling, bearing and air resistance in kN, for a mass in tonnes. */
const drag = (m: number, v: number) => 0.012 * G * m + 0.0035 * m * v + 0.012 * v * v;

export const keyOf = (node: number, side: Side) => `${node}:${side}`;

export interface SimEvent {
  /** arrive, stop and depart are news for the train's driver; the rest are warnings for everyone. */
  kind: 'spad' | 'collision' | 'buffer' | 'arrive' | 'stop' | 'depart' | 'missed' | 'protection' | 'damage';
  train: number;
  text: string;
}

interface Occupancy {
  train: number;
  sMin: number;
  sMax: number;
}

/** What the driver's desk shows about the line ahead. Speeds in m/s, distances in metres. */
export interface DeskInfo {
  /** The limit where the head is, capped by the train's own top speed. */
  limit: number;
  /** The first lower limit ahead on the train's route, if any. */
  nextLimit: { speed: number; dist: number } | null;
  /** Rise per metre over the stretch ahead: positive is uphill. */
  gradient: number;
  /** Distance to stand from the current speed with the lever at full brake. Infinity if it can't stop. */
  brakingDistance: number;
}

/** A piece of track ahead. start and end are distances from the head to its entry and exit nodes. */
interface AheadPiece {
  seg: number;
  dir: Dir;
  start: number;
  end: number;
  exit: Exit;
}

export interface NextSignal {
  key: string;
  node: number;
  side: Side;
  dist: number;
}

export interface SignalRoute {
  diverging: boolean;
  dir: 'straight' | 'left' | 'right';
  index: number;
  count: number;
  speed: number;
}

export interface SignalIndication {
  type: SignalType;
  aspect: Aspect;
  callingOn: boolean;
  route: SignalRoute | null;
}

export interface GuardWarning {
  kind: 'signal' | 'speed' | 'spad';
  text: string;
  timer: number;
  acknowledged: boolean;
  key: string;
}

/** Everything a save needs to put a moving train back exactly as it was. */
export interface TrainState {
  trail: Piece[];
  headS: number;
  speed: number;
  throttle: number;
  brake: number;
  dynamic: number;
  emergency: boolean;
  airBrake: number;
  route: Piece[];
  targetStation: number | null;
  dwell: number;
  stopRemain: number;
  stuck: number;
  crashCooldown: number;
  grants: string[];
  score: { spads: number; stops: number };
  /** Missing from saves made before damage existed. */
  damaged?: boolean;
  /** Missing from saves made before calling-on/shunt signals existed. */
  restricted?: boolean;
}

export class Train {
  id: number;
  name: string;
  cars: Car[];
  trail: Piece[] = [];
  headS = 0;
  speed = 0;
  throttle = 0;
  /** Air brake demand: 0 to 1 of full service braking. */
  brake = 0;
  /** Engine brake demand, 0 to 1. Works at once but only from the locomotives. */
  dynamic = 0;
  emergency = false;
  /** Air brake actually applied, in the same units as brake. It chases the demand. */
  airBrake = 0;
  /** True while the wheels spin because more force was asked for than the rail can take. */
  slipping = false;
  ai = true;
  schedule: number[] = []; // Station ids; empty = every station
  /** Departure time from each scheduled stop, in seconds of the day, or null to leave once the dwell is over. */
  times: (number | null)[] = [];
  /** Timetabled arrival at each stop, in seconds of the day, or null for a dwell before departure. */
  arrivals: (number | null)[] = [];
  /** True where the train changes ends before leaving a stop, to go back the way it came. */
  turns: boolean[] = [];
  /** Recent stops as they actually happened, with clock times, for the service diagram. Not saved. */
  log: { station: number; arr: number; dep: number | null }[] = [];
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
  /** Set by train protection under strict rules: emergency braking until back under the limit. */
  tripped = false;
  /** True after an unacknowledged-warning trip under strict rules; holds until stopped or reset. */
  warnTripped = false;
  /** True after a SPAD under strict rules: holds emergency brake until stopped and reset. */
  spadTripped = false;
  /** True while proceeding under a calling-on / shunt move (25 km/h speed cap). */
  restricted = false;
  /** Active cab safety warning awaiting driver acknowledgement. */
  warning: GuardWarning | null = null;
  /** Source key of the last acknowledged warning so the same beacon does not re-trigger. */
  lastWarnKey = '';
  /** Crashed or derailed under strict rules. It can't move until recovered. */
  damaged = false;
  /** Where the train last stood at a platform, so recovery has somewhere to put it. */
  lastStop: { seg: number; s: number; dir: Dir } | null = null;
  /** The player's run, while they drive this train. */
  duty: Duty | null = null;
  /** True once the head has passed the stop it's due at, so leaving it behind counts as a miss. */
  passedStop = false;
  /** Last known head position, used to re-seat the train when track under it is deleted. */
  lastPos: { x: number; z: number; hx: number; hz: number } | null = null;

  constructor(id: number, name: string, cars: Car[]) {
    this.id = id;
    this.name = name;
    this.cars = cars;
  }

  get length() {
    let l = 0;
    for (const c of this.cars) l += VEHICLES[c.type].length + GAP;
    return l - GAP;
  }

  get mass() {
    let m = 0;
    for (const c of this.cars) m += carMass(c);
    return m;
  }

  /** The slowest vehicle sets the speed of the whole train. */
  get topSpeed() {
    let v = Infinity;
    for (const c of this.cars) v = Math.min(v, VEHICLES[c.type].topSpeed);
    return v;
  }

  /** Pulling force available at a speed, from every locomotive, in kN. */
  tractiveForce(speed: number) {
    let f = 0;
    for (const c of this.cars) {
      const tr = VEHICLES[c.type].traction;
      if (tr) f += Math.min(tr.tractive, tr.power / Math.max(speed, 0.5));
    }
    return f;
  }

  /** The most pulling force the rail can take, in kN. */
  get adhesionLimit() {
    let driven = 0;
    for (const c of this.cars) if (VEHICLES[c.type].traction) driven += carMass(c);
    return driven * G * ADHESION;
  }

  /** Air brake force on the whole train at full service braking, in kN. */
  get brakeForce() {
    let f = 0;
    for (const c of this.cars) f += carBrake(c);
    return f;
  }

  /** Seconds for the air brake to reach every car. It takes longer to release. */
  get brakeLag() {
    return 1.2 + this.length / 80;
  }

  /** Friction brakes weaken as speed rises. */
  airDecel(speed: number) {
    return ((1.2 - 0.5 * Math.min(1, speed / 44)) * this.brakeForce) / this.mass;
  }

  /** Deceleration from full engine braking at a speed. */
  dynamicDecel(speed: number) {
    let f = 0;
    for (const c of this.cars) {
      const tr = VEHICLES[c.type].traction;
      if (tr) f += Math.min(tr.dynamic, tr.power / Math.max(speed, 0.5));
    }
    return (f * Math.min(1, speed / DYNAMIC_FADE_SPEED)) / this.mass;
  }
}

export class Sim {
  net: Network;
  trains: Train[] = [];
  onEvent: (e: SimEvent) => void = () => {};
  /** Signal key -> aspect, refreshed by the interlocking tick. */
  aspects = new Map<string, Aspect>();
  /** Signal key -> full indication (type, aspect, calling-on, route feather), refreshed by interlocking. */
  indications = new Map<string, SignalIndication>();
  /** Node ids locked by an active route, keyed to the train holding them. */
  nodeClaims = new Map<number, number>();
  segClaims = new Map<number, number>();
  /** Level crossing ids locked by an active route or occupied crossing segment, keyed to the train holding them. */
  crossingClaims = new Map<string, number>();
  occ = new Map<number, Occupancy[]>();
  private segDirs = new Map<number, Set<Dir>>();
  private shuntSegs = new Map<number, number>();
  /** Simulation steps run so far. */
  steps = 0;
  /** Strict rules: train protection brakes a player train well over the limit, and hard hits damage it. */
  strict = false;
  /** Time of day in seconds, which timetabled departures wait for. Set by the game from its clock. */
  clock = 12 * 3600;
  private interlockTimer = 0;
  private unspent = 0;
  private prints: Map<number, string>;

  constructor(net: Network) {
    this.net = net;
    this.prints = this.segPrints();
  }

  // ------------------------------------------------------------ placement
  /** Places a train with its head at (seg, s) heading dir, shifting forward if there is no room behind. */
  place(t: Train, seg: number, s: number, dir: Dir) {
    const net = this.net;
    t.speed = 0;
    t.airBrake = 0;
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
    this.remember(t);
  }

  private remember(t: Train) {
    const h = this.head(t);
    t.lastPos = { x: h.x, z: h.z, hx: h.tx * h.dir, hz: h.tz * h.dir };
  }

  /** Fingerprint of each segment's shape and ends: when it changes, trains on it may no longer sit where they were. */
  private segPrints(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [id, s] of this.net.segs) {
      const g = this.net.geom.get(id);
      out.set(id, `${s.a}:${s.sa}:${s.b}:${s.sb}:${g ? g.length.toFixed(2) : ''}`);
    }
    return out;
  }

  /**
   * Call after the track was edited. Trains standing on a changed or removed
   * segment are re-seated where they were, keeping speed, dwell and timetable
   * progress; every other train carries on untouched. Returns trains that no
   * longer have any track to stand on.
   */
  syncTrack(): Train[] {
    const before = this.prints;
    const after = this.segPrints();
    this.prints = after;
    const changed = new Set<number>();
    for (const [id, p] of after) if (before.get(id) !== p) changed.add(id);
    for (const id of before.keys()) if (!after.has(id)) changed.add(id);
    const lost: Train[] = [];
    if (!changed.size) return lost;
    for (const t of [...this.trains]) {
      if (t.trail.some((p) => changed.has(p.seg))) {
        const keep = { speed: t.speed, dwell: t.dwell, stopRemain: t.stopRemain, schedIdx: t.schedIdx };
        // The head position from before the edit: the trail may no longer match the track.
        const at = t.lastPos ?? { x: 0, z: 0, hx: 1, hz: 0 };
        if (!this.replace(t, at.x, at.z, at.hx, at.hz)) {
          lost.push(t);
          continue;
        }
        t.speed = keep.speed;
        t.dwell = keep.dwell;
        t.stopRemain = keep.stopRemain;
        t.schedIdx = keep.schedIdx;
        if (t.ai) this.plan(t, false);
      } else if (t.route.some((p) => changed.has(p.seg))) {
        // Track ahead changed: plan again, but keep how the train is moving.
        if (t.ai) this.plan(t, false);
        else t.route = [];
      }
    }
    return lost;
  }

  captureState(t: Train): TrainState {
    return {
      trail: t.trail.map((p) => ({ ...p })),
      headS: t.headS,
      speed: t.speed,
      throttle: t.throttle,
      brake: t.brake,
      dynamic: t.dynamic,
      emergency: t.emergency,
      airBrake: t.airBrake,
      route: t.route.map((p) => ({ ...p })),
      targetStation: t.targetStation,
      dwell: t.dwell,
      stopRemain: t.stopRemain,
      stuck: t.stuck,
      crashCooldown: t.crashCooldown,
      grants: [...t.grants],
      score: { ...t.score },
      damaged: t.damaged,
      restricted: t.restricted,
    };
  }

  /** True when pieces exist and each one leads on to the next. */
  private connected(pieces: Piece[]) {
    const net = this.net;
    return pieces.every((p, i) => {
      if (!net.segs.has(p.seg)) return false;
      const next = pieces[i + 1];
      if (!next) return true;
      if (!net.segs.has(next.seg)) return false;
      const e = net.exit(p.seg, p.dir);
      return e.options.includes(next.seg) && net.entryDir(next.seg, e.node, e.side) === next.dir;
    });
  }

  /** Puts a train back exactly as saved. Returns false, changing nothing, if the track no longer matches. */
  restoreState(t: Train, s: TrainState): boolean {
    const last = s.trail.at(-1);
    if (!last || !this.connected(s.trail)) return false;
    const length = this.net.geom.get(last.seg)!.length;
    if (s.headS < 0 || s.headS > length) return false;
    t.trail = s.trail.map((p) => ({ ...p }));
    t.headS = s.headS;
    t.speed = s.speed;
    t.throttle = s.throttle;
    t.brake = s.brake;
    t.dynamic = s.dynamic;
    t.emergency = s.emergency;
    t.airBrake = s.airBrake;
    // The trail is what must fit the track. A route that doesn't is simply planned again.
    const keepRoute = this.connected(s.route);
    t.route = keepRoute ? s.route.map((p) => ({ ...p })) : [];
    t.targetStation = keepRoute ? s.targetStation : null;
    t.dwell = s.dwell;
    t.stopRemain = s.stopRemain;
    t.stuck = s.stuck;
    t.crashCooldown = s.crashCooldown;
    t.grants = [...s.grants];
    t.score = { ...s.score };
    t.damaged = s.damaged ?? false;
    t.restricted = s.restricted ?? false;
    t.spadTripped = false;
    t.warnTripped = false;
    t.warning = null;
    t.lastWarnKey = '';
    t.next = null;
    this.remember(t);
    return true;
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

  head(t: Train) {
    return this.behind(t, 0);
  }

  /** Like behind, for drawing: frames fall between steps, so trains are shown part of a step back to stay smooth. */
  drawn(t: Train, d = 0) {
    return this.behind(t, d + t.speed * (STEP - this.unspent));
  }

  /** Front and rear bogie positions of a car, ordered along the consist. */
  carPose(t: Train, index: number) {
    let d = 0;
    for (let i = 0; i < index; i++) d += VEHICLES[t.cars[i].type].length + GAP;
    const len = VEHICLES[t.cars[index].type].length;
    return { front: this.drawn(t, d + len * 0.18), rear: this.drawn(t, d + len * 0.82) };
  }

  /** Rise per metre in the direction of travel and curve resistance per unit weight, averaged by mass along the train. */
  private track(t: Train) {
    let d = 0;
    let slope = 0;
    let curve = 0;
    let mass = 0;
    for (const c of t.cars) {
      const len = VEHICLES[c.type].length;
      const at = this.behind(t, d + len / 2);
      const m = carMass(c);
      slope += at.ty * at.dir * m;
      curve += (CURVE_RESISTANCE / this.net.geom.get(at.seg)!.minRadius) * m;
      mass += m;
      d += len + GAP;
    }
    return { slope: slope / mass, curve: curve / mass };
  }

  private slope(t: Train) {
    return this.track(t).slope;
  }

  /** Deceleration from engine and service brakes together at this train's speed. */
  private brakeDecel(t: Train) {
    return t.airDecel(t.speed) + t.dynamicDecel(t.speed);
  }

  /** Deceleration the AI can count on here: gravity eats into the brakes on a descent. */
  private planBrake(t: Train) {
    const air = t.airDecel(t.speed);
    const available = (air * EMERGENCY + t.dynamicDecel(t.speed) + G * this.slope(t)) * PLAN_MARGIN;
    return Math.max(MIN_PLAN_BRAKE, Math.min(air * PLAN_SHARE, available));
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
        let penalty = claimed !== undefined && claimed !== t.id ? 4000 : 0;
        for (const c of net.crossingsOn(opt)) {
          const cc = this.crossingClaims.get(c.id);
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
  stops(t: Train): Stop[] {
    const all = new Set(this.net.stations.map((s) => s.id));
    const listed = t.schedule
      .map((id, i) => ({ id, arr: t.arrivals[i] ?? null, dep: t.times[i] ?? null, turn: t.turns[i] ?? false }))
      .filter((s) => all.has(s.id));
    return listed.length ? listed : [...all].map((id) => ({ id, arr: null, dep: null, turn: false }));
  }

  /** Records an arrival for the service diagram, keeping only the most recent stops. */
  private logArrival(t: Train) {
    if (t.targetStation === null) return;
    t.log.push({ station: t.targetStation, arr: this.clock, dep: null });
    if (t.log.length > LOG_STOPS) t.log.shift();
  }

  /** Leaves the current stop: changes ends first if the timetable says so, then heads for the next stop. */
  private leaveStop(t: Train) {
    const last = t.log.at(-1);
    if (last && last.dep === null) last.dep = this.clock;
    if (this.stops(t)[t.schedIdx]?.turn) this.reverse(t);
    this.plan(t, true);
  }

  private stationOrder(t: Train) {
    return this.stops(t).map((s) => s.id);
  }

  /** Seconds a train at its current stop must still wait for its timetabled departure. */
  departureWait(t: Train) {
    const dep = this.stops(t)[t.schedIdx]?.dep;
    return dep === null || dep === undefined ? 0 : Math.max(0, untilTime(dep, this.clock));
  }

  /** Holds a train whose dwell is over until its departure time. Returns true while it waits. */
  private holdForTimetable(t: Train) {
    const wait = this.departureWait(t);
    if (wait <= 0) return false;
    // One step at a time, so the status reads the same every step until it leaves.
    t.dwell = Math.min(wait, STEP);
    t.statusText = `Leaves at ${clockText(this.stops(t)[t.schedIdx].dep!)}`;
    return true;
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

  // ------------------------------------------------------------ interlocking
  /** Walks a block from a signal to the next stopping signal or dead end, skipping distant repeaters. */
  private walkBlock(startNode: number, startSide: Side, t: Train | null) {
    const net = this.net;
    const segs: number[] = [];
    const dirs: Dir[] = [];
    const nodes: number[] = [startNode];
    const crossingSet = new Set<string>();
    let end: { node: number; side: Side } | null = null;
    let deadEnd = false;
    const firstSeg = this.pick(t, -1, startNode, startSide);
    if (firstSeg === undefined) return { segs, dirs, nodes, crossings: [] as string[], end, deadEnd: true };
    let seg = firstSeg;
    let dir = net.entryDir(seg, startNode, startSide);
    const seen = new Set<number>();
    while (!seen.has(seg) && seen.size < 200) {
      seen.add(seg);
      segs.push(seg);
      dirs.push(dir);
      for (const c of net.crossingsOn(seg)) crossingSet.add(c.id);
      const e = net.exit(seg, dir);
      const exitDef = net.nodes.get(e.node)!.signals[e.side];
      if (exitDef && signalType(exitDef) !== 'distant') {
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
    return { segs, dirs, nodes, crossings: [...crossingSet], end, deadEnd };
  }

  private blockFree(b: { segs: number[]; nodes: number[]; crossings: string[] }, trainId: number | null) {
    for (const s of b.segs) {
      const c = this.segClaims.get(s);
      if (c !== undefined && c !== trainId) return false;
      const sh = this.shuntSegs.get(s);
      if (sh !== undefined && sh !== trainId) return false;
      for (const o of this.occ.get(s) ?? []) if (o.train !== trainId) return false;
    }
    for (const n of b.nodes) {
      const c = this.nodeClaims.get(n);
      if (c !== undefined && c !== trainId) return false;
    }
    for (const cid of b.crossings) {
      const c = this.crossingClaims.get(cid);
      if (c !== undefined && c !== trainId) return false;
    }
    return true;
  }

  /**
   * Calling-on / shunt move: allows entering a block occupied by a standing or same-direction train,
   * while rejecting opposing moves, active opposing claims, and conflicting level crossings.
   */
  private callingOnAllowed(
    b: { segs: number[]; dirs: Dir[]; nodes: number[]; crossings: string[] },
    trainId: number | null,
  ): boolean {
    if (!b.segs.length) return false;
    if (this.blockFree(b, trainId)) return true;
    const blockSegSet = new Set(b.segs);
    for (const n of b.nodes) {
      const c = this.nodeClaims.get(n);
      if (c !== undefined && c !== trainId) {
        // Allow a claim on a terminal/forward node held solely by a train already occupying this block.
        const inBlock = b.segs.some((s) => (this.occ.get(s) ?? []).some((o) => o.train === c));
        if (!inBlock) return false;
      }
    }
    for (const cid of b.crossings) {
      const c = this.crossingClaims.get(cid);
      if (c === undefined || c === trainId) continue;
      const crossing = this.net.crossings.find((x) => x.id === cid);
      if (!crossing) return false;
      const otherSeg = blockSegSet.has(crossing.seg1) ? crossing.seg2 : crossing.seg1;
      if (!blockSegSet.has(otherSeg) || (this.occ.get(otherSeg)?.some((o) => o.train === c) ?? false)) return false;
    }
    for (let i = 0; i < b.segs.length; i++) {
      const s = b.segs[i];
      const dir = b.dirs[i];
      const shuntHolder = this.shuntSegs.get(s);
      if (shuntHolder !== undefined && shuntHolder !== trainId) return false;
      const occs = this.occ.get(s) ?? [];
      const claimedBy = this.segClaims.get(s);
      if (claimedBy !== undefined && claimedBy !== trainId && !occs.some((o) => o.train === claimedBy)) return false;
      const dirs = this.segDirs.get(s);
      if (dirs && dirs.has(-dir as Dir)) {
        if (!occs.length) return false;
        for (const o of occs) {
          if (o.train === trainId) continue;
          const other = this.trains.find((tr) => tr.id === o.train);
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
  private routeInfo(startNode: number, startSide: Side, block: { segs: number[]; dirs: Dir[] }): SignalRoute | null {
    const net = this.net;
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

  private claimSeg(seg: number, dir: Dir, trainId: number) {
    if (!this.segClaims.has(seg)) this.segClaims.set(seg, trainId);
    let dirs = this.segDirs.get(seg);
    if (!dirs) {
      dirs = new Set();
      this.segDirs.set(seg, dirs);
    }
    dirs.add(dir);
    for (const c of this.net.crossingsOn(seg)) {
      if (!this.crossingClaims.has(c.id)) this.crossingClaims.set(c.id, trainId);
    }
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
    this.crossingClaims.clear();
    this.segDirs.clear();
    this.shuntSegs.clear();
    for (const t of this.trains) {
      const occupiedSegs = new Set<number>();
      for (const [seg, list] of this.occ) if (list.some((o) => o.train === t.id)) occupiedSegs.add(seg);
      for (const p of t.trail) if (occupiedSegs.has(p.seg)) this.claimSeg(p.seg, p.dir, t.id);
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
      const type = signalType(def);
      const block = this.walkBlock(t.next.node, t.next.side, t);
      const ok = type === 'shunt' ? this.callingOnAllowed(block, t.id) : this.blockFree(block, t.id);
      if (ok) {
        t.grants.push(t.next.key);
        this.setRouteSwitches(t, block);
        if (type === 'shunt') {
          for (const s of block.segs) {
            if ((this.occ.get(s)?.length ?? 0) > 0 && !this.shuntSegs.has(s)) this.shuntSegs.set(s, t.id);
          }
        }
        this.walkClaims(t);
      }
    }
    // Aspects and full indications. Two passes so distant signals reflect the main/shunt signals ahead.
    this.aspects.clear();
    this.indications.clear();
    const grantedKeys = new Map<string, Train>();
    for (const t of this.trains) for (const k of t.grants) grantedKeys.set(k, t);
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
        const block = this.walkBlock(node.id, side, holder);
        const route = this.routeInfo(node.id, side, block);
        if (def.hold) {
          this.aspects.set(key, 'red');
          this.indications.set(key, { type, aspect: 'red', callingOn: false, route });
          continue;
        }
        if (type === 'shunt') {
          const ok = holder !== null || this.callingOnAllowed(block, null);
          const aspect: Aspect = ok ? 'yellow' : 'red';
          this.aspects.set(key, aspect);
          this.indications.set(key, { type, aspect, callingOn: ok, route });
          continue;
        }
        if (!holder && !this.blockFree(block, null)) {
          this.aspects.set(key, 'red');
          this.indications.set(key, { type, aspect: 'red', callingOn: false, route });
          continue;
        }
        let onward = !block.deadEnd;
        if (block.end) {
          const nextDef = net.nodes.get(block.end.node)!.signals[block.end.side]!;
          const nextType = signalType(nextDef);
          const nextBlock = this.walkBlock(block.end.node, block.end.side, holder);
          const nextFree = this.blockFree(nextBlock, holder?.id ?? null);
          if (
            nextDef.hold ||
            (nextType === 'shunt' ? !this.callingOnAllowed(nextBlock, holder?.id ?? null) : !nextFree)
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
        this.aspects.set(key, aspect);
        this.indications.set(key, { type, aspect, callingOn: false, route });
      }
    }
    for (const d of distantQueue) {
      const key = keyOf(d.nodeId, d.side);
      const block = this.walkBlock(d.nodeId, d.side, null);
      const route = this.routeInfo(d.nodeId, d.side, block);
      let aspect: Aspect = 'yellow';
      if (!d.hold && block.end) {
        const nextInd = this.indications.get(keyOf(block.end.node, block.end.side));
        if (nextInd && nextInd.aspect !== 'red' && !nextInd.callingOn) aspect = 'green';
      }
      this.aspects.set(key, aspect);
      this.indications.set(key, { type: 'distant', aspect, callingOn: false, route });
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

  /** Claims track from the head through every granted signal and records the next ungranted stopping signal. */
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
      this.claimSeg(seg, dir, t.id);
      const e = net.exit(seg, dir);
      const def = net.nodes.get(e.node)!.signals[e.side];
      if (def && signalType(def) !== 'distant') {
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
          const text = `${t.name} hit the buffer stop at ${Math.round(t.speed * 3.6)} km/h`;
          t.duty?.add(`Hit the buffer stop at ${Math.round(t.speed * 3.6)} km/h`, -PENALTY.buffer);
          if (this.strict && !t.ai && t.speed > CRASH_SPEED) this.damage(t, text);
          else this.onEvent({ kind: 'buffer', train: t.id, text });
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
    const def = n.signals[side];
    if (def) {
      const type = signalType(def);
      if (type !== 'distant') {
        if (t.grants[0] === key) {
          t.grants.shift();
          t.restricted = type === 'shunt';
        } else if (this.aspects.get(key) === 'red') {
          t.score.spads++;
          t.duty?.add('Passed a signal at danger', -PENALTY.spad);
          if (this.strict && !t.ai) {
            t.tripped = true;
            t.spadTripped = true;
            t.emergency = true;
            t.throttle = 0;
            t.warning = {
              kind: 'spad',
              text: 'Passed signal at danger — emergency brake',
              timer: 0,
              acknowledged: true,
              key: `spad:${key}`,
            };
          }
          this.onEvent({
            kind: 'spad',
            train: t.id,
            text:
              this.strict && !t.ai
                ? `${t.name} passed a signal at danger — emergency brake applied`
                : `${t.name} passed a signal at danger`,
          });
        } else {
          t.restricted = type === 'shunt';
        }
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
    if (st && !t.ai && st.id === t.targetStation) t.passedStop = true;
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
    const speedCap = t.restricted ? Math.min(SHUNT_VMAX, t.topSpeed) : t.topSpeed;
    let allowed = Math.min(geo.vmax, speedCap);
    let stopAt = Infinity;
    let stationAt = Infinity;
    let bufferAt = Infinity;
    if (t.stopRemain >= 0) stationAt = t.stopRemain;
    const seen = new Set<number>();
    let current = true;
    const lineLimit = Math.min(geo.vmax, speedCap);
    const occBuffer = t.restricted ? 10 : 25;
    while (dist < range && !seen.has(seg)) {
      seen.add(seg);
      if (!current) {
        allowed = Math.min(allowed, Math.sqrt(Math.min(geo.vmax, speedCap) ** 2 + 2 * planBrake * dist));
      }
      for (const o of this.occ.get(seg) ?? []) {
        if (o.train === t.id) continue;
        const gap = dir > 0 ? (current ? o.sMin - t.headS : o.sMin) : current ? t.headS - o.sMax : geo.length - o.sMax;
        if (gap >= -2 || !current) stopAt = Math.min(stopAt, dist + Math.max(gap, 0) - occBuffer);
      }
      const e = net.exit(seg, dir);
      const end = dist + toEnd;
      const nodeDef = net.nodes.get(e.node)!;
      const def = nodeDef.signals[e.side];
      const key = keyOf(e.node, e.side);
      if (def && signalType(def) !== 'distant' && !t.grants.includes(key)) {
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
      t.dynamic = 0;
      t.emergency = false;
      t.statusText = 'At platform';
      if (t.dwell <= 0 && !this.holdForTimetable(t)) {
        t.stopRemain = -1;
        this.leaveStop(t);
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
    const hold = Math.max(0, -G * this.slope(t)) / this.brakeDecel(t);
    let need = 0;
    if (diff > 0.3) {
      t.throttle = Math.min(1, diff * 0.45);
    } else {
      t.throttle = 0;
      if (diff < -0.1) need = hold - diff * 0.7 + 0.2;
      else need = target < 0.2 ? Math.max(1, hold) : hold;
    }
    t.brake = Math.min(1, need);
    t.dynamic = t.brake;
    // Only a heavy train on a steep descent gets here: the service brake alone can't hold it.
    t.emergency = hold > 1 && need > 1;
    // Arrival.
    if (t.speed < 0.25 && lim.stationAt <= 2.5) {
      t.dwell = DWELL;
      t.restricted = false;
      t.score.stops++;
      this.logArrival(t);
      const st = this.net.stations.find((s) => s.id === t.targetStation);
      if (st) this.onEvent({ kind: 'arrive', train: t.id, text: `${t.name} arrived at ${st.name}` });
      t.stuck = 0;
      t.brake = 1;
      t.dynamic = 0;
      t.emergency = false;
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
    for (const cid of block.crossings) {
      const holder = this.crossingClaims.get(cid);
      const other = this.trains.find((o) => o.id === holder);
      if (other && other !== t && other.stuck > 15 && other.dwell <= 0 && t.id > other.id) return true;
    }
    return false;
  }

  /** Force at the rail after the adhesion limit, in kN. The autopilot eases off before the wheels slip. */
  private traction(t: Train) {
    const cut = t.emergency || t.tripped || t.damaged || (!t.ai && t.dwell > 0);
    const asked = t.speed < t.topSpeed && !cut ? t.tractiveForce(t.speed) * t.throttle : 0;
    const grip = t.adhesionLimit;
    t.slipping = !t.ai && asked > grip;
    if (t.slipping) return grip * SLIP_GRIP;
    return Math.min(asked, grip);
  }

  private updateAirBrake(t: Train, dt: number) {
    const emergency = t.emergency || t.tripped;
    // Doors open and a damaged train both hold the brakes on.
    const held = t.damaged || (!t.ai && t.dwell > 0) ? 1 : 0;
    const demand = emergency ? EMERGENCY : Math.max(t.brake, held);
    if (demand > t.airBrake) {
      // An emergency application vents the brake pipe from every car, so it reaches them far sooner.
      const time = emergency ? t.brakeLag / 3 : t.brakeLag;
      t.airBrake = Math.min(demand, t.airBrake + dt / time);
    } else {
      t.airBrake = Math.max(demand, t.airBrake - dt / (t.brakeLag * 1.5));
    }
  }

  private physics(t: Train, dt: number) {
    const { slope, curve } = this.track(t);
    const m = t.mass; // tonnes -> force in kN gives m/s^2
    let a = this.traction(t) / m - G * slope;
    this.updateAirBrake(t, dt);
    const braking = t.airBrake * t.airDecel(t.speed) + t.dynamic * t.dynamicDecel(t.speed);
    const resist = drag(m, t.speed) / m + G * curve + braking;
    if (t.speed > 0 || a > resist) {
      a -= resist;
    } else {
      a = 0; // Held stationary by the brakes.
    }
    t.speed = Math.max(0, t.speed + a * dt);
    if (t.speed > 0) this.advance(t, t.speed * dt);
  }

  /** True when any part of one train is within a car's width of the other. */
  private touch(A: Train, B: Train) {
    const ha = this.behind(A, 0);
    const hb = this.behind(B, 0);
    if (Math.hypot(ha.x - hb.x, ha.z - hb.z) > A.length + B.length + 10) return false;
    for (let da = 0; da <= A.length; da += 6) {
      const a = this.behind(A, da);
      for (let db = 0; db <= B.length; db += 6) {
        const b = this.behind(B, db);
        if (Math.hypot(a.x - b.x, a.z - b.z) < 3.2 && Math.abs(a.y - b.y) < 3.5) return true;
      }
    }
    return false;
  }

  /** The first other train this one is touching, for refusing a placement on top of it. */
  touching(t: Train): Train | null {
    return this.trains.find((o) => o !== t && this.touch(t, o)) ?? null;
  }

  private collisions(dt: number) {
    for (const t of this.trains) if (t.crashCooldown > 0) t.crashCooldown -= dt;
    for (let i = 0; i < this.trains.length; i++) {
      for (let j = i + 1; j < this.trains.length; j++) {
        const A = this.trains[i];
        const B = this.trains[j];
        if (A.crashCooldown > 0 || B.crashCooldown > 0) continue;
        const hit = this.touch(A, B);
        if (hit) {
          const fast = Math.max(A.speed, B.speed);
          this.onEvent({
            kind: 'collision',
            train: A.id,
            text: `${A.name} and ${B.name} collided at ${Math.round(fast * 3.6)} km/h`,
          });
          for (const t of [A, B]) {
            t.duty?.add(`Collided at ${Math.round(fast * 3.6)} km/h`, -PENALTY.collision);
            if (this.strict && !t.ai && fast > CRASH_SPEED) this.damage(t, `${t.name} was damaged in the collision`);
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

  /** Runs as many whole steps as dt has paid for, keeping the remainder for next time. */
  update(dt: number) {
    this.unspent += dt;
    let n = 0;
    while (this.unspent >= STEP && n < MAX_STEPS_PER_UPDATE) {
      this.step();
      this.unspent -= STEP;
      n++;
    }
    if (this.unspent >= STEP) this.unspent = 0;
  }

  private step() {
    this.steps++;
    this.interlockTimer += STEP;
    if (this.interlockTimer > 0.15) {
      this.interlockTimer = 0;
      this.interlock();
    }
    for (const t of this.trains) {
      if (t.ai) this.driveAI(t, STEP);
      else this.driveManual(t, STEP);
      this.physics(t, STEP);
      this.remember(t);
    }
    this.collisions(STEP);
  }

  /** Seconds since the simulation started. */
  get time() {
    return this.steps * STEP;
  }

  /** What the player's train does by itself: limits, train protection, stops and doors. */
  private driveManual(t: Train, dt: number) {
    const lim = this.collectLimits(t);
    t.limit = lim.lineLimit;
    t.statusText = '';
    this.updateWarning(t, dt);
    if (this.strict) this.protect(t);
    t.duty?.overspeed(dt, t.speed, t.limit);
    if (t.dwell > 0) {
      t.statusText = 'Doors open';
      t.dwell -= dt;
      if (t.dwell <= 0 && !this.holdForTimetable(t)) this.depart(t);
      return;
    }
    this.checkStop(t);
  }

  /** Checks for restrictive signals or lower speed limits ahead and triggers cab warnings. */
  private updateWarning(t: Train, dt: number) {
    if (t.spadTripped) return;
    let hazard: { kind: 'signal' | 'speed'; text: string; key: string } | null = null;
    if (t.speed > 3) {
      const sig = this.walkAhead(t, 220, ({ end, exit }) => {
        if (end >= 220) return null;
        const def = this.net.nodes.get(exit.node)!.signals[exit.side];
        if (!def) return undefined;
        const key = keyOf(exit.node, exit.side);
        const ind = this.indications.get(key);
        const aspect = ind?.aspect ?? this.aspects.get(key) ?? 'green';
        if (aspect === 'green') return undefined;
        const label = ind?.callingOn
          ? 'Calling-on (25 km/h)'
          : ind?.route?.diverging
            ? `Diverging ${ind.route.dir}`
            : aspect === 'red'
              ? 'Stop signal ahead'
              : 'Caution signal ahead';
        return { kind: 'signal' as const, text: label, key: `sig:${key}:${aspect}` };
      });
      if (sig) hazard = sig;
    }
    if (!hazard) {
      const nextLim = this.walkAhead(t, 250, ({ seg, start }) => {
        if (start <= 0 || start >= 250) return undefined;
        const speed = Math.min(this.net.geom.get(seg)!.vmax, t.topSpeed);
        return speed < t.limit - 2.5 && t.speed > speed + 2
          ? {
              kind: 'speed' as const,
              text: `Speed drop to ${Math.round(speed * 3.6)} km/h ahead`,
              key: `spd:${seg}:${Math.round(speed * 3.6)}`,
            }
          : undefined;
      });
      if (nextLim) hazard = nextLim;
    }

    if (hazard) {
      if (hazard.key !== t.lastWarnKey && (!t.warning || t.warning.key !== hazard.key)) {
        t.warning = { ...hazard, timer: WARN_ACK_SECONDS, acknowledged: false };
      }
    } else if (t.warning?.acknowledged) {
      t.warning = null;
    }

    if (t.warning && !t.warning.acknowledged) {
      t.warning.timer = Math.max(0, t.warning.timer - dt);
      if (t.warning.timer <= 0 && this.strict) {
        t.tripped = true;
        t.warnTripped = true;
        t.warning.acknowledged = true;
        t.lastWarnKey = t.warning.key;
        t.duty?.add('Unacknowledged warning: train protection braked the train', -PENALTY.protection);
        this.onEvent({
          kind: 'protection',
          train: t.id,
          text: `Train protection braked ${t.name}: warning not acknowledged`,
        });
      }
    }
  }

  /** Acknowledges an active cab warning or resets a stopped protection trip. */
  acknowledge(t: Train) {
    if (t.warning && !t.warning.acknowledged) {
      t.warning.acknowledged = true;
      t.lastWarnKey = t.warning.key;
    }
    if (t.spadTripped && t.speed < 0.2) {
      t.spadTripped = false;
      t.tripped = false;
      t.emergency = false;
      t.warning = null;
    } else if (t.tripped && !t.spadTripped && t.speed <= t.limit) {
      t.warnTripped = false;
      t.tripped = false;
    }
  }

  /** Train protection: emergency braking well over the limit, and derailment far over a curve's limit. */
  private protect(t: Train) {
    const trip = t.limit + Math.max(10 / 3.6, t.limit * 0.1);
    if (!t.tripped && t.speed > trip) {
      t.tripped = true;
      t.duty?.add('Train protection braked the train', -PENALTY.protection);
      this.onEvent({
        kind: 'protection',
        train: t.id,
        text: `Train protection braked ${t.name}: ${Math.round(t.speed * 3.6)} km/h in a ${Math.round(t.limit * 3.6)} km/h limit`,
      });
    }
    if (t.warnTripped && t.speed < 0.2) t.warnTripped = false;
    if (t.tripped && !t.spadTripped && !t.warnTripped && t.speed <= t.limit) {
      t.tripped = false;
    }
    // Protection normally stops this happening; it matters when a curve comes up faster than the brakes can act.
    if (t.limit < LINE_VMAX - 0.5 && t.speed > t.limit * 1.5 && t.speed - t.limit > 30 / 3.6) {
      this.damage(t, `${t.name} derailed on a curve at ${Math.round(t.speed * 3.6)} km/h`);
    }
  }

  private damage(t: Train, text: string) {
    if (t.damaged) return;
    t.damaged = true;
    t.speed = 0;
    t.throttle = 0;
    t.duty?.add('Train damaged', -PENALTY.damage);
    this.onEvent({ kind: 'damage', train: t.id, text: `${text}. Recover it to carry on` });
  }

  /**
   * Changes the vehicles of a standing train, keeping its head where it is and its place in the timetable.
   * Returns why it can't, or null once done: a train needs a locomotive, must be stopped and must fit.
   */
  setConsist(t: Train, cars: Car[]): string | null {
    if (!cars.some((c) => VEHICLES[c.type].traction)) return 'A train needs at least one locomotive';
    if (t.speed > 0.3) return 'Stop the train before changing its vehicles';
    const old = { cars: t.cars, trail: t.trail, headS: t.headS };
    const keep = { dwell: t.dwell, schedIdx: t.schedIdx, target: t.targetStation };
    const h = t.trail[t.trail.length - 1];
    t.cars = cars;
    this.place(t, h.seg, t.headS, h.dir);
    if (this.touching(t)) {
      t.cars = old.cars;
      t.trail = old.trail;
      t.headS = old.headS;
      return 'There is no room behind the train for a longer one';
    }
    t.dwell = keep.dwell;
    t.schedIdx = keep.schedIdx;
    // A train at a platform finishes its stop there; one that isn't heads on for the same stop.
    if (t.dwell > 0) t.targetStation = keep.target;
    else this.plan(t, false);
    return null;
  }

  /** Puts a damaged train back on the track where it last stood at a platform, or where it is. */
  recover(t: Train) {
    const at = t.lastStop;
    if (at && this.net.segs.has(at.seg))
      this.place(t, at.seg, Math.min(at.s, this.net.geom.get(at.seg)!.length), at.dir);
    t.damaged = false;
    t.tripped = false;
    t.spadTripped = false;
    t.warnTripped = false;
    t.restricted = false;
    t.warning = null;
    t.lastWarnKey = '';
    t.speed = 0;
    t.airBrake = 1;
    t.passedStop = false;
    this.plan(t, false);
    t.duty?.startLeg(this.time, this.dueIn(t));
  }

  /** Running time a timetable allows from here to the next stop along the planned route, or null with no route. */
  legTime(t: Train): number | null {
    if (!t.route.length) return null;
    let time = LEG_ALLOWANCE;
    for (const p of t.route) {
      const g = this.net.geom.get(p.seg);
      if (g) time += g.length / (Math.min(g.vmax, t.topSpeed) * LEG_PACE);
    }
    return time;
  }

  /** Metres from the head back to a node under the train, or null if the node isn't under it. */
  private nodeBehind(t: Train, node: number) {
    const net = this.net;
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

  /** Counts a stop when the player's train stands within the platform it's due at. */
  private checkStop(t: Train) {
    const st = this.net.stations.find((s) => s.id === t.targetStation);
    if (!st) return;
    // A train that stopped short has the point still ahead of it: count that as a negative distance behind.
    const ahead = this.walkAhead(t, st.length + t.length, ({ end, exit }) =>
      exit.node === st.nodeId ? end : undefined,
    );
    const behind = this.nodeBehind(t, st.nodeId) ?? (ahead === null ? null : -ahead);
    if (behind === null) {
      if (t.passedStop) {
        t.duty?.add(`Missed the stop at ${st.name}`, -PENALTY.missed);
        this.onEvent({ kind: 'missed', train: t.id, text: `${t.name} missed the stop at ${st.name}` });
        this.plan(t, true);
        this.startLeg(t);
      }
      return;
    }
    // The mark puts the middle of the train at the middle of the platform. Positive means past it.
    const offset = behind - t.length / 2;
    const room = Math.max(0, (st.length - t.length) / 2) + STOP_SLACK;
    if (Math.abs(offset) > room) {
      if (t.speed < 0.15) {
        const by = Math.round(Math.abs(offset) - room);
        t.statusText =
          offset < 0
            ? `Draw forward ${by} m to stand in the platform`
            : `${by} m past the platform: change ends and set back`;
      }
      return;
    }
    if (t.speed >= 0.15) return;
    t.dwell = DWELL;
    t.restricted = false;
    t.score.stops++;
    this.logArrival(t);
    const h = t.trail[t.trail.length - 1];
    t.lastStop = { seg: h.seg, s: t.headS, dir: h.dir };
    const points = t.duty?.stop(st.name, offset, this.time);
    const scored = points === undefined ? '' : `: ${points} points`;
    this.onEvent({ kind: 'stop', train: t.id, text: `Stopped at ${st.name}${scored}. Doors open` });
  }

  private depart(t: Train) {
    t.dwell = 0;
    this.leaveStop(t);
    this.startLeg(t);
    const next = this.net.stations.find((s) => s.id === t.targetStation);
    this.onEvent({
      kind: 'depart',
      train: t.id,
      text: next ? `Doors closed. Next stop: ${next.name}` : 'Doors closed. No stop planned ahead',
    });
  }

  /** Begins timing the run to the train's next stop. */
  startLeg(t: Train) {
    t.passedStop = false;
    t.duty?.startLeg(this.time, this.dueIn(t));
  }

  /**
   * Seconds until the train is due at its next stop: the timetabled arrival, a dwell before departure, when
   * the stop has a time, and otherwise an estimate from the route. Negative means it's already late.
   */
  dueIn(t: Train): number | null {
    const stop = this.stops(t)[t.schedIdx];
    if (stop && t.targetStation === stop.id) {
      if (stop.arr !== null) return untilTime(stop.arr, this.clock);
      if (stop.dep !== null) return untilTime(stop.dep - DWELL, this.clock);
    }
    return this.legTime(t);
  }

  /**
   * Walks the track ahead of the head along the route the train would take. visit returns undefined to carry on,
   * or a value to stop with; null stops with nothing found. The walk also stops where the line ends.
   */
  private walkAhead<T>(t: Train, range: number, visit: (p: AheadPiece) => T | null | undefined): T | null {
    const net = this.net;
    const h = t.trail[t.trail.length - 1];
    let seg = h.seg;
    let dir = h.dir;
    let start = dir > 0 ? -t.headS : t.headS - net.geom.get(seg)!.length;
    const seen = new Set<number>();
    while (start < range && !seen.has(seg)) {
      seen.add(seg);
      const exit = net.exit(seg, dir);
      const end = start + net.geom.get(seg)!.length;
      const r = visit({ seg, dir, start, end, exit });
      if (r !== undefined) return r;
      const nx = this.pick(t, seg, exit.node, exit.side);
      if (nx === undefined) return null;
      dir = net.entryDir(nx, exit.node, exit.side);
      seg = nx;
      start = end;
    }
    return null;
  }

  /** The next junction ahead that the driver can throw, within the given range. */
  nextJunction(t: Train, range = 800) {
    return this.walkAhead(t, range, ({ end, exit }) => {
      if (end >= range) return null;
      if (exit.options.length < 2) return undefined;
      const selected = this.net.selected(exit.node, exit.side)!;
      return { node: exit.node, side: exit.side, dist: end, selected, options: exit.options };
    });
  }

  /** Next signal for the HUD: prefers the next stopping signal (main/shunt), falling back to a distant signal. */
  signalAhead(t: Train) {
    type Found = {
      dist: number;
      aspect: Aspect;
      node: number;
      side: Side;
      type: SignalType;
      callingOn: boolean;
      route: SignalRoute | null;
    };
    let distant: Found | null = null;
    const main = this.walkAhead(t, 4000, ({ end, exit }) => {
      if (end >= 4000) return null;
      const def = this.net.nodes.get(exit.node)!.signals[exit.side];
      if (!def) return undefined;
      const key = keyOf(exit.node, exit.side);
      const ind = this.indications.get(key);
      const type = ind?.type ?? signalType(def);
      const aspect: Aspect = ind?.aspect ?? this.aspects.get(key) ?? 'green';
      const hit: Found = {
        dist: end,
        aspect,
        node: exit.node,
        side: exit.side,
        type,
        callingOn: ind?.callingOn ?? false,
        route: ind?.route ?? null,
      };
      if (type === 'distant') {
        if (!distant) distant = hit;
        return undefined;
      }
      return hit;
    });
    return main ?? distant;
  }

  stationAhead(t: Train) {
    return this.walkAhead(t, 5000, ({ end, exit }) => {
      if (end >= 5000) return null;
      const st = this.net.stations.find((s) => s.nodeId === exit.node);
      return st ? { name: st.name, dist: end } : undefined;
    });
  }

  /** Limits, gradient and braking for the driver's desk. */
  deskInfo(t: Train): DeskInfo {
    const net = this.net;
    const head = this.head(t);
    const speedCap = t.restricted ? Math.min(SHUNT_VMAX, t.topSpeed) : t.topSpeed;
    const limit = Math.min(net.geom.get(head.seg)!.vmax, speedCap);
    const nextLimit = this.walkAhead(t, LIMIT_LOOKAHEAD, ({ seg, start }) => {
      if (start <= 0) return undefined;
      const speed = Math.min(net.geom.get(seg)!.vmax, speedCap);
      return speed < limit - 0.3 ? { speed, dist: start } : undefined;
    });
    // Height at the end of the stretch, or where the line ends if that comes first.
    let far = { y: head.y, dist: 0 };
    this.walkAhead(t, GRADIENT_LOOKAHEAD, ({ seg, dir, start, end }) => {
      const L = net.geom.get(seg)!.length;
      const along = Math.min(end, GRADIENT_LOOKAHEAD) - start;
      far = { y: net.sample(seg, dir > 0 ? along : L - along).y, dist: start + along };
      return end >= GRADIENT_LOOKAHEAD ? null : undefined;
    });
    const gradient = far.dist > 1 ? (far.y - head.y) / far.dist : 0;
    return { limit, nextLimit, gradient, brakingDistance: this.brakingDistance(t) };
  }

  /** Steps the train's own physics forward with the lever at full brake, from its brakes as they are now. */
  private brakingDistance(t: Train) {
    const { slope, curve } = this.track(t);
    const m = t.mass;
    const dt = 0.1;
    let v = t.speed;
    let air = t.airBrake;
    let dist = 0;
    for (let time = 0; v > 0; time += dt) {
      if (time > 600) return Infinity;
      air = Math.min(1, air + dt / t.brakeLag);
      const decel = air * t.airDecel(v) + t.dynamicDecel(v) + drag(m, v) / m + G * (curve + slope);
      if (decel <= 0 && time > t.brakeLag) return Infinity;
      const nv = Math.max(0, v - decel * dt);
      dist += ((v + nv) / 2) * dt;
      v = nv;
    }
    return dist;
  }
}
