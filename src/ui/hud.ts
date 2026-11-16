import type { BrushMode, Tool } from '../editor/editor';
// HTML interface: mode lever, clock, train register, driver's desk and the editor's lever frame.
import type { Game } from '../game';
import type { MapEntry } from '../mapLibrary';
import type { Quality, Rules } from '../persistence';
import type { Duty } from '../rail/duty';
import { clock } from '../rail/duty';
import type { Side } from '../rail/network';
import { LINE_VMAX } from '../rail/network';
import type { DeskInfo, SimEvent, Train } from '../rail/sim';
import { CAM_LABEL } from '../render/cameraRig';
import type { SceneryType } from '../render/scatter';
import type { Preset } from '../world/heightfield';
import { Guide } from './guide';
import { OverviewMap } from './overviewMap';
import { PerfOverlay } from './perfOverlay';
import { ServiceDiagram } from './serviceDiagram';
import { TimetableDialog } from './timetableDialog';

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers name the element type they expect.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Room past the fastest line speed so overspeed shows on the dial.
const MAX_KMH = Math.ceil((LINE_VMAX * 3.6) / 20) * 20 + 20;
const OVERSPEED_KMH = 2;
const BRAKE_MARKER_RANGE = 2000; // m; how near a stop signal must be before the braking marker shows
const DIAL_START = -135;
const DIAL_SWEEP = 270;

// Lever colours follow signal-box practice as closely as the tool list allows.
const LEVERS: { tool: Tool; label: string; color: string }[] = [
  { tool: 'select', label: 'Select', color: '#e9e4d2' },
  { tool: 'track', label: 'Track', color: '#1c1c1e' },
  { tool: 'signal', label: 'Signal', color: '#c9302a' },
  { tool: 'station', label: 'Station', color: '#2f62a8' },
  { tool: 'bridge', label: 'Bridge', color: '#d9a52a' },
  { tool: 'terrain', label: 'Terrain', color: '#6e4a2c' },
  { tool: 'scenery', label: 'Scenery', color: '#2f7a48' },
  { tool: 'train', label: 'Train', color: '#7a3b7a' },
  { tool: 'delete', label: 'Remove', color: '#8d8f92' },
];

const SCENERY_LABEL: Record<SceneryType, string> = {
  tree_pine: 'Pine tree',
  tree_oak: 'Oak tree',
  tree_birch: 'Birch tree',
  rock_a: 'Small rock',
  rock_b: 'Large rock',
  house_a: 'Cottage',
  house_b: 'Long house',
  house_c: 'Town house',
};

function polar(angleDeg: number, r: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: 100 + Math.cos(a) * r, y: 100 + Math.sin(a) * r };
}
const kmhToAngle = (k: number) => DIAL_START + (Math.min(k, MAX_KMH) / MAX_KMH) * DIAL_SWEEP;

function brakeText(t: Train) {
  if (t.emergency) return 'Emergency brake on';
  if (t.slipping) return 'Wheels slipping: ease off the power';
  if (t.airBrake > 0.02 || t.brake > 0) return 'Air brake on';
  if (t.dynamic > 0) return 'Engine brake on';
  return '';
}

export class Hud {
  autopilot = true;
  private trainRows = new Map<number, { speed: HTMLElement; state: HTMLElement; li: HTMLElement }>();
  private frameCounter = 0;
  private lastLimit = -1;
  private empty: boolean | null = null;
  map!: OverviewMap;
  perf!: PerfOverlay;
  timetable!: TimetableDialog;
  private lamps: HTMLElement[] | null = null;
  guide!: Guide;

  constructor(private game: Game) {}

