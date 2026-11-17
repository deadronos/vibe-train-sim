// Ties the simulation, renderers, editor and interface together and runs the frame loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { SoundSettings } from './audio';
import { SimAudio } from './audio';
import { DriverInput } from './driverInput';
import { Editor } from './editor/editor';
import { History } from './history';
import type { MapEntry } from './mapLibrary';
import { browserStorage, MapLibrary } from './mapLibrary';
import type { Quality, Rules } from './persistence';
import {
  backupStoredSave,
  buildWorld,
  captureSave,
  downloadMap,
  readQuality,
  readRules,
  recordBest,
  readSound,
  readSave,
  restoreEdit,
  restoreTrains,
  SAVE_KEY,
  writeQuality,
  writeRules,
  writeSound,
  writeSave,
} from './persistence';
import { buildDemoNetwork, populateDemoTrains } from './rail/demoMap';
import { Duty } from './rail/duty';
import { Network } from './rail/network';
import type { Train } from './rail/sim';
import type { Car } from './rail/vehicles';

/** A train's stops with, for each, the times and whether it changes ends there. */
export interface Timetable {
  schedule: number[];
  times: (number | null)[];
  arrivals: (number | null)[];
  turns: boolean[];
}
import { Sim } from './rail/sim';
import { Assets } from './render/assets';
import { CameraRig } from './render/cameraRig';
import { Environment } from './render/environment';
import { PropsRenderer } from './render/props';
import { ScatterRenderer } from './render/scatter';
import { TerrainRenderer } from './render/terrain';
import { TrackRenderer } from './render/track';
import { TrainRenderer } from './render/trains';
import type { SaveData } from './saveData';
import { parseSave } from './saveData';
import { AssetLoadError, CONTEXT_LOST_TEXT, SAVE_RECOVERED_TEXT } from './startupError';
import { showFatal } from './ui/fatal';
import { Hud } from './ui/hud';
import type { Preset } from './world/heightfield';
import { Heightfield } from './world/heightfield';
import type { PlacedItem } from './world/scenery';

