// A 2D map of the whole railway, drawn from the same data as the simulation.
import type { Game } from '../game';
import type { Train } from '../rail/sim';
import { keyOf } from '../rail/sim';
import { RES, WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';

const REDRAW_MS = 200;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
/** Zoom from which signals are drawn: below it they'd only be clutter. */
const SIGNAL_ZOOM = 2.5;
const PICK_PX = 14;

// Map colours: signal colours mean signal aspects only, as everywhere else in the interface.
const COLOR = {
  track: '#e9e4d2',
  occupied: '#c7a350',
  station: '#2f62a8',
  train: '#e9e4d2',
  driven: '#c7a350',
  label: '#edeadd',
  red: '#e5392c',
  yellow: '#f0a62b',
  green: '#39c46f',
};

export class OverviewMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private terrainFor: unknown = null;
  private timer = 0;
  /** World point at the centre of the view, and zoom where 1 fits the whole world. */
  private cx = 0;
  private cz = 0;
  private zoom = 1;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;

  constructor(
    private game: Game,
    private panel: HTMLElement,
  ) {
    this.canvas = panel.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle(open = !this.open) {
    this.panel.hidden = !open;
    this.game.hud.syncMapButton(open);
    if (open) {
      this.terrainFor = null; // The ground may have been reshaped since the map was last open
      // Start centred on what the player is looking at.
      const t = this.game.driven;
      const at = this.game.editing ? this.game.editor.controls.target : t ? this.game.sim.head(t) : null;
      if (at && this.zoom > 1) {
        this.cx = at.x;
        this.cz = at.z;
      }
      this.draw();
    }
  }

  /** Called every frame; redraws a few times a second while open. */
  update() {
    if (!this.open) return;
    const now = performance.now();
    if (now - this.timer < REDRAW_MS) return;
    this.timer = now;
    this.draw();
  }

  private get size() {
    return this.canvas.width;
  }

  /** Pixels per metre. */
  private get scale() {
    return (this.size / WORLD_SIZE) * this.zoom;
  }

  private toPx(x: number, z: number): [number, number] {
    const s = this.scale;
    return [(x - this.cx) * s + this.size / 2, (z - this.cz) * s + this.size / 2];
  }

  private toWorld(px: number, py: number) {
    const s = this.scale;
    return { x: (px - this.size / 2) / s + this.cx, z: (py - this.size / 2) / s + this.cz };
  }

  private clampView() {
    const half = WORLD_SIZE / 2;
    const room = half - half / this.zoom;
    this.cx = Math.max(-room, Math.min(room, this.cx));
    this.cz = Math.max(-room, Math.min(room, this.cz));
  }

  /** One pixel per grid cell, coloured by height. Rebuilt only when the terrain object changes. */
  private terrainImage() {
    const hf = this.game.hf;
    if (this.terrain && this.terrainFor === hf && !hf.dirty) return this.terrain;
    const c = this.terrain ?? document.createElement('canvas');
    c.width = RES;
    c.height = RES;
    const g = c.getContext('2d')!;
    const img = g.createImageData(RES, RES);
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const h = hf.h[j * hf.stride + i];
        const k = (j * RES + i) * 4;
        if (h < WATER_LEVEL) {
          img.data.set([22, 52, 66, 255], k);
        } else {
          const v = Math.min(1, h / 220);
          img.data.set([38 + v * 70, 64 + v * 52, 52 + v * 40, 255], k);
        }
      }
    }
    g.putImageData(img, 0, 0);
    this.terrain = c;
    this.terrainFor = hf;
    return c;
  }

  draw() {
    const g = this.game;
    const ctx = this.ctx;
    const size = this.size;
    ctx.fillStyle = '#122629';
    ctx.fillRect(0, 0, size, size);
    // Terrain
    const [x0, y0] = this.toPx(-WORLD_SIZE / 2, -WORLD_SIZE / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainImage(), x0, y0, WORLD_SIZE * this.scale, WORLD_SIZE * this.scale);

    // Track, with occupied sections picked out so a red signal can be explained.
    const net = g.net;
    ctx.lineCap = 'round';
    for (const [id, geo] of net.geom) {
      // A train standing on a section shows thick; a section only locked for a train's route shows thin.
      const occupied = (g.sim.occ.get(id)?.length ?? 0) > 0;
      ctx.strokeStyle = occupied || g.sim.segClaims.has(id) ? COLOR.occupied : COLOR.track;
      ctx.lineWidth = occupied ? 3.5 : 1.6;
      ctx.beginPath();
      for (let i = 0; i < geo.n; i++) {
        const [px, py] = this.toPx(geo.pos[i * 3], geo.pos[i * 3 + 2]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    if (this.zoom >= SIGNAL_ZOOM) {
      for (const n of net.nodes.values()) {
        for (const side of [1, -1] as const) {
          if (!n.signals[side]) continue;
          const aspect = g.sim.aspects.get(keyOf(n.id, side)) ?? 'green';
          // Signals stand on the right of the trains they control.
          const [px, py] = this.toPx(n.x - n.dz * side * 6, n.z + n.dx * side * 6);
          ctx.fillStyle = COLOR[aspect];
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.font = '600 12px Overpass, sans-serif';
    ctx.textBaseline = 'middle';
    for (const st of net.stations) {
      const n = net.nodes.get(st.nodeId);
      if (!n) continue;
      const [px, py] = this.toPx(n.x, n.z);
      ctx.fillStyle = COLOR.station;
      ctx.strokeStyle = COLOR.track;
      ctx.lineWidth = 1.5;
      ctx.fillRect(px - 5, py - 5, 10, 10);
      ctx.strokeRect(px - 5, py - 5, 10, 10);
      this.label(st.name, px + 9, py);
    }

    for (const t of g.sim.trains) this.drawTrain(t, t === g.driven);
  }

  private label(text: string, x: number, y: number) {
    const ctx = this.ctx;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10, 21, 22, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = COLOR.label;
    ctx.fillText(text, x, y);
  }

  private drawTrain(t: Train, driven: boolean) {
    const ctx = this.ctx;
    const sim = this.game.sim;
    ctx.strokeStyle = driven ? COLOR.driven : COLOR.train;
    ctx.lineWidth = Math.max(4, 3 * this.scale);
    ctx.beginPath();
    for (let d = 0; d <= t.length; d += 8) {
      const p = sim.behind(t, Math.min(d, t.length));
      const [px, py] = this.toPx(p.x, p.z);
      if (d === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // An arrowhead shows which way it's going.
    const h = sim.head(t);
    const l = Math.hypot(h.tx, h.tz) || 1;
    const fx = (h.tx * h.dir) / l;
    const fz = (h.tz * h.dir) / l;
    const [px, py] = this.toPx(h.x, h.z);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(px + fx * 9, py + fz * 9);
    ctx.lineTo(px - fz * 6, py + fx * 6);
    ctx.lineTo(px + fz * 6, py - fx * 6);
    ctx.fill();
    this.label(t.name, px + 10, py - 10);
  }

  private pointerPx(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.size, y: ((e.clientY - r.top) / r.height) * this.size };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.pointerPx(e);
    const before = this.toWorld(p.x, p.y);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    // Keep the point under the pointer still while zooming.
    const after = this.toWorld(p.x, p.y);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
    this.clampView();
    this.draw();
  }

  private onDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pointerPx(e);
    this.drag = { x: p.x, y: p.y, cx: this.cx, cz: this.cz, moved: false };
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) return;
    const p = this.pointerPx(e);
    const dx = p.x - this.drag.x;
    const dy = p.y - this.drag.y;
    if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.cx = this.drag.cx - dx / this.scale;
    this.cz = this.drag.cz - dy / this.scale;
    this.clampView();
    this.draw();
  }

  /** A click picks a train to drive or, in the editor, moves the camera there. */
  private onUp(e: PointerEvent) {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.moved) return;
    const p = this.pointerPx(e);
    const g = this.game;
    const train = this.trainAt(p.x, p.y);
    if (train && !g.editing) {
      g.setDriven(train);
      g.hud.toast(`Now following ${train.name}`);
      this.draw();
      return;
    }
    const w = this.toWorld(p.x, p.y);
    if (g.editing) {
      g.editor.lookAt(w.x, w.z);
      this.toggle(false);
    }
  }

  private trainAt(px: number, py: number) {
    let best: { t: Train; d: number } | null = null;
    for (const t of this.game.sim.trains) {
      for (let d = 0; d <= t.length; d += 8) {
        const q = this.game.sim.behind(t, d);
        const [qx, qy] = this.toPx(q.x, q.z);
        const dist = Math.hypot(qx - px, qy - py);
        if (dist < PICK_PX && (!best || dist < best.d)) best = { t, d: dist };
      }
    }
    return best?.t ?? null;
  }
}
