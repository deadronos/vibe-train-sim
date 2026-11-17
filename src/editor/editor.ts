// Map editor controller: planning camera, handle rendering, pointer raycasting and tool dispatch.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

import { gameKey } from '../keyFilter';
import type { planCurve, SignalType } from '../rail/network';
import { DEFAULT_FOV, prefersReducedMotion } from '../render/cameraRig';
import type { SceneryType } from '../world/scenery';
import { createTools } from './tools';
import type { BrushMode, EditorContext, EditorHost, EditorTool, Tool, TrainKind, WorldPoint } from './tools/tool';

export type { BrushMode, EditorHost, Tool, TrainKind };

const INITIAL_HANDLE_CAPACITY = 2048;
/** How far apart, in CSS pixels, two taps still count as the same place. */
const TAP_SLOP = 28;
const ENTER_TRANSITION_SEC = 0.45;

export class Editor implements EditorContext {
  tool: Tool = 'select';
  controls: MapControls;
  heightOffset = 0;
  brushMode: BrushMode = 'raise';
  brushRadius = 60;
  brushStrength = 0.6;
  sceneryType: SceneryType = 'tree_pine';
  signalType: SignalType = 'main';
  trainKind: TrainKind = 'passenger';
  selected: number | null = null;
  status = '';
  runTrains = false;
  /** Snaps new lines to 15° steps, as holding Shift does. For touch screens, which have no Shift. */
  snap = false;
  cursor: WorldPoint | null = null;
  shift = false;

