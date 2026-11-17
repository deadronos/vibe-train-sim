// Train simulation entry point: placement, saves, manual driving, HUD queries and stepping. Contains no rendering code.
import { driveAI, holdForTimetable, leaveStop, logArrival } from './driverAI';
import { PENALTY } from './duty';
import type { InterlockState, Occupancy } from './interlocking';
import { interlockNetwork } from './interlocking';
import type { Dir, Network, Piece, Side, SignalType } from './network';
import { LINE_VMAX, signalType } from './network';
import {
  advanceTrain,
  brakingDistance,
  collectLimits,
  planBrake,
  stepPhysics,
  tractiveLoad,
  trainsTouch,
} from './physics';
import {
  behind,
  collectJunctionDists,
  departureWait,
  dueIn,
  findRoute,
  headPose,
  legTime,
  nodeBehind,
  pickSegment,
  planRoute,
  pruneTrail,
  rememberHead,
  reverseTrain,
  stops,
  walkTrainAhead,
} from './routing';
import type { DeskInfo, GuardWarning, SimEvent, Stop, TrainState, TrainStatus } from './train';
import {
  clockText,
  CRASH_SPEED,
  DAY,
  DWELL,
  GAP,
  GRADIENT_LOOKAHEAD,
  LIMIT_LOOKAHEAD,
  MAX_STEPS_PER_UPDATE,
  SHUNT_VMAX,
  STEP,
  STOP_SLACK,
  Train,
  untilTime,
  WARN_ACK_SECONDS,
} from './train';
import type { Car } from './vehicles';
import { VEHICLES } from './vehicles';
import type { Aspect, NextSignal, SignalIndication, SignalRoute } from './walk';
import { keyOf } from './walk';

