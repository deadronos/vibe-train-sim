// Builds rails, sleepers, ballast and bridges by sweeping profiles per segment and merging into world chunks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Network, SegGeom } from '../rail/network';
import { DIAMOND_MAX_DY } from '../rail/network';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';
import type { Assets } from './assets';

const CHUNKS = 8;
type Profile = [number, number][];

const RAIL: Profile = [
  [-0.04, -0.17],
  [0.04, -0.17],
  [0.04, -0.15],
  [0.016, -0.14],
  [0.016, -0.03],
  [0.036, -0.02],
  [0.036, 0.0],
  [-0.036, 0.0],
  [-0.036, -0.02],
  [-0.016, -0.03],
  [-0.016, -0.14],
  [-0.04, -0.15],
];
const BALLAST: Profile = [
  [-2.5, -0.74],
  [2.5, -0.74],
  [1.45, -0.23],
  [-1.45, -0.23],
];
const DECK: Profile = [
  [-2.9, -0.62],
  [2.9, -0.62],
  [2.9, -0.3],
  [-2.9, -0.3],
];
const GIRDER: Profile = [
  [-1.7, -2.3],
  [1.7, -2.3],
  [2.4, -0.62],
  [-2.4, -0.62],
];
const BOX = (cx: number, cy: number, w: number, h: number): Profile => [
  [cx - w, cy - h],
  [cx + w, cy - h],
  [cx + w, cy + h],
  [cx - w, cy + h],
];

