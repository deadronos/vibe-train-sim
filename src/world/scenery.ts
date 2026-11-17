// World scenery item types, placed items, and deterministic spatial scatter generation.
import { fbm, mulberry } from '../core/noise';
import type { Network } from '../rail/network';
import type { Heightfield, Preset } from './heightfield';
import { WATER_LEVEL, WORLD_SIZE } from './heightfield';

export type SceneryType =
  | 'tree_pine'
  | 'tree_oak'
  | 'tree_birch'
  | 'rock_a'
  | 'rock_b'
  | 'house_a'
  | 'house_b'
  | 'house_c';

export const SCENERY_TYPES: Record<SceneryType, true> = {
  tree_pine: true,
  tree_oak: true,
  tree_birch: true,
  rock_a: true,
  rock_b: true,
  house_a: true,
  house_b: true,
  house_c: true,
};

export const SCENERY_LABEL: Record<SceneryType, string> = {
  tree_pine: 'Pine tree',
  tree_oak: 'Oak tree',
  tree_birch: 'Birch tree',
  rock_a: 'Small rock',
  rock_b: 'Large rock',
  house_a: 'Cottage',
  house_b: 'Long house',
  house_c: 'Town house',
};

export interface PlacedItem {
  type: SceneryType;
  x: number;
  z: number;
  rot: number;
  scale: number;
}

export type SceneryExclusion =
  | { x: number; z: number; r: number }
  | { minX: number; minZ: number; maxX: number; maxZ: number };

const GRID_CELLS = 80;
const CANDIDATES_PER_CELL = 5;

const MIX: Record<Preset, { density: number; types: [SceneryType, number][] }> = {
  alpine: {
    density: 1,
    types: [
      ['tree_pine', 0.72],
      ['tree_oak', 0.1],
      ['tree_birch', 0.1],
      ['rock_a', 0.05],
      ['rock_b', 0.03],
    ],
  },
  plains: {
    density: 0.55,
    types: [
      ['tree_oak', 0.55],
      ['tree_birch', 0.28],
      ['tree_pine', 0.1],
      ['rock_a', 0.07],
    ],
  },
  desert: {
    density: 0.3,
    types: [
      ['rock_a', 0.55],
      ['rock_b', 0.35],
      ['tree_birch', 0.1],
    ],
  },
  islands: {
    density: 0.65,
    types: [
      ['tree_oak', 0.45],
      ['tree_birch', 0.3],
      ['tree_pine', 0.13],
      ['rock_a', 0.07],
      ['rock_b', 0.05],
    ],
  },
};

function cellSeed(seed: number, cx: number, cz: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(cx, 668265263) + Math.imul(cz, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function isSceneryExcluded(x: number, z: number, exclusions: readonly SceneryExclusion[]): boolean {
  for (const ex of exclusions) {
    if ('r' in ex) {
      const dx = x - ex.x;
      const dz = z - ex.z;
      if (dx * dx + dz * dz <= ex.r * ex.r) return true;
    } else if (x >= ex.minX && x <= ex.maxX && z >= ex.minZ && z <= ex.maxZ) {
      return true;
    }
  }
  return false;
}

/**
 * Generates procedural trees and rocks using an independent per-cell spatial seed so terrain or track
 * edits in one area never reshuffle distant scenery.
 */
export function generateScenery(
  hf: Heightfield,
  net: Network,
  density = 1,
  exclusions: readonly SceneryExclusion[] = [],
): PlacedItem[] {
  if (density <= 0) return [];
  const half = WORLD_SIZE / 2;
  // Coarse mask of ground reserved for the railway.
  const MS = 400;
  const cell = WORLD_SIZE / MS;
  const mask = new Uint8Array(MS * MS);
  const stampMask = (x: number, z: number, r: number) => {
    const cx = Math.floor((x + half) / cell);
    const cz = Math.floor((z + half) / cell);
    const R = Math.ceil(r / cell);
    for (let j = Math.max(0, cz - R); j <= Math.min(MS - 1, cz + R); j++) {
      for (let i = Math.max(0, cx - R); i <= Math.min(MS - 1, cx + R); i++) mask[j * MS + i] = 1;
    }
  };
  for (const g of net.geom.values()) {
    for (let i = 0; i < g.n; i += 3) stampMask(g.pos[i * 3], g.pos[i * 3 + 2], 16);
  }
  for (const st of net.stations) {
    const n = net.nodes.get(st.nodeId);
    if (!n) continue;
    for (let d = -st.length / 2; d <= st.length / 2; d += 10) stampMask(n.x + n.dx * d, n.z + n.dz * d, 34);
  }

  const mix = MIX[hf.preset];
  const threshold = mix.density * density;
  const gridStep = WORLD_SIZE / GRID_CELLS;
  const out: PlacedItem[] = [];

  for (let cz = 0; cz < GRID_CELLS; cz++) {
    for (let cx = 0; cx < GRID_CELLS; cx++) {
      const rng = mulberry(cellSeed(hf.seed, cx, cz));
      for (let slot = 0; slot < CANDIDATES_PER_CELL; slot++) {
        // Draw all candidate numbers unconditionally so local height edits cannot shift neighbouring slots.
        const ux = rng();
        const uz = rng();
        const densityRoll = rng();
        const pick = rng();
        const rotation = rng() * Math.PI * 2;
        const size = 0.72 + rng() * 0.6;
        const altRoll = rng();
        if (densityRoll >= threshold) continue;
        const x = (cx + ux) * gridStep - half;
        const z = (cz + uz) * gridStep - half;
        if (exclusions.length && isSceneryExcluded(x, z, exclusions)) continue;
        const forest = fbm((x + hf.seed * 91) * 0.0042, (z - hf.seed * 53) * 0.0042, 3);
        if (forest < 0.47) continue;
        const y = hf.height(x, z);
        if (y < WATER_LEVEL + 2.2) continue;
        const mx = Math.min(MS - 1, Math.max(0, Math.floor((x + half) / cell)));
        const mz = Math.min(MS - 1, Math.max(0, Math.floor((z + half) / cell)));
        if (mask[mz * MS + mx]) continue;
        if (hf.normalY(x, z) < 0.86) continue;
        let acc = 0;
        let type: SceneryType = mix.types[0][0];
        for (const [t, w] of mix.types) {
          acc += w;
          if (pick <= acc) {
            type = t;
            break;
          }
        }
        if (y > 165 && type !== 'rock_a' && type !== 'rock_b') {
          if (y > 225 || altRoll < (y - 165) / 60) continue;
        }
        out.push({ type, x, z, rot: rotation, scale: type.startsWith('rock') ? size * 1.2 : size });
      }
    }
  }
  return out;
}
