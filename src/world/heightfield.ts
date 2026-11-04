import { fbm, ridged, smoothstep } from '../core/noise';
// Terrain heights. "base" holds noise plus editor brush work; "h" adds embankments and cuttings around track.
import type { Network, Segment } from '../rail/network';

export type Preset = 'alpine' | 'plains' | 'desert' | 'islands';

export const WORLD_SIZE = 3200;
export const RES = 512;
export const WATER_LEVEL = 0;
/** Gap between rail and ground above which the track becomes a bridge. */
export const BRIDGE_GAP = 6.5;
const GROUND_BELOW_RAIL = 0.68;

export function riverCenter(x: number) {
  return 170 * Math.sin(x * 0.0021 + 1.1) + 70 * Math.sin(x * 0.0051);
}

export function baseHeight(preset: Preset, seed: number, x: number, z: number): number {
  const half = WORLD_SIZE / 2;
  const r = Math.hypot(x, z) / half;
  const nx = x + seed * 311;
  const nz = z - seed * 173;
  let h: number;
  let riverDepth = -4;
  let riverWidth = 1;
  switch (preset) {
    case 'plains':
      h =
        14 +
        fbm(nx * 0.0014, nz * 0.0014, 5) * 26 +
        ridged(nx * 0.0009, nz * 0.0009, 3) * 16 * smoothstep(0.5, 0.85, r);
      break;
    case 'desert': {
      const n = fbm(nx * 0.0011, nz * 0.0011, 5);
      const raw = 18 + n * 50 + ridged(nx * 0.0016, nz * 0.0016, 3) * 60 * smoothstep(0.3, 0.75, r);
      // Terracing turns rolling hills into mesas.
      const step = 16;
      const t = raw / step;
      const f = t - Math.floor(t);
      h = (Math.floor(t) + smoothstep(0.62, 0.8, f)) * step;
      riverDepth = -2.5;
      riverWidth = 0.75;
      break;
    }
    case 'islands': {
      const land = fbm(nx * 0.0013, nz * 0.0013, 5);
      h = (land - 0.46) * 150 + ridged(nx * 0.002, nz * 0.002, 3) * 30 * smoothstep(0.5, 0.72, land);
      riverWidth = 1.4;
      break;
    }
    default: {
      const hills = fbm(nx * 0.0013, nz * 0.0013, 5) * 30 + 20;
      const mtn = ridged(nx * 0.0011, nz * 0.0011, 5) * 430 * smoothstep(0.42, 0.86, r) ** 1.3;
      h = hills + mtn;
      break;
    }
  }
  // A river crosses every preset, so bridges have something to span.
  const d = Math.abs(z - riverCenter(x));
  const rc = smoothstep(110 * riverWidth, 26 * riverWidth, d);
  h = h + (riverDepth - h) * rc;
  // The world is an island; the sea hides the map edge.
  const edge = smoothstep(0.84, 0.98, r);
  return h + (-14 - h) * edge;
}

export class Heightfield {
  preset: Preset;
  seed: number;
  readonly stride = RES + 1;
  /** Noise with brush edits applied; what the map generator and the editor share. */
  base = new Float32Array((RES + 1) * (RES + 1));
  /** Pristine noise, kept so saves only need to store the brush differences. */
  pristine = new Float32Array((RES + 1) * (RES + 1));
  h = new Float32Array((RES + 1) * (RES + 1));
  private wBest = new Float32Array((RES + 1) * (RES + 1));
  private tBest = new Float32Array((RES + 1) * (RES + 1));
  /** Grid cell bounds touched since the renderer last updated, as [minI, minJ, maxI, maxJ]. */
  dirty: [number, number, number, number] | null = null;

  constructor(preset: Preset, seed: number) {
    this.preset = preset;
    this.seed = seed;
    this.generate();
  }

