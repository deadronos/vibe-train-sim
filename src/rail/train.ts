import type { Duty } from './duty';
import type { Dir, Piece } from './network';
import type { Car } from './vehicles';
import { carBrake, carMass, VEHICLES } from './vehicles';
import type { NextSignal } from './walk';

/** Speed cap (25 km/h) when proceeding past a calling-on / shunt signal. */
export const SHUNT_VMAX = 25 / 3.6;
/** Seconds the driver has to acknowledge a cab warning before protection brakes under strict rules. */
export const WARN_ACK_SECONDS = 4.0;
/** Seconds per simulation step. Results don't depend on how often frames arrive. */
export const STEP = 1 / 30;
export const MAX_STEPS_PER_UPDATE = 32; // Beyond this a slow machine falls behind rather than stalling further
export const GAP = 0.8;
export const G = 9.81;
export const EMERGENCY = 1.5; // Emergency brake force, as a multiple of full service braking
export const PLAN_SHARE = 0.6; // AI plans softer than the service brake can deliver
export const PLAN_MARGIN = 0.7; // Share of the deceleration left on a descent that the AI relies on
export const MIN_PLAN_BRAKE = 0.1;
export const ADHESION = 0.3; // Share of the weight on driven wheels that the rail can take as pulling force
export const SLIP_GRIP = 0.75; // Share of that limit left once the wheels are slipping
export const CURVE_RESISTANCE = 0.6; // Divided by radius in metres, as a share of weight
export const DYNAMIC_FADE_SPEED = 2; // m/s; engine braking fades out below this
export const LIMIT_LOOKAHEAD = 2500; // m; how far the desk looks for a lower limit
export const GRADIENT_LOOKAHEAD = 300; // m; the stretch the desk's gradient reading covers
export const DWELL = 22; // s at a platform
export const STOP_SLACK = 4; // m a stopped train may stand beyond its platform and still count
export const CRASH_SPEED = 15 / 3.6; // Under strict rules, hits faster than this damage the train
export const LEG_PACE = 0.8; // Share of the line speed a timetable expects on average
export const LEG_ALLOWANCE = 40; // s added to every leg for starting and stopping
export const DAY = 24 * 3600;
export const LOG_STOPS = 40;

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
export const drag = (m: number, v: number) => 0.012 * G * m + 0.0035 * m * v + 0.012 * v * v;

export interface SimEvent {
  /** arrive, stop and depart are news for the train's driver; the rest are warnings for everyone. */
  kind: 'spad' | 'collision' | 'buffer' | 'arrive' | 'stop' | 'depart' | 'missed' | 'protection' | 'damage';
  train: number;
  text: string;
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

export interface GuardWarning {
  kind: 'signal' | 'speed' | 'spad';
  text: string;
  timer: number;
  acknowledged: boolean;
  key: string;
}

/** Structured train status so the interface chooses the wording. */
export type TrainStatus =
  | { kind: 'idle' }
  | { kind: 'at_platform' }
  | { kind: 'waiting_signal' }
  | { kind: 'running' }
  | { kind: 'next_stop'; stationId: number }
  | { kind: 'leaves_at'; time: number }
  | { kind: 'doors_open' }
  | { kind: 'draw_forward'; by: number }
  | { kind: 'past_platform'; by: number };

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
  status: TrainStatus = { kind: 'idle' };
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
  /** Cumulative distance travelled in metres, used for wheel spin and joint/junction cues. Not saved. */
  odometer = 0;

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
