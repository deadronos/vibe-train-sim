// Ties the simulation, renderers, editor and interface together and runs the frame loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { NearbyTrainSound, SoundSettings, TrainAudioInput } from './audio';
import { dopplerPitch, NEARBY_TRAIN_RANGE, SimAudio } from './audio';
import { DriverInput } from './driverInput';
import { Editor } from './editor/editor';
import { History } from './history';
import type { MapEntry } from './mapLibrary';
import { browserStorage, MapLibrary } from './mapLibrary';
import type { Quality, Rules, ScenerySetting, ShadowSetting } from './persistence';
import {
  backupStoredSave,
  buildWorld,
  captureSave,
  downloadMap,
  readQuality,
  readRules,
  readScenery,
  readShadows,
  recordBest,
  readSound,
  readSave,
  restoreEdit,
  restoreTrains,
  SAVE_KEY,
  writeQuality,
  writeRules,
  writeScenery,
  writeShadows,
  writeSound,
  writeSave,
} from './persistence';
import { buildDemoNetwork, populateDemoTrains } from './rail/demoMap';
import { Duty } from './rail/duty';
import type { Dir } from './rail/network';
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
import { collectJunctionDists, GAP, Sim, tractiveLoad } from './rail/sim';
import { VEHICLES } from './rail/vehicles';
import { Assets } from './render/assets';
import { CameraRig, prefersReducedMotion } from './render/cameraRig';
import { Environment } from './render/environment';
import { ParticleRenderer } from './render/particles';
import { PropsRenderer } from './render/props';
import { ScatterRenderer } from './render/scatter';
import { TerrainRenderer } from './render/terrain';
import { TrackRenderer } from './render/track';
import type { TrainRenderOpts } from './render/trains';
import { TrainRenderer } from './render/trains';
import type { SaveData } from './saveData';
import { parseSave } from './saveData';
import { AssetLoadError, CONTEXT_LOST_TEXT, SAVE_RECOVERED_TEXT } from './startupError';
import { showFatal } from './ui/fatal';
import { Hud } from './ui/hud';
import type { Preset } from './world/heightfield';
import { Heightfield, riverCenter, WORLD_SIZE } from './world/heightfield';
import type { PlacedItem, SceneryExclusion } from './world/scenery';

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
  camera = new THREE.PerspectiveCamera(58, 1, 0.8, 10000);
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
  particles!: ParticleRenderer;
  rig: CameraRig;
  editor!: Editor;
  hud!: Hud;
  audio = new SimAudio();
  driven: Train | null = null;
  editing = false;
  quality: Quality = readQuality();
  shadows: ShadowSetting = readShadows();
  scenery: ScenerySetting = readScenery();
  private appliedSceneryDensity = -1;
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
  private tmpAudioFocus = new THREE.Vector3();
  private lastListener = new THREE.Vector3();
  private listenerVelocity = new THREE.Vector3();
  private listenerForward = new THREE.Vector3();
  private listenerUp = new THREE.Vector3();
  private sourceVelocity = new THREE.Vector3();
  private nearbyTrainSounds: NearbyTrainSound[] = [];
  private tmpJunctionDists: number[] = [];
  private tmpBogieOffsets: number[] = [];
  private trainDwelling = new Set<number>();
  private lastSignalAhead = { train: -1, key: '', aspect: '' };
  private tmpTrainOpts: TrainRenderOpts = {};
  private tmpAudioInput: TrainAudioInput = {
    speed: 0,
    throttle: 0,
    powerLoad: 0,
    airBrake: 0,
    brakeDemand: 0,
    dynamic: 0,
    emergency: false,
    minRadius: Infinity,
    onBridge: false,
    nearby: 0,
    cab: false,
  };

  constructor() {
    this.audio.settings = readSound();
    const canvas = document.getElementById('view') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
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
        `${import.meta.env.BASE_URL}assets/assetpack.glb?v=${__ASSETPACK_HASH__}`,
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
    this.particles = new ParticleRenderer(this.scene);
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
  private installWorld(hf: Heightfield, net: Network, placed: PlacedItem[], exclusions: SceneryExclusion[] = []) {
    this.hf = hf;
    this.net = net;
    this.sim = new Sim(net);
    this.sim.strict = this.rules === 'strict';
    this.sim.onEvent = (e) => {
      if ((e.kind === 'protection' || (e.kind === 'spad' && this.sim.strict)) && e.train === this.driven?.id) {
        this.audio.playTrip();
      }
      if (e.kind === 'collision' || e.kind === 'buffer' || e.kind === 'damage') {
        const tr = this.sim.trains.find((x) => x.id === e.train);
        if (tr) {
          const h = this.sim.head(tr);
          const d = this.camera.position.distanceTo(this.tmpAudioFocus.set(h.x, h.y, h.z));
          const nearby = Math.max(0, 1 - d / 500);
          const spd = Math.max(8, tr.speed);
          this.particles.emitBurst(h.x, h.y, h.z, spd, this.env.night);
          if (!this.editing && this.trainSpeed > 0 && nearby > 0.01) {
            this.audio.playImpact(e.kind === 'buffer' ? 'buffer' : 'collision', spd, nearby);
          }
        }
      }
      if (
        (e.kind === 'stop' || e.kind === 'arrive' || e.kind === 'depart') &&
        this.trainSpeed > 0 &&
        this.trainSpeed <= 2 &&
        (!this.editing || this.editor?.runTrains)
      ) {
        const tr = this.sim.trains.find((x) => x.id === e.train);
        if (tr) {
          const h = this.sim.head(tr);
          const d = this.camera.position.distanceTo(this.tmpAudioFocus.set(h.x, h.y, h.z));
          const nearby = Math.max(0, 1 - d / 260);
          if (nearby > 0.01) this.audio.playDoorChime(e.kind === 'depart' ? 'close' : 'open', nearby);
        }
      }
      this.hud.onSimEvent(e);
    };
    if (!this.terrain) this.terrain = new TerrainRenderer(this.scene, hf);
    else this.terrain.setField(hf);
    this.track.clear();
    this.trainsR.clear();
    this.particles.clear();
    this.audio.resetTrainTracking(0, 0, 0);
    this.trainDwelling.clear();
    this.lastSignalAhead.train = -1;
    this.scatter.placed = placed;
    this.scatter.exclusions = exclusions;
    net.dirty = new Set(net.segs.keys());
    hf.grade(net);
    this.terrain.sync();
    this.track.sync(net, hf);
    this.props.invalidate();
    this.props.sync(net);
    this.scatter.rebuild(hf, net);
    net.dirtyBounds = null;
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
      exclusions: this.scatter.exclusions,
      hours: this.env.hours,
      drivenId: this.driven?.id ?? null,
    });
  }

  private syncAudioTracking() {
    this.trainDwelling.clear();
    for (const t of this.sim.trains) {
      if (t.dwell > 0) this.trainDwelling.add(t.id);
    }
    this.lastSignalAhead.train = -1;
  }

  applySave(data: SaveData, restoreTime: boolean) {
    // Build everything that can throw before the current world is replaced.
    const { hf, net } = buildWorld(data);
    this.installWorld(hf, net, [...data.placed], [...(data.exclusions ?? [])]);
    this.driven = restoreTrains(this.sim, data);
    this.syncAudioTracking();
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

  setShadows(s: ShadowSetting) {
    writeShadows(s);
    this.shadows = s;
    this.applyQuality(false);
  }

  setScenery(s: ScenerySetting) {
    writeScenery(s);
    this.scenery = s;
    this.applyQuality(true);
  }

  /** The effects in use: low under the low setting, or once auto has run out of resolution to give up. */
  private get lowEffects() {
    return this.quality === 'low' || (this.quality === 'auto' && this.autoLow);
  }

  /** Applies the quality, shadow and scenery settings to the running renderer without reloading. */
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
    const shadowMode = this.shadows === 'auto' ? (low ? 'low' : 'high') : this.shadows;
    const shadowSize = shadowMode === 'off' ? 0 : shadowMode === 'low' ? 2048 : 4096;
    this.env?.setShadowSize(shadowSize);

    const sceneryMode = this.scenery === 'auto' ? (low ? 'low' : 'high') : this.scenery;
    const density = sceneryMode === 'off' ? 0 : sceneryMode === 'low' ? 0.4 : 1;
    const densityChanged = density !== this.appliedSceneryDensity;
    this.appliedSceneryDensity = density;
    this.scatter?.setDensity(density);
    this.particles?.setEnabled(!low);
    if (rebuildScenery && densityChanged && this.hf) this.scatter.rebuild(this.hf, this.net);
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
    this.syncAudioTracking();
    this.track.clear();
    this.particles.clear();
    net.dirty = new Set(net.segs.keys());
    this.scatter.placed = [...d.placed];
    this.scatter.exclusions = [...(d.exclusions ?? [])];
    this.scatter.markAllDirty();
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
  commitEdit(opts: { scenery?: boolean; bounds?: { minX: number; minZ: number; maxX: number; maxZ: number } } = {}) {
    this.hf.grade(this.net);
    for (const t of this.sim.syncTrack()) this.removeTrain(t);
    if (this.net.dirtyBounds) {
      const b = this.net.dirtyBounds;
      this.scatter.markBoundsDirty(b.minX - 40, b.minZ - 40, b.maxX + 40, b.maxZ + 40, true);
      this.net.dirtyBounds = null;
    }
    if (opts.bounds) {
      const b = opts.bounds;
      this.scatter.markBoundsDirty(b.minX, b.minZ, b.maxX, b.maxZ, true);
    }
    if (opts.scenery) this.scatterTimer = 0.25;
    this.hud.syncTrains();
  }

  get placedScenery(): readonly PlacedItem[] {
    return this.scatter.placed;
  }

  get generatedScenery(): readonly PlacedItem[] {
    return this.scatter.generated;
  }

  addPlacedScenery(item: PlacedItem) {
    this.scatter.placed.push(item);
    this.scatter.markPlacedDirty(item.x, item.z);
  }

  placedSceneryNear(x: number, z: number, radius: number) {
    return this.scatter.placedNear(x, z, radius);
  }

  removePlacedScenery(index: number) {
    const [removed] = this.scatter.placed.splice(index, 1);
    if (removed) this.scatter.markPlacedDirty(removed.x, removed.z);
  }

  generatedSceneryNear(x: number, z: number, radius: number) {
    return this.scatter.generatedNear(x, z, radius);
  }

  addSceneryExclusion(ex: SceneryExclusion) {
    this.scatter.exclusions.push(ex);
    this.scatter.markExclusionDirty(ex);
  }

  /** Adds and places a train on track; returns any existing train blocking it if there is no room. */
  addTrain(train: Train, seg: number, s: number, dir: Dir): Train | null {
    this.sim.trains.push(train);
    this.sim.place(train, seg, s, dir);
    return this.sim.touching(train);
  }

  toast(text: string, warn = false) {
    this.hud.toast(text, warn);
  }

  playLeverSound(kind: 'points' | 'signal') {
    this.audio.playLeverClunk(kind);
  }

  syncEditor() {
    this.hud.syncEditor();
  }

  syncTrains() {
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
    this.rig.releaseKeys();
    if (editing) this.editor.enter();
    else {
      this.editor.leave();
      this.rig.beginTransition();
      this.save(true);
    }
    this.hud.syncMode();
  }

  // ------------------------------------------------------------ driving
  setDriven(t: Train | null) {
    const changed = this.driven !== t && this.driven !== null && t !== null;
    if (this.driven && this.driven !== t && !this.driven.ai) {
      this.driven.ai = true;
      this.endDuty(this.driven);
      this.sim.plan(this.driven, false);
    }
    this.driven = t;
    this.input.lever = 0;
    if (t) this.audio.resetTrainTracking(t.speed, t.airBrake, t.odometer);
    if (changed && !this.editing && this.rig.mode !== 'free') this.rig.beginTransition();
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
    this.audio.playLeverClunk('points');
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
    const simDt = !this.editing || this.editor.runTrains ? dt * this.trainSpeed : 0;
    if (simDt > 0) {
      this.sim.update(simDt);
    } else {
      this.interlockTimer += dt;
      if (this.interlockTimer > 0.3) {
        this.interlockTimer = 0;
        this.sim.interlock();
      }
    }

    this.terrain.sync();
    this.track.sync(this.net, this.hf);
    this.track.update(this.net, dt);
    this.props.sync(this.net);
    if (this.scatterTimer > 0) {
      this.scatterTimer -= dt;
      if (this.scatterTimer <= 0) this.scatter.sync(this.hf, this.net);
    }

    if (this.editing) {
      this.editor.update(dt);
      this.focus.copy(this.editor.controls.target);
    } else if (this.driven || this.rig.mode === 'free') {
      this.rig.update(this.sim, this.driven, this.hf, dt);
      this.focus.copy(this.rig.focus);
    }
    this.tmpTrainOpts.cameraPos = this.camera.position;
    this.tmpTrainOpts.driven = this.driven;
    this.tmpTrainOpts.cabActive = !this.editing && this.rig.cabInteriorActive;
    this.tmpTrainOpts.cabLever = this.input.lever;
    this.tmpTrainOpts.night = this.env.night;
    this.tmpTrainOpts.reducedMotion = prefersReducedMotion();
    this.trainsR.sync(this.sim, this.tmpTrainOpts);
    this.env.update(dt, this.focus, this.trainSpeed);
    const shadowFrustum = this.env.sun.castShadow && this.renderer.shadowMap.enabled ? this.env.shadowFrustum : null;
    this.terrain.updateLOD(this.camera.position, shadowFrustum);
    this.scatter.updateLOD(this.camera.position, shadowFrustum, this.focus);
    this.assets.setNight(this.env.night);
    this.props.update(this.sim, this.camera, this.env.night);
    this.trainsR.updateHeadlight(this.sim, this.driven, this.env.night, this.camera.position);
    this.particles.update(this.sim, this.hf, dt, simDt, this.env.night);
    this.terrain.update(this.elapsed);

    this.updateAudio(dt, simDt > 0);
    this.hud.update();
    this.renderer.info.reset();
    this.composer.render();
    this.hud.perf.update(this.renderer.info, dt);
    this.adaptQuality(dt);
  }

  private trainSoundPitch(position: ReturnType<Sim['drawn']>, speed: number) {
    const signedSpeed = position.dir * speed * this.trainSpeed;
    this.sourceVelocity.set(position.tx, position.ty, position.tz).multiplyScalar(signedSpeed);
    return dopplerPitch(position, this.sourceVelocity, this.camera.position, this.listenerVelocity);
  }

  private updateAudio(dt: number, trainsRunning: boolean) {
    const listener = this.camera.position;
    this.listenerVelocity.subVectors(listener, this.lastListener).multiplyScalar(dt > 0 ? 1 / dt : 0);
    this.lastListener.copy(listener);
    // Camera cuts and large zoom jumps are changes of viewpoint, with no physical listener velocity.
    if (this.listenerVelocity.lengthSq() > 100 ** 2) this.listenerVelocity.set(0, 0, 0);

    const driven = this.editing ? null : this.driven;
    if (!this.audio.running) {
      if (driven) this.audio.resetTrainTracking(driven.speed, driven.airBrake, driven.odometer);
      return;
    }
    const cab = !!driven && this.rig.cabInteriorActive;
    const drivenPose = driven && this.sim.drawn(driven, VEHICLES[driven.cars[0].type].length / 2);
    this.nearbyTrainSounds.length = 0;
    if (trainsRunning && !this.audio.muted) {
      for (const train of this.sim.trains) {
        if (train === driven) continue;
        const position = this.sim.drawn(train, VEHICLES[train.cars[0].type].length / 2);
        const distance = Math.hypot(position.x - listener.x, position.y - listener.y, position.z - listener.z);
        if (distance >= NEARBY_TRAIN_RANGE) continue;
        this.nearbyTrainSounds.push({
          train,
          position,
          distance,
          pitch: this.trainSoundPitch(position, train.speed),
          speed: train.speed,
          throttle: train.throttle,
          powerLoad: tractiveLoad(train),
        });
      }
      this.nearbyTrainSounds.sort((a, b) => a.distance - b.distance);
    }
    this.listenerForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.listenerUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.updateSpatial(
      listener,
      this.listenerForward,
      this.listenerUp,
      !cab && drivenPose ? drivenPose : listener,
      this.nearbyTrainSounds,
    );

    const pitch = !cab && driven && drivenPose ? this.trainSoundPitch(drivenPose, driven.speed) : 1;
    this.updateDrivenAudio(driven, trainsRunning, cab, pitch);
    this.updateWorldAudio(listener, driven, trainsRunning, cab, dt);
    this.audio.updateWarning(
      dt,
      trainsRunning && !!driven && !driven.ai && !!driven.warning && !driven.warning.acknowledged,
    );
  }

  private updateWorldAudio(
    listener: THREE.Vector3,
    driven: Train | null,
    trainsRunning: boolean,
    cab: boolean,
    dt: number,
  ) {
    const groundY = this.hf.height(listener.x, listener.z);
    const nearWaterY = Math.min(
      groundY,
      this.hf.height(listener.x + 24, listener.z),
      this.hf.height(listener.x - 24, listener.z),
      this.hf.height(listener.x, listener.z + 24),
      this.hf.height(listener.x, listener.z - 24),
    );
    const inWorld = Math.abs(listener.x) <= WORLD_SIZE / 2 && Math.abs(listener.z) <= WORLD_SIZE / 2;
    const riverDist = inWorld ? Math.abs(listener.z - riverCenter(listener.x)) : Infinity;
    this.audio.updateAmbience(
      {
        preset: this.hf.preset,
        cameraY: listener.y,
        groundY,
        nearWaterY,
        riverDist,
        night: this.env.night,
        cab,
      },
      dt,
    );

    // AI trains do not emit a 'depart' SimEvent, so watch dwell transitions for their closing door chime.
    for (const tr of this.sim.trains) {
      const dwelling = tr.dwell > 0;
      const was = this.trainDwelling.has(tr.id);
      if (dwelling) {
        this.trainDwelling.add(tr.id);
      } else if (was) {
        this.trainDwelling.delete(tr.id);
        if (tr.ai && trainsRunning && this.trainSpeed <= 2) {
          const h = this.sim.head(tr);
          const d = listener.distanceTo(this.tmpAudioFocus.set(h.x, h.y, h.z));
          const nearby = Math.max(0, 1 - d / 260);
          if (nearby > 0.01) this.audio.playDoorChime('close', nearby);
        }
      }
    }

    if (!driven) {
      this.lastSignalAhead.train = -1;
      return;
    }
    const sig = this.sim.signalAhead(driven);
    const key = sig ? `${sig.node}:${sig.side}` : '';
    const aspect = sig ? sig.aspect : '';
    if (
      trainsRunning &&
      this.lastSignalAhead.train === driven.id &&
      key &&
      key === this.lastSignalAhead.key &&
      aspect !== this.lastSignalAhead.aspect &&
      sig!.dist < 600
    ) {
      this.audio.playLeverClunk('signal', 0.55);
    }
    this.lastSignalAhead.train = driven.id;
    this.lastSignalAhead.key = key;
    this.lastSignalAhead.aspect = aspect;
  }

  private updateDrivenAudio(t: Train | null, trainsRunning: boolean, cab: boolean, pitch: number) {
    if (t) {
      const h = this.sim.head(t);
      const d = this.camera.position.distanceTo(this.tmpAudioFocus.set(h.x, h.y, h.z));
      const nearby = trainsRunning ? Math.max(0, 1 - d / 500) : 0;
      let minRadius = Infinity;
      for (let i = 0; i < t.trail.length; i++) {
        const g = this.net.geom.get(t.trail[i].seg);
        if (g && g.minRadius < minRadius) minRadius = g.minRadius;
      }
      const headSeg = this.net.segs.get(h.seg);
      const onBridge = headSeg ? this.hf.isBridgeSample(headSeg, h.x, h.y, h.z) : false;
      collectJunctionDists(this.net, t, this.tmpJunctionDists);
      this.tmpBogieOffsets.length = 0;
      let off = 0;
      for (let i = 0; i < t.cars.length; i++) {
        const len = VEHICLES[t.cars[i].type].length;
        this.tmpBogieOffsets.push(off + len * 0.18, off + len * 0.82);
        off += len + GAP;
      }
      this.tmpAudioInput.speed = t.speed;
      this.tmpAudioInput.throttle = t.throttle;
      this.tmpAudioInput.powerLoad = tractiveLoad(t);
      this.tmpAudioInput.airBrake = t.airBrake;
      this.tmpAudioInput.brakeDemand = t.emergency ? 1.5 : t.brake;
      this.tmpAudioInput.dynamic = t.dynamic;
      this.tmpAudioInput.emergency = t.emergency;
      this.tmpAudioInput.minRadius = minRadius;
      this.tmpAudioInput.onBridge = onBridge;
      this.tmpAudioInput.nearby = nearby;
      this.tmpAudioInput.cab = cab;
      this.audio.update(this.tmpAudioInput, t.odometer, this.tmpJunctionDists, this.tmpBogieOffsets, pitch);
    } else {
      this.tmpAudioInput.speed = 0;
      this.tmpAudioInput.throttle = 0;
      this.tmpAudioInput.powerLoad = 0;
      this.tmpAudioInput.airBrake = 0;
      this.tmpAudioInput.brakeDemand = 0;
      this.tmpAudioInput.dynamic = 0;
      this.tmpAudioInput.emergency = false;
      this.tmpAudioInput.minRadius = Infinity;
      this.tmpAudioInput.onBridge = false;
      this.tmpAudioInput.nearby = 0;
      this.tmpAudioInput.cab = false;
      this.tmpJunctionDists.length = 0;
      this.tmpBogieOffsets.length = 0;
      this.audio.update(this.tmpAudioInput, 0, this.tmpJunctionDists, this.tmpBogieOffsets);
    }
  }
}