const TRAIN_SPEEDS = [0, 1, 2, 4, 8];
const AUTOSAVE_MS = 60_000;
const ADAPT_EVERY = 2; // s between auto quality checks
const AUTO_SLOW_FPS = 45;
const AUTO_FAST_FPS = 57;
const AUTO_MIN_SCALE = 0.55;
const BACKUP_KEPT_TEXT = 'Your previous map is kept in Maps, under Backups';
const BACKUP_FAILED_TEXT =
  'Your previous map could not be backed up because browser storage is full. Delete saved copies in Maps, or export maps you want to keep';

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(58, 1, 0.4, 20000);
  composer: EffectComposer;
  assets = new Assets();
  env!: Environment;
  hf!: Heightfield;
  net!: Network;
  sim!: Sim;
  terrain!: TerrainRenderer;
  track!: TrackRenderer;
  props!: PropsRenderer;
  scatter!: ScatterRenderer;
  trainsR!: TrainRenderer;
  rig: CameraRig;
  editor!: Editor;
  hud!: Hud;
  audio = new SimAudio();
  driven: Train | null = null;
  editing = false;
  quality: Quality = readQuality();
  private bloom: UnrealBloomPass;
  /** Resolution share auto quality has settled on, from AUTO_MIN_SCALE to 1. */
  autoScale = 1;
  private autoLow = false;
  private adaptTimer = 0;
  rules: Rules = readRules();
  /** How fast the railway runs: 0 is paused. */
  trainSpeed = 1;
  input = new DriverInput();
  readonly history = new History();
  private last = performance.now();
  private elapsed = 0;
  private scatterTimer = 0;
  private interlockTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  fps = 60;
  private focus = new THREE.Vector3();

  constructor() {
    this.audio.settings = readSound();
    const canvas = document.getElementById('view') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onContextLost();
    });
    this.renderer.info.autoReset = false; // The composer renders several passes; count them all
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.4, 3.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.rig = new CameraRig(this.camera, canvas, () => !this.editing);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  async start() {
    const loading = document.getElementById('loading')!;
    const bar = document.getElementById('loadbar') as HTMLElement;
    try {
      await this.assets.load(
        `${import.meta.env.BASE_URL}assets/assetpack.glb`,
        (f) => (bar.style.width = `${Math.round(f * 100)}%`),
      );
    } catch (err) {
      throw new AssetLoadError(err);
    }

    this.env = new Environment(this.scene, this.renderer, 4096);
    this.hud = new Hud(this);
    this.track = new TrackRenderer(this.scene, this.assets);
    this.props = new PropsRenderer(this.scene, this.assets);
    this.scatter = new ScatterRenderer(this.scene, this.assets);
    this.applyQuality(false);
    this.trainsR = new TrainRenderer(this.scene, this.assets);

    const { saved, recovered } = readSave();
    try {
      if (saved) this.applySave(saved, true);
      else this.newWorld('alpine', 1, true);
    } catch (err) {
      // Validation passed but the map still can't be built, so treat it like a corrupt save.
      console.error(err);
      backupStoredSave();
      this.newWorld('alpine', 1, true);
      this.hud.toast(SAVE_RECOVERED_TEXT, true);
    }

    this.editor = new Editor(this);
    this.hud.bind();
    this.input.bind(this);
    loading.classList.add('gone');
    if (recovered) this.hud.toast(SAVE_RECOVERED_TEXT, true);
    window.addEventListener('beforeunload', () => this.save(true));
    // beforeunload doesn't fire reliably on phones or when the browser crashes, so save at these moments too.
    window.addEventListener('pagehide', () => this.save(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save(true);
    });
    setInterval(() => {
      if (!this.lost) this.save(true);
    }, AUTOSAVE_MS);
    window.addEventListener('storage', (e) => {
      if (e.key !== SAVE_KEY || this.warnedOtherTab) return;
      this.warnedOtherTab = true;
      this.hud.toast(
        'This map is also open in another tab. Whichever tab saves last keeps its changes, so close one of them',
        true,
      );
    });
    requestAnimationFrame(() => this.frame());
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ world management
  private installWorld(hf: Heightfield, net: Network, placed: PlacedItem[]) {
    this.hf = hf;
    this.net = net;
    this.sim = new Sim(net);
    this.sim.strict = this.rules === 'strict';
    this.sim.onEvent = (e) => {
      if ((e.kind === 'protection' || (e.kind === 'spad' && this.sim.strict)) && e.train === this.driven?.id) {
        this.audio.playTrip();
      }
      this.hud.onSimEvent(e);
    };
    if (!this.terrain) this.terrain = new TerrainRenderer(this.scene, hf);
    else this.terrain.setField(hf);
    this.track.clear();
    this.trainsR.clear();
    this.scatter.placed = placed;
    net.dirty = new Set(net.segs.keys());
    hf.grade(net);
    this.terrain.sync();
    this.track.sync(net, hf);
    this.props.invalidate();
    this.props.sync(net);
    this.scatter.rebuild(hf, net);
    this.driven = null;
    this.history.clear();
    this.hud.syncUndo();
  }

  newWorld(preset: Preset, seed: number, starter: boolean) {
    const hf = new Heightfield(preset, seed);
    if (starter) {
      const { net, stations } = buildDemoNetwork(hf);
      this.installWorld(hf, net, []);
      populateDemoTrains(this.sim, stations);
      this.setDriven(this.sim.trains[0]);
      this.sim.interlock();
    } else {
      this.installWorld(hf, new Network(), []);
    }
    this.hud.syncTrains();
  }

  private snapshot(): SaveData {
    return captureSave({
      hf: this.hf,
      net: this.net,
      sim: this.sim,
      placed: this.scatter.placed,
      hours: this.env.hours,
      drivenId: this.driven?.id ?? null,
    });
  }

  applySave(data: SaveData, restoreTime: boolean) {
    // Build everything that can throw before the current world is replaced.
    const { hf, net } = buildWorld(data);
    this.installWorld(hf, net, [...data.placed]);
    this.driven = restoreTrains(this.sim, data);
    this.hud.syncTrains();
    if (restoreTime) this.env.hours = data.hours;
    if (!this.driven && this.sim.trains.length) this.setDriven(this.sim.trains[0]);
    if (this.driven && !this.driven.ai) this.beginDuty(this.driven);
  }

  save(silent = false) {
    try {
      writeSave(this.snapshot());
      if (!silent) this.hud.toast('Map saved in this browser');
    } catch {
      // Autosaves warn once, so a full storage doesn't fill the screen with toasts.
      if (silent && this.warnedSaveFailed) return;
      if (silent) this.warnedSaveFailed = true;
      this.hud.toast('Saving failed: browser storage is full or blocked. Export the map to a file instead', true);
    }
  }

  /** Replaces the map, first keeping the current one as a backup so nothing is lost without a way back. */
  private replaceMap(before: string, apply: () => void) {
    const backedUp = this.sim ? this.library.backup(`${this.mapLabel()}, before ${before}`, this.snapshot()) : true;
    apply();
    this.hud.toast(backedUp ? BACKUP_KEPT_TEXT : BACKUP_FAILED_TEXT, !backedUp);
    this.save(true);
  }

  /** Names a map by what's in it, since maps themselves have no names. */
  private mapLabel() {
    const land = { alpine: 'Alpine', plains: 'Plains', desert: 'Desert', islands: 'Islands' }[this.hf.preset];
    const n = this.sim.trains.length;
    return `${land} map with ${n === 0 ? 'no' : n} train${n === 1 ? '' : 's'}`;
  }

  startNewMap(preset: Preset, seed: number, starter: boolean) {
    this.replaceMap('a new map', () => this.newWorld(preset, seed, starter));
  }

  saveCopy(name: string) {
    const r = this.library.saveCopy(name, this.snapshot());
    this.hud.toast(r.ok ? `Saved a copy called ${name.trim() || 'Untitled map'}` : `Saving failed: ${r.reason}`, !r.ok);
    return r.ok;
  }

  loadMap(entry: MapEntry) {
    const r = this.library.load(entry);
    if (!r.ok) {
      this.hud.toast(`Can't load ${entry.name}: ${r.reason}`, true);
      return;
    }
    try {
      this.replaceMap(entry.kind === 'copy' ? `loading ${entry.name}` : 'loading a backup', () =>
        this.applySave(r.data, true),
      );
    } catch (err) {
      console.error(err);
      this.hud.toast(`Can't load ${entry.name}: the map could not be built`, true);
    }
  }

  exportMap() {
    downloadMap(this.snapshot());
  }

  importMap(text: string) {
    const r = parseSave(text);
    if (!r.ok) {
      this.hud.toast(`Import failed: ${r.reason}. The current map is unchanged`, true);
      return;
    }
    const before = JSON.stringify(this.snapshot());
    try {
      this.replaceMap('an import', () => this.applySave(r.data, true));
    } catch (err) {
      // Put the previous map back so a failed import never leaves a half-loaded one.
      console.error(err);
      const old = parseSave(before);
      if (old.ok) this.applySave(old.data, true);
      this.hud.toast('Import failed: the map could not be built. The current map is unchanged', true);
    }
  }

  private lost = false;
  private warnedSaveFailed = false;
  private warnedOtherTab = false;
  library = new MapLibrary(browserStorage());
  private onContextLost() {
    if (this.lost) return;
    this.lost = true;
    if (this.sim) this.save(true);
    showFatal(CONTEXT_LOST_TEXT, true);
  }

  setSound(change: Partial<SoundSettings>) {
    this.audio.set(change);
    writeSound(this.audio.settings);
    this.hud.syncSound();
  }

  setQuality(q: Quality) {
    writeQuality(q);
    this.quality = q;
    this.autoScale = 1;
    this.autoLow = false;
    this.applyQuality(true);
  }

  /** The effects in use: low under the low setting, or once auto has run out of resolution to give up. */
  private get lowEffects() {
    return this.quality === 'low' || (this.quality === 'auto' && this.autoLow);
  }

  /** Applies the quality setting to the running renderer, so nothing needs a reload. */
  private applyQuality(rebuildScenery: boolean) {
    const low = this.lowEffects;
    const cap = low ? 1 : 1.75;
    const scale = this.quality === 'auto' ? this.autoScale : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap) * scale);
    this.bloom.enabled = !low;
    const samples = low ? 0 : 4;
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples === samples) continue;
      t.samples = samples;
      t.dispose(); // Reallocated with the new sample count on the next render
    }
    this.env?.setShadowSize(low ? 2048 : 4096);
    this.scatter?.setDensity(low ? 0.4 : 1);
    if (rebuildScenery && this.hf) this.scatter.rebuild(this.hf, this.net);
    this.resize();
  }

  /**
   * Auto quality: every couple of seconds, lower the resolution while frames run slow, and raise it again when
   * there's room. At the lowest resolution it drops to low effects once.
   */
  private adaptQuality(dt: number) {
    if (this.quality !== 'auto' || document.hidden) return;
    this.adaptTimer += dt;
    if (this.adaptTimer < ADAPT_EVERY) return;
    this.adaptTimer = 0;
    const before = this.autoScale;
    if (this.fps < AUTO_SLOW_FPS) {
      if (this.autoScale > AUTO_MIN_SCALE) this.autoScale = Math.max(AUTO_MIN_SCALE, this.autoScale * 0.85);
      else if (!this.autoLow) {
        this.autoLow = true;
        this.autoScale = 1;
        this.applyQuality(true);
        return;
      }
    } else if (this.fps > AUTO_FAST_FPS && this.autoScale < 1) {
      this.autoScale = Math.min(1, this.autoScale * 1.1);
    }
    if (this.autoScale !== before) this.applyQuality(false);
  }

  // ------------------------------------------------------------ editing
  pushUndo() {
    this.history.push(JSON.stringify(this.snapshot()));
    this.hud.syncUndo();
  }

  /** Puts the map back as it was at the last pushUndo, leaving nothing to redo. For an edit that was refused. */
  abandonEdit() {
    const s = this.history.discard();
    if (s !== null) this.restoreSnapshot(s);
    this.hud.syncUndo();
  }

  private restoreSnapshot(json: string) {
    const d = JSON.parse(json) as SaveData;
    const onEvent = this.sim.onEvent;
    const duties = new Map(this.sim.trains.map((t) => [t.id, t.duty]));
    const { net, sim, driven } = restoreEdit(this.hf, d);
    this.net = net;
    this.sim = sim;
    this.sim.onEvent = onEvent;
    this.sim.strict = this.rules === 'strict';
    for (const t of sim.trains) t.duty = duties.get(t.id) ?? null;
    this.driven = driven;
    this.track.clear();
    net.dirty = new Set(net.segs.keys());
    this.scatter.placed = [...d.placed];
    this.props.invalidate();
    this.scatterTimer = 0.01;
    this.editor.selected = null;
    this.hud.syncTrains();
    this.hud.syncEditor();
  }

  undo() {
    const s = this.history.undo(JSON.stringify(this.snapshot()));
    if (s !== null) this.restoreSnapshot(s);
    this.hud.syncUndo();
  }

  redo() {
    const s = this.history.redo(JSON.stringify(this.snapshot()));
    if (s !== null) this.restoreSnapshot(s);
    this.hud.syncUndo();
  }

  /** Call after any change to the map. Keeps terrain and trains consistent with the new track. */
  commitEdit(opts: { scenery?: boolean } = {}) {
    this.hf.grade(this.net);
    for (const t of this.sim.syncTrack()) this.removeTrain(t);
    if (opts.scenery) this.scatterTimer = 0.25;
    this.hud.syncTrains();
  }

  /** Starts scoring the player's run on a train. */
  private beginDuty(t: Train) {
    t.duty = new Duty();
    this.sim.startLeg(t);
  }

  /** Ends the player's run on a train and shows how it went, if anything happened. */
  private endDuty(t: Train) {
    const d = t.duty;
    t.duty = null;
    if (!d || (!d.stops && !d.lines.length)) return;
    d.overspeed(0, 0, Infinity); // Closes a spell over the limit that was still going
    const best = recordBest(`${this.hf.preset}-${this.hf.seed}`, d.total);
    this.hud.showDuty(t.name, d, best);
  }

  /** Sets a train's stops and departure times, and sends it to the first stop of the new timetable. */
  setTimetable(t: Train, tt: Timetable) {
    t.schedule = tt.schedule;
    t.times = tt.times;
    t.arrivals = tt.arrivals;
    t.turns = tt.turns;
    t.schedIdx = 0;
    // A train standing at a platform finishes its stop; one on the move heads for the new first stop.
    if (t.dwell <= 0) {
      t.stopRemain = -1;
      this.sim.plan(t, false);
      if (!t.ai) this.sim.startLeg(t);
    }
    this.save(true);
  }

  /** Changes a train's vehicles. Returns why it can't, or null once done. */
  setConsist(t: Train, cars: Car[]) {
    const why = this.sim.setConsist(t, cars);
    if (!why) {
      this.hud.syncTrains();
      this.save(true);
    }
    return why;
  }

  setRules(r: Rules) {
    this.rules = r;
    writeRules(r);
    this.sim.strict = r === 'strict';
    for (const t of this.sim.trains) {
      t.tripped = false;
      t.spadTripped = false;
      t.warning = null;
    }
  }

  acknowledgeWarning() {
    const t = this.driven;
    if (!t || t.ai) return;
    const wasTripped = t.tripped;
    this.sim.acknowledge(t);
    if (wasTripped && !t.tripped) this.hud.toast('Train protection reset');
  }

  recoverDriven() {
    const t = this.driven;
    if (!t?.damaged) return;
    this.sim.recover(t);
    this.hud.toast(t.lastStop ? `${t.name} is back at its last stop` : `${t.name} is back on the line`);
  }

  removeTrain(t: Train) {
    this.sim.trains = this.sim.trains.filter((x) => x !== t);
    if (this.driven === t) this.driven = this.sim.trains[0] ?? null;
    if (this.driven) this.driven.ai = this.hud?.autopilot ? true : this.driven.ai;
    this.hud.syncTrains();
  }

  setMode(editing: boolean) {
    if (editing === this.editing) return;
    this.editing = editing;
    document.body.dataset.mode = editing ? 'edit' : 'drive';
    this.audio.horn(false);
    if (editing) this.editor.enter();
    else {
      this.editor.leave();
      this.save(true);
    }
    this.hud.syncMode();
  }

  // ------------------------------------------------------------ driving
  setDriven(t: Train | null) {
    if (this.driven && this.driven !== t && !this.driven.ai) {
      this.driven.ai = true;
      this.endDuty(this.driven);
      this.sim.plan(this.driven, false);
    }
    this.driven = t;
    this.input.lever = 0;
    this.hud?.syncTrains();
  }

  setAutopilot(on: boolean) {
    const t = this.driven;
    if (!t) return;
    t.ai = on;
    if (on) {
      this.endDuty(t);
      this.sim.plan(t, false);
    } else {
      this.beginDuty(t);
      t.throttle = 0;
      this.input.lever = t.speed > 0.2 ? 0 : -0.5;
      t.dwell = 0;
      t.stopRemain = -1;
    }
    this.hud.syncDrive();
  }

  throwNextSwitch() {
    const t = this.driven;
    if (!t) return;
    const j = this.sim.nextJunction(t);
    if (!j) {
      this.hud.toast('No junction ahead within 800 m');
      return;
    }
    if (this.sim.switchLocked(j.node) && this.sim.nodeClaims.get(j.node) !== t.id) {
      this.hud.toast('Those points are locked by another train');
      return;
    }
    if (t.grants.length && this.sim.nodeClaims.get(j.node) === t.id && j.dist < 60) {
      this.hud.toast('Too close to throw the points');
      return;
    }
    this.net.throwSwitch(j.node, j.side);
    t.grants = [];
    this.hud.toast('Points thrown');
  }

  nextTrain() {
    const list = this.sim.trains;
    if (!list.length) return;
    const i = this.driven ? list.indexOf(this.driven) : -1;
    this.setDriven(list[(i + 1) % list.length]);
  }

  reverseDriven() {
    const t = this.driven;
    if (!t) return;
    if (t.speed > 0.3) {
      this.hud.toast('Stop the train before changing direction');
      return;
    }
    this.sim.reverse(t);
    this.hud.toast('Direction changed: driving from the other end');
  }

  private driveInput(dt: number) {
    const t = this.driven;
    if (!t) return;
    if (t.ai && this.input.movingLever) {
      // Touching the controls takes over from the autopilot.
      this.setAutopilot(false);
      this.hud.toast('Autopilot off: you are driving');
    }
    if (!t.ai) this.input.drive(t, dt);
  }

  setTrainSpeed(speed: number) {
    this.trainSpeed = speed;
    this.hud.syncTrainSpeed();
  }

  /** Steps through the train speeds from the keyboard. */
  changeTrainSpeed(by: 1 | -1) {
    const i = TRAIN_SPEEDS.indexOf(this.trainSpeed);
    this.setTrainSpeed(TRAIN_SPEEDS[Math.max(0, Math.min(TRAIN_SPEEDS.length - 1, i + by))]);
  }

  setLever(v: number) {
    if (this.driven?.ai) this.setAutopilot(false);
    this.input.lever = v;
  }

  // ------------------------------------------------------------ frame
  private frame() {
    if (this.lost) return;
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.elapsed += dt;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    if (!this.editing && this.trainSpeed > 0) this.driveInput(dt);
    this.sim.clock = this.env.hours * 3600;
    if (!this.editing || this.editor.runTrains) {
      this.sim.update(dt * this.trainSpeed);
    } else {
      this.interlockTimer += dt;
      if (this.interlockTimer > 0.3) {
        this.interlockTimer = 0;
        this.sim.interlock();
      }
    }

    this.terrain.sync();
    this.track.sync(this.net, this.hf);
    this.props.sync(this.net);
    if (this.scatterTimer > 0) {
      this.scatterTimer -= dt;
      if (this.scatterTimer <= 0) this.scatter.rebuild(this.hf, this.net);
    }
    this.trainsR.sync(this.sim);

    if (this.editing) {
      this.editor.update(dt);
      this.focus.copy(this.editor.controls.target);
    } else if (this.driven) {
      this.rig.update(this.sim, this.driven, this.hf, dt);
      const h = this.sim.head(this.driven);
      this.focus.set(h.x, h.y, h.z);
    }
    this.env.update(dt, this.focus, this.trainSpeed);
    this.assets.setNight(this.env.night);
    this.props.update(this.sim, this.camera, this.env.night);
    this.trainsR.updateHeadlight(this.sim, this.driven, this.env.night);
    this.terrain.update(this.elapsed);

    const t = this.driven;
    if (t) {
      const h = this.sim.head(t);
      const d = this.camera.position.distanceTo(this.focus.set(h.x, h.y, h.z));
      const quiet = this.editing || this.trainSpeed === 0;
      this.audio.update(dt, t.speed, t.throttle, quiet ? 0 : Math.max(0.05, 1 - d / 500));
      this.audio.updateWarning(dt, !quiet && !t.ai && !!t.warning && !t.warning.acknowledged);
    } else {
      this.audio.update(dt, 0, 0, 0);
      this.audio.updateWarning(dt, false);
    }
    this.hud.update();
    this.renderer.info.reset();
    this.composer.render();
    this.hud.perf.update(this.renderer.info, dt);
    this.adaptQuality(dt);
  }
}