  readonly host: EditorHost;
  private tools: Record<Tool, EditorTool>;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private ribbon: THREE.Mesh;
  private ribbonGood: THREE.MeshBasicMaterial;
  private ribbonBad: THREE.MeshBasicMaterial;
  private handleGeo = new THREE.SphereGeometry(1, 12, 8);
  private handleMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
    fog: false,
  });
  private handleCapacity = INITIAL_HANDLE_CAPACITY;
  private handles: THREE.InstancedMesh;
  private ring: THREE.LineLoop;
  private highlight: THREE.Mesh;
  private arrow: THREE.Mesh;
  private root = new THREE.Group();
  private boxEl: HTMLElement | null;
  /** Where a touch tapped first: touch has no hover, so the first tap previews and a second tap there confirms. */
  private tapAt: { x: number; y: number } | null = null;
  private keys = new Set<string>();

  private transT = 1;
  private transFromPos = new THREE.Vector3();
  private transFromQuat = new THREE.Quaternion();
  private transFromFov = DEFAULT_FOV;
  private transGoalPos = new THREE.Vector3();
  private transGoalQuat = new THREE.Quaternion();

  constructor(host: EditorHost) {
    this.host = host;
    this.tools = createTools();
    this.boxEl = document.getElementById('box-select');
    const dom = host.renderer.domElement;
    this.controls = new MapControls(host.camera, dom);
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

    this.handles = new THREE.InstancedMesh(this.handleGeo, this.handleMat, this.handleCapacity);
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
    host.scene.add(this.root);

    dom.addEventListener('pointerdown', (e) => {
      if (this.host.editing && this.transT < 1) this.finishTransition();
      this.onDown(e);
    });
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener(
      'wheel',
      () => {
        if (this.host.editing && this.transT < 1) this.finishTransition();
      },
      { passive: true },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      this.shift = e.shiftKey;
      if (!gameKey(e)) return;
      this.keys.add(e.code);
      if (!this.host.editing) return;
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

  // ------------------------------------------------------------ EditorContext helpers
  edit(
    opts: { scenery?: boolean; bounds?: { minX: number; minZ: number; maxX: number; maxZ: number } },
    fn: () => boolean | void,
  ): boolean {
    this.host.pushUndo();
    if (fn() === false) {
      this.host.abandonEdit();
      return false;
    }
    this.host.commitEdit(opts);
    return true;
  }

  setStatus(text: string) {
    this.status = text;
  }

  refreshPanel() {
    this.host.syncEditor();
  }

  setControlsEnabled(enabled: boolean) {
    this.controls.enabled = enabled;
  }

  showHighlight(x: number, y: number, z: number, scale: number) {
    this.highlight.visible = true;
    this.highlight.position.set(x, y, z);
    this.highlight.scale.setScalar(scale);
  }

  showArrow(x: number, y: number, z: number, tx: number, tz: number) {
    this.arrow.visible = true;
    this.arrow.position.set(x, y, z);
    this.arrow.lookAt(x + tx * 5, y, z + tz * 5);
  }

  showRing(x: number, y: number, z: number, radius: number) {
    this.ring.visible = true;
    this.ring.position.set(x, y, z);
    this.ring.scale.setScalar(radius);
  }

  hideRing() {
    this.ring.visible = false;
  }

  showBox(x0: number, y0: number, x1: number, y1: number) {
    if (!this.boxEl) return;
    const l = Math.min(x0, x1);
    const t = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    this.boxEl.hidden = false;
    this.boxEl.style.left = `${l}px`;
    this.boxEl.style.top = `${t}px`;
    this.boxEl.style.width = `${w}px`;
    this.boxEl.style.height = `${h}px`;
  }

  hideBox() {
    if (this.boxEl) this.boxEl.hidden = true;
  }

  private projVec = new THREE.Vector3();

  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const r = this.host.renderer.domElement.getBoundingClientRect();
    this.projVec.set(x, y, z).project(this.host.camera);
    const visible = this.projVec.z >= -1 && this.projVec.z <= 1;
    return {
      x: r.left + (this.projVec.x * 0.5 + 0.5) * r.width,
      y: r.top + (-this.projVec.y * 0.5 + 0.5) * r.height,
      visible,
    };
  }

  showRibbon(curve: ReturnType<typeof planCurve>, P: WorldPoint, Q: WorldPoint, ok: boolean) {
    const n = curve.steps + 1;
    const pos = new Float32Array(n * 2 * 3);
    const hw = 2;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = curve.xs[b] - curve.xs[a];
      let tz = curve.zs[b] - curve.zs[a];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      const f = curve.cum[i] / (curve.length || 1);
      const y = P.y + (Q.y - P.y) * f + 0.4;
      pos[i * 6] = curve.xs[i] - tz * hw;
      pos[i * 6 + 1] = y;
      pos[i * 6 + 2] = curve.zs[i] + tx * hw;
      pos[i * 6 + 3] = curve.xs[i] + tz * hw;
      pos[i * 6 + 4] = y;
      pos[i * 6 + 5] = curve.zs[i] - tx * hw;
    }
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = this.ribbon.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(index);
    this.ribbon.material = ok ? this.ribbonGood : this.ribbonBad;
    this.ribbon.visible = true;
  }

  hideRibbon() {
    this.ribbon.visible = false;
  }

  // ------------------------------------------------------------ mode & tool lifecycle
  releaseKeys() {
    this.keys.clear();
    this.shift = false;
  }

  private finishTransition() {
    const cam = this.host.camera;
    this.transT = 1;
    cam.position.copy(this.transGoalPos);
    cam.quaternion.copy(this.transGoalQuat);
    if (cam.fov !== DEFAULT_FOV) {
      cam.fov = DEFAULT_FOV;
      cam.updateProjectionMatrix();
    }
    this.controls.update();
  }

  enter() {
    this.root.visible = true;
    const h = this.host;
    const cam = h.camera;
    // Rise up from the driving view to a planning view around the current position.
    const focus = h.driven ? h.sim.head(h.driven) : { x: 0, y: 20, z: 0 };
    this.controls.target.set(focus.x, focus.y, focus.z);
    this.transGoalPos.set(focus.x + 200, focus.y + 300, focus.z + 330);
    if (!prefersReducedMotion() && cam.position.lengthSq() > 0) {
      this.transFromPos.copy(cam.position);
      this.transFromQuat.copy(cam.quaternion);
      this.transFromFov = cam.fov;
      cam.position.copy(this.transGoalPos);
      cam.lookAt(this.controls.target);
      this.transGoalQuat.copy(cam.quaternion);
      cam.position.copy(this.transFromPos);
      cam.quaternion.copy(this.transFromQuat);
      this.transT = 0;
    } else {
      cam.position.copy(this.transGoalPos);
      if (cam.fov !== DEFAULT_FOV) {
        cam.fov = DEFAULT_FOV;
        cam.updateProjectionMatrix();
      }
      this.transT = 1;
      this.controls.update();
      this.transGoalQuat.copy(cam.quaternion);
    }
    this.controls.enabled = true;
    this.setTool(this.tool);
  }

  /** Moves the planning view to look at a point, keeping the camera's angle and distance. */
  lookAt(x: number, z: number) {
    this.transT = 1;
    const cam = this.host.camera;
    const t = this.controls.target;
    const y = this.host.hf.height(x, z);
    cam.position.set(cam.position.x + x - t.x, cam.position.y + y - t.y, cam.position.z + z - t.z);
    t.set(x, y, z);
    this.controls.update();
  }

  leave() {
    this.transT = 1;
    this.root.visible = false;
    this.controls.enabled = false;
    this.hideBox();
    this.cancel();
    this.tools[this.tool].leave?.(this);
    this.selected = null;
  }

  setTool(tool: Tool) {
    this.tools[this.tool].leave?.(this);
    this.tool = tool;
    this.tapAt = null;
    this.selected = null;
    this.ribbon.visible = false;
    this.arrow.visible = false;
    this.highlight.visible = false;
    this.ring.visible = false;
    this.hideBox();
    const active = this.tools[tool];
    // Left button pans only when the tool asks for it; every other tool owns the click.
    this.controls.mouseButtons = {
      LEFT: active.leftPan ? THREE.MOUSE.PAN : null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.status = '';
    active.enter?.(this);
    this.host.syncEditor();
  }

  cancel() {
    this.tools[this.tool].cancel?.(this);
    this.ribbon.visible = false;
    this.hideBox();
    this.status = '';
  }

  private nudgeHeight(delta: number) {
    this.heightOffset = Math.max(-30, Math.min(60, this.heightOffset + delta));
    this.tools[this.tool].onHeightChange?.(this);
    this.host.syncEditor();
  }

  private pointer(e: PointerEvent) {
    const r = this.host.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    return this.host.hf.raycast(o.x, o.y, o.z, d.x, d.y, d.z);
  }

  private clearOverlays() {
    this.arrow.visible = false;
    this.ring.visible = false;
    this.highlight.visible = false;
  }

  private onDown(e: PointerEvent) {
    if (!this.host.editing || e.button !== 0) return;
    const p = this.pointer(e);
    if (!p) return;
    this.cursor = p;
    const active = this.tools[this.tool];
    if (e.pointerType === 'touch' && active.tapToConfirm) {
      if (!this.confirmTap(e, p)) return;
      active.down?.(this, p);
      return;
    }
    active.down?.(this, p, { x: e.clientX, y: e.clientY });
  }

  /** True when this touch confirms the last one. Otherwise previews the tap and waits for a second one. */
  private confirmTap(e: PointerEvent, p: WorldPoint) {
    const prev = this.tapAt;
    if (prev && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < TAP_SLOP) {
      this.tapAt = null;
      return true;
    }
    this.tapAt = { x: e.clientX, y: e.clientY };
    this.clearOverlays();
    this.tools[this.tool].hover?.(this, p);
    this.status = `${this.status ? `${this.status}. ` : ''}Tap the same place again to confirm`;
    return false;
  }

  private onMove(e: PointerEvent) {
    if (!this.host.editing) return;
    const p = this.pointer(e);
    this.cursor = p;
    const active = this.tools[this.tool];
    const screen = { x: e.clientX, y: e.clientY };
    if (active.move?.(this, p, screen)) return;
    if (!p) {
      this.clearOverlays();
      return;
    }
    this.clearOverlays();
    active.hover?.(this, p);
  }

  private onUp(e: PointerEvent) {
    if (!this.host.editing) return;
    const active = this.tools[this.tool];
    if (!active.up) return;
    active.up(this, this.pointer(e), { x: e.clientX, y: e.clientY });
  }

  /** Undoes an edit that left a point breaking the track rules, and says why. Otherwise commits it. */
  refuseIfBroken(node: number, action: string): boolean {
    const h = this.host;
    const problem = h.net.nodes.has(node) ? h.net.problemAt(node) : null;
    if (problem) {
      h.abandonEdit();
      h.toast(`${action} undone. ${problem}`, true);
      h.syncEditor();
      return true;
    }
    h.commitEdit({ scenery: true });
    return false;
  }

  /** Turns the selected point by degrees, positive to the left. */
  turnSelected(deg: number) {
    if (this.selected === null) return;
    const id = this.selected;
    this.host.pushUndo();
    this.host.net.turnNode(id, (deg * Math.PI) / 180);
    this.refuseIfBroken(id, 'Turn');
  }

  deleteSelected() {
    if (this.selected === null) return;
    const id = this.selected;
    this.edit({ scenery: true }, () => {
      this.host.net.removeNode(id);
      this.selected = null;
    });
    this.host.syncEditor();
  }

  private nodeColor = new THREE.Color();
  private scratchFwd = new THREE.Vector3();
  private scratchRight = new THREE.Vector3();
  private scratchMove = new THREE.Vector3();
  private tmp = new THREE.Object3D();

  /** Node markers scale with distance so they stay clickable at any zoom. */
  update(dt: number) {
    if (!this.host.editing) return;
    const h = this.host;
    const net = h.net;
    const cam = h.camera;

    if (this.transT < 1) {
      if (this.keys.size > 0) {
        this.finishTransition();
      } else {
        this.transT = Math.min(1, this.transT + dt / ENTER_TRANSITION_SEC);
        const e = 1 - (1 - this.transT) ** 3;
        cam.position.lerpVectors(this.transFromPos, this.transGoalPos, e);
        cam.quaternion.slerpQuaternions(this.transFromQuat, this.transGoalQuat, e);
        const nextFov = this.transFromFov + (DEFAULT_FOV - this.transFromFov) * e;
        if (Math.abs(cam.fov - nextFov) > 0.01) {
          cam.fov = nextFov;
          cam.updateProjectionMatrix();
        }
        if (this.transT >= 1) this.finishTransition();
      }
    } else {
      this.controls.update();
      const panSpeed = 0.9 * this.controls.getDistance() * dt;
      const fwd = cam.getWorldDirection(this.scratchFwd);
      fwd.y = 0;
      fwd.normalize();
      const right = this.scratchRight.set(-fwd.z, 0, fwd.x);
      const move = this.scratchMove.set(0, 0, 0);
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(panSpeed);
        cam.position.add(move);
        this.controls.target.add(move);
      }
      const ground = h.hf.height(cam.position.x, cam.position.z) + 4;
      if (cam.position.y < ground) cam.position.y = ground;
    }

    if (net.nodes.size > this.handleCapacity) {
      let nextCap = this.handleCapacity;
      while (nextCap < net.nodes.size) nextCap *= 2;
      this.handleCapacity = nextCap;
      this.root.remove(this.handles);
      this.handles.dispose();
      this.handles = new THREE.InstancedMesh(this.handleGeo, this.handleMat, nextCap);
      this.handles.renderOrder = 11;
      this.handles.frustumCulled = false;
      this.root.add(this.handles);
    }

    let i = 0;
    const camPos = cam.position;
    for (const n of net.nodes.values()) {
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
              : net.stationAt(n.id)
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
