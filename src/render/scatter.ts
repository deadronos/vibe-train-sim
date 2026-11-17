// Trees, rocks and buildings with incremental per-region updates, distance LODs and shadow culling.
import * as THREE from 'three';

import type { Network } from '../rail/network';
import type { Heightfield } from '../world/heightfield';
import { WORLD_SIZE } from '../world/heightfield';
import type { PlacedItem, SceneryExclusion, SceneryType } from '../world/scenery';
import { buildTrackMask, generateSceneryRegion } from '../world/scenery';
import type { Assets } from './assets';
import { chunkXZDistance, selectLod } from './terrain';

export const SCATTER_REGIONS = 8;
const SCATTER_LOD_THRESHOLDS = [40, 260] as const;
const SCATTER_LOD_HYSTERESIS = 25;
const SCATTER_SHADOW_RADIUS = 280;

const LOD_ASSET: Partial<Record<SceneryType, readonly [string, string, string]>> = {
  tree_pine: ['tree_pine', 'tree_pine_lod1', 'tree_pine_lod2'],
  tree_oak: ['tree_oak', 'tree_oak_lod1', 'tree_oak_lod2'],
  tree_birch: ['tree_birch', 'tree_birch_lod1', 'tree_birch_lod2'],
};

function assetForLod(type: SceneryType, lod: number): string | null {
  if (lod === 2 && (type === 'rock_a' || type === 'rock_b')) return null;
  const entry = LOD_ASSET[type];
  return entry ? entry[lod] : type;
}

interface ScatterRegion {
  rx: number;
  rz: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  generated: PlacedItem[];
  byType: Map<SceneryType, THREE.Matrix4[]>;
  box: THREE.Box3;
  hasItems: boolean;
  generatedDirty: boolean;
  meshesDirty: boolean;
  lod: number;
  inShadow: boolean;
  builtLod: number;
  meshes: THREE.InstancedMesh[];
}

