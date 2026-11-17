// Trees, rocks and buildings. Random nature comes from the seed; "placed" items are the player's.
import * as THREE from 'three';

import type { Network } from '../rail/network';
import type { Heightfield } from '../world/heightfield';
import { WORLD_SIZE } from '../world/heightfield';
import type { PlacedItem, SceneryExclusion } from '../world/scenery';
import { generateScenery } from '../world/scenery';
import type { Assets } from './assets';

const REGIONS = 8;

export class ScatterRenderer {
  group = new THREE.Group();
  placed: PlacedItem[] = [];
  exclusions: SceneryExclusion[] = [];
  generated: PlacedItem[] = [];
  private density = 1;
  private tmp = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
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
    const items = new Map<string, PlacedItem[]>();
    const push = (it: PlacedItem) => {
      const rx = Math.max(0, Math.min(REGIONS - 1, Math.floor(((it.x + half) / WORLD_SIZE) * REGIONS)));
      const rz = Math.max(0, Math.min(REGIONS - 1, Math.floor(((it.z + half) / WORLD_SIZE) * REGIONS)));
      const key = `${it.type}|${rx}|${rz}`;
      let list = items.get(key);
      if (!list) items.set(key, (list = []));
      list.push(it);
    };

    this.generated = generateScenery(hf, net, this.density, this.exclusions);
    for (const it of this.generated) push(it);
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

  /** Finds a generated scenery item close to a point, for the delete tool. */
  generatedNear(x: number, z: number, radius: number): PlacedItem | null {
    let best: PlacedItem | null = null;
    let bd = radius * radius;
    for (const it of this.generated) {
      const d = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    return best;
  }
}
