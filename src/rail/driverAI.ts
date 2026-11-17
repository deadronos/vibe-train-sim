import type { InterlockState } from './interlocking';
import { inDeadlock } from './interlocking';
import type { Network } from './network';
import { brakeDecel, collectLimits, slopeOf } from './physics';
import { departureWait, findRoute, stops } from './routing';
import type { SimEvent, Train } from './train';
import { DWELL, G, LOG_STOPS, STEP } from './train';

export interface DriverActions {
  plan: (t: Train, advance: boolean) => void;
  reverse: (t: Train) => boolean;
  onEvent: (e: SimEvent) => void;
}

/** Records an arrival for the service diagram, keeping only the most recent stops. */
export function logArrival(t: Train, clock: number) {
  if (t.targetStation === null) return;
  t.log.push({ station: t.targetStation, arr: clock, dep: null });
  if (t.log.length > LOG_STOPS) t.log.shift();
}

/** Leaves the current stop: changes ends first if the timetable says so, then heads for the next stop. */
export function leaveStop(net: Network, t: Train, clock: number, actions: Pick<DriverActions, 'plan' | 'reverse'>) {
  const last = t.log.at(-1);
  if (last && last.dep === null) last.dep = clock;
  if (stops(net, t)[t.schedIdx]?.turn) actions.reverse(t);
  actions.plan(t, true);
}

/** Holds a train whose dwell is over until its departure time. Returns true while it waits. */
export function holdForTimetable(net: Network, t: Train, clock: number) {
  const wait = departureWait(net, t, clock);
  if (wait <= 0) return false;
  // One step at a time, so the status reads the same every step until it leaves.
  t.dwell = Math.min(wait, STEP);
  t.status = { kind: 'leaves_at', time: stops(net, t)[t.schedIdx].dep! };
  return true;
}

export function driveAI(
  net: Network,
  trains: Train[],
  state: InterlockState,
  t: Train,
  dt: number,
  clock: number,
  actions: DriverActions,
) {
  if (t.dwell > 0) {
    t.dwell -= dt;
    t.throttle = 0;
    t.brake = 1;
    t.dynamic = 0;
    t.emergency = false;
    t.status = { kind: 'at_platform' };
    if (t.dwell <= 0 && !holdForTimetable(net, t, clock)) {
      t.stopRemain = -1;
      leaveStop(net, t, clock, actions);
    }
    return;
  }
  if (t.targetStation === null && !t.route.length && net.stations.length) {
    actions.plan(t, false);
  }
  const lim = collectLimits(net, state.occ, t);
  t.limit = lim.lineLimit;
  let target = lim.allowed;
  if (lim.stopAt !== Infinity) target = Math.min(target, Math.sqrt(2 * lim.planBrake * Math.max(0, lim.stopAt - 0.5)));
  if (lim.stopAt <= 0.6) target = 0;
  const diff = target - t.speed;
  // Without this share the train settles at a creep on a descent, where gravity balances a light brake.
  const hold = Math.max(0, -G * slopeOf(net, t)) / brakeDecel(t);
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
    logArrival(t, clock);
    const st = t.targetStation !== null ? net.stationById(t.targetStation) : undefined;
    if (st) actions.onEvent({ kind: 'arrive', train: t.id, text: `${t.name} arrived at ${st.name}` });
    t.stuck = 0;
    t.brake = 1;
    t.dynamic = 0;
    t.emergency = false;
    return;
  }
  // Waiting: try a different route, then back away so opposing trains can never lock each other out.
  if (t.speed < 0.15 && target < 0.3) {
    t.status = { kind: 'waiting_signal' };
    t.stuck += dt;
    if (t.stuck > 20 && t.stuck - dt <= 20 && t.targetStation !== null) {
      const st = net.stationById(t.targetStation);
      const r = st ? findRoute(net, t, st.nodeId, state.segClaims, state.crossingClaims) : null;
      if (r) t.route = r;
    }
    if (t.stuck > 70) {
      if (inDeadlock(net, trains, state, t)) {
        t.stuck = 0;
        actions.reverse(t);
        actions.plan(t, false);
      } else {
        t.stuck = 45; // Plain queueing: look again shortly.
      }
    }
  } else {
    t.stuck = 0;
    t.status = t.targetStation !== null ? { kind: 'next_stop', stationId: t.targetStation } : { kind: 'running' };
  }
}
