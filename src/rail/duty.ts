// Scores a player's turn at the controls: stops made well and on time earn points, bad driving costs them.

/** Points for each part of a good stop. */
const STOP_BASE = 50;
const ACCURACY_MAX = 50;
const ACCURACY_PER_M = 6; // Points lost per metre from the stopping mark
const PUNCTUALITY_MAX = 50;
const LATE_PER_POINT = 3; // Seconds late that cost one point
/** Speed over the limit that starts to cost points, in m/s (5 km/h): small slips while braking are free. */
export const OVERSPEED_MARGIN = 5 / 3.6;
const OVERSPEED_PER_S = 3;

export const PENALTY = {
  spad: 150,
  missed: 100,
  buffer: 100,
  collision: 200,
  protection: 30,
  damage: 300,
} as const;

export interface DutyLine {
  text: string;
  points: number;
}

export class Duty {
  points = 0;
  stops = 0;
  lines: DutyLine[] = [];
  /** Simulation time the next stop is due, in seconds, or null when there's no next stop. */
  due: number | null = null;
  private over: { time: number; peak: number; limit: number } | null = null;

  add(text: string, points: number) {
    this.points += points;
    this.lines.push({ text, points });
  }

  /** Starts the run to the next stop, due after the given running time. */
  startLeg(now: number, runTime: number | null) {
    this.due = runTime === null ? null : now + runTime;
  }

  /** Called every step. Time well over the limit costs points, reported as one line per spell. */
  overspeed(dt: number, speed: number, limit: number) {
    if (speed > limit + OVERSPEED_MARGIN) {
      this.over ??= { time: 0, peak: 0, limit };
      this.over.time += dt;
      this.over.peak = Math.max(this.over.peak, speed);
      this.points -= dt * OVERSPEED_PER_S;
    } else if (this.over) {
      const o = this.over;
      this.over = null;
      const lost = o.time * OVERSPEED_PER_S;
      this.lines.push({
        text: `Over the ${kmh(o.limit)} km/h limit for ${Math.ceil(o.time)} s, up to ${kmh(o.peak)} km/h`,
        points: -lost,
      });
    }
  }

  /** Scores a stop: offset is metres from the mark, and lateness comes from the due time. Returns the points. */
  stop(station: string, offset: number, now: number) {
    const accuracy = Math.round(Math.max(0, ACCURACY_MAX - ACCURACY_PER_M * Math.abs(offset)));
    const late = this.due === null ? 0 : now - this.due;
    const punctuality = Math.round(Math.max(0, PUNCTUALITY_MAX - Math.max(0, late) / LATE_PER_POINT));
    const points = STOP_BASE + accuracy + punctuality;
    const when = late <= 0 ? 'on time' : `${clock(late)} late`;
    this.stops++;
    this.add(`Stopped at ${station}, ${Math.round(Math.abs(offset))} m from the mark, ${when}`, points);
    return points;
  }

  /** Whole points for display. */
  get total() {
    return Math.round(this.points);
  }
}

const kmh = (v: number) => Math.round(v * 3.6);

/** Minutes and seconds, such as 2:05. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
