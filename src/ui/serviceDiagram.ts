// A service diagram: stations down the side, clock time across, and a line for each train through its stops.
// Dashed lines are the timetable; solid lines are what actually happened.
import type { Game } from '../game';
import type { Sim, Train } from '../rail/sim';
import { clockText, untilTime } from '../rail/sim';

const WINDOW = 2 * 3600; // s of clock time shown, centred on now
const DWELL = 22;
// Train colours, kept clear of the signal colours and of brass, which marks now.
const PALETTE = ['#7fb2e0', '#e9e4d2', '#c792c0', '#9cc59c', '#e0a070', '#a0a8e8', '#d8d070', '#8fd0c8'];
const PAD = { left: 130, right: 16, top: 16, bottom: 34 };

/** Stations in the order trains visit them, so most lines run straight down or up the diagram. */
export function stationOrder(sim: Sim): number[] {
  const order: number[] = [];
  for (const t of sim.trains) {
    for (const s of sim.stops(t)) if (!order.includes(s.id)) order.push(s.id);
  }
  for (const st of sim.net.stations) if (!order.includes(st.id)) order.push(st.id);
  return order;
}

/** The timetabled points of a train's run: arrival then departure at each stop that has a time. */
export function plannedPoints(sim: Sim, t: Train): { station: number; time: number }[] {
  const out: { station: number; time: number }[] = [];
  for (const s of sim.stops(t)) {
    const arr = s.arr ?? (s.dep === null ? null : s.dep - DWELL);
    if (arr !== null) out.push({ station: s.id, time: arr });
    if (s.dep !== null) out.push({ station: s.id, time: s.dep });
  }
  return out;
}

export class ServiceDiagram {
  private dlg = document.getElementById('dlg-diagram') as HTMLDialogElement;
  private canvas = this.dlg.querySelector('canvas')!;
  private ctx = this.canvas.getContext('2d')!;
  private timer = 0;

  constructor(private game: Game) {
    this.dlg.addEventListener('close', () => clearInterval(this.timer));
  }

  open() {
    this.draw();
    this.dlg.showModal();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.draw(), 1000);
  }

  private draw() {
    const g = this.game;
    const sim = g.sim;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const now = sim.clock;
    const order = stationOrder(sim);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    // Times are placed relative to now, so the diagram reads across midnight.
    const x = (time: number) => PAD.left + ((untilTime(time, now) + WINDOW / 2) / WINDOW) * plotW;
    const y = (station: number) =>
      PAD.top + (order.length < 2 ? plotH / 2 : (order.indexOf(station) / (order.length - 1)) * plotH);

    ctx.fillStyle = '#122629';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '600 12px Overpass, sans-serif';
    ctx.textBaseline = 'middle';

    // Stations
    for (const id of order) {
      const st = sim.net.stations.find((s) => s.id === id);
      ctx.strokeStyle = 'rgba(233, 228, 210, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y(id));
      ctx.lineTo(W - PAD.right, y(id));
      ctx.stroke();
      ctx.fillStyle = '#a9bab4';
      ctx.textAlign = 'right';
      ctx.fillText(st?.name ?? '', PAD.left - 8, y(id));
    }

    // Time axis, every 15 minutes
    ctx.textAlign = 'center';
    const step = 15 * 60;
    const first = Math.ceil((now - WINDOW / 2) / step) * step;
    for (let tick = first; tick <= now + WINDOW / 2; tick += step) {
      const px = x(tick);
      ctx.strokeStyle = 'rgba(233, 228, 210, 0.08)';
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, H - PAD.bottom);
      ctx.stroke();
      ctx.fillStyle = '#a9bab4';
      ctx.fillText(clockText(tick), px, H - PAD.bottom + 16);
    }
    ctx.strokeStyle = '#c7a350';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x(now), PAD.top - 6);
    ctx.lineTo(x(now), H - PAD.bottom + 4);
    ctx.stroke();

    const legend = document.getElementById('diagram-legend')!;
    legend.innerHTML = '';
    sim.trains.forEach((t, i) => {
      const color = PALETTE[i % PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      // Planned
      ctx.setLineDash([6, 5]);
      this.path(plannedPoints(sim, t).map((p) => [x(p.time), y(p.station)]));
      // Actual, running on to now from the last departure
      ctx.setLineDash([]);
      const actual: [number, number][] = [];
      for (const s of t.log) {
        actual.push([x(s.arr), y(s.station)]);
        actual.push([x(s.dep ?? now), y(s.station)]);
      }
      this.path(actual);
      const li = document.createElement('li');
      li.innerHTML = '<i></i><span></span>';
      (li.firstChild as HTMLElement).style.background = color;
      li.lastChild!.textContent = t.name;
      legend.appendChild(li);
    });
    ctx.setLineDash([]);
  }

  /** Draws a line through points, breaking it where it jumps more than the window, as at midnight. */
  private path(points: [number, number][]) {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach(([px, py], i) => {
      const prev = points[i - 1];
      if (i === 0 || px < prev[0] - 1) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}
