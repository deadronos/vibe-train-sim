// Map editor tools: laying track, junctions, signals, stations, bridges, terrain brushes, scenery and trains.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

import type { Game } from '../game';
import { gameKey } from '../keyFilter';
import { EMPTY_FREIGHT, FREIGHT, PASSENGER, SHUTTLE } from '../rail/demoMap';
import type { Dir, RailNode, Side } from '../rail/network';
import { curveMinRadius, MAX_GRADE, MIN_RADIUS, planCurve } from '../rail/network';
import { Train } from '../rail/sim';
import type { Car } from '../rail/vehicles';
import type { SceneryType } from '../render/scatter';
import { WATER_LEVEL } from '../world/heightfield';

export type Tool = 'select' | 'track' | 'signal' | 'station' | 'bridge' | 'terrain' | 'scenery' | 'train' | 'delete';
export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten';

type Anchor =
  | { kind: 'node'; node: number }
  | { kind: 'seg'; seg: number; s: number; x: number; y: number; z: number }
  | { kind: 'free'; x: number; y: number; z: number };

const STATION_NAMES = [
  'Ashcombe',
  'Birchford',
  'Coldwater',
  'Dunmoor',
  'Elmstead',
  'Fernhollow',
  'Greyhaven',
  'Hartsmere',
  'Ivybridge Road',
  'Juniper Halt',
  'Kestrel Lane',
  'Low Marsh',
];
const ANCHOR_NODE = 14;
const ANCHOR_SEG = 9;
const HANDLE_CAPACITY = 2048;

export class Editor {
  tool: Tool = 'select';
  controls: MapControls;
  heightOffset = 0;
  brushMode: BrushMode = 'raise';
  brushRadius = 60;
  brushStrength = 0.6;
  sceneryType: SceneryType = 'tree_pine';
  trainKind: 'passenger' | 'shuttle' | 'freight' | 'emptyFreight' = 'passenger';
  selected: number | null = null;
  status = '';
  runTrains = false;