export class ScatterRenderer {
  group = new THREE.Group();
  readonly stats = { regionRegens: 0, regionMeshRebuilds: 0 };
  placed: PlacedItem[] = [];
  exclusions: SceneryExclusion[] = [];
  generated: PlacedItem[] = [];
  private density = 1;
  private regions: ScatterRegion[] = [];
  private tmp = new THREE.Object3D();
  private perRegionGroup = new THREE.Group();
  private lod1Group = new THREE.Group();
  private lod2Group = new THREE.Group();
  private lod1BatchDirty = true;
  private lod2BatchDirty = true;
  private batchBucket = new Map<string, THREE.Matrix4[]>();

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    const size = WORLD_SIZE / SCATTER_REGIONS;
    const half = WORLD_SIZE / 2;
    for (let rz = 0; rz < SCATTER_REGIONS; rz++) {
      for (let rx = 0; rx < SCATTER_REGIONS; rx++) {
        const minX = rx * size - half;
        const minZ = rz * size - half;
        this.regions.push({
          rx,
          rz,
          minX,
          minZ,
          maxX: minX + size,
          maxZ: minZ + size,
          generated: [],
          byType: new Map(),
          box: new THREE.Box3(),
          hasItems: false,
          generatedDirty: true,
          meshesDirty: true,
          lod: -1,
          inShadow: false,
          builtLod: -1,
          meshes: [],
        });
      }
    }
    this.group.add(this.perRegionGroup, this.lod1Group, this.lod2Group);
    scene.add(this.group);
  }

  setDensity(d: number) {
    this.density = d;
  }

  private regionCoords(x: number, z: number): [number, number] {
    const half = WORLD_SIZE / 2;
    const rx = Math.max(0, Math.min(SCATTER_REGIONS - 1, Math.floor(((x + half) / WORLD_SIZE) * SCATTER_REGIONS)));
    const rz = Math.max(0, Math.min(SCATTER_REGIONS - 1, Math.floor(((z + half) / WORLD_SIZE) * SCATTER_REGIONS)));
    return [rx, rz];
  }

  markAllDirty() {
    for (const r of this.regions) {
      r.generatedDirty = true;
      r.meshesDirty = true;
    }
  }

  markPlacedDirty(x: number, z: number) {
    const [rx, rz] = this.regionCoords(x, z);
    this.regions[rz * SCATTER_REGIONS + rx].meshesDirty = true;
  }

  markExclusionDirty(ex: SceneryExclusion) {
    if ('r' in ex) {
      this.markBoundsDirty(ex.x - ex.r, ex.z - ex.r, ex.x + ex.r, ex.z + ex.r, true);
    } else {
      this.markBoundsDirty(ex.minX, ex.minZ, ex.maxX, ex.maxZ, true);
    }
  }

  markBoundsDirty(minX: number, minZ: number, maxX: number, maxZ: number, regen = true) {
    const [rx0, rz0] = this.regionCoords(minX, minZ);
    const [rx1, rz1] = this.regionCoords(maxX, maxZ);
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        const r = this.regions[rz * SCATTER_REGIONS + rx];
        if (regen) r.generatedDirty = true;
        r.meshesDirty = true;
      }
    }
  }

  rebuild(hf: Heightfield, net: Network) {
    this.markAllDirty();
    this.sync(hf, net);
  }

  private clearRegionMeshes(r: ScatterRegion) {
    for (const m of r.meshes) {
      this.perRegionGroup.remove(m);
      m.dispose();
    }
    r.meshes.length = 0;
    r.builtLod = -1;
  }

  /** Rebuilds only the regions marked dirty since the last sync. */
  sync(hf: Heightfield, net: Network) {
    let anyGen = false;
    let anyMesh = false;
    for (const r of this.regions) {
      if (r.generatedDirty) anyGen = true;
      if (r.meshesDirty) anyMesh = true;
    }
    if (!anyGen && !anyMesh) return;

    const mask = anyGen ? buildTrackMask(net) : undefined;
    if (anyGen) {
      for (const r of this.regions) {
        if (!r.generatedDirty) continue;
        r.generatedDirty = false;
        r.generated = generateSceneryRegion(hf, net, r.rx, r.rz, SCATTER_REGIONS, this.density, this.exclusions, mask);
        r.meshesDirty = true;
        this.stats.regionRegens++;
      }
      const flat: PlacedItem[] = [];
      for (const r of this.regions) {
        for (let i = 0; i < r.generated.length; i++) flat.push(r.generated[i]);
      }
      this.generated = flat;
    }

    // Group placed items by region only when rebuilding dirty region meshes.
    const placedByRegion = new Map<number, PlacedItem[]>();
    for (const p of this.placed) {
      const [rx, rz] = this.regionCoords(p.x, p.z);
      const idx = rz * SCATTER_REGIONS + rx;
      if (!this.regions[idx].meshesDirty) continue;
      let list = placedByRegion.get(idx);
      if (!list) placedByRegion.set(idx, (list = []));
      list.push(p);
    }

    const t = this.tmp;
    for (let idx = 0; idx < this.regions.length; idx++) {
      const r = this.regions[idx];
      if (!r.meshesDirty) continue;
      r.meshesDirty = false;
      this.clearRegionMeshes(r);
      r.byType.clear();
      r.box.makeEmpty();
      r.hasItems = false;

      const pushItem = (it: PlacedItem) => {
        const y = hf.height(it.x, it.z) - 0.05;
        t.position.set(it.x, y, it.z);
        t.rotation.set(0, it.rot, 0);
        t.scale.setScalar(it.scale);
        t.updateMatrix();
        let list = r.byType.get(it.type);
        if (!list) r.byType.set(it.type, (list = []));
        list.push(t.matrix.clone());
        r.box.expandByPoint(t.position);
        r.hasItems = true;
      };

      for (let i = 0; i < r.generated.length; i++) pushItem(r.generated[i]);
      const extra = placedByRegion.get(idx);
      if (extra) {
        for (let i = 0; i < extra.length; i++) pushItem(extra[i]);
      }
      if (r.hasItems) {
        // Expand XZ and Y for tree crowns and tall roofs so shadow frustum intersection stays conservative.
        r.box.min.x -= 6;
        r.box.min.y -= 2;
        r.box.min.z -= 6;
        r.box.max.x += 6;
        r.box.max.y += 18;
        r.box.max.z += 6;
      }
      if (r.lod === 1 && !r.inShadow) this.lod1BatchDirty = true;
      else if (r.lod === 2) this.lod2BatchDirty = true;
      this.stats.regionMeshRebuilds++;
    }
  }

  private ensureRegionMeshes(r: ScatterRegion, lod: number) {
    if (r.builtLod === lod) return;
    this.clearRegionMeshes(r);
    r.builtLod = lod;
    if (!r.hasItems) return;
    for (const [type, list] of r.byType) {
      const assetName = assetForLod(type, lod);
      if (!assetName) continue;
      for (const prim of this.assets.primitives(assetName)) {
        const inst = new THREE.InstancedMesh(prim.geometry, prim.material, list.length);
        for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = r.inShadow;
        inst.receiveShadow = true;
        inst.frustumCulled = true;
        inst.computeBoundingBox();
        inst.computeBoundingSphere();
        this.perRegionGroup.add(inst);
        r.meshes.push(inst);
      }
    }
  }

  private rebuildBatchGroup(targetGroup: THREE.Group, targetLod: number, requireNonShadow: boolean, quadrants = 1) {
    for (const child of [...targetGroup.children]) {
      targetGroup.remove(child);
      (child as THREE.InstancedMesh).dispose?.();
    }
    for (const list of this.batchBucket.values()) list.length = 0;

    const qShift = SCATTER_REGIONS / quadrants;
    for (let i = 0; i < this.regions.length; i++) {
      const r = this.regions[i];
      if (!r.hasItems || r.lod !== targetLod) continue;
      if (requireNonShadow && r.inShadow) continue;
      const qx = Math.floor(r.rx / qShift);
      const qz = Math.floor(r.rz / qShift);
      for (const [type, list] of r.byType) {
        const assetName = assetForLod(type, targetLod);
        if (!assetName) continue;
        const bKey = quadrants > 1 ? `${assetName}|${qx}|${qz}` : assetName;
        let dst = this.batchBucket.get(bKey);
        if (!dst) this.batchBucket.set(bKey, (dst = []));
        for (let k = 0; k < list.length; k++) dst.push(list[k]);
      }
    }

    for (const [bKey, list] of this.batchBucket) {
      if (!list.length) continue;
      const sep = bKey.indexOf('|');
      const assetName = sep >= 0 ? bKey.slice(0, sep) : bKey;
      for (const prim of this.assets.primitives(assetName)) {
        const inst = new THREE.InstancedMesh(prim.geometry, prim.material, list.length);
        for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = false;
        inst.receiveShadow = targetLod < 2;
        inst.frustumCulled = true;
        inst.computeBoundingBox();
        inst.computeBoundingSphere();
        targetGroup.add(inst);
      }
    }
  }

  /** Selects per-region LODs and culls shadow casters outside the directional shadow frustum. */
  updateLOD(camPos: THREE.Vector3, shadowFrustum: THREE.Frustum | null, focusPos: THREE.Vector3 = camPos) {
    for (let i = 0; i < this.regions.length; i++) {
      const r = this.regions[i];
      const dist = chunkXZDistance(camPos.x, camPos.z, r.minX, r.minZ, r.maxX, r.maxZ);
      const nextLod = selectLod(dist, r.lod, SCATTER_LOD_THRESHOLDS, SCATTER_LOD_HYSTERESIS);
      const nextShadow =
        shadowFrustum !== null &&
        r.hasItems &&
        nextLod < 2 &&
        chunkXZDistance(focusPos.x, focusPos.z, r.minX, r.minZ, r.maxX, r.maxZ) <= SCATTER_SHADOW_RADIUS &&
        shadowFrustum.intersectsBox(r.box);
      const wasPerRegion = r.lod === 0 || r.inShadow;
      const isPerRegion = nextLod === 0 || nextShadow;

      if (nextLod !== r.lod || nextShadow !== r.inShadow) {
        if (r.lod === 1 && !r.inShadow) this.lod1BatchDirty = true;
        else if (r.lod === 2) this.lod2BatchDirty = true;
        if (nextLod === 1 && !nextShadow) this.lod1BatchDirty = true;
        else if (nextLod === 2) this.lod2BatchDirty = true;
        r.lod = nextLod;
        r.inShadow = nextShadow;
      }

      if (isPerRegion) {
        this.ensureRegionMeshes(r, nextLod);
        for (let m = 0; m < r.meshes.length; m++) {
          r.meshes[m].visible = true;
          r.meshes[m].castShadow = nextShadow;
        }
      } else if (wasPerRegion) {
        for (let m = 0; m < r.meshes.length; m++) r.meshes[m].visible = false;
      } else if (r.meshes.length && r.builtLod !== nextLod) {
        for (let m = 0; m < r.meshes.length; m++) r.meshes[m].visible = false;
      }
    }

    if (this.lod1BatchDirty) {
      this.lod1BatchDirty = false;
      this.rebuildBatchGroup(this.lod1Group, 1, true, 2);
    }
    if (this.lod2BatchDirty) {
      this.lod2BatchDirty = false;
      this.rebuildBatchGroup(this.lod2Group, 2, false, 2);
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
    const [rx0, rz0] = this.regionCoords(x - radius, z - radius);
    const [rx1, rz1] = this.regionCoords(x + radius, z + radius);
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        const list = this.regions[rz * SCATTER_REGIONS + rx].generated;
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          const d = (it.x - x) ** 2 + (it.z - z) ** 2;
          if (d < bd) {
            bd = d;
            best = it;
          }
        }
      }
    }
    return best;
  }
}