interface Frame {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

/** Sweeps a closed profile along frames with hard-edged normals and returns a geometry. */
function sweep(frames: Frame[], profile: Profile, uvScale = 0.25): THREE.BufferGeometry {
  const m = profile.length;
  const quads = (frames.length - 1) * m;
  const pos = new Float32Array(quads * 4 * 3);
  const nor = new Float32Array(quads * 4 * 3);
  const uv = new Float32Array(quads * 4 * 2);
  const idx = new Uint32Array(quads * 6);
  let v = 0;
  let w = 0;
  let along = 0;
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i < frames.length - 1; i++) {
    const A = frames[i];
    const B = frames[i + 1];
    const stepLen = Math.hypot(B.x - A.x, B.z - A.z);
    for (let k = 0; k < m; k++) {
      const [ax, ay] = profile[k];
      const [bx, by] = profile[(k + 1) % m];
      const corners: [Frame, number, number][] = [
        [A, ax, ay],
        [A, bx, by],
        [B, bx, by],
        [B, ax, ay],
      ];
      // Profiles wind counter-clockwise seen along travel, so the outward normal is this edge's perpendicular.
      const ex = bx - ax;
      const ey = by - ay;
      const nl = Math.hypot(ex, ey) || 1;
      const nLat = ey / nl;
      const nUp = -ex / nl;
      p.set(A.rx * nLat, nUp, A.rz * nLat);
      q.set(B.rx * nLat, nUp, B.rz * nLat);
      for (let c = 0; c < 4; c++) {
        const [F, lat, up] = corners[c];
        pos[v * 3] = F.x + F.rx * lat;
        pos[v * 3 + 1] = F.y + up;
        pos[v * 3 + 2] = F.z + F.rz * lat;
        const N = c < 2 ? p : q;
        nor[v * 3] = N.x;
        nor[v * 3 + 1] = N.y;
        nor[v * 3 + 2] = N.z;
        uv[v * 2] = lat * uvScale;
        uv[v * 2 + 1] = (along + (c < 2 ? 0 : stepLen)) * uvScale;
        v++;
      }
      const b = v - 4;
      idx[w++] = b;
      idx[w++] = b + 2;
      idx[w++] = b + 1;
      idx[w++] = b;
      idx[w++] = b + 3;
      idx[w++] = b + 2;
    }
    along += stepLen;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function noiseTexture(base: [number, number, number], spread: number, size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = Math.random();
    const big = Math.random() < 0.28 ? 0.72 : 1;
    const f = (1 - spread + n * spread * 2) * big;
    data[i * 4] = Math.min(255, base[0] * f);
    data[i * 4 + 1] = Math.min(255, base[1] * f);
    data[i * 4 + 2] = Math.min(255, base[2] * f);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const MATS = () => ({
  ballast: new THREE.MeshStandardMaterial({ map: noiseTexture([122, 116, 106], 0.42), roughness: 0.96 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x8d8f92, metalness: 0.92, roughness: 0.34 }),
  sleeper: new THREE.MeshStandardMaterial({ color: 0x4d4a45, roughness: 0.9 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x77756f, roughness: 0.88 }),
  girder: new THREE.MeshStandardMaterial({ color: 0x31434c, metalness: 0.6, roughness: 0.52 }),
});

interface SegCache {
  chunk: number;
  ballast: THREE.BufferGeometry | null;
  rail: THREE.BufferGeometry | null;
  deck: THREE.BufferGeometry | null;
  girder: THREE.BufferGeometry | null;
  sleepers: THREE.Matrix4[];
  piers: THREE.Matrix4[];
  abutments: THREE.Matrix4[];
  struts: THREE.Matrix4[];
}

interface ChunkMesh {
  group: THREE.Group;
  disposables: THREE.BufferGeometry[];
  instanced: THREE.InstancedMesh[];
}

function chunkOfPoint(x: number, z: number): number {
  const half = WORLD_SIZE / 2;
  const cx = Math.max(0, Math.min(CHUNKS - 1, Math.floor(((x + half) / WORLD_SIZE) * CHUNKS)));
  const cz = Math.max(0, Math.min(CHUNKS - 1, Math.floor(((z + half) / WORLD_SIZE) * CHUNKS)));
  return cz * CHUNKS + cx;
}

function mergeList(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0].clone();
  return mergeGeometries(geos, false);
}

export class TrackRenderer {
  group = new THREE.Group();
  readonly stats = { segRebuilds: 0, chunkRebuilds: 0 };
  private crossingGroup = new THREE.Group();
  private lastCrossingVersion = -1;
  private segCache = new Map<number, SegCache>();
  private chunkSegs = new Map<number, Set<number>>();
  private chunkMeshes = new Map<number, ChunkMesh>();
  private dirtyChunks = new Set<number>();
  private mats = MATS();
  private frogMat = new THREE.MeshStandardMaterial({ color: 0x2c3033, metalness: 0.85, roughness: 0.4 });
  private sleeperGeo = new THREE.BoxGeometry(2.5, 0.14, 0.26);
  private crossTimberGeo = new THREE.BoxGeometry(3.2, 0.14, 0.28);
  private checkRailGeo = new THREE.BoxGeometry(0.055, 0.14, 4.4);
  private frogGeo = new THREE.BoxGeometry(0.26, 0.15, 0.52);
  private strutGeo = new THREE.BoxGeometry(0.16, 0.16, 1);
  private tmp = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    this.group.add(this.crossingGroup);
    scene.add(this.group);
  }

  clear() {
    for (const id of [...this.segCache.keys()]) this.removeSegCache(id);
    for (const cid of [...this.chunkMeshes.keys()]) this.clearChunkMesh(cid);
    this.chunkSegs.clear();
    this.dirtyChunks.clear();
    this.clearCrossings();
    this.lastCrossingVersion = -1;
  }

  private clearCrossings() {
    for (const child of [...this.crossingGroup.children]) {
      this.crossingGroup.remove(child);
      if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
    }
  }

  private removeSegCache(id: number) {
    const s = this.segCache.get(id);
    if (!s) return;
    s.ballast?.dispose();
    s.rail?.dispose();
    s.deck?.dispose();
    s.girder?.dispose();
    const set = this.chunkSegs.get(s.chunk);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.chunkSegs.delete(s.chunk);
    }
    this.dirtyChunks.add(s.chunk);
    this.segCache.delete(id);
  }

