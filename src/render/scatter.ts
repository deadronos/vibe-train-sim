// Trees, rocks and buildings. Random nature comes from the seed; "placed" items are the player's.
import * as THREE from 'three';
import { fbm, mulberry } from '../core/noise';
import { Network } from '../rail/network';
import { Heightfield, Preset, WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';
import { Assets } from './assets';

export type SceneryType = 'tree_pine' | 'tree_oak' | 'tree_birch' | 'rock_a' | 'rock_b' | 'house_a' | 'house_b' | 'house_c';

export interface PlacedItem {
  type: SceneryType;
  x: number;
  z: number;
  rot: number;
  scale: number;
}

const REGIONS = 8;

interface Inst {
  type: SceneryType;
  x: number;
  z: number;
  rot: number;
  scale: number;
}

const MIX: Record<Preset, { density: number; types: [SceneryType, number][] }> = {
  alpine: { density: 1, types: [['tree_pine', 0.72], ['tree_oak', 0.1], ['tree_birch', 0.1], ['rock_a', 0.05], ['rock_b', 0.03]] },
  plains: { density: 0.55, types: [['tree_oak', 0.55], ['tree_birch', 0.28], ['tree_pine', 0.1], ['rock_a', 0.07]] },
  desert: { density: 0.3, types: [['rock_a', 0.55], ['rock_b', 0.35], ['tree_birch', 0.1]] },
  islands: { density: 0.65, types: [['tree_oak', 0.45], ['tree_birch', 0.3], ['tree_pine', 0.13], ['rock_a', 0.07], ['rock_b', 0.05]] },
};

export class ScatterRenderer {
  group = new THREE.Group();
  placed: PlacedItem[] = [];
  private density = 1;
  private tmp = new THREE.Object3D();

  constructor(scene: THREE.Scene, private assets: Assets) {
    scene.add(this.group);
  }

  setDensity(d: number) {
    this.density = d;
  }

  rebuild(hf: Heightfield, net: Network) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.InstancedMesh).dispose?.();
    }
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
    const rng = mulberry(hf.seed * 7919 + 13);
    const mix = MIX[hf.preset];
    const items = new Map<string, Inst[]>();
    const push = (it: Inst) => {
      const rx = Math.min(REGIONS - 1, Math.floor(((it.x + half) / WORLD_SIZE) * REGIONS));
      const rz = Math.min(REGIONS - 1, Math.floor(((it.z + half) / WORLD_SIZE) * REGIONS));
      const key = `${it.type}|${rx}|${rz}`;
      let list = items.get(key);
      if (!list) items.set(key, (list = []));
      list.push(it);
    };
    const attempts = Math.floor(30000 * mix.density * this.density);
    for (let i = 0; i < attempts; i++) {
      const x = (rng() - 0.5) * WORLD_SIZE;
      const z = (rng() - 0.5) * WORLD_SIZE;
      const pick = rng();
      const rotation = rng() * Math.PI * 2;
      const size = 0.72 + rng() * 0.6;
      const forest = fbm((x + hf.seed * 91) * 0.0042, (z - hf.seed * 53) * 0.0042, 3);
      if (forest < 0.47) continue;
      const y = hf.height(x, z);
      if (y < WATER_LEVEL + 2.2) continue;
      const k = Math.floor((z + half) / cell) * MS + Math.floor((x + half) / cell);
      if (mask[k]) continue;
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
        if (y > 225 || rng() < (y - 165) / 60) continue;
      }
      push({ type, x, z, rot: rotation, scale: type.startsWith('rock') ? size * 1.2 : size });
    }
    for (const p of this.placed) push({ ...p });

    const t = this.tmp;
    for (const [key, list] of items) {
      const type = key.split('|')[0];
      for (const prim of this.assets.primitives(type)) {
        const inst = new THREE.InstancedMesh(prim.geometry, prim.material, list.length);
        list.forEach((it, i) => {
          t.position.set(it.x, hf.height(it.x, it.z) - 0.05, it.z);
          t.rotation.set(0, it.rot, 0);
          t.scale.setScalar(it.scale);
          t.updateMatrix();
          inst.setMatrixAt(i, t.matrix);
        });
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        this.group.add(inst);
      }
    }
  }

  /** Finds a player-placed item close to a point, for the delete tool. */
  placedNear(x: number, z: number, radius: number) {
    let best = -1;
    let bd = radius * radius;
    this.placed.forEach((p, i) => {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
}
