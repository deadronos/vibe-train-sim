// Edits a train's stops, times and vehicles. Changes apply as they're made.
import type { Game, Timetable } from '../game';
import type { Train } from '../rail/sim';
import { clockText } from '../rail/sim';
import type { Car, CarType } from '../rail/vehicles';
import { VEHICLES } from '../rail/vehicles';

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers name the element type they expect.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const CAR_LABEL: Record<CarType, string> = {
  loco_diesel: 'Diesel locomotive',
  loco_freight: 'Freight locomotive',
  loco_light: 'Light locomotive',
  coach: 'Coach',
  wagon_box: 'Box wagon',
  wagon_tank: 'Tank wagon',
};

/** "08:05" from a time input, as seconds of the day, or null when empty. */
function parseTime(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

const isWagon = (type: CarType) => type.startsWith('wagon');

export class TimetableDialog {
  private dlg = $<HTMLDialogElement>('dlg-timetable');
  private train: Train | null = null;

  constructor(private game: Game) {
    $<HTMLSelectElement>('tt-train').onchange = (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      this.train = this.game.sim.trains.find((t) => t.id === id) ?? null;
      $('tt-consist-msg').textContent = '';
      this.render();
    };
    $('tt-add').onclick = () => {
      const tt = this.timetable();
      if (!tt) return;
      const station = Number($<HTMLSelectElement>('tt-add-station').value);
      this.apply({
        schedule: [...tt.schedule, station],
        times: [...tt.times, null],
        arrivals: [...tt.arrivals, null],
        turns: [...tt.turns, false],
      });
    };
    $('tt-clear').onclick = () => this.apply({ schedule: [], times: [], arrivals: [], turns: [] });
    const addCar = $<HTMLSelectElement>('tt-add-car');
    for (const type of Object.keys(VEHICLES) as CarType[]) addCar.add(new Option(CAR_LABEL[type], type));
    $('tt-add-car-btn').onclick = () => {
      const t = this.train;
      if (t) this.setCars([...t.cars, { type: addCar.value as CarType, flip: false }]);
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
    $('tt-consist-msg').textContent = '';
    this.render();
    this.dlg.showModal();
  }

  /** The train's timetable with one entry per stop in every list. */
  private timetable(): Timetable | null {
    const t = this.train;
    if (!t) return null;
    return {
      schedule: [...t.schedule],
      times: t.schedule.map((_, i) => t.times[i] ?? null),
      arrivals: t.schedule.map((_, i) => t.arrivals[i] ?? null),
      turns: t.schedule.map((_, i) => t.turns[i] ?? false),
    };
  }

  private apply(tt: Timetable) {
    if (!this.train) return;
    this.game.setTimetable(this.train, tt);
    this.render();
  }

  private setCars(cars: Car[]) {
    if (!this.train) return;
    $('tt-consist-msg').textContent = this.game.setConsist(this.train, cars) ?? '';
    this.render();
  }

  private render() {
    this.renderStops();
    this.renderCars();
  }

  private renderStops() {
    const ol = $('tt-stops');
    ol.innerHTML = '';
    const t = this.train;
    const tt = this.timetable();
    const stations = this.game.net.stations;
    $<HTMLButtonElement>('tt-add').disabled = !t || !stations.length;
    if (!t || !tt) {
      ol.innerHTML = '<li class="state">There are no trains. Add one with the Train lever in Edit map.</li>';
      return;
    }
    if (!tt.schedule.length) {
      ol.innerHTML = '<li class="state">Calls at every station in turn, leaving once the doors close.</li>';
      return;
    }
    tt.schedule.forEach((id, i) => {
      const li = document.createElement('li');
      if (i === t.schedIdx) li.classList.add('next');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      if (i === t.schedIdx) n.title = 'Next stop';

      const station = document.createElement('select');
      station.setAttribute('aria-label', `Stop ${i + 1}`);
      for (const st of stations) station.add(new Option(st.name, String(st.id), false, st.id === id));
      station.onchange = () => {
        tt.schedule[i] = Number(station.value);
        this.apply(tt);
      };

      const timeInput = (label: string, list: (number | null)[]) => {
        const input = document.createElement('input');
        input.type = 'time';
        input.setAttribute('aria-label', `${label} stop ${i + 1}`);
        const v = list[i];
        input.value = v === null ? '' : clockText(v);
        input.onchange = () => {
          list[i] = parseTime(input.value);
          this.apply(tt);
        };
        return input;
      };

      const turn = document.createElement('input');
      turn.type = 'checkbox';
      turn.checked = tt.turns[i];
      turn.setAttribute('aria-label', `Change ends at stop ${i + 1}`);
      turn.onchange = () => {
        tt.turns[i] = turn.checked;
        this.apply(tt);
      };

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove stop ${i + 1}`);
      remove.onclick = () => {
        const keep = (_: unknown, k: number) => k !== i;
        this.apply({
          schedule: tt.schedule.filter(keep),
          times: tt.times.filter(keep),
          arrivals: tt.arrivals.filter(keep),
          turns: tt.turns.filter(keep),
        });
      };
      li.append(n, station, timeInput('Arrive at', tt.arrivals), timeInput('Leave', tt.times), turn, remove);
      ol.appendChild(li);
    });
  }

  private renderCars() {
    const ol = $('tt-cars');
    ol.innerHTML = '';
    const t = this.train;
    $<HTMLButtonElement>('tt-add-car-btn').disabled = !t;
    if (!t) return;
    t.cars.forEach((car, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = CAR_LABEL[car.type];
      li.appendChild(label);
      if (isWagon(car.type)) {
        const loaded = document.createElement('label');
        loaded.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = car.loaded !== false;
        box.onchange = () => this.setCars(t.cars.map((c, k) => (k === i ? { ...c, loaded: box.checked } : c)));
        loaded.append(box, ' Loaded');
        li.appendChild(loaded);
      } else {
        li.appendChild(document.createElement('span'));
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${CAR_LABEL[car.type]}, vehicle ${i + 1}`);
      remove.disabled = t.cars.length < 2;
      remove.onclick = () => this.setCars(t.cars.filter((_, k) => k !== i));
      li.appendChild(remove);
      ol.appendChild(li);
    });
    $('tt-cars-sum').textContent = `${Math.round(t.length)} m, ${Math.round(t.mass)} t`;
  }
}