  private clearChunkMesh(cid: number) {
    const cm = this.chunkMeshes.get(cid);
    if (!cm) return;
    this.group.remove(cm.group);
    for (const g of cm.disposables) g.dispose();
    for (const im of cm.instanced) im.dispose();
    this.chunkMeshes.delete(cid);
  }

  /** Rebuilds every segment flagged dirty on the network, merging dirty world chunks and crossings. */
  sync(net: Network, hf: Heightfield) {
    const hadDirty = net.dirty.size > 0;
    for (const id of net.dirty) {
      this.removeSegCache(id);
      if (net.segs.has(id)) {
        const cache = this.buildSegCache(net, hf, id);
        this.segCache.set(id, cache);
        let set = this.chunkSegs.get(cache.chunk);
        if (!set) this.chunkSegs.set(cache.chunk, (set = new Set()));
        set.add(id);
        this.dirtyChunks.add(cache.chunk);
        this.stats.segRebuilds++;
      }
    }
    net.dirty.clear();

    if (this.dirtyChunks.size > 0) {
      for (const cid of this.dirtyChunks) {
        this.rebuildChunk(cid);
        this.stats.chunkRebuilds++;
      }
      this.dirtyChunks.clear();
    }

    if (hadDirty || this.lastCrossingVersion !== net.version) {
      this.lastCrossingVersion = net.version;
      this.rebuildCrossings(net);
    }
  }

  private rebuildChunk(cid: number) {
    this.clearChunkMesh(cid);
    const segIds = this.chunkSegs.get(cid);
    if (!segIds || segIds.size === 0) return;

    const ballastGeos: THREE.BufferGeometry[] = [];
    const railGeos: THREE.BufferGeometry[] = [];
    const deckGeos: THREE.BufferGeometry[] = [];
    const girderGeos: THREE.BufferGeometry[] = [];
    const sleeperMats: THREE.Matrix4[] = [];
    const pierMats: THREE.Matrix4[] = [];
    const abutmentMats: THREE.Matrix4[] = [];
    const strutMats: THREE.Matrix4[] = [];

    for (const id of segIds) {
      const c = this.segCache.get(id);
      if (!c) continue;
      if (c.ballast) ballastGeos.push(c.ballast);
      if (c.rail) railGeos.push(c.rail);
      if (c.deck) deckGeos.push(c.deck);
      if (c.girder) girderGeos.push(c.girder);
      for (let i = 0; i < c.sleepers.length; i++) sleeperMats.push(c.sleepers[i]);
      for (let i = 0; i < c.piers.length; i++) pierMats.push(c.piers[i]);
      for (let i = 0; i < c.abutments.length; i++) abutmentMats.push(c.abutments[i]);
      for (let i = 0; i < c.struts.length; i++) strutMats.push(c.struts[i]);
    }

    const group = new THREE.Group();
    const disposables: THREE.BufferGeometry[] = [];
    const instanced: THREE.InstancedMesh[] = [];

    const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, castShadow: boolean) => {
      const merged = mergeList(geos);
      if (!merged) return;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      group.add(mesh);
      disposables.push(merged);
    };

    addMerged(ballastGeos, this.mats.ballast, false);
    addMerged(railGeos, this.mats.rail, false);
    addMerged(deckGeos, this.mats.deck, true);
    addMerged(girderGeos, this.mats.girder, true);

