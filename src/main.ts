// Ties the simulation, renderers, editor and interface together and runs the frame loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import './ui/style.css';
import { SimAudio } from './audio';
import { Editor } from './editor/editor';
import { buildDemoNetwork, populateDemoTrains } from './rail/demoMap';
import { Network } from './rail/network';
import { Sim, Train } from './rail/sim';
import { Assets } from './render/assets';
import { CameraRig } from './render/cameraRig';
import { Environment } from './render/environment';
import { PropsRenderer } from './render/props';
import type { PlacedItem } from './render/scatter';
import { ScatterRenderer } from './render/scatter';
import { TerrainRenderer } from './render/terrain';
import { TrackRenderer } from './render/track';
import { TrainRenderer } from './render/trains';
import type { SaveData } from './saveData';
import { parseSave } from './saveData';
import {
  AssetLoadError,
  CONTEXT_LOST_TEXT,
  describeStartupError,
  NoWebGLError,
  SAVE_RECOVERED_TEXT,
} from './startupError';
import { Hud } from './ui/hud';
import type { Preset } from './world/heightfield';
import { Heightfield } from './world/heightfield';

export type Quality = 'high' | 'low';
const SAVE_KEY = 'vibe-train-sim/map-v1';
// A save that fails validation is moved here so nothing the player made is thrown away.
const BACKUP_KEY = 'vibe-train-sim/map-v1-backup';
const QUALITY_KEY = 'vibe-train-sim/quality';

function readQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'high';
  } catch {
    return 'high';
  }
}

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
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private last = performance.now();
  private elapsed = 0;
  private lever = 0;
  private keys = new Set<string>();
  private scatterTimer = 0;
  private interlockTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  fps = 60;
  private focus = new THREE.Vector3();

  constructor() {
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality === 'high' ? 1.75 : 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.quality === 'high' ? 4 : 0,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (this.quality === 'high') this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.4, 3.2));
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

    this.env = new Environment(this.scene, this.renderer, this.quality === 'high' ? 4096 : 2048);
    this.hud = new Hud(this);
    this.track = new TrackRenderer(this.scene, this.assets);
    this.props = new PropsRenderer(this.scene, this.assets);
    this.scatter = new ScatterRenderer(this.scene, this.assets);
    this.scatter.setDensity(this.quality === 'high' ? 1 : 0.4);
    this.trainsR = new TrainRenderer(this.scene, this.assets);

    const { saved, recovered } = this.readSave();
    try {
      if (saved) this.applySave(saved, true);
      else this.newWorld('alpine', 1, true);
    } catch (err) {
      // Validation passed but the map still can't be built, so treat it like a corrupt save.
      console.error(err);
      this.keepBackup(localStorage.getItem(SAVE_KEY));
      this.newWorld('alpine', 1, true);
      this.hud.toast(SAVE_RECOVERED_TEXT, true);
    }

    this.editor = new Editor(this);
    this.hud.bind();
    this.bindDriveKeys();
    loading.classList.add('gone');
    if (recovered) this.hud.toast(SAVE_RECOVERED_TEXT, true);
    window.addEventListener('beforeunload', () => this.save(true));
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
    this.sim.onEvent = (e) => this.hud.onSimEvent(e);
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
    this.undoStack = [];
    this.redoStack = [];
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
    const trains = this.sim.trains.map((t) => {
      const h = this.sim.head(t);
      return {
        id: t.id,
        name: t.name,
        cars: t.cars,
        schedule: t.schedule,
        schedIdx: t.schedIdx,
        ai: t.ai,
        x: h.x,
        z: h.z,
        hx: h.tx * h.dir,
        hz: h.tz * h.dir,
      };
    });
    return {
      v: 1,
      preset: this.hf.preset,
      seed: this.hf.seed,
      edits: this.hf.exportEdits(),
      net: this.net.toJSON(),
      placed: this.scatter.placed,
      hours: this.env.hours,
      drivenId: this.driven?.id ?? null,
      trains,
    };
  }

  private restoreTrains(data: SaveData) {
    for (const j of data.trains) {
      const t = new Train(j.id, j.name, j.cars);
      t.schedule = j.schedule;
      t.schedIdx = j.schedIdx;
      t.ai = j.ai;
      this.sim.trains.push(t);
      if (this.sim.replace(t, j.x, j.z, j.hx, j.hz)) this.sim.plan(t, false);
      else this.sim.trains.pop();
    }
    const d = this.sim.trains.find((t) => t.id === data.drivenId) ?? null;
    this.driven = d;
    this.hud.syncTrains();
  }

  applySave(data: SaveData, restoreTime: boolean) {
    // Build everything that can throw before the current world is replaced.
    const hf = new Heightfield(data.preset, data.seed);
    hf.importEdits(data.edits);
    hf.h.set(hf.base);
    const net = Network.fromJSON(data.net);
    this.installWorld(hf, net, [...data.placed]);
    this.restoreTrains(data);
    if (restoreTime) this.env.hours = data.hours;
    if (!this.driven && this.sim.trains.length) this.setDriven(this.sim.trains[0]);
  }

  save(silent = false) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.snapshot()));
      if (!silent) this.hud.toast('Map saved in this browser');
    } catch {
      if (!silent)
        this.hud.toast('Saving failed: browser storage is full or blocked. Export the map to a file instead');
    }
  }

  private keepBackup(raw: string | null) {
    try {
      if (raw) localStorage.setItem(BACKUP_KEY, raw);
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* Storage is blocked or full, so there is nowhere to keep it. */
    }
  }

  private readSave(): { saved: SaveData | null; recovered: boolean } {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch {
      return { saved: null, recovered: false };
    }
    if (!raw) return { saved: null, recovered: false };
    const r = parseSave(raw);
    if (r.ok) return { saved: r.data, recovered: false };
    console.warn(`Ignoring the saved map: ${r.reason}`);
    this.keepBackup(raw);
    return { saved: null, recovered: true };
  }

  exportMap() {
    const blob = new Blob([JSON.stringify(this.snapshot())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vibe-train-map.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  importMap(text: string) {
    const r = parseSave(text);
    if (!r.ok) {
      this.hud.toast(`Import failed: ${r.reason}. The current map is unchanged`, true);
      return;
    }
    const before = JSON.stringify(this.snapshot());
    try {
      this.applySave(r.data, true);
      this.hud.toast('Map imported');
    } catch (err) {
      // Put the previous map back so a failed import never leaves a half-loaded one.
      console.error(err);
      const old = parseSave(before);
      if (old.ok) this.applySave(old.data, true);
      this.hud.toast('Import failed: the map could not be built. The current map is unchanged', true);
    }
  }

  private lost = false;
  private onContextLost() {
    if (this.lost) return;
    this.lost = true;
    if (this.sim) this.save(true);
    showFatal(CONTEXT_LOST_TEXT, true);
  }

  setQuality(q: Quality) {
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* The choice simply lasts for this page only. */
    }
    this.save(true);
    location.reload();
  }

  // ------------------------------------------------------------ editing
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.snapshot()));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }

  private restoreSnapshot(json: string) {
    const d = JSON.parse(json) as SaveData;
    const undo = this.undoStack;
    const redo = this.redoStack;
    this.hf.importEdits(d.edits);
    const net = Network.fromJSON(d.net);
    this.net = net;
    const old = this.sim;
    this.sim = new Sim(net);
    this.sim.onEvent = old.onEvent;
    this.track.clear();
    net.dirty = new Set(net.segs.keys());
    this.scatter.placed = [...d.placed];
    this.hf.grade(net);
    this.props.invalidate();
    this.restoreTrains(d);
    this.scatterTimer = 0.01;
    this.undoStack = undo;
    this.redoStack = redo;
    this.editor.selected = null;
    this.hud.syncEditor();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.snapshot()));
    this.restoreSnapshot(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.snapshot()));
    this.restoreSnapshot(s);
  }

  /** Call after any change to the map. Keeps terrain and trains consistent with the new track. */
  commitEdit(opts: { scenery?: boolean; light?: boolean }) {
    this.hf.grade(this.net);
    this.reseatTrains();
    if (opts.scenery) this.scatterTimer = 0.25;
    this.hud.syncTrains();
  }

  /** Track was edited under the trains, so put each one back on the nearest track. */
  private reseatTrains() {
    for (const t of [...this.sim.trains]) {
      const valid = t.trail.every((p) => this.net.segs.has(p.seg));
      let x = 0;
      let z = 0;
      let hx = 1;
      let hz = 0;
      if (valid) {
        const h = this.sim.head(t);
        x = h.x;
        z = h.z;
        hx = h.tx * h.dir;
        hz = h.tz * h.dir;
      } else {
        const last = t.lastPos;
        if (last) {
          x = last.x;
          z = last.z;
          hx = last.hx;
          hz = last.hz;
        }
      }
      if (!this.sim.replace(t, x, z, hx, hz)) this.removeTrain(t);
      else if (t.ai) this.sim.plan(t, false);
    }
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
      this.sim.plan(this.driven, false);
    }
    this.driven = t;
    this.lever = 0;
    this.hud?.syncTrains();
  }

  setAutopilot(on: boolean) {
    const t = this.driven;
    if (!t) return;
    t.ai = on;
    if (on) this.sim.plan(t, false);
    else {
      t.throttle = 0;
      this.lever = t.speed > 0.2 ? 0 : -0.3;
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

  private bindDriveKeys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      this.audio.unlock();
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && this.editing) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        this.setMode(!this.editing);
        return;
      }
      if (e.code === 'KeyH' && !e.repeat) this.audio.horn(true);
      this.keys.add(e.code);
      if (this.editing || e.repeat) return;
      switch (e.code) {
        case 'KeyC':
          this.rig.cycle();
          this.hud.syncDrive();
          break;
        case 'KeyJ':
          this.throwNextSwitch();
          break;
        case 'KeyP':
          this.setAutopilot(!this.driven?.ai);
          break;
        case 'KeyN':
          this.nextTrain();
          break;
        case 'KeyR':
          this.reverseDriven();
          break;
        case 'KeyM':
          this.audio.setMuted(!this.audio.muted);
          this.hud.toast(this.audio.muted ? 'Sound off' : 'Sound on');
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyH') this.audio.horn(false);
    });
    window.addEventListener('pointerdown', () => this.audio.unlock());
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
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const space = this.keys.has('Space');
    if (t.ai && (up || down) && !this.editing) {
      // Touching the controls takes over from the autopilot.
      this.setAutopilot(false);
      this.hud.toast('Autopilot off: you are driving');
    }
    if (t.ai) return;
    if (up) this.lever = Math.min(1, this.lever + dt * 0.55);
    if (down) this.lever = Math.max(-1, this.lever - dt * 0.75);
    t.throttle = Math.max(0, this.lever);
    t.brake = space ? 1 : Math.max(0, -this.lever);
    this.hud.lever = this.lever;
  }

  setLever(v: number) {
    if (this.driven?.ai) this.setAutopilot(false);
    this.lever = v;
  }

  // ------------------------------------------------------------ frame
  private frame() {
    if (this.lost) return;
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.elapsed += dt;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    if (!this.editing) this.driveInput(dt);
    if (!this.editing || this.editor.runTrains) {
      this.sim.update(dt);
      for (const t of this.sim.trains) {
        const h = this.sim.head(t);
        t.lastPos = { x: h.x, z: h.z, hx: h.tx * h.dir, hz: h.tz * h.dir };
      }
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
    this.env.update(dt, this.focus);
    this.assets.setNight(this.env.night);
    this.props.update(this.sim, this.camera, this.env.night);
    this.trainsR.updateHeadlight(this.sim, this.driven, this.env.night);
    this.terrain.update(this.elapsed);

    const t = this.driven;
    if (t) {
      const h = this.sim.head(t);
      const d = this.camera.position.distanceTo(this.focus.set(h.x, h.y, h.z));
      this.audio.update(dt, t.speed, t.throttle, this.editing ? 0 : Math.max(0.05, 1 - d / 500));
    }
    this.hud.update();
    this.composer.render();
  }
}

function webglAvailable(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/** Replaces the loading screen with a message, so a failure never looks like endless loading. */
function showFatal(text: string, reload: boolean) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.remove('gone');
  el.classList.add('failed');
  el.setAttribute('role', 'alert');
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = text;
  const nodes: HTMLElement[] = [p];
  if (reload) {
    const b = document.createElement('button');
    b.className = 'fatal-btn';
    b.textContent = 'Reload page';
    b.addEventListener('click', () => location.reload());
    nodes.push(b);
  }
  el.replaceChildren(...nodes);
}

async function boot() {
  if (!webglAvailable()) throw new NoWebGLError();
  const game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  await game.start();
}

boot().catch((err) => {
  console.error(err);
  const { failure, text } = describeStartupError(err, import.meta.env.DEV);
  showFatal(text, failure !== 'no-webgl');
});
