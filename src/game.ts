// Ties the simulation, renderers, editor and interface together and runs the frame loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { SimAudio } from './audio';
import { DriverInput } from './driverInput';
import { Editor } from './editor/editor';
import { History } from './history';
import type { Quality } from './persistence';
import {
  backupStoredSave,
  buildWorld,
  captureSave,
  downloadMap,
  readQuality,
  readSave,
  restoreEdit,
  restoreTrains,
  writeQuality,
  writeSave,
} from './persistence';
import { buildDemoNetwork, populateDemoTrains } from './rail/demoMap';
import { Network } from './rail/network';
import type { Train } from './rail/sim';
import { Sim } from './rail/sim';
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
import { AssetLoadError, CONTEXT_LOST_TEXT, SAVE_RECOVERED_TEXT } from './startupError';
import { showFatal } from './ui/fatal';
import { Hud } from './ui/hud';
import type { Preset } from './world/heightfield';
import { Heightfield } from './world/heightfield';

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
  input = new DriverInput();
  private history = new History();
  private last = performance.now();
  private elapsed = 0;
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
    this.history.clear();
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
  }

  save(silent = false) {
    try {
      writeSave(this.snapshot());
      if (!silent) this.hud.toast('Map saved in this browser');
    } catch {
      if (!silent)
        this.hud.toast('Saving failed: browser storage is full or blocked. Export the map to a file instead');
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
    writeQuality(q);
    this.save(true);
    location.reload();
  }

  // ------------------------------------------------------------ editing
  pushUndo() {
    this.history.push(JSON.stringify(this.snapshot()));
  }

  private restoreSnapshot(json: string) {
    const d = JSON.parse(json) as SaveData;
    const onEvent = this.sim.onEvent;
    const { net, sim, driven } = restoreEdit(this.hf, d);
    this.net = net;
    this.sim = sim;
    this.sim.onEvent = onEvent;
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
  }

  redo() {
    const s = this.history.redo(JSON.stringify(this.snapshot()));
    if (s !== null) this.restoreSnapshot(s);
  }

  /** Call after any change to the map. Keeps terrain and trains consistent with the new track. */
  commitEdit(opts: { scenery?: boolean } = {}) {
    this.hf.grade(this.net);
    for (const t of this.sim.syncTrack()) this.removeTrain(t);
    if (opts.scenery) this.scatterTimer = 0.25;
    this.hud.syncTrains();
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
    this.input.lever = 0;
    this.hud?.syncTrains();
  }

  setAutopilot(on: boolean) {
    const t = this.driven;
    if (!t) return;
    t.ai = on;
    if (on) this.sim.plan(t, false);
    else {
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

  setLever(v: number) {
    if (this.driven?.ai) this.setAutopilot(false);
    this.input.lever = v;
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