    const addInst = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      list: THREE.Matrix4[],
      castShadow: boolean,
      receiveShadow: boolean,
    ) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = castShadow;
      inst.receiveShadow = receiveShadow;
      inst.frustumCulled = true;
      inst.computeBoundingBox();
      inst.computeBoundingSphere();
      group.add(inst);
      instanced.push(inst);
    };

    addInst(this.sleeperGeo, this.mats.sleeper, sleeperMats, false, true);
    if (pierMats.length) {
      for (const prim of this.assets.primitives('pier')) addInst(prim.geometry, prim.material, pierMats, true, true);
    }
    if (abutmentMats.length) {
      for (const prim of this.assets.primitives('abutment')) {
        addInst(prim.geometry, prim.material, abutmentMats, true, true);
      }
    }
    addInst(this.strutGeo, this.mats.girder, strutMats, true, false);

    this.group.add(group);
    this.chunkMeshes.set(cid, { group, disposables, instanced });
  }

  private rebuildCrossings(net: Network) {
    this.clearCrossings();
    const diamonds = net.crossings.filter((c) => Math.abs(c.y1 - c.y2) <= DIAMOND_MAX_DY);
    if (!diamonds.length) return;
    const frogs: THREE.Matrix4[] = [];
    const checks: THREE.Matrix4[] = [];
    const timbers: THREE.Matrix4[] = [];
    const t = this.tmp;
    for (const c of diamonds) {
      const y = c.y;
      const n1x = -c.t1z;
      const n1z = c.t1x;
      const n2x = -c.t2z;
      const n2z = c.t2x;
      const denom = c.t1x * n2x + c.t1z * n2z;
      const nDot = n1x * n2x + n1z * n2z;
      // Bisector angle for the frog castings and shared diamond crossing timbers.
      const sign = c.t1x * c.t2x + c.t1z * c.t2z >= 0 ? 1 : -1;
      let bx = c.t1x + sign * c.t2x;
      let bz = c.t1z + sign * c.t2z;
      const bl = Math.hypot(bx, bz) || 1;
      bx /= bl;
      bz /= bl;
      const bYaw = Math.atan2(bx, bz);

      if (Math.abs(denom) > 0.05) {
        for (const lat1 of [-0.7175, 0.7175]) {
          for (const lat2 of [-0.7175, 0.7175]) {
            const u = (lat2 - lat1 * nDot) / denom;
            t.position.set(c.x + lat1 * n1x + u * c.t1x, y - 0.08, c.z + lat1 * n1z + u * c.t1z);
            t.rotation.set(0, bYaw, 0);
            t.scale.set(1, 1, 1);
            t.updateMatrix();
            frogs.push(t.matrix.clone());
          }
        }
      }
      for (const [tx, tz, nx, nz] of [
        [c.t1x, c.t1z, n1x, n1z],
        [c.t2x, c.t2z, n2x, n2z],
      ] as const) {
        const yaw = Math.atan2(tx, tz);
        for (const lat of [-0.625, 0.625]) {
          t.position.set(c.x + nx * lat, y - 0.072, c.z + nz * lat);
          t.rotation.set(0, yaw, 0);
          t.scale.set(1, 1, 1);
          t.updateMatrix();
          checks.push(t.matrix.clone());
        }
      }
      for (let off = -1.95; off <= 1.96; off += 0.65) {
        t.position.set(c.x + bx * off, y - 0.232, c.z + bz * off);
        t.rotation.set(0, bYaw, 0);
        t.scale.set(1, 1, 1);
        t.updateMatrix();
        timbers.push(t.matrix.clone());
      }
    }
    const emit = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = true;
      inst.frustumCulled = true;
      inst.computeBoundingBox();
      inst.computeBoundingSphere();
      this.crossingGroup.add(inst);
    };
    emit(this.frogGeo, this.frogMat, frogs);
    emit(this.checkRailGeo, this.mats.rail, checks);
    emit(this.crossTimberGeo, this.mats.sleeper, timbers);
  }

  private buildSegCache(net: Network, hf: Heightfield, id: number): SegCache {
    const seg = net.segs.get(id)!;
    const g = net.geom.get(id) as SegGeom;
    const mid = Math.floor(g.n / 2);
    const chunk = chunkOfPoint(g.pos[mid * 3], g.pos[mid * 3 + 2]);

    const stride = g.minRadius > 400 ? 2 : 1;
    const frames: Frame[] = [];
    const idxs: number[] = [];
    for (let i = 0; i < g.n; i += stride) idxs.push(i);
    if (idxs[idxs.length - 1] !== g.n - 1) idxs.push(g.n - 1);
    const bridge: boolean[] = [];
    const water: boolean[] = [];
    for (const i of idxs) {
      const tx = g.tan[i * 3];
      const tz = g.tan[i * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      const x = g.pos[i * 3];
      const y = g.pos[i * 3 + 1];
      const z = g.pos[i * 3 + 2];
      frames.push({ x, y, z, rx: -tz / l, rz: tx / l });
      bridge.push(hf.isBridgeSample(seg, x, y, z));
      water.push(hf.baseAt(x, z) < WATER_LEVEL + 1.2);
    }
    // Close short gaps in bridges and drop tiny spans so structures read as one piece.
    const stepLen = g.step * stride;
    const closeRuns = (value: boolean, minLen: number) => {
      let i = 0;
      while (i < bridge.length) {
        if (bridge[i] !== value) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < bridge.length && bridge[j + 1] === value) j++;
        if ((j - i + 1) * stepLen < minLen && i > 0 && j < bridge.length - 1) {
          for (let k = i; k <= j; k++) bridge[k] = !value;
        }
        i = j + 1;
      }
    };
    closeRuns(false, 18);
    closeRuns(true, 12);

    const ballastGeos: THREE.BufferGeometry[] = [];
    const deckGeos: THREE.BufferGeometry[] = [];
    const girderGeos: THREE.BufferGeometry[] = [];
    const piers: Frame[] = [];
    const abutments: { f: Frame; flip: boolean }[] = [];
    const struts: [THREE.Vector3, THREE.Vector3][] = [];

    let i = 0;
    while (i < frames.length) {
      let j = i;
      while (j + 1 < frames.length && bridge[j + 1] === bridge[i]) j++;
      // Include the next frame so runs meet with no gap.
      const end = Math.min(j + 1, frames.length - 1);
      const run = frames.slice(i, end + 1);
      if (run.length >= 2) {
        if (!bridge[i]) {
          ballastGeos.push(sweep(run, BALLAST));
        } else {
          deckGeos.push(sweep(run, DECK));
          const overWater = water.slice(i, end + 1).filter(Boolean).length > run.length * 0.2;
          if (overWater) this.addTruss(run, girderGeos, struts);
          else girderGeos.push(sweep(run, GIRDER));
          // Railings on both sides.
          girderGeos.push(sweep(run, BOX(-2.85, 0.75, 0.03, 0.03)), sweep(run, BOX(2.85, 0.75, 0.03, 0.03)));
          let acc = 0;
          const spacing = overWater ? 36 : 24;
          let nextPier = spacing * 0.5;
          for (let k = 0; k < run.length - 1; k++) {
            const seglen = Math.hypot(run[k + 1].x - run[k].x, run[k + 1].z - run[k].z);
            acc += seglen;
            if (acc >= nextPier) {
              nextPier += spacing;
              piers.push(run[k]);
            }
          }
          if (i > 0) abutments.push({ f: run[0], flip: false });
          if (end < frames.length - 1) abutments.push({ f: run[run.length - 1], flip: true });
        }
      }
      i = j + 1;
    }

    const collapse = (geos: THREE.BufferGeometry[], yOff = 0): THREE.BufferGeometry | null => {
      if (!geos.length) return null;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const x of geos) x.dispose();
      if (yOff) merged.translate(0, yOff, 0);
      return merged;
    };

    const crossings = net.crossingsOn(id).filter((c) => Math.abs(c.y1 - c.y2) <= DIAMOND_MAX_DY);
    const sinkBallast = crossings.some((c) => c.seg2 === id) ? -0.014 : 0;

    const ballast = collapse(ballastGeos, sinkBallast);
    const deck = collapse(deckGeos);
    const girder = collapse(girderGeos);
    const rail = collapse([
      sweep(
        frames,
        RAIL.map(([a, b]) => [a - 0.7175, b]),
      ),
      sweep(
        frames,
        RAIL.map(([a, b]) => [a + 0.7175, b]),
      ),
    ]);

    const t = this.tmp;
    const sleepers: THREE.Matrix4[] = [];
    const spacing = 0.72;
    const count = Math.max(1, Math.floor(g.length / spacing));
    for (let k = 0; k < count; k++) {
      const sAlong = (k + 0.5) * spacing;
      if (crossings.some((c) => Math.abs(sAlong - (c.seg1 === id ? c.s1 : c.s2)) < 2.2)) continue;
      const p = net.sample(id, sAlong);
      t.position.set(p.x, p.y - 0.23, p.z);
      t.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
      t.scale.set(1, 1, 1);
      t.updateMatrix();
      sleepers.push(t.matrix.clone());
    }

    const pierMats: THREE.Matrix4[] = [];
    for (const f of piers) {
      t.position.set(f.x, f.y - 0.62, f.z);
      t.rotation.set(0, Math.atan2(f.rx, f.rz) - Math.PI / 2, 0);
      t.scale.set(1, 1, 1);
      t.updateMatrix();
      pierMats.push(t.matrix.clone());
    }

    const abutmentMats: THREE.Matrix4[] = [];
    for (const { f, flip } of abutments) {
      t.position.set(f.x, f.y - 0.62, f.z);
      t.rotation.set(0, Math.atan2(f.rx, f.rz) - Math.PI / 2 + (flip ? Math.PI : 0), 0);
      t.scale.set(1, 1, 1);
      t.updateMatrix();
      abutmentMats.push(t.matrix.clone());
    }

    const strutMats: THREE.Matrix4[] = [];
    for (const [a, b] of struts) {
      t.position.copy(a).add(b).multiplyScalar(0.5);
      t.scale.set(1, 1, a.distanceTo(b));
      t.lookAt(b);
      t.updateMatrix();
      strutMats.push(t.matrix.clone());
    }

    return {
      chunk,
      ballast,
      rail,
      deck,
      girder,
      sleepers,
      piers: pierMats,
      abutments: abutmentMats,
      struts: strutMats,
    };
  }

  /** Through-truss for river crossings: top chords, verticals and alternating diagonals. */
  private addTruss(run: Frame[], steel: THREE.BufferGeometry[], struts: [THREE.Vector3, THREE.Vector3][]) {
    const H = 6.4;
    const X = 2.8;
    steel.push(sweep(run, BOX(-X, H, 0.13, 0.13)), sweep(run, BOX(X, H, 0.13, 0.13)));
    steel.push(sweep(run, BOX(-X, -0.2, 0.14, 0.24)), sweep(run, BOX(X, -0.2, 0.14, 0.24)));
    const panel = 7;
    let acc = 0;
    let idx = 0;
    let prev = run[0];
    let last: Frame | null = null;
    const point = (f: Frame, lat: number, up: number) =>
      new THREE.Vector3(f.x + f.rx * lat, f.y + up, f.z + f.rz * lat);
    for (let k = 1; k < run.length; k++) {
      acc += Math.hypot(run[k].x - prev.x, run[k].z - prev.z);
      prev = run[k];
      if (acc < panel && k < run.length - 1) continue;
      acc = 0;
      const f = run[k];
      if (last) {
        for (const lat of [-X, X]) {
          const low = idx % 2 === 0;
          struts.push([point(last, lat, low ? -0.1 : H), point(f, lat, low ? H : -0.1)]);
          struts.push([point(f, lat, -0.1), point(f, lat, H)]);
        }
      }
      struts.push([point(f, -X, H), point(f, X, H)]);
      last = f;
      idx++;
    }
  }
}