export {
  clockText,
  collectJunctionDists,
  DAY,
  GAP,
  keyOf,
  SHUNT_VMAX,
  STEP,
  tractiveLoad,
  Train,
  untilTime,
  WARN_ACK_SECONDS,
};
export type {
  Aspect,
  DeskInfo,
  GuardWarning,
  NextSignal,
  SignalIndication,
  SignalRoute,
  SimEvent,
  Stop,
  TrainState,
  TrainStatus,
};

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

  private get interlockState(): InterlockState {
    return {
      aspects: this.aspects,
      indications: this.indications,
      nodeClaims: this.nodeClaims,
      segClaims: this.segClaims,
      crossingClaims: this.crossingClaims,
      occ: this.occ,
      segDirs: this.segDirs,
      shuntSegs: this.shuntSegs,
    };
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
    const pieces: Piece[] = [{ seg, dir }];
    let have = dir > 0 ? s : net.geom.get(seg)!.length - s;
    let cur = pieces[0];
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
    t.trail = pieces;
    t.headS = s;
    if (have < L) {
      // Dead end close behind: slide the head forward along the track.
      advanceTrain(net, t, L - have, true);
    }
    pruneTrail(net, t);
    t.next = null;
    rememberHead(net, t);
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
    rememberHead(this.net, t);
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

  // ------------------------------------------------------------ geometry & routing queries
  behind(t: Train, d: number) {
    return behind(this.net, t, d);
  }

  head(t: Train) {
    return headPose(this.net, t);
  }

  /** Seconds behind the latest step that `drawn()` interpolates at. */
  get drawnLag() {
    return STEP - this.unspent;
  }

  /** Like behind, for drawing: frames fall between steps, so trains are shown part of a step back to stay smooth. */
  drawn(t: Train, d = 0) {
    return behind(this.net, t, d + t.speed * (STEP - this.unspent));
  }

  /** Front and rear bogie positions of a car, ordered along the consist. */
  carPose(t: Train, index: number) {
    let d = 0;
    for (let i = 0; i < index; i++) d += VEHICLES[t.cars[i].type].length + GAP;
    const len = VEHICLES[t.cars[index].type].length;
    return { front: this.drawn(t, d + len * 0.18), rear: this.drawn(t, d + len * 0.82) };
  }

  pick(t: Train | null, seg: number, node: number, side: Side): number | undefined {
    return pickSegment(this.net, t, seg, node, side);
  }

  findRoute(t: Train, nodeId: number): Piece[] | null {
    return findRoute(this.net, t, nodeId, this.segClaims, this.crossingClaims);
  }

  stops(t: Train): Stop[] {
    return stops(this.net, t);
  }

  departureWait(t: Train) {
    return departureWait(this.net, t, this.clock);
  }

  plan(t: Train, advance: boolean) {
    planRoute(this.net, t, advance, this.segClaims, this.crossingClaims);
  }

  reverse(t: Train): boolean {
    return reverseTrain(this.net, t);
  }

  interlock() {
    interlockNetwork(this.net, this.trains, this.interlockState, (t) => planBrake(this.net, t));
  }

  switchLocked(node: number) {
    return this.nodeClaims.has(node);
  }

  touching(t: Train): Train | null {
    return this.trains.find((o) => o !== t && trainsTouch(this.net, t, o)) ?? null;
  }

  legTime(t: Train): number | null {
    return legTime(this.net, t);
  }

  dueIn(t: Train): number | null {
    return dueIn(this.net, t, this.clock);
  }

  // ------------------------------------------------------------ step & collisions
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
    const actions = {
      plan: (tr: Train, adv: boolean) => this.plan(tr, adv),
      reverse: (tr: Train) => this.reverse(tr),
      onEvent: this.onEvent,
    };
    for (const t of this.trains) {
      if (t.ai) driveAI(this.net, this.trains, this.interlockState, t, STEP, this.clock, actions);
      else this.driveManual(t, STEP);
      stepPhysics(
        this.net,
        t,
        STEP,
        (node, side, fromSeg) => this.crossNode(t, node, side, fromSeg),
        () => this.hitBuffer(t),
      );
      rememberHead(this.net, t);
    }
    this.collisions(STEP);
  }

  /** Seconds since the simulation started. */
  get time() {
    return this.steps * STEP;
  }

  private hitBuffer(t: Train) {
    if (t.speed <= 1.5) return;
    const text = `${t.name} hit the buffer stop at ${Math.round(t.speed * 3.6)} km/h`;
    t.duty?.add(`Hit the buffer stop at ${Math.round(t.speed * 3.6)} km/h`, -PENALTY.buffer);
    if (this.strict && !t.ai && t.speed > CRASH_SPEED) this.damage(t, text);
    else this.onEvent({ kind: 'buffer', train: t.id, text });
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
    const st = net.stationAt(node);
    if (st && t.ai && st.id === t.targetStation) t.stopRemain = Math.max(1, t.length / 2);
    if (st && !t.ai && st.id === t.targetStation) t.passedStop = true;
  }

  private collisions(dt: number) {
    for (const t of this.trains) if (t.crashCooldown > 0) t.crashCooldown -= dt;
    for (let i = 0; i < this.trains.length; i++) {
      for (let j = i + 1; j < this.trains.length; j++) {
        const A = this.trains[i];
        const B = this.trains[j];
        if (A.crashCooldown > 0 || B.crashCooldown > 0) continue;
        if (!trainsTouch(this.net, A, B)) continue;
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

  // ------------------------------------------------------------ manual driving & protection
  private driveManual(t: Train, dt: number) {
    const lim = collectLimits(this.net, this.occ, t);
    t.limit = lim.lineLimit;
    t.status = { kind: 'idle' };
    this.updateWarning(t, dt);
    if (this.strict) this.protect(t);
    t.duty?.overspeed(dt, t.speed, t.limit);
    if (t.dwell > 0) {
      t.status = { kind: 'doors_open' };
      t.dwell -= dt;
      if (t.dwell <= 0 && !holdForTimetable(this.net, t, this.clock)) this.depart(t);
      return;
    }
    this.checkStop(t);
  }

  /** Checks for restrictive signals or lower speed limits ahead and triggers cab warnings. */
  private updateWarning(t: Train, dt: number) {
    if (t.spadTripped) return;
    let hazard: { kind: 'signal' | 'speed'; text: string; key: string } | null = null;
    if (t.speed > 3) {
      const sig = walkTrainAhead(this.net, t, 220, ({ end, exit }) => {
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
      const nextLim = walkTrainAhead(this.net, t, 250, ({ seg, start }) => {
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
    if (t.tripped && !t.spadTripped && !t.warnTripped && t.speed <= t.limit) t.tripped = false;
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

  private checkStop(t: Train) {
    const st = t.targetStation !== null ? this.net.stationById(t.targetStation) : undefined;
    if (!st) return;
    // A train that stopped short has the point still ahead of it: count that as a negative distance behind.
    const ahead = walkTrainAhead(this.net, t, st.length + t.length, ({ end, exit }) =>
      exit.node === st.nodeId ? end : undefined,
    );
    const back = nodeBehind(this.net, t, st.nodeId) ?? (ahead === null ? null : -ahead);
    if (back === null) {
      if (t.passedStop) {
        t.duty?.add(`Missed the stop at ${st.name}`, -PENALTY.missed);
        this.onEvent({ kind: 'missed', train: t.id, text: `${t.name} missed the stop at ${st.name}` });
        this.plan(t, true);
        this.startLeg(t);
      }
      return;
    }
    // The mark puts the middle of the train at the middle of the platform. Positive means past it.
    const offset = back - t.length / 2;
    const room = Math.max(0, (st.length - t.length) / 2) + STOP_SLACK;
    if (Math.abs(offset) > room) {
      if (t.speed < 0.15) {
        const by = Math.round(Math.abs(offset) - room);
        t.status = offset < 0 ? { kind: 'draw_forward', by } : { kind: 'past_platform', by };
      }
      return;
    }
    if (t.speed >= 0.15) return;
    t.dwell = DWELL;
    t.restricted = false;
    t.score.stops++;
    logArrival(t, this.clock);
    const h = t.trail[t.trail.length - 1];
    t.lastStop = { seg: h.seg, s: t.headS, dir: h.dir };
    const points = t.duty?.stop(st.name, offset, this.time);
    const scored = points === undefined ? '' : `: ${points} points`;
    this.onEvent({ kind: 'stop', train: t.id, text: `Stopped at ${st.name}${scored}. Doors open` });
  }

  private depart(t: Train) {
    t.dwell = 0;
    leaveStop(this.net, t, this.clock, {
      plan: (tr, adv) => this.plan(tr, adv),
      reverse: (tr) => this.reverse(tr),
    });
    this.startLeg(t);
    const next = t.targetStation !== null ? this.net.stationById(t.targetStation) : undefined;
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

  // ------------------------------------------------------------ HUD queries
  /** The next junction ahead that the driver can throw, within the given range. */
  nextJunction(t: Train, range = 800) {
    return walkTrainAhead(this.net, t, range, ({ end, exit }) => {
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
    const main = walkTrainAhead(this.net, t, 4000, ({ end, exit }) => {
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
    return walkTrainAhead(this.net, t, 5000, ({ end, exit }) => {
      if (end >= 5000) return null;
      const st = this.net.stationAt(exit.node);
      return st ? { name: st.name, dist: end } : undefined;
    });
  }

  /** Limits, gradient and braking for the driver's desk. */
  deskInfo(t: Train): DeskInfo {
    const net = this.net;
    const head = this.head(t);
    const speedCap = t.restricted ? Math.min(SHUNT_VMAX, t.topSpeed) : t.topSpeed;
    const limit = Math.min(net.geom.get(head.seg)!.vmax, speedCap);
    const nextLimit = walkTrainAhead(net, t, LIMIT_LOOKAHEAD, ({ seg, start }) => {
      if (start <= 0) return undefined;
      const speed = Math.min(net.geom.get(seg)!.vmax, speedCap);
      return speed < limit - 0.3 ? { speed, dist: start } : undefined;
    });
    // Height at the end of the stretch, or where the line ends if that comes first.
    let far = { y: head.y, dist: 0 };
    walkTrainAhead(net, t, GRADIENT_LOOKAHEAD, ({ seg, dir, start, end }) => {
      const L = net.geom.get(seg)!.length;
      const along = Math.min(end, GRADIENT_LOOKAHEAD) - start;
      far = { y: net.sample(seg, dir > 0 ? along : L - along).y, dist: start + along };
      return end >= GRADIENT_LOOKAHEAD ? null : undefined;
    });
    const gradient = far.dist > 1 ? (far.y - head.y) / far.dist : 0;
    return { limit, nextLimit, gradient, brakingDistance: brakingDistance(net, t) };
  }
}