  private start: Anchor | null = null;
  private cursor: { x: number; y: number; z: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private ribbon: THREE.Mesh;
  private ribbonGood: THREE.MeshBasicMaterial;
  private ribbonBad: THREE.MeshBasicMaterial;
  private handles: THREE.InstancedMesh;
  private ring: THREE.LineLoop;
  private highlight: THREE.Mesh;
  private arrow: THREE.Mesh;
  private root = new THREE.Group();
  private dragging = false;
  private brushing = false;
  private flattenTo = 0;
  private shift = false;
  private keys = new Set<string>();
  private nameCounter = 0;
  private lastPreview: { ok: boolean; reason: string } = { ok: false, reason: '' };

  constructor(private game: Game) {
    const dom = game.renderer.domElement;
    this.controls = new MapControls(game.camera, dom);
    this.controls.enabled = false;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 2600;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;

    this.ribbonGood = new THREE.MeshBasicMaterial({
      color: 0x4fe08a,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ribbonBad = new THREE.MeshBasicMaterial({
      color: 0xff5242,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), this.ribbonGood);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 10;
    this.ribbon.visible = false;

    this.handles = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95, fog: false }),
      HANDLE_CAPACITY,
    );
    this.handles.renderOrder = 11;
    this.handles.frustumCulled = false;

    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++)
      pts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2)));
    this.ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffe9a8, depthTest: false, transparent: true, fog: false }),
    );
    this.ring.renderOrder = 12;
    this.ring.visible = false;

    this.highlight = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd466, depthTest: false, transparent: true, fog: false }),
    );
    this.highlight.rotation.x = Math.PI / 2;
    this.highlight.renderOrder = 12;
    this.highlight.visible = false;

    const arrowGeo = new THREE.ConeGeometry(2.2, 7, 4);
    arrowGeo.rotateX(Math.PI / 2);
    this.arrow = new THREE.Mesh(
      arrowGeo,
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, depthTest: false, transparent: true, fog: false }),
    );
    this.arrow.renderOrder = 12;
    this.arrow.visible = false;

    this.root.add(this.ribbon, this.handles, this.ring, this.highlight, this.arrow);
    this.root.visible = false;
    game.scene.add(this.root);

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', () => this.onUp());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      this.shift = e.shiftKey;
      if (!gameKey(e)) return;
      this.keys.add(e.code);
      if (!this.game.editing) return;
      if (e.code === 'Escape') this.cancel();
      if (e.code === 'BracketRight') this.nudgeHeight(2);
      if (e.code === 'BracketLeft') this.nudgeHeight(-2);
      if (e.code === 'Delete' || e.code === 'Backspace') this.deleteSelected();
    });
    window.addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      this.keys.delete(e.code);
    });
  }

  releaseKeys() {
    this.keys.clear();
    this.shift = false;
  }

  enter() {
    this.root.visible = true;
    const g = this.game;
    const cam = g.camera;
    // Rise up from the driving view to a planning view around the current position.
    const focus = g.driven ? g.sim.head(g.driven) : { x: 0, y: 20, z: 0 };
    this.controls.target.set(focus.x, focus.y, focus.z);
    cam.position.set(focus.x + 200, focus.y + 300, focus.z + 330);
    this.controls.enabled = true;
    this.controls.update();
    this.setTool(this.tool);
  }

  leave() {
    this.root.visible = false;
    this.controls.enabled = false;
    this.cancel();
    this.selected = null;
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.start = null;
    this.selected = null;
    this.ribbon.visible = false;
    this.arrow.visible = false;
    this.highlight.visible = false;
    this.ring.visible = false;
    // Left button pans only with the select tool; every other tool owns the click.
    this.controls.mouseButtons = {
      LEFT: tool === 'select' ? THREE.MOUSE.PAN : null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.status = '';
    this.game.hud.syncEditor();
  }

  cancel() {
    this.start = null;
    this.ribbon.visible = false;
    this.status = '';
  }

  private nudgeHeight(delta: number) {
    this.heightOffset = Math.max(-30, Math.min(60, this.heightOffset + delta));
    if (this.tool === 'track') this.refreshPreview();
    this.game.hud.syncEditor();
  }

  private pointer(e: PointerEvent) {
    const r = this.game.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.game.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    return this.game.hf.raycast(o.x, o.y, o.z, d.x, d.y, d.z);
  }

  private onDown(e: PointerEvent) {
    if (!this.game.editing || e.button !== 0) return;
    const p = this.pointer(e);
    if (!p) return;
    this.cursor = p;
    const g = this.game;
    switch (this.tool) {
      case 'select': {
        const n = g.net.nearestNode(p.x, p.z, ANCHOR_NODE);
        this.selected = n ? n.id : null;
        if (n) {
          this.controls.enabled = false;
          this.dragging = true;
          g.pushUndo();
        }
        g.hud.syncEditor();
        break;
      }
      case 'track':
        this.clickTrack(p);
        break;
      case 'signal':
        this.clickSignal(p);
        break;
      case 'station':
        this.clickStation(p);
        break;
      case 'bridge':
        this.clickBridge(p);
        break;
      case 'terrain':
        g.pushUndo();
        this.brushing = true;
        this.flattenTo = g.hf.baseAt(p.x, p.z);
        this.brushAt(p);
        break;
      case 'scenery':
        g.pushUndo();
        g.scatter.placed.push({
          type: this.sceneryType,
          x: p.x,
          z: p.z,
          rot: Math.random() * Math.PI * 2,
          scale: this.sceneryType.startsWith('house') ? 1 : 0.8 + Math.random() * 0.5,
        });
        g.commitEdit({ scenery: true });
        break;
      case 'train':
        this.clickTrain(p);
        break;
      case 'delete':
        this.clickDelete(p);
        break;
    }
  }

  private onMove(e: PointerEvent) {
    if (!this.game.editing) return;
    const p = this.pointer(e);
    this.cursor = p;
    if (!p) {
      this.ring.visible = false;
      return;
    }
    const g = this.game;
    if (this.dragging && this.selected !== null) {
      const n = g.net.nodes.get(this.selected);
      if (n) {
        g.net.moveNode(n.id, p.x, n.y, p.z);
        g.commitEdit();
        g.hud.syncEditor();
      }
      return;
    }
    if (this.brushing) this.brushAt(p);
    this.updateHover(p);
  }

  private onUp() {
    if (!this.game.editing) return;
    if (this.dragging) {
      this.dragging = false;
      this.controls.enabled = true;
      this.game.commitEdit({ scenery: true });
    }
    if (this.brushing) {
      this.brushing = false;
      this.game.net.dirty = new Set(this.game.net.segs.keys());
      this.game.commitEdit({ scenery: true });
    }
  }

  private brushAt(p: { x: number; z: number }) {
    const g = this.game;
    g.hf.brush(this.brushMode, p.x, p.z, this.brushRadius, this.brushStrength, this.flattenTo);
    g.hf.grade(g.net);
  }

  private anchorAt(p: { x: number; y: number; z: number }): Anchor {
    const g = this.game;
    const n = g.net.nearestNode(p.x, p.z, ANCHOR_NODE);
    if (n) return { kind: 'node', node: n.id };
    const near = g.net.nearest(p.x, p.z, ANCHOR_SEG);
    if (near) {
      const s = g.net.sample(near.seg, near.s);
      return { kind: 'seg', seg: near.seg, s: near.s, x: s.x, y: s.y, z: s.z };
    }
    const base = g.hf.baseAt(p.x, p.z);
    return { kind: 'free', x: p.x, y: Math.max(base + 0.7, WATER_LEVEL + 3) + this.heightOffset, z: p.z };
  }

  private anchorPos(a: Anchor) {
    if (a.kind === 'node') {
      const n = this.game.net.nodes.get(a.node)!;
      return { x: n.x, y: n.y, z: n.z };
    }
    return { x: a.x, y: a.y, z: a.z };
  }

  /** Works out heading, shape and validity for the piece being drawn. */
  private previewPlan(startA: Anchor, endA: Anchor) {
    const g = this.game;
    const P = this.anchorPos(startA);
    const Q = this.anchorPos(endA);
    const chord = Math.hypot(Q.x - P.x, Q.z - P.z);
    if (chord < 15)
      return {
        ok: false,
        reason: 'Too short',
        curve: null as ReturnType<typeof planCurve> | null,
        P,
        Q,
        d0x: 1,
        d0z: 0,
        d1x: -1,
        d1z: 0,
      };
    const cx = (Q.x - P.x) / chord;
    const cz = (Q.z - P.z) / chord;
    let d0x = cx;
    let d0z = cz;
    if (startA.kind === 'node') {
      const n = g.net.nodes.get(startA.node)!;
      const side = n.dx * cx + n.dz * cz >= 0 ? 1 : -1;
      d0x = n.dx * side;
      d0z = n.dz * side;
    } else if (startA.kind === 'seg') {
      const s = g.net.sample(startA.seg, startA.s);
      const l = Math.hypot(s.tx, s.tz) || 1;
      const side = s.tx * cx + s.tz * cz >= 0 ? 1 : -1;
      d0x = (s.tx / l) * side;
      d0z = (s.tz / l) * side;
    } else if (this.shift) {
      const a = Math.round(Math.atan2(cz, cx) / (Math.PI / 12)) * (Math.PI / 12);
      d0x = Math.cos(a);
      d0z = Math.sin(a);
    }
    let d1x: number;
    let d1z: number;
    if (endA.kind === 'node') {
      const n = g.net.nodes.get(endA.node)!;
      const side = n.dx * -cx + n.dz * -cz >= 0 ? 1 : -1;
      d1x = n.dx * side;
      d1z = n.dz * side;
    } else if (endA.kind === 'seg') {
      const s = g.net.sample(endA.seg, endA.s);
      const l = Math.hypot(s.tx, s.tz) || 1;
      const side = (s.tx / l) * -cx + (s.tz / l) * -cz >= 0 ? 1 : -1;
      d1x = (s.tx / l) * side;
      d1z = (s.tz / l) * side;
    } else {
      // Mirror the start tangent across the chord: a free end finishes a circular arc.
      const dot = d0x * cx + d0z * cz;
      const rx = 2 * dot * cx - d0x;
      const rz = 2 * dot * cz - d0z;
      d1x = -rx;
      d1z = -rz;
    }
    const curve = planCurve(P.x, P.z, d0x, d0z, Q.x, Q.z, d1x, d1z);
    const minR = curveMinRadius(curve.xs, curve.zs, curve.steps + 1, 6);
    const grade = Math.abs(Q.y - P.y) / curve.length;
    let ok = true;
    let reason = `${Math.round(curve.length)} m, radius ${minR === Infinity ? 'straight' : Math.round(minR) + ' m'}, grade ${(grade * 100).toFixed(1)}%`;
    if (d0x * cx + d0z * cz < 0.05) {
      ok = false;
      reason = 'Turn is too sharp: start in the direction the track already points';
    } else if (minR < MIN_RADIUS) {
      ok = false;
      reason = `Curve too tight: radius ${Math.round(minR)} m, minimum ${MIN_RADIUS} m`;
    } else if (grade > MAX_GRADE) {
      ok = false;
      reason = `Too steep: ${(grade * 100).toFixed(1)}%, maximum ${(MAX_GRADE * 100).toFixed(0)}%. Change the height with [ and ]`;
    }
    return { ok, reason, curve, P, Q, d0x, d0z, d1x, d1z };
  }

  private refreshPreview() {
    if (!this.start || !this.cursor) {
      this.ribbon.visible = false;
      return;
    }
    const end = this.anchorAt(this.cursor);
    const plan = this.previewPlan(this.start, end);
    this.lastPreview = { ok: plan.ok, reason: plan.reason };
    this.status = plan.reason;
    if (!plan.curve) {
      this.ribbon.visible = false;
      return;
    }
    const c = plan.curve;
    const n = c.steps + 1;
    const pos = new Float32Array(n * 2 * 3);
    const hw = 2;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = c.xs[b] - c.xs[a];
      let tz = c.zs[b] - c.zs[a];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      const f = c.cum[i] / (c.length || 1);
      const y = plan.P.y + (plan.Q.y - plan.P.y) * f + 0.4;
      pos[i * 6] = c.xs[i] - tz * hw;
      pos[i * 6 + 1] = y;
      pos[i * 6 + 2] = c.zs[i] + tx * hw;
      pos[i * 6 + 3] = c.xs[i] + tz * hw;
      pos[i * 6 + 4] = y;
      pos[i * 6 + 5] = c.zs[i] - tx * hw;
    }
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = this.ribbon.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(index);
    this.ribbon.material = plan.ok ? this.ribbonGood : this.ribbonBad;
    this.ribbon.visible = true;
  }

  private resolveAnchor(a: Anchor, dirX: number, dirZ: number): { node: RailNode; side: Side } {
    // Returns the node to attach to and the side whose outward direction best matches (dirX, dirZ).
    const net = this.game.net;
    let node: RailNode;
    if (a.kind === 'node') node = net.nodes.get(a.node)!;
    else if (a.kind === 'seg') node = net.split(a.seg, this.clampSplit(a.seg, a.s));
    else node = net.addNode(a.x, a.y, a.z, dirX, dirZ);
    const side: Side = node.dx * dirX + node.dz * dirZ >= 0 ? 1 : -1;
    return { node, side };
  }

  private clampSplit(seg: number, s: number) {
    const L = this.game.net.geom.get(seg)!.length;
    return Math.max(6, Math.min(L - 6, s));
  }

  private clickTrack(p: { x: number; y: number; z: number }) {
    const g = this.game;
    const here = this.anchorAt(p);
    if (!this.start) {
      this.start = here;
      this.status = 'Click where the track should end';
      return;
    }
    const plan = this.previewPlan(this.start, here);
    if (!plan.ok) {
      g.hud.toast(plan.reason);
      return;
    }
    g.pushUndo();
    const a = this.resolveAnchor(this.start, plan.d0x, plan.d0z);
    const endIsFree = here.kind === 'free';
    let b: { node: RailNode; side: Side };
    if (endIsFree) {
      const node = g.net.addNode(plan.Q.x, plan.Q.y, plan.Q.z, -plan.d1x, -plan.d1z);
      b = { node, side: -1 };
    } else {
      // Splitting may have replaced an anchor's segment; re-find it when both ends sit on one segment.
      let endAnchor = here;
      if (here.kind === 'seg' && this.start.kind === 'seg' && here.seg === this.start.seg) {
        const near = g.net.nearest(here.x, here.z, ANCHOR_SEG * 2);
        if (near) endAnchor = { ...here, seg: near.seg, s: near.s };
      }
      b = this.resolveAnchor(endAnchor, plan.d1x, plan.d1z);
    }
    if (a.node.id === b.node.id) {
      g.undo();
      g.hud.toast('A track cannot start and end at the same point');
      this.cancel();
      return;
    }
    g.net.addSegment(a.node.id, a.side, b.node.id, b.side);
    if (endIsFree) {
      this.start = { kind: 'node', node: b.node.id };
    } else {
      this.start = null;
      this.ribbon.visible = false;
    }
    g.commitEdit({ scenery: true });
    this.refreshPreview();
  }

  /** Finds or creates a node on the track near a point, along with the travel side the mouse favours. */
  private trackPointFromMouse(p: { x: number; z: number }) {
    const g = this.game;
    const near = g.net.nearest(p.x, p.z, 26);
    if (!near) return null;
    const s = g.net.sample(near.seg, near.s);
    const l = Math.hypot(s.tx, s.tz) || 1;
    const tx = s.tx / l;
    const tz = s.tz / l;
    // Trains keep the signal on their right, so the mouse side picks the direction of travel.
    const cross = (p.x - s.x) * -tz + (p.z - s.z) * tx;
    const travel: Dir = cross >= 0 ? 1 : -1;
    return { seg: near.seg, s: near.s, x: s.x, y: s.y, z: s.z, tx: tx * travel, tz: tz * travel, travel, cross };
  }

  private nodeForPoint(pt: { seg: number; s: number; x: number; z: number }): RailNode {
    const g = this.game;
    const existing = g.net.nearestNode(pt.x, pt.z, 10);
    if (existing) return existing;
    return g.net.split(pt.seg, this.clampSplit(pt.seg, pt.s));
  }

  private clickSignal(p: { x: number; z: number }) {
    const g = this.game;
    const pt = this.trackPointFromMouse(p);
    if (!pt) {
      g.hud.toast('Click close to a track to place a signal');
      return;
    }
    g.pushUndo();
    const node = this.nodeForPoint(pt);
    const side: Side = node.dx * pt.tx + node.dz * pt.tz >= 0 ? 1 : -1;
    if (node.signals[side]) {
      delete node.signals[side];
      g.hud.toast('Signal removed');
    } else {
      node.signals[side] = { hold: false };
      g.hud.toast('Signal placed');
    }
    g.net.version++;
    g.commitEdit();
  }

  private clickStation(p: { x: number; z: number }) {
    const g = this.game;
    const pt = this.trackPointFromMouse(p);
    if (!pt) {
      g.hud.toast('Click close to a track to place a station');
      return;
    }
    const node0 = g.net.nearestNode(pt.x, pt.z, 10);
    if (node0 && g.net.stations.some((s) => s.nodeId === node0.id)) {
      g.hud.toast('This point already has a station');
      return;
    }
    g.pushUndo();
    const node = this.nodeForPoint(pt);
    const onRightOfNode = (p.x - node.x) * -node.dz + (p.z - node.z) * node.dx >= 0;
    const name = STATION_NAMES[this.nameCounter++ % STATION_NAMES.length];
    g.net.stations.push({ id: g.net.id(), name, nodeId: node.id, platformSide: onRightOfNode ? 1 : -1, length: 140 });
    g.net.version++;
    this.selected = node.id;
    g.commitEdit({ scenery: true });
    g.hud.toast(`Station ${name} placed. Rename it from the panel with the select tool`);
  }

  private clickBridge(p: { x: number; z: number }) {
    const g = this.game;
    const near = g.net.nearest(p.x, p.z, 16);
    if (!near) {
      g.hud.toast('Click a track to change how it crosses the ground');
      return;
    }
    g.pushUndo();
    const seg = g.net.segs.get(near.seg)!;
    const nextMode = { auto: 'force', force: 'none', none: 'auto' } as const;
    seg.bridge = nextMode[seg.bridge];
    g.net.dirty.add(seg.id);
    g.net.version++;
    g.commitEdit({ scenery: true });
    const text = {
      auto: 'Automatic: bridges where the track is high above ground',
      force: 'Always a bridge on this section',
      none: 'Always an embankment on this section',
    };
    g.hud.toast(text[seg.bridge]);
  }

  private clickTrain(p: { x: number; z: number }) {
    const g = this.game;
    const near = g.net.nearest(p.x, p.z, 26);
    if (!near) {
      g.hud.toast('Click a track to add a train');
      return;
    }
    g.pushUndo();
    const types: Record<string, () => Car[]> = {
      passenger: PASSENGER,
      shuttle: SHUTTLE,
      freight: FREIGHT,
      emptyFreight: EMPTY_FREIGHT,
    };
    const num = 400 + Math.floor(Math.random() * 500);
    const label = { passenger: 'Express', shuttle: 'Local', freight: 'Freight', emptyFreight: 'Empties' }[
      this.trainKind
    ];
    const id = g.sim.trains.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const train = new Train(id, `${label} ${num}`, types[this.trainKind]());
    g.sim.trains.push(train);
    g.sim.place(train, near.seg, near.s, 1);
    g.sim.plan(train, false);
    g.hud.syncTrains();
    g.hud.toast(`${train.name} is on the line`);
  }

  private clickDelete(p: { x: number; z: number }) {
    const g = this.game;
    const net = g.net;
    for (const t of g.sim.trains) {
      for (let d = 0; d <= t.length; d += 8) {
        const q = g.sim.behind(t, d);
        if (Math.hypot(q.x - p.x, q.z - p.z) < 7) {
          g.pushUndo();
          g.removeTrain(t);
          g.hud.toast(`${t.name} removed`);
          return;
        }
      }
    }
    const n = net.nearestNode(p.x, p.z, 8);
    if (n && (n.signals[1] || n.signals[-1])) {
      g.pushUndo();
      n.signals = {};
      net.version++;
      g.commitEdit();
      g.hud.toast('Signal removed');
      return;
    }
    if (n) {
      const st = net.stations.find((s) => s.nodeId === n.id);
      if (st) {
        g.pushUndo();
        net.stations = net.stations.filter((s) => s !== st);
        net.version++;
        g.commitEdit({ scenery: true });
        g.hud.toast(`${st.name} removed`);
        return;
      }
    }
    const pi = g.scatter.placedNear(p.x, p.z, 7);
    if (pi >= 0) {
      g.pushUndo();
      g.scatter.placed.splice(pi, 1);
      g.commitEdit({ scenery: true });
      return;
    }
    const near = net.nearest(p.x, p.z, 7);
    if (near) {
      g.pushUndo();
      net.removeSegment(near.seg);
      g.commitEdit({ scenery: true });
      g.hud.toast('Track removed');
    }
  }

  deleteSelected() {
    if (this.selected === null) return;
    const g = this.game;
    g.pushUndo();
    g.net.removeNode(this.selected);
    this.selected = null;
    g.commitEdit({ scenery: true });
    g.hud.syncEditor();
  }

  private updateHover(p: { x: number; y: number; z: number }) {
    const g = this.game;
    this.arrow.visible = false;
    this.ring.visible = false;
    this.highlight.visible = false;
    switch (this.tool) {
      case 'track': {
        const a = this.anchorAt(p);
        if (a.kind !== 'free') {
          const q = this.anchorPos(a);
          this.highlight.visible = true;
          this.highlight.position.set(q.x, q.y + 0.5, q.z);
          this.highlight.scale.setScalar(5);
        }
        if (this.start) this.refreshPreview();
        else
          this.status =
            a.kind === 'node'
              ? 'Click to continue from here'
              : a.kind === 'seg'
                ? 'Click to branch from this track'
                : 'Click to start a new line';
        break;
      }
      case 'signal':
      case 'station': {
        const pt = this.trackPointFromMouse(p);
        if (pt) {
          this.arrow.visible = this.tool === 'signal';
          this.arrow.position.set(pt.x + pt.tx * 7, pt.y + 2, pt.z + pt.tz * 7);
          this.arrow.lookAt(pt.x + pt.tx * 12, pt.y + 2, pt.z + pt.tz * 12);
          this.highlight.visible = true;
          this.highlight.position.set(pt.x, pt.y + 0.5, pt.z);
          this.highlight.scale.setScalar(4);
          this.status =
            this.tool === 'signal'
              ? 'The signal controls trains running in the arrow direction. Move to the other side of the track to flip it'
              : 'The platform is built on the side the mouse is on';
        } else {
          this.status = 'Move close to a track';
        }
        break;
      }
      case 'terrain': {
        this.ring.visible = true;
        this.ring.position.set(p.x, p.y + 2, p.z);
        this.ring.scale.setScalar(this.brushRadius);
        this.status = '';
        break;
      }
      case 'delete':
      case 'bridge': {
        const near = g.net.nearest(p.x, p.z, this.tool === 'delete' ? 7 : 16);
        if (near) {
          const s = g.net.sample(near.seg, near.s);
          this.highlight.visible = true;
          this.highlight.position.set(s.x, s.y + 0.5, s.z);
          this.highlight.scale.setScalar(4);
          if (this.tool === 'bridge')
            this.status = `This section: ${{ auto: 'automatic', force: 'always a bridge', none: 'always an embankment' }[g.net.segs.get(near.seg)!.bridge]}. Click to change`;
        }
        break;
      }
      case 'select': {
        const n = g.net.nearestNode(p.x, p.z, ANCHOR_NODE);
        if (n) {
          this.highlight.visible = true;
          this.highlight.position.set(n.x, n.y + 0.5, n.z);
          this.highlight.scale.setScalar(5);
        }
        break;
      }
    }
  }

  private nodeColor = new THREE.Color();
  private tmp = new THREE.Object3D();

  /** Node markers scale with distance so they stay clickable at any zoom. */
  update(dt: number) {
    if (!this.game.editing) return;
    const g = this.game;
    const net = g.net;
    this.controls.update();
    const cam = g.camera;
    const panSpeed = 0.9 * this.controls.getDistance() * dt;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(panSpeed);
      cam.position.add(move);
      this.controls.target.add(move);
    }
    const ground = g.hf.height(cam.position.x, cam.position.z) + 4;
    if (cam.position.y < ground) cam.position.y = ground;

    let i = 0;
    const camPos = cam.position;
    for (const n of net.nodes.values()) {
      if (i >= HANDLE_CAPACITY) break;
      const d = Math.hypot(n.x - camPos.x, n.y - camPos.y, n.z - camPos.z);
      const r = Math.max(1.1, d * 0.0042);
      this.tmp.position.set(n.x, n.y + 0.5, n.z);
      this.tmp.scale.setScalar(n.id === this.selected ? r * 1.5 : r);
      this.tmp.updateMatrix();
      this.handles.setMatrixAt(i, this.tmp.matrix);
      const color =
        n.id === this.selected
          ? 0xffffff
          : net.isJunction(n.id)
            ? 0xf0a62b
            : n.signals[1] || n.signals[-1]
              ? 0xe5392c
              : net.stations.some((s) => s.nodeId === n.id)
                ? 0x4fa6e0
                : 0xb7c2bb;
      this.handles.setColorAt(i, this.nodeColor.set(color));
      i++;
    }
    this.handles.count = Math.max(i, 0);
    this.handles.instanceMatrix.needsUpdate = true;
    if (this.handles.instanceColor) this.handles.instanceColor.needsUpdate = true;
  }
}