  bind() {
    const g = this.game;
    $('mode-drive').onclick = () => g.setMode(false);
    $('mode-edit').onclick = () => g.setMode(true);

    const slider = $<HTMLInputElement>('time-slider');
    slider.oninput = () => (g.env.hours = Number(slider.value));
    document.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => {
      b.onclick = () => {
        g.env.timeScale = Number(b.dataset.rate);
        this.syncRate();
      };
    });
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.onclick = () => g.setTrainSpeed(Number(b.dataset.speed));
    });
    this.syncTrainSpeed();
    g.env.timeScale = 0.0167;
    this.syncRate();
    const cloud = $<HTMLInputElement>('cloud-slider');
    cloud.value = String(g.env.cloudCover);
    cloud.oninput = () => (g.env.cloudCover = Number(cloud.value));

    $('btn-save').onclick = () => g.save();
    $('btn-export').onclick = () => g.exportMap();
    const file = $<HTMLInputElement>('import-file');
    $('btn-import').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      if (f) g.importMap(await f.text());
      file.value = '';
    };
    const dlgNew = $<HTMLDialogElement>('dlg-new');
    $('btn-new').onclick = () => dlgNew.showModal();
    dlgNew.addEventListener('close', () => {
      if (dlgNew.returnValue !== 'go') return;
      const preset = $<HTMLSelectElement>('new-preset').value as Preset;
      const seed = Number($<HTMLInputElement>('new-seed').value) || 1;
      const starter = $<HTMLInputElement>('new-starter').checked;
      g.startNewMap(preset, seed, starter);
      if (!starter) g.setMode(true);
      if (!starter) this.toast('Empty map created. Pull the Track lever to lay your first line');
    });
    const help = $<HTMLDialogElement>('dlg-help');
    $('btn-help').onclick = () => help.showModal();
    window.addEventListener('keydown', (e) => {
      if (e.key !== '?') return;
      if (help.open) help.close();
      else help.showModal();
    });
    this.bindSound();
    this.map = new OverviewMap(g, $('overview'));
    this.perf = new PerfOverlay(g, $('perf'));
    this.timetable = new TimetableDialog(g);
    $('btn-timetable').onclick = () => this.timetable.open(g.driven);
    const diagram = new ServiceDiagram(g);
    $('tt-diagram').onclick = () => diagram.open();
    $('btn-overview').onclick = () => this.map.toggle();
    $('overview-close').onclick = () => this.map.toggle(false);
    this.guide = new Guide(g, $('guide'));
    $('btn-guide').onclick = () => {
      help.close();
      this.guide.restart();
    };
    this.bindMaps();
    const q = $<HTMLSelectElement>('quality');
    q.value = g.quality;
    q.onchange = () => g.setQuality(q.value as Quality);
    const rules = $<HTMLSelectElement>('rules');
    rules.value = g.rules;
    rules.onchange = () => {
      g.setRules(rules.value as Rules);
      this.toast(
        g.rules === 'strict'
          ? 'Strict rules: train protection brakes trains well over the limit, and hard hits damage the train'
          : 'Relaxed rules: mistakes cost points but never stop the train',
      );
    };
    $('btn-recover').onclick = () => g.recoverDriven();
    this.bindFolds();
    const horn = $('btn-horn');
    horn.onpointerdown = () => g.audio.horn(true);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const)
      horn.addEventListener(ev, () => g.audio.horn(false));
    // Keyboard presses send click only, so give them a short blast.
    horn.onclick = (e) => {
      if (e.detail > 0) return;
      g.audio.horn(true);
      setTimeout(() => g.audio.horn(false), 500);
    };
    $('btn-next').onclick = () => g.nextTrain();

    $('btn-auto').onclick = () => g.setAutopilot(!g.driven?.ai);
    $('btn-switch').onclick = () => g.throwNextSwitch();
    $('btn-reverse').onclick = () => g.reverseDriven();
    $('btn-camera').onclick = () => {
      g.rig.cycle();
      this.syncDrive();
    };
    const lever = $<HTMLInputElement>('power-lever');
    lever.oninput = () => g.setLever(Number(lever.value));

    this.buildDial();
    this.buildFrame();
    this.syncMode();
    this.syncTrains();
    this.syncDrive();
  }

  private buildDial() {
    const group = $('dial-ticks') as unknown as SVGGElement;
    const NS = 'http://www.w3.org/2000/svg';
    for (let k = 0; k <= MAX_KMH; k += 10) {
      const major = k % 20 === 0;
      const a = kmhToAngle(k);
      const p0 = polar(a, 83);
      const p1 = polar(a, major ? 71 : 77);
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(p0.x));
      line.setAttribute('y1', String(p0.y));
      line.setAttribute('x2', String(p1.x));
      line.setAttribute('y2', String(p1.y));
      line.setAttribute('stroke', '#15282a');
      line.setAttribute('stroke-width', major ? '2.6' : '1.2');
      group.appendChild(line);
      if (major) {
        const t = polar(a, 57);
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', String(t.x));
        text.setAttribute('y', String(t.y + 4));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'tick-label');
        text.textContent = String(k);
        group.appendChild(text);
      }
    }
  }

  private buildFrame() {
    const frame = $('frame');
    frame.innerHTML = '';
    for (const l of LEVERS) {
      const b = document.createElement('button');
      b.className = 'lever';
      b.dataset.tool = l.tool;
      b.style.setProperty('--lever', l.color);
      b.innerHTML = `<span class="slot"></span><span class="rod"></span><span class="tag">${l.label}</span>`;
      b.setAttribute('aria-pressed', 'false');
      b.tabIndex = -1;
      b.onclick = () => this.game.editor.setTool(l.tool);
      frame.appendChild(b);
    }
    // A toolbar is one tab stop; arrow keys move between its levers.
    frame.addEventListener('keydown', (e) => {
      const levers = [...frame.querySelectorAll<HTMLButtonElement>('.lever')];
      const i = levers.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const to = {
        ArrowRight: i + 1,
        ArrowDown: i + 1,
        ArrowLeft: i - 1,
        ArrowUp: i - 1,
        Home: 0,
        End: levers.length - 1,
      }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation(); // Arrow keys also move the editor camera
      const next = levers[(to + levers.length) % levers.length];
      for (const l of levers) l.tabIndex = l === next ? 0 : -1;
      next.focus();
    });
  }

  private bindMaps() {
    const g = this.game;
    const dlg = $<HTMLDialogElement>('dlg-maps');
    $('btn-maps').onclick = () => {
      this.syncMaps();
      dlg.showModal();
    };
    $('btn-copy').onclick = () => {
      const name = $<HTMLInputElement>('copy-name');
      if (g.saveCopy(name.value)) name.value = '';
      this.syncMaps();
    };
  }

  /** Lists saved copies and backups. Loading needs no prompt, because the map it replaces becomes a backup. */
  syncMapButton(open: boolean) {
    $('btn-overview').setAttribute('aria-pressed', String(open));
  }

  private syncMaps() {
    const g = this.game;
    const dateText = (ms: number) =>
      new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const fill = (ul: HTMLElement, entries: MapEntry[], empty: string) => {
      ul.innerHTML = '';
      if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'state';
        li.textContent = empty;
        ul.appendChild(li);
      }
      for (const e of entries) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="name"></span><span class="when"></span><button data-act="load">Load</button>`;
        li.querySelector('.name')!.textContent = e.name;
        li.querySelector('.when')!.textContent = dateText(e.savedAt);
        li.querySelector<HTMLButtonElement>('[data-act=load]')!.onclick = () => {
          $<HTMLDialogElement>('dlg-maps').close();
          g.loadMap(e);
        };
        const del = document.createElement('button');
        del.textContent = 'Delete';
        // Deleting can't be undone, so it takes a second click.
        del.onclick = () => {
          if (del.dataset.armed) {
            g.library.remove(e);
            this.syncMaps();
            return;
          }
          del.dataset.armed = '1';
          del.textContent = 'Delete for good';
        };
        li.appendChild(del);
        ul.appendChild(li);
      }
    };
    fill($('copy-list'), g.library.copies(), 'No saved copies yet.');
    fill($('backup-list'), g.library.backups(), 'No backups yet. One is kept each time a map is replaced.');
  }

  /** The Menu and Trains buttons that small screens use to fold the menu, clock controls and train list away. */
  private bindFolds() {
    const folds = [
      { btn: $('btn-menu'), cls: 'menu-open' },
      { btn: $('btn-trains'), cls: 'trains-open' },
    ];
    const set = (open: string | null) => {
      for (const f of folds) {
        const on = f.cls === open;
        document.body.classList.toggle(f.cls, on);
        f.btn.setAttribute('aria-expanded', String(on));
      }
    };
    for (const f of folds) f.btn.onclick = () => set(document.body.classList.contains(f.cls) ? null : f.cls);
    // A menu item that opens something closes the menu behind it. Lists and sliders keep it open.
    $('menu-plate').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) set(null);
    });
    $('view').addEventListener('pointerdown', () => set(null));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.matches('.menu-open, .trains-open')) set(null);
    });
  }

  private bindSound() {
    const g = this.game;
    const dlg = $<HTMLDialogElement>('dlg-sound');
    $('btn-sound').onclick = () => {
      this.syncSound();
      dlg.showModal();
    };
    $<HTMLInputElement>('sound-on').onchange = (e) => g.setSound({ muted: !(e.target as HTMLInputElement).checked });
    for (const k of ['volume', 'engine', 'rail', 'horn'] as const) {
      const input = $<HTMLInputElement>(`sound-${k}`);
      input.oninput = () => g.setSound({ [k]: Number(input.value) });
    }
    this.syncSound();
  }

  syncSound() {
    const a = this.game.audio;
    const s = a.settings;
    $('btn-sound').setAttribute('aria-pressed', String(!s.muted));
    $('btn-sound').textContent = s.muted ? 'Sound off' : 'Sound';
    $<HTMLInputElement>('sound-on').checked = !s.muted;
    for (const k of ['volume', 'engine', 'rail', 'horn'] as const) {
      $<HTMLInputElement>(`sound-${k}`).value = String(s[k]);
    }
    $('sound-wait').hidden = a.started;
  }

  syncTrainSpeed() {
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === this.game.trainSpeed));
    });
  }

  private syncRate() {
    document.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.rate) - this.game.env.timeScale) < 1e-6));
    });
  }

  syncMode() {
    const editing = this.game.editing;
    $('mode-drive').setAttribute('aria-pressed', String(!editing));
    $('mode-edit').setAttribute('aria-pressed', String(editing));
    this.syncEditor();
  }

  syncDrive() {
    const g = this.game;
    const t = g.driven;
    $('btn-auto').setAttribute('aria-pressed', String(!!t?.ai));
    $('btn-camera').textContent = `${CAM_LABEL[g.rig.mode]} view`;
    this.autopilot = !!t?.ai;
  }

  /** Rebuilds the train list when the set of trains changes. */
  syncTrains() {
    const g = this.game;
    const ul = $('train-list');
    ul.innerHTML = '';
    this.trainRows.clear();
    if (!g.sim) return;
    if (!g.sim.trains.length) {
      const li = document.createElement('li');
      li.textContent = 'No trains on the map. Add one with the Train lever in Edit map.';
      li.className = 'state';
      ul.appendChild(li);
    }
    for (const t of g.sim.trains) {
      const li = document.createElement('li');
      li.classList.toggle('driven', t === g.driven);
      const b = document.createElement('button');
      b.innerHTML = `<span class="name"><span></span><span class="speed"></span></span><span class="state"></span>`;
      b.querySelector('.name span')!.textContent = t.name;
      b.onclick = () => g.setDriven(t);
      if (t === g.driven) b.setAttribute('aria-current', 'true');
      li.appendChild(b);
      ul.appendChild(li);
      this.trainRows.set(t.id, { speed: b.querySelector('.speed')!, state: b.querySelector('.state')!, li });
    }
    this.syncDrive();
  }

  syncEditor() {
    const g = this.game;
    if (!g.editor) return;
    const ed = g.editor;
    document.querySelectorAll<HTMLButtonElement>('.lever').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === ed.tool));
      if (document.activeElement?.parentElement !== b.parentElement) b.tabIndex = b.dataset.tool === ed.tool ? 0 : -1;
    });
    const p = $('tool-panel');
    p.innerHTML = '';
    switch (ed.tool) {
      case 'select':
        this.panelSelect(p);
        break;
      case 'track':
        p.innerHTML = `<h2>Lay track</h2><p>Click to start, then click again to lay a section. Start on a track to branch into a junction, or finish on one to join it.</p>
          <label><span>Height above ground: <output id="height-val"></output> m</span><input id="height" type="range" min="-30" max="60" step="1" /></label>
          <p>High sections become bridges automatically. Low sections cut through the ground.</p>
          <label class="check"><input id="snap" type="checkbox" /> Snap new lines to 15° steps (Shift)</label>
          <div class="row"><button id="stop-laying">Stop laying (Esc)</button></div>`;
        {
          const snap = $<HTMLInputElement>('snap');
          snap.checked = ed.snap;
          snap.onchange = () => (ed.snap = snap.checked);
          $('stop-laying').onclick = () => ed.cancel();
          const hv = $<HTMLOutputElement>('height-val');
          const h = $<HTMLInputElement>('height');
          h.value = String(ed.heightOffset);
          hv.textContent = String(ed.heightOffset);
          h.oninput = () => {
            ed.heightOffset = Number(h.value);
            hv.textContent = h.value;
          };
        }
        break;
      case 'signal':
        p.innerHTML = `<h2>Signals</h2><p>Click beside a track. The arrow shows which direction of travel the signal controls. Click the same spot again to remove it.</p><p>Red means the section ahead is occupied, yellow means the next signal is red.</p>`;
        break;
      case 'station':
        p.innerHTML = `<h2>Stations</h2><p>Click beside a track to build a platform on that side. Trains stop here on their timetable.</p>`;
        break;
      case 'bridge':
        p.innerHTML = `<h2>Bridges</h2><p>Click a section of track to switch between automatic, always a bridge, and always an embankment.</p><p>Spans over water get a steel truss.</p>`;
        break;
      case 'terrain':
        this.panelTerrain(p);
        break;
      case 'scenery':
        p.innerHTML = `<h2>Scenery</h2><label>Place<select id="scenery-type">${Object.entries(SCENERY_LABEL)
          .map(([k, v]) => `<option value="${k}">${v}</option>`)
          .join('')}</select></label><p>Click the ground to place one.</p>`;
        {
          const s = $<HTMLSelectElement>('scenery-type');
          s.value = ed.sceneryType;
          s.onchange = () => (ed.sceneryType = s.value as SceneryType);
        }
        break;
      case 'train':
        p.innerHTML = `<h2>Add a train</h2><label>Type<select id="train-kind"><option value="passenger">Express: 3 coaches, 2 locomotives</option><option value="shuttle">Local: 2 coaches</option><option value="freight">Freight: 5 loaded wagons</option><option value="emptyFreight">Empties: 5 empty wagons</option></select></label><p>Click a track to place it. New trains call at every station.</p>
          <label class="check"><input id="run-trains" type="checkbox" /> Keep trains moving while editing</label>
          <div class="row"><button id="btn-tt-edit">Edit timetables</button></div>`;
        {
          const k = $<HTMLSelectElement>('train-kind');
          k.value = ed.trainKind;
          k.onchange = () => (ed.trainKind = k.value as typeof ed.trainKind);
          $('btn-tt-edit').onclick = () => this.timetable.open(g.sim.trains.at(-1) ?? null);
          const r = $<HTMLInputElement>('run-trains');
          r.checked = ed.runTrains;
          r.onchange = () => (ed.runTrains = r.checked);
        }
        break;
      case 'delete':
        p.innerHTML = `<h2>Remove</h2><p>Click a train, signal, station, placed scenery or section of track to remove it.</p>`;
        break;
    }
    const undoRow = document.createElement('div');
    undoRow.className = 'row';
    undoRow.innerHTML = `<button id="btn-undo">Undo</button><button id="btn-redo">Redo</button>`;
    p.appendChild(undoRow);
    $('btn-undo').onclick = () => g.undo();
    $('btn-redo').onclick = () => g.redo();
    this.syncUndo();
  }

  syncUndo() {
    const undo = document.getElementById('btn-undo') as HTMLButtonElement | null;
    const redo = document.getElementById('btn-redo') as HTMLButtonElement | null;
    if (undo) undo.disabled = !this.game.history.canUndo;
    if (redo) redo.disabled = !this.game.history.canRedo;
  }

  private panelTerrain(p: HTMLElement) {
    const ed = this.game.editor;
    const labels: Record<BrushMode, string> = { raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten' };
    p.innerHTML = `<h2>Shape terrain</h2><div class="row" id="brush-modes">${(Object.keys(labels) as BrushMode[])
      .map((m) => `<button data-mode="${m}" aria-pressed="${m === ed.brushMode}">${labels[m]}</button>`)
      .join('')}</div>
      <label>Brush size<input id="brush-size" type="range" min="15" max="220" /></label>
      <label>Strength<input id="brush-str" type="range" min="0.1" max="2" step="0.05" /></label>
      <p>Lower the ground below the waterline to make lakes and rivers.</p>`;
    p.querySelectorAll<HTMLButtonElement>('#brush-modes button').forEach((b) => {
      b.onclick = () => {
        ed.brushMode = b.dataset.mode as BrushMode;
        this.syncEditor();
      };
    });
    const size = $<HTMLInputElement>('brush-size');
    size.value = String(ed.brushRadius);
    size.oninput = () => (ed.brushRadius = Number(size.value));
    const str = $<HTMLInputElement>('brush-str');
    str.value = String(ed.brushStrength);
    str.oninput = () => (ed.brushStrength = Number(str.value));
  }

  private panelSelect(p: HTMLElement) {
    const g = this.game;
    const ed = g.editor;
    const n = ed.selected !== null ? g.net.nodes.get(ed.selected) : null;
    if (!n) {
      p.innerHTML = `<h2>Select</h2><p>Click a point on the track to change it. Drag a point to move it. Drag the ground to move the view.</p>`;
      return;
    }
    const station = g.net.stations.find((s) => s.nodeId === n.id);
    const rows: string[] = [
      `<h2>Track point</h2>`,
      `<label><span>Rail height: <output id="sel-y">${n.y.toFixed(1)}</output> m</span><input id="sel-h" type="range" min="-5" max="160" step="0.5" value="${n.y}" /></label>`,
    ];
    rows.push(
      `<div class="row"><button data-turn="5">Turn 5° left</button><button data-turn="-5">Turn 5° right</button></div>`,
    );
    if (station) {
      rows.push(`<label>Station name<input id="sel-name" type="text" maxlength="24" /></label>`);
      rows.push(
        `<label><span>Platform length: <output id="sel-len">${station.length}</output> m</span><input id="sel-len-in" type="range" min="60" max="300" step="10" value="${station.length}" /></label>`,
      );
    }
    for (const side of [1, -1] as Side[]) {
      const count = g.net.attached(n.id, side).length;
      const label = side === 1 ? 'Forward' : 'Backward';
      if (count > 1)
        rows.push(`<div class="row"><button data-throw="${side}">Throw ${label.toLowerCase()} points</button></div>`);
      if (n.signals[side])
        rows.push(
          `<label class="check"><input type="checkbox" data-hold="${side}" ${n.signals[side].hold ? 'checked' : ''}/> Hold the ${label.toLowerCase()} signal at red</label>`,
        );
    }
    rows.push(`<div class="row"><button id="sel-del">Remove point</button></div>`);
    p.innerHTML = rows.join('');
    const h = $<HTMLInputElement>('sel-h');
    const y = $<HTMLOutputElement>('sel-y');
    let undoPushed = false;
    h.oninput = () => {
      if (!undoPushed) {
        g.pushUndo();
        undoPushed = true;
      }
      g.net.moveNode(n.id, n.x, Number(h.value), n.z);
      y.textContent = Number(h.value).toFixed(1);
      g.commitEdit();
      ed.status = g.net.problemAt(n.id) ?? '';
    };
    h.onchange = () => {
      undoPushed = false;
      ed.refuseIfBroken(n.id, 'Height change');
    };
    p.querySelectorAll<HTMLButtonElement>('[data-turn]').forEach((b) => {
      b.onclick = () => ed.turnSelected(Number(b.dataset.turn));
    });
    if (station) {
      const name = $<HTMLInputElement>('sel-name');
      name.value = station.name;
      // Typing a name is one undo step, not one per key.
      let renamePushed = false;
      name.onfocus = () => (renamePushed = false);
      name.oninput = () => {
        if (!renamePushed) {
          g.pushUndo();
          renamePushed = true;
        }
        station.name = name.value || station.name;
        g.net.version++;
      };
      const len = $<HTMLInputElement>('sel-len-in');
      let lenPushed = false;
      len.oninput = () => {
        if (!lenPushed) {
          g.pushUndo();
          lenPushed = true;
        }
        station.length = Number(len.value);
        $('sel-len').textContent = len.value;
        g.net.version++;
      };
      len.onchange = () => (lenPushed = false);
    }
    p.querySelectorAll<HTMLButtonElement>('[data-throw]').forEach((b) => {
      b.onclick = () => {
        g.pushUndo();
        g.net.throwSwitch(n.id, Number(b.dataset.throw) as Side);
        g.sim.interlock();
        this.toast('Points thrown');
      };
    });
    p.querySelectorAll<HTMLInputElement>('[data-hold]').forEach((c) => {
      c.onchange = () => {
        g.pushUndo();
        n.signals[Number(c.dataset.hold)]!.hold = c.checked;
        g.net.version++;
      };
    });
    $('sel-del').onclick = () => ed.deleteSelected();
  }

  toast(text: string, warn = false) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = warn ? 'toast warn' : 'toast';
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild?.remove();
    setTimeout(() => el.remove(), warn ? 5500 : 3200);
  }

  onSimEvent(e: SimEvent) {
    const driven = this.game.driven;
    const isMine = driven && driven.id === e.train;
    if (e.kind === 'arrive' || e.kind === 'stop' || e.kind === 'depart') {
      if (isMine) this.toast(e.text);
    } else {
      this.toast(e.text, true);
    }
  }

  /** The end-of-run summary, with every scored event and how it compares with the best on this landscape. */
  showDuty(name: string, d: Duty, best: number | null) {
    $('duty-title').textContent = `Your run on ${name}`;
    const record =
      best === null
        ? 'Your first score on this landscape'
        : d.total > best
          ? `A new best, beating ${best}`
          : `Best on this landscape: ${best}`;
    $('duty-total').textContent = `${d.total} points from ${d.stops} stop${d.stops === 1 ? '' : 's'}. ${record}.`;
    const ul = $('duty-lines');
    ul.innerHTML = '';
    for (const line of d.lines) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span class="pts"></span>';
      li.children[0].textContent = line.text;
      const pts = Math.round(line.points);
      li.children[1].textContent = pts > 0 ? `+${pts}` : String(pts);
      li.classList.toggle('lost', pts < 0);
      ul.appendChild(li);
    }
    $<HTMLDialogElement>('dlg-duty').showModal();
  }

  private setDialLimit(kmh: number) {
    if (Math.abs(kmh - this.lastLimit) < 1) return;
    this.lastLimit = kmh;
    const path = $('dial-limit') as unknown as SVGPathElement;
    const a0 = kmhToAngle(kmh);
    const a1 = kmhToAngle(MAX_KMH);
    if (a1 - a0 < 1) {
      path.setAttribute('d', '');
      return;
    }
    const p0 = polar(a0, 84);
    const p1 = polar(a1, 84);
    const large = a1 - a0 > 180 ? 1 : 0;
    path.setAttribute('d', `M ${p0.x} ${p0.y} A 84 84 0 ${large} 1 ${p1.x} ${p1.y}`);
  }

  update() {
    const g = this.game;
    this.frameCounter++;
    $('clock').textContent = g.env.clockText();
    if (document.activeElement !== $('time-slider')) $<HTMLInputElement>('time-slider').value = String(g.env.hours);
    if (g.editing) {
      const st = $('status');
      if (st.textContent !== g.editor.status) st.textContent = g.editor.status;
    }
    if (this.frameCounter % 15 === 0) $('fps').textContent = `${Math.round(g.fps)} fps`;
    this.map.update();
    if (this.frameCounter % 15 === 0) this.guide.update();
    const t = g.driven;
    this.setEmpty(!t);
    if (!t) return;
    const kmh = t.speed * 3.6;
    $('dial-needle').setAttribute('transform', `rotate(${kmhToAngle(kmh)} 100 100)`);
    $('dial-speed').textContent = String(Math.round(kmh));
    this.setDialLimit(t.limit * 3.6);
    const lever = t.ai ? t.throttle - t.brake : g.input.lever;
    $<HTMLInputElement>('power-lever').value = String(lever);

    if (this.frameCounter % 8 !== 0) return;
    this.autopilot = t.ai;
    $('train-text').textContent = t.ai
      ? 'Autopilot is driving. Press W or move the lever to take over'
      : t.statusText || brakeText(t);
    const recover = $('btn-recover');
    recover.hidden = !t.damaged;
    $('lever-text').hidden = t.damaged;
    $('btn-auto').setAttribute('aria-pressed', String(t.ai));
    $('lever-text').textContent = leverText(t, lever);
    const info = g.sim.deskInfo(t);
    this.showLine(info, kmh);
    const sig = g.sim.signalAhead(t);
    this.lamps ??= [...document.querySelectorAll<HTMLElement>('.lamps i')];
    this.lamps.forEach((l) => l.classList.toggle('on', !!sig && l.dataset.lamp === sig.aspect));
    const word = sig ? { red: 'Stop', yellow: 'Caution', green: 'Clear' }[sig.aspect] : '';
    $('signal-text').textContent = sig ? `${word} in ${formatDist(sig.dist)}` : 'No signal ahead';
    $('dial').setAttribute('aria-label', `Speed ${Math.round(kmh)} km/h, limit ${Math.round(info.limit * 3.6)}`);
    this.announce(t, sig ? `Signal ahead: ${word.toLowerCase()} in ${formatDist(sig.dist)}` : null, kmh, info);
    this.showBraking(sig?.aspect === 'red' && sig.dist < BRAKE_MARKER_RANGE ? sig.dist : null, t, info);
    const stn = g.sim.stationAhead(t);
    $('station-text').textContent = stn ? `${stn.name} in ${formatDist(stn.dist)}${this.dueText(t, stn.name)}` : '';
    const j = g.sim.nextJunction(t);
    if (j) {
      const idx = j.options.indexOf(j.selected);
      $('junction-text').textContent = `Points in ${formatDist(j.dist)}: route ${idx + 1} of ${j.options.length}`;
    } else {
      $('junction-text').textContent = '';
    }
    for (const train of g.sim.trains) {
      const row = this.trainRows.get(train.id);
      if (!row) continue;
      row.speed.textContent = `${Math.round(train.speed * 3.6)} km/h`;
      const text = train.ai ? train.statusText : `You are driving: ${train.duty?.total ?? 0} points`;
      if (row.state.textContent !== text) row.state.textContent = text;
    }
  }

  private spoken = { train: -1, signal: '', over: false };

  /**
   * Tells screen readers about changes that matter while driving: a new signal aspect ahead, or going over
   * the limit. Speed itself is on the dial's label, to read on demand rather than announced constantly.
   */
  private announce(t: Train, signal: string | null, kmh: number, info: DeskInfo) {
    const s = this.spoken;
    const aspect = signal?.split(' in ')[0] ?? '';
    const over = !t.ai && kmh > info.limit * 3.6 + OVERSPEED_KMH;
    let text = '';
    if (t.id !== s.train) text = `Driving ${t.name}. ${signal ?? 'No signal ahead'}`;
    else if (aspect !== s.signal && signal) text = signal;
    if (over && !s.over) text = `${text} Over the ${Math.round(info.limit * 3.6)} km/h limit`.trim();
    s.train = t.id;
    s.signal = aspect;
    s.over = over;
    if (text) $('drive-status').textContent = text;
  }

  /** When the player is due at the station ahead, how long until then, or how late they are. */
  private dueText(t: Train, station: string) {
    const due = t.duty?.due;
    const target = this.game.net.stations.find((s) => s.id === t.targetStation);
    if (t.ai || due === undefined || due === null || target?.name !== station) return '';
    const left = due - this.game.sim.time;
    return left >= 0 ? `, due in ${clock(left)}` : `, ${clock(-left)} late`;
  }

  /** Clears the desk when there is no train to drive, so it never shows the last train's values. */
  private setEmpty(empty: boolean) {
    if (empty === this.empty) return;
    this.empty = empty;
    $('desk').classList.toggle('empty', empty);
    for (const id of ['power-lever', 'btn-auto', 'btn-switch', 'btn-reverse', 'btn-horn']) {
      $<HTMLInputElement | HTMLButtonElement>(id).disabled = empty;
    }
    if (!empty) return;
    $('dial-needle').setAttribute('transform', `rotate(${kmhToAngle(0)} 100 100)`);
    $('dial-speed').textContent = '–';
    this.setDialLimit(MAX_KMH);
    $<HTMLInputElement>('power-lever').value = '0';
    document.querySelectorAll('.lamps i').forEach((l) => l.classList.remove('on'));
    $('signal-text').textContent = 'No train to drive';
    for (const id of ['station-text', 'junction-text', 'train-text', 'lever-text', 'next-limit-text', 'grade-text']) {
      $(id).textContent = '';
    }
    $('limit-text').textContent = 'Add one with the Train lever in Edit map';
    $('limit-text').classList.remove('alert');
    $('brake-row').hidden = true;
  }

  private showLine(info: DeskInfo, kmh: number) {
    const limit = Math.round(info.limit * 3.6);
    const over = kmh > info.limit * 3.6 + OVERSPEED_KMH;
    const limitEl = $('limit-text');
    limitEl.textContent = over ? `Over the limit of ${limit} km/h` : `Limit ${limit} km/h`;
    limitEl.classList.toggle('alert', over);
    const next = info.nextLimit;
    $('next-limit-text').textContent = next
      ? `${Math.round(next.speed * 3.6)} km/h in ${formatDist(next.dist)}`
      : 'No lower limit ahead';
    const pct = info.gradient * 100;
    $('grade-text').textContent =
      Math.abs(pct) < 0.1 ? 'Level' : `${pct > 0 ? 'Uphill' : 'Downhill'} ${Math.abs(pct).toFixed(1)}%`;
  }

  /** Compares the room left before a red signal with the distance the train needs to stop. */
  private showBraking(signalDist: number | null, t: Train, info: DeskInfo) {
    const row = $('brake-row');
    row.hidden = signalDist === null || t.speed < 0.5;
    if (row.hidden || signalDist === null) return;
    const room = Math.max(1, signalDist - 8);
    const need = info.brakingDistance;
    const share = Math.min(1, need / room);
    const late = share > 0.85;
    $('brake-bar').style.setProperty('--fill', String(share));
    row.classList.toggle('alert', late);
    const text =
      need === Infinity ? 'Can’t stop on this descent' : late ? 'Brake now' : `Full brake: ${formatDist(need)}`;
    $('brake-text').textContent = text;
  }
}

function leverText(t: Train, lever: number) {
  if (t.emergency) return 'Emergency brake';
  const pct = Math.round(Math.abs(lever) * 100);
  if (pct === 0) return 'Coasting';
  return `${lever > 0 ? 'Power' : 'Brake'} ${pct}%`;
}

function formatDist(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