  generate() {
    const half = WORLD_SIZE / 2;
    const cell = WORLD_SIZE / RES;
    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const v = baseHeight(this.preset, this.seed, i * cell - half, j * cell - half);
        this.base[j * this.stride + i] = v;
      }
    }
    this.pristine.set(this.base);
    this.h.set(this.base);
    this.dirty = [0, 0, RES, RES];
  }

  private sampleArray(arr: Float32Array, x: number, z: number): number {
    const half = WORLD_SIZE / 2;
    const fx = Math.max(0, Math.min(RES - 0.0001, ((x + half) / WORLD_SIZE) * RES));
    const fz = Math.max(0, Math.min(RES - 0.0001, ((z + half) / WORLD_SIZE) * RES));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const s = this.stride;
    const a = arr[j * s + i];
    const b = arr[j * s + i + 1];
    const c = arr[(j + 1) * s + i];
    const d = arr[(j + 1) * s + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }

  height(x: number, z: number) {
    return this.sampleArray(this.h, x, z);
  }

  baseAt(x: number, z: number) {
    return this.sampleArray(this.base, x, z);
  }

  normalY(x: number, z: number) {
    const e = 4;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return 1 / Math.hypot(dx / (2 * e), 1, dz / (2 * e));
  }

  /** Ray-terrain intersection for the editor cursor. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist = 9000) {
    let t = 0;
    let prevT = 0;
    let step = 4;
    while (t < maxDist) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (Math.abs(x) > WORLD_SIZE / 2 || Math.abs(z) > WORLD_SIZE / 2) {
        if ((x * dx > 0 && Math.abs(x) > WORLD_SIZE / 2) || (z * dz > 0 && Math.abs(z) > WORLD_SIZE / 2)) return null;
      }
      const gap = y - Math.max(this.height(x, z), WATER_LEVEL);
      if (gap <= 0) {
        // Refine by bisection.
        let a = prevT;
        let b = t;
        for (let i = 0; i < 8; i++) {
          const m = (a + b) / 2;
          const g = oy + dy * m - Math.max(this.height(ox + dx * m, oz + dz * m), WATER_LEVEL);
          if (g > 0) a = m;
          else b = m;
        }
        return { x: ox + dx * b, y: oy + dy * b, z: oz + dz * b };
      }
      prevT = t;
      step = Math.max(2, gap * 0.45);
      t += step;
    }
    return null;
  }

  private markDirty(i0: number, j0: number, i1: number, j1: number) {
    if (!this.dirty) this.dirty = [i0, j0, i1, j1];
    else {
      const d = this.dirty;
      d[0] = Math.min(d[0], i0);
      d[1] = Math.min(d[1], j0);
      d[2] = Math.max(d[2], i1);
      d[3] = Math.max(d[3], j1);
    }
  }

  /** Editor brush. mode: raise, lower, smooth or flatten toward flattenTo. */
  brush(
    mode: 'raise' | 'lower' | 'smooth' | 'flatten',
    x: number,
    z: number,
    radius: number,
    strength: number,
    flattenTo = 0,
  ) {
    const half = WORLD_SIZE / 2;
    const cell = WORLD_SIZE / RES;
    const i0 = Math.max(1, Math.floor((x - radius + half) / cell));
    const i1 = Math.min(RES - 1, Math.ceil((x + radius + half) / cell));
    const j0 = Math.max(1, Math.floor((z - radius + half) / cell));
    const j1 = Math.min(RES - 1, Math.ceil((z + radius + half) / cell));
    const s = this.stride;
    const b = this.base;
    const copy = mode === 'smooth' ? b.slice() : b;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * cell - half;
        const pz = j * cell - half;
        const d = Math.hypot(px - x, pz - z);
        if (d > radius) continue;
        const f = smoothstep(radius, radius * 0.25, d) * strength;
        const k = j * s + i;
        if (mode === 'raise') b[k] += f * 1.6;
        else if (mode === 'lower') b[k] -= f * 1.6;
        else if (mode === 'flatten') b[k] += (flattenTo - b[k]) * Math.min(1, f * 0.3);
        else {
          const avg = (copy[k - 1] + copy[k + 1] + copy[k - s] + copy[k + s]) / 4;
          b[k] += (avg - b[k]) * Math.min(1, f * 0.6);
        }
      }
    }
  }

  /** True for a segment sample that should be carried by a bridge rather than an embankment. */
  isBridgeSample(seg: Segment, x: number, y: number, z: number) {
    if (seg.bridge === 'none') return false;
    if (seg.bridge === 'force') return true;
    const g = this.baseAt(x, z);
    return y - g > BRIDGE_GAP || g < WATER_LEVEL + 0.8;
  }

  /** Recomputes the graded terrain from base plus track corridors and flags the changed area. */
  grade(net: Network) {
    const half = WORLD_SIZE / 2;
    const cell = WORLD_SIZE / RES;
    const s = this.stride;
    const w = this.wBest;
    const t = this.tBest;
    w.fill(0);
    const stamp = (x: number, z: number, target: number, core: number, slope: number) => {
      const groundNow = this.baseAt(x, z);
      const diff = Math.abs(target - groundNow);
      const reach = core + Math.min(55, Math.max(6, diff * slope));
      const i0 = Math.max(0, Math.floor((x - reach + half) / cell));
      const i1 = Math.min(RES, Math.ceil((x + reach + half) / cell));
      const j0 = Math.max(0, Math.floor((z - reach + half) / cell));
      const j1 = Math.min(RES, Math.ceil((z + reach + half) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = i * cell - half;
          const pz = j * cell - half;
          const d = Math.hypot(px - x, pz - z);
          const f = d <= core ? 1 : smoothstep(reach, core, d);
          const k = j * s + i;
          if (f > w[k]) {
            w[k] = f;
            t[k] = target;
          }
        }
      }
    };
    for (const seg of net.segs.values()) {
      const g = net.geom.get(seg.id);
      if (!g) continue;
      for (let i = 0; i < g.n; i += 2) {
        const x = g.pos[i * 3];
        const y = g.pos[i * 3 + 1];
        const z = g.pos[i * 3 + 2];
        if (this.isBridgeSample(seg, x, y, z)) continue;
        stamp(x, z, y - GROUND_BELOW_RAIL, 5.5, 1.9);
      }
    }
    // Level ground for platforms and station buildings.
    for (const st of net.stations) {
      const node = net.nodes.get(st.nodeId);
      if (!node) continue;
      const rx = -node.dz * st.platformSide;
      const rz = node.dx * st.platformSide;
      for (let off = -st.length / 2; off <= st.length / 2; off += 8) {
        // The forecourt sits flush with the platform top, starting just behind the platform.
        const px = node.x + node.dx * off + rx * 17;
        const pz = node.z + node.dz * off + rz * 17;
        stamp(px, pz, node.y + 0.92, 10.5, 1.8);
      }
    }
    let minI = RES;
    let minJ = RES;
    let maxI = 0;
    let maxJ = 0;
    let changed = false;
    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const k = j * s + i;
        const v = this.base[k] + (t[k] - this.base[k]) * w[k];
        const nv = w[k] > 0 ? v : this.base[k];
        if (Math.abs(nv - this.h[k]) > 0.001) {
          this.h[k] = nv;
          changed = true;
          if (i < minI) minI = i;
          if (i > maxI) maxI = i;
          if (j < minJ) minJ = j;
          if (j > maxJ) maxJ = j;
        }
      }
    }
    if (changed) this.markDirty(minI, minJ, maxI, maxJ);
  }

  /** Sparse brush differences for saving. */
  exportEdits(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.base.length; k++) {
      const d = this.base[k] - this.pristine[k];
      if (Math.abs(d) > 0.02) out.push(k, Math.round(d * 50) / 50);
    }
    return out;
  }

  importEdits(edits: number[]) {
    this.base.set(this.pristine);
    for (let i = 0; i < edits.length; i += 2) this.base[edits[i]] = this.pristine[edits[i]] + edits[i + 1];
  }
}
