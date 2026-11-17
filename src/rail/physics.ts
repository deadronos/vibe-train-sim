import type { Occupancy } from './interlocking';
import type { Network, Side } from './network';
import { signalType } from './network';
import { behind, pickSegment, pruneTrail, walkTrainAhead } from './routing';
import type { Train } from './train';
import {
  CURVE_RESISTANCE,
  drag,
  EMERGENCY,
  G,
  GAP,
  MIN_PLAN_BRAKE,
  PLAN_MARGIN,
  PLAN_SHARE,
  SHUNT_VMAX,
  SLIP_GRIP,
} from './train';
import { carMass, VEHICLES } from './vehicles';
import { keyOf } from './walk';

/** Rise per metre in the direction of travel and curve resistance per unit weight, averaged by mass along the train. */
export function trackProfile(net: Network, t: Train) {
  let d = 0;
  let slope = 0;
  let curve = 0;
  let mass = 0;
  for (const c of t.cars) {
    const len = VEHICLES[c.type].length;
    const at = behind(net, t, d + len / 2);
    const m = carMass(c);
    slope += at.ty * at.dir * m;
    curve += (CURVE_RESISTANCE / net.geom.get(at.seg)!.minRadius) * m;
    mass += m;
    d += len + GAP;
  }
  return { slope: slope / mass, curve: curve / mass };
}

export function slopeOf(net: Network, t: Train) {
  return trackProfile(net, t).slope;
}

/** Deceleration from engine and service brakes together at this train's speed. */
export function brakeDecel(t: Train) {
  return t.airDecel(t.speed) + t.dynamicDecel(t.speed);
}

/** Deceleration the AI can count on here: gravity eats into the brakes on a descent. */
export function planBrake(net: Network, t: Train) {
  const air = t.airDecel(t.speed);
  const available = (air * EMERGENCY + t.dynamicDecel(t.speed) + G * slopeOf(net, t)) * PLAN_MARGIN;
  return Math.max(MIN_PLAN_BRAKE, Math.min(air * PLAN_SHARE, available));
}

/** Force at the rail after the adhesion limit, in kN. The autopilot eases off before the wheels slip. */
function traction(t: Train) {
  const cut = t.emergency || t.tripped || t.damaged || (!t.ai && t.dwell > 0);
  const asked = t.speed < t.topSpeed && !cut ? t.tractiveForce(t.speed) * t.throttle : 0;
  const grip = t.adhesionLimit;
  t.slipping = !t.ai && asked > grip;
  if (t.slipping) return grip * SLIP_GRIP;
  return Math.min(asked, grip);
}

function updateAirBrake(t: Train, dt: number) {
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

export function advanceTrain(
  net: Network,
  t: Train,
  ds: number,
  silent = false,
  onNode?: (node: number, side: Side, fromSeg: number) => void,
  onBuffer?: () => void,
) {
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
    const nxt = pickSegment(net, t, p.seg, e.node, e.side);
    if (nxt === undefined) {
      if (!silent) onBuffer?.();
      t.speed = 0;
      break;
    }
    if (!silent) onNode?.(e.node, e.side, p.seg);
    const dir = net.entryDir(nxt, e.node, e.side);
    t.trail.push({ seg: nxt, dir });
    t.headS = dir > 0 ? 0 : net.geom.get(nxt)!.length;
  }
  if (!silent && ds > 0 && t.stopRemain >= 0) t.stopRemain = Math.max(0, t.stopRemain - (ds - rem));
  pruneTrail(net, t);
}

export function stepPhysics(
  net: Network,
  t: Train,
  dt: number,
  onNode: (node: number, side: Side, fromSeg: number) => void,
  onBuffer: () => void,
) {
  const { slope, curve } = trackProfile(net, t);
  const m = t.mass; // tonnes -> force in kN gives m/s^2
  let a = traction(t) / m - G * slope;
  updateAirBrake(t, dt);
  const braking = t.airBrake * t.airDecel(t.speed) + t.dynamic * t.dynamicDecel(t.speed);
  const resist = drag(m, t.speed) / m + G * curve + braking;
  if (t.speed > 0 || a > resist) {
    a -= resist;
  } else {
    a = 0; // Held stationary by the brakes.
  }
  t.speed = Math.max(0, t.speed + a * dt);
  if (t.speed > 0) advanceTrain(net, t, t.speed * dt, false, onNode, onBuffer);
}

/** Steps the train's own physics forward with the lever at full brake, from its brakes as they are now. */
export function brakingDistance(net: Network, t: Train) {
  const { slope, curve } = trackProfile(net, t);
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

/** True when any part of one train is within a car's width of the other. */
export function trainsTouch(net: Network, A: Train, B: Train) {
  const ha = behind(net, A, 0);
  const hb = behind(net, B, 0);
  if (Math.hypot(ha.x - hb.x, ha.z - hb.z) > A.length + B.length + 10) return false;
  for (let da = 0; da <= A.length; da += 6) {
    const a = behind(net, A, da);
    for (let db = 0; db <= B.length; db += 6) {
      const b = behind(net, B, db);
      if (Math.hypot(a.x - b.x, a.z - b.z) < 3.2 && Math.abs(a.y - b.y) < 3.5) return true;
    }
  }
  return false;
}

export function collectLimits(net: Network, occ: Map<number, Occupancy[]>, t: Train) {
  const brake = planBrake(net, t);
  const range = Math.max(400, (t.speed * t.speed) / (2 * brake) + 300);
  const speedCap = t.restricted ? Math.min(SHUNT_VMAX, t.topSpeed) : t.topSpeed;
  const headGeo = net.geom.get(t.trail[t.trail.length - 1].seg)!;
  const lineLimit = Math.min(headGeo.vmax, speedCap);
  let allowed = lineLimit;
  let stopAt = Infinity;
  let stationAt = t.stopRemain >= 0 ? t.stopRemain : Infinity;
  let bufferAt = Infinity;
  let current = true;
  const occBuffer = t.restricted ? 10 : 25;
  walkTrainAhead(net, t, range, ({ seg, dir, start, end, exit }) => {
    const dist = current ? 0 : start;
    if (dist >= range) return null;
    const geo = net.geom.get(seg)!;
    if (!current) {
      allowed = Math.min(allowed, Math.sqrt(Math.min(geo.vmax, speedCap) ** 2 + 2 * brake * dist));
    }
    for (const o of occ.get(seg) ?? []) {
      if (o.train === t.id) continue;
      const gap = dir > 0 ? (current ? o.sMin - t.headS : o.sMin) : current ? t.headS - o.sMax : geo.length - o.sMax;
      if (gap >= -2 || !current) stopAt = Math.min(stopAt, dist + Math.max(gap, 0) - occBuffer);
    }
    const def = net.nodes.get(exit.node)!.signals[exit.side];
    const key = keyOf(exit.node, exit.side);
    if (def && signalType(def) !== 'distant' && !t.grants.includes(key)) {
      stopAt = Math.min(stopAt, end - 8);
      return true;
    }
    const st = net.stationAt(exit.node);
    if (st && st.id === t.targetStation && t.stopRemain < 0 && t.ai) {
      stationAt = Math.min(stationAt, end + Math.max(1, t.length / 2));
    }
    current = false;
    if (pickSegment(net, t, seg, exit.node, exit.side) === undefined) {
      bufferAt = end - 4;
      return true;
    }
    return undefined;
  });
  if (bufferAt < stationAt) stationAt = bufferAt;
  stopAt = Math.min(stopAt, bufferAt, stationAt);
  return { allowed, stopAt, stationAt, lineLimit, planBrake: brake };
}
