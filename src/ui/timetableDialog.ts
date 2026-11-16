// Edits a train's stops and departure times. Changes apply as they're made.
import type { Game } from '../game';
import type { Train } from '../rail/sim';
import { clockText } from '../rail/sim';

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers name the element type they expect.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "08:05" from a time input, as seconds of the day, or null when empty. */
function parseTime(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

export class TimetableDialog {
  private dlg = $<HTMLDialogElement>('dlg-timetable');
  private train: Train | null = null;

  constructor(private game: Game) {
    $<HTMLSelectElement>('tt-train').onchange = (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      this.train = this.game.sim.trains.find((t) => t.id === id) ?? null;
      this.render();
    };
    $('tt-add').onclick = () => {
      const t = this.train;
      if (!t) return;
      const station = Number($<HTMLSelectElement>('tt-add-station').value);
      this.apply([...t.schedule, station], [...this.times(t), null]);
    };
    $('tt-clear').onclick = () => {
      if (this.train) this.apply([], []);
    };
  }

  /** Opens on the given train, or the first one. */
  open(t: Train | null) {
    const trains = this.game.sim.trains;
    this.train = t ?? trains[0] ?? null;
    const sel = $<HTMLSelectElement>('tt-train');
    sel.innerHTML = '';
    for (const tr of trains) sel.add(new Option(tr.name, String(tr.id), false, tr === this.train));
    const add = $<HTMLSelectElement>('tt-add-station');
    add.innerHTML = '';
    for (const st of this.game.net.stations) add.add(new Option(st.name, String(st.id)));
    this.render();
    this.dlg.showModal();
  }

  private times(t: Train) {
    return t.schedule.map((_, i) => t.times[i] ?? null);
  }

  private apply(schedule: number[], times: (number | null)[]) {
    if (!this.train) return;
    this.game.setTimetable(this.train, schedule, times);
    this.render();
  }

  private render() {
    const ol = $('tt-stops');
    ol.innerHTML = '';
    const t = this.train;
    const stations = this.game.net.stations;
    $<HTMLButtonElement>('tt-add').disabled = !t || !stations.length;
    if (!t) {
      ol.innerHTML = '<li class="state">There are no trains. Add one with the Train lever in Edit map.</li>';
      return;
    }
    if (!t.schedule.length) {
      ol.innerHTML = '<li class="state">Calls at every station in turn, leaving once the doors close.</li>';
      return;
    }
    const times = this.times(t);
    t.schedule.forEach((id, i) => {
      const li = document.createElement('li');
      if (i === t.schedIdx) li.classList.add('next');
      const station = document.createElement('select');
      station.setAttribute('aria-label', `Stop ${i + 1}`);
      for (const st of stations) station.add(new Option(st.name, String(st.id), false, st.id === id));
      station.onchange = () => {
        const schedule = [...t.schedule];
        schedule[i] = Number(station.value);
        this.apply(schedule, times);
      };
      const time = document.createElement('input');
      time.type = 'time';
      time.setAttribute('aria-label', `Leaves stop ${i + 1} at`);
      const dep = times[i];
      time.value = dep === null ? '' : clockText(dep);
      time.onchange = () => {
        const next = [...times];
        next[i] = parseTime(time.value);
        this.apply(t.schedule, next);
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove stop ${i + 1}`);
      remove.onclick = () =>
        this.apply(
          t.schedule.filter((_, k) => k !== i),
          times.filter((_, k) => k !== i),
        );
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      // The stop the train is heading for, or standing at.
      if (i === t.schedIdx) n.title = 'Next stop';
      li.append(n, station, time, remove);
      ol.appendChild(li);
    });
  }
}
