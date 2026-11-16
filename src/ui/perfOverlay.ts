// A developer overlay with frame time and renderer counts, opened with ?debug in the URL or the ` key.
import type * as THREE from 'three';

import type { Game } from '../game';

const REFRESH_MS = 500;

export class PerfOverlay {
  private last = 0;
  private frameMs = 0;

  constructor(
    private game: Game,
    private el: HTMLElement,
  ) {
    el.hidden = !new URLSearchParams(location.search).has('debug');
  }

  toggle() {
    this.el.hidden = !this.el.hidden;
  }

  /** Call after rendering a frame, before renderer.info is reset for the next one. */
  update(info: THREE.WebGLInfo, dt: number) {
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
    if (this.el.hidden) return;
    const now = performance.now();
    if (now - this.last < REFRESH_MS) return;
    this.last = now;
    const g = this.game;
    const quality = g.quality === 'auto' ? `auto, ${Math.round(g.autoScale * 100)}% resolution` : g.quality;
    this.el.textContent = [
      `${Math.round(g.fps)} fps, ${this.frameMs.toFixed(1)} ms`,
      `${info.render.calls} draw calls`,
      `${(info.render.triangles / 1000).toFixed(0)}k triangles`,
      `${info.memory.geometries} geometries, ${info.memory.textures} textures`,
      `pixel ratio ${g.renderer.getPixelRatio().toFixed(2)}`,
      `quality ${quality}`,
    ].join('\n');
  }
}
