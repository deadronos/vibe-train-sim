// Builds rails, sleepers, ballast, bridges, diamond crossings and animated junction turnouts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Network, RailNode, SegGeom, Side } from '../rail/network';
import { DIAMOND_MAX_DY } from '../rail/network';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';
import type { Assets } from './assets';
import { prefersReducedMotion } from './cameraRig';

const CHUNKS = 8;
const GAUGE_HALF = 0.7175;
const GAUGE = GAUGE_HALF * 2;
const BLADE_THROW_SPEED = 5.5; // 1/s -> ~0.18 s smooth point throw
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
  s: number;
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

export interface JunctionBranch {
  segId: number;
  dir: 1 | -1;
  latAtProbe: number;
}

export interface JunctionMetrics {
  branches: JunctionBranch[];
  sToe: number;
  sHeel: number;
  sJuncEnd: number;
  frogs: { leftIdx: number; rightIdx: number; sFrog: number }[];
}

function sampleBranch(net: Network, node: RailNode, side: Side, segId: number, s: number) {
  const g = net.geom.get(segId)!;
  const dir = net.entryDir(segId, node.id, side);
  const segS = dir > 0 ? Math.min(g.length, s) : Math.max(0, g.length - s);
  const p = net.sample(segId, segS);
  const sign = dir;
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    tx: p.tx * sign,
    ty: p.ty * sign,
    tz: p.tz * sign,
    rx: -p.tz * sign,
    rz: p.tx * sign,
  };
}

/** Computes sorted left-to-right branches, switch heel/toe, frog distances, and junction trim length. */
export function computeJunctionMetrics(net: Network, node: RailNode, side: Side): JunctionMetrics | null {
  const opts = net.attached(node.id, side);
  if (opts.length < 2) return null;
  const fx = node.dx * side;
  const fz = node.dz * side;
  const rx = -fz;
  const rz = fx;
  let minLen = Infinity;
  for (const id of opts) {
    const g = net.geom.get(id);
    if (!g) return null;
    if (g.length < minLen) minLen = g.length;
  }
  const probeS = Math.min(18, minLen * 0.6);
  const branches: JunctionBranch[] = opts.map((segId) => {
    const p = sampleBranch(net, node, side, segId, probeS);
    return {
      segId,
      dir: net.entryDir(segId, node.id, side),
      latAtProbe: (p.x - node.x) * rx + (p.z - node.z) * rz,
    };
  });
  branches.sort((a, b) => a.latAtProbe - b.latAtProbe);

  const sToe = Math.min(0.45, minLen * 0.08);
  let sHeel = 7.5;
  let maxFrog = 12;
  const frogs: { leftIdx: number; rightIdx: number; sFrog: number }[] = [];

  for (let k = 0; k < branches.length - 1; k++) {
    const bL = branches[k].segId;
    const bR = branches[k + 1].segId;
    let foundHeel = -1;
    let foundFrog = -1;
    const limit = Math.min(64, minLen - 1);
    for (let s = 1; s <= limit; s += 0.5) {
      const pL = sampleBranch(net, node, side, bL, s);
      const pR = sampleBranch(net, node, side, bR, s);
      const sep = (pR.x - pL.x) * rx + (pR.z - pL.z) * rz;
      if (foundHeel < 0 && sep >= 0.24) foundHeel = s;
      if (sep >= GAUGE) {
        foundFrog = s;
        break;
      }
    }
    if (foundHeel > 0) sHeel = Math.min(sHeel, Math.max(4.5, Math.min(10.5, foundHeel)));
    if (foundFrog > 0) {
      frogs.push({ leftIdx: k, rightIdx: k + 1, sFrog: foundFrog });
      if (foundFrog > maxFrog) maxFrog = foundFrog;
    }
  }
  sHeel = Math.min(sHeel, minLen * 0.45);
  const sJuncEnd = Math.min(minLen * 0.85, maxFrog + 3.5);
  return { branches, sToe, sHeel, sJuncEnd, frogs };
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

/** Sweeps a variable-width ballast apron bridging the outer left edge of framesL and outer right edge of framesR. */
function sweepJunctionBallast(framesL: Frame[], framesR: Frame[], uvScale = 0.25): THREE.BufferGeometry {
  const n = Math.min(framesL.length, framesR.length);
  const quads = (n - 1) * 4;
  const pos = new Float32Array(quads * 4 * 3);
  const nor = new Float32Array(quads * 4 * 3);
  const uv = new Float32Array(quads * 4 * 2);
  const idx = new Uint32Array(quads * 6);
  const pt = (f: Frame, lat: number, up: number): [number, number, number] => [
    f.x + f.rx * lat,
    f.y + up,
    f.z + f.rz * lat,
  ];
  const ringAt = (i: number): [number, number, number][] => [
    pt(framesL[i], -2.5, -0.74),
    pt(framesR[i], 2.5, -0.74),
    pt(framesR[i], 1.45, -0.23),
    pt(framesL[i], -1.45, -0.23),
  ];
  const lats = [-2.5, 2.5, 1.45, -1.45];
  let v = 0;
  let w = 0;
  let along = 0;
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const norm = new THREE.Vector3();
  for (let i = 0; i < n - 1; i++) {
    const rA = ringAt(i);
    const rB = ringAt(i + 1);
    const stepLen = Math.hypot(framesL[i + 1].x - framesL[i].x, framesL[i + 1].z - framesL[i].z);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const c0 = rA[k];
      const c1 = rA[k2];
      const c2 = rB[k2];
      const c3 = rB[k];
      e1.set(c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]);
      e2.set(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
      norm.crossVectors(e1, e2).normalize();
      const corners = [c0, c1, c2, c3];
      const clats = [lats[k], lats[k2], lats[k2], lats[k]];
      for (let c = 0; c < 4; c++) {
        pos[v * 3] = corners[c][0];
        pos[v * 3 + 1] = corners[c][1];
        pos[v * 3 + 2] = corners[c][2];
        nor[v * 3] = norm.x;
        nor[v * 3 + 1] = norm.y;
        nor[v * 3 + 2] = norm.z;
        uv[v * 2] = clats[c] * uvScale;
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

/** Slices a frame array to [sStart, sEnd], interpolating boundary frames so adjacent meshes meet cleanly. */
function sliceFrames(frames: Frame[], sStart: number, sEnd: number): Frame[] {
  if (sStart >= sEnd || frames.length < 2) return [];
  const interp = (a: Frame, b: Frame, s: number): Frame => {
    const t = Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s || 1)));
    const rx = a.rx + (b.rx - a.rx) * t;
    const rz = a.rz + (b.rz - a.rz) * t;
    const l = Math.hypot(rx, rz) || 1;
    return {
      s,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      rx: rx / l,
      rz: rz / l,
    };
  };
  const out: Frame[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.s >= sStart && f.s <= sEnd) {
      if (out.length === 0 && f.s > sStart && i > 0) out.push(interp(frames[i - 1], f, sStart));
      out.push(f);
    } else if (out.length > 0 && f.s > sEnd) {
      out.push(interp(frames[i - 1], f, sEnd));
      break;
    } else if (out.length === 0 && f.s > sEnd && i > 0) {
      out.push(interp(frames[i - 1], f, sStart));
      out.push(interp(frames[i - 1], f, sEnd));
      break;
    }
  }
  return out;
}

/** Tapered unit-length switch blade from Z=0 (heel) to Z=1 (tip), top at Y=0. */
function makeBladeGeo(): THREE.BufferGeometry {
  const w0 = 0.036;
  const w1 = 0.008;
  const y0 = -0.155;
  const y1 = 0.0;
  // 8 vertices forming a tapered rectangular prism along Z (0..1).
  const pos = new Float32Array([
    -w0,
    y0,
    0,
    w0,
    y0,
    0,
    w0,
    y1,
    0,
    -w0,
    y1,
    0,
    -w1,
    y0,
    1,
    w1,
    y0,
    1,
    w1,
    y1,
    1,
    -w1,
    y1,
    1,
  ]);
  const indices = [
    2,
    3,
    7,
    2,
    7,
    6, // top
    0,
    1,
    5,
    0,
    5,
    4, // bottom
    0,
    4,
    7,
    0,
    7,
    3, // left
    1,
    2,
    6,
    1,
    6,
    5, // right
    4,
    5,
    6,
    4,
    6,
    7, // tip
    0,
    3,
    2,
    0,
    2,
    1, // heel
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
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

interface BladeDesc {
  nodeId: number;
  side: Side;
  branchSegId: number;
  heelPos: THREE.Vector3;
  closedToe: THREE.Vector3;
  openToe: THREE.Vector3;
  closedAmt: number;
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
  private junctionGroup = new THREE.Group();
  private bladeMesh: THREE.InstancedMesh | null = null;
  private bladeCap = 0;
  private blades: BladeDesc[] = [];
  private bladesDirty = false;
  private lastCrossingVersion = -1;
  private lastJunctionVersion = -1;
  private segCache = new Map<number, SegCache>();
  private chunkSegs = new Map<number, Set<number>>();
  private chunkMeshes = new Map<number, ChunkMesh>();
  private dirtyChunks = new Set<number>();
  private mats = MATS();
  private frogMat = new THREE.MeshStandardMaterial({ color: 0x2c3033, metalness: 0.85, roughness: 0.4 });
  private bladeMat = new THREE.MeshStandardMaterial({ color: 0xadb0b4, metalness: 0.92, roughness: 0.28 });
  private sleeperGeo = new THREE.BoxGeometry(2.5, 0.14, 0.26);
  private crossTimberGeo = new THREE.BoxGeometry(3.2, 0.14, 0.28);
  private checkRailGeo = new THREE.BoxGeometry(0.055, 0.14, 4.4);
  private juncGuardGeo = new THREE.BoxGeometry(0.055, 0.14, 3.6);
  private frogGeo = new THREE.BoxGeometry(0.26, 0.15, 0.52);
  private juncFrogGeo = new THREE.BoxGeometry(0.22, 0.145, 1.15);
  private bladeGeo = makeBladeGeo();
  private strutGeo = new THREE.BoxGeometry(0.16, 0.16, 1);
  private tmp = new THREE.Object3D();
  private tmpTarget = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    this.group.add(this.crossingGroup, this.junctionGroup);
    scene.add(this.group);
  }

  clear() {
    for (const id of [...this.segCache.keys()]) this.removeSegCache(id);
    for (const cid of [...this.chunkMeshes.keys()]) this.clearChunkMesh(cid);
    this.chunkSegs.clear();
    this.dirtyChunks.clear();
    this.clearCrossings();
    this.clearJunctions();
    this.lastCrossingVersion = -1;
    this.lastJunctionVersion = -1;
  }

  private clearCrossings() {
    for (const child of [...this.crossingGroup.children]) {
      this.crossingGroup.remove(child);
      if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
    }
  }

  private clearJunctions() {
    for (const child of [...this.junctionGroup.children]) {
      this.junctionGroup.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh === this.bladeMesh) {
        this.bladeMesh.dispose();
        this.bladeMesh = null;
        this.bladeCap = 0;
      } else if ((child as THREE.InstancedMesh).isInstancedMesh) {
        (child as THREE.InstancedMesh).dispose();
      } else if (mesh.isMesh) {
        mesh.geometry.dispose();
      }
    }
    this.blades = [];
    this.bladesDirty = false;
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

  /** Rebuilds every segment flagged dirty on the network, merging dirty world chunks, crossings and junctions. */
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
    if (hadDirty || this.lastJunctionVersion !== net.version) {
      this.lastJunctionVersion = net.version;
      this.rebuildJunctions(net, hf);
    }
  }

  /** Smoothly animates junction switch blades whenever points are thrown. */
  update(net: Network, dt: number) {
    if (!this.blades.length || !this.bladeMesh) return;
    const reduced = prefersReducedMotion();
    let moved = false;
    for (let i = 0; i < this.blades.length; i++) {
      const b = this.blades[i];
      const target = net.selected(b.nodeId, b.side) === b.branchSegId ? 1 : 0;
      if (b.closedAmt !== target) {
        if (reduced) {
          b.closedAmt = target;
        } else {
          const step = dt * BLADE_THROW_SPEED;
          if (b.closedAmt < target) b.closedAmt = Math.min(target, b.closedAmt + step);
          else b.closedAmt = Math.max(target, b.closedAmt - step);
        }
        moved = true;
      }
    }
    if (moved || this.bladesDirty) {
      this.bladesDirty = false;
      this.flushBlades();
    }
  }

  private flushBlades() {
    const count = this.blades.length;
    if (count === 0) {
      if (this.bladeMesh) {
        this.bladeMesh.count = 0;
        this.bladeMesh.visible = false;
      }
      return;
    }
    if (!this.bladeMesh || count > this.bladeCap) {
      if (this.bladeMesh) {
        this.junctionGroup.remove(this.bladeMesh);
        this.bladeMesh.dispose();
      }
      let cap = Math.max(16, this.bladeCap || 16);
      while (cap < count) cap *= 2;
      this.bladeCap = cap;
      this.bladeMesh = new THREE.InstancedMesh(this.bladeGeo, this.bladeMat, cap);
      this.bladeMesh.castShadow = false;
      this.bladeMesh.receiveShadow = true;
      this.bladeMesh.frustumCulled = true;
      this.junctionGroup.add(this.bladeMesh);
    }
    this.bladeMesh.visible = true;
    this.bladeMesh.count = count;
    const t = this.tmp;
    for (let i = 0; i < count; i++) {
      const b = this.blades[i];
      this.tmpTarget.lerpVectors(b.openToe, b.closedToe, b.closedAmt);
      t.position.copy(b.heelPos);
      t.scale.set(1, 1, Math.max(0.5, b.heelPos.distanceTo(this.tmpTarget)));
      t.lookAt(this.tmpTarget);
      t.updateMatrix();
      this.bladeMesh.setMatrixAt(i, t.matrix);
    }
    this.bladeMesh.instanceMatrix.needsUpdate = true;
    this.bladeMesh.computeBoundingBox();
    this.bladeMesh.computeBoundingSphere();
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

  private rebuildJunctions(net: Network, hf: Heightfield) {
    this.clearJunctions();
    const ballastGeos: THREE.BufferGeometry[] = [];
    const frogMats: THREE.Matrix4[] = [];
    const guardMats: THREE.Matrix4[] = [];
    const bearerMats: THREE.Matrix4[] = [];
    const t = this.tmp;

    for (const node of net.nodes.values()) {
      for (const side of [1, -1] as Side[]) {
        const m = computeJunctionMetrics(net, node, side);
        if (!m) continue;
        const { branches, sToe, sHeel, sJuncEnd, frogs } = m;
        const bLeft = branches[0].segId;
        const bRight = branches[branches.length - 1].segId;

        // Blended single ballast apron from toe to sJuncEnd (skipped if junction sits on a bridge).
        const onBridge = branches.some((br) => {
          const seg = net.segs.get(br.segId)!;
          return hf.isBridgeSample(seg, node.x, node.y, node.z);
        });
        if (!onBridge && sJuncEnd > 1) {
          const steps = Math.max(4, Math.ceil(sJuncEnd / 1.25));
          const framesL: Frame[] = [];
          const framesR: Frame[] = [];
          for (let i = 0; i <= steps; i++) {
            const s = (i / steps) * sJuncEnd;
            const pL = sampleBranch(net, node, side, bLeft, s);
            const pR = sampleBranch(net, node, side, bRight, s);
            framesL.push({ s, x: pL.x, y: pL.y, z: pL.z, rx: pL.rx, rz: pL.rz });
            framesR.push({ s, x: pR.x, y: pR.y, z: pR.z, rx: pR.rx, rz: pR.rz });
          }
          ballastGeos.push(sweepJunctionBallast(framesL, framesR));
        }

        // Wide turnout bearers spanning from outer left to outer right rail across the turnout.
        const count = Math.max(1, Math.floor(sJuncEnd / 0.72));
        for (let k = 0; k < count; k++) {
          const s = (k + 0.5) * 0.72;
          if (s > sJuncEnd) break;
          const pL = sampleBranch(net, node, side, bLeft, s);
          const pR = sampleBranch(net, node, side, bRight, s);
          const span = Math.hypot(pR.x - pL.x, pR.z - pL.z);
          const bx = pL.tx + pR.tx;
          const bz = pL.tz + pR.tz;
          t.position.set((pL.x + pR.x) * 0.5, (pL.y + pR.y) * 0.5 - 0.23, (pL.z + pR.z) * 0.5);
          t.rotation.set(0, Math.atan2(bx, bz), 0);
          t.scale.set((span + 2.5) / 2.5, 1, 1);
          t.updateMatrix();
          bearerMats.push(t.matrix.clone());
        }

        // Frog casting and outer guard (check) rails at each rail crossing.
        for (const f of frogs) {
          const segL = branches[f.leftIdx].segId;
          const segR = branches[f.rightIdx].segId;
          const pL = sampleBranch(net, node, side, segL, f.sFrog);
          const pR = sampleBranch(net, node, side, segR, f.sFrog);
          // Frog sits where left branch's right rail (+0.7175) meets right branch's left rail (-0.7175).
          const fx = (pL.x + pL.rx * GAUGE_HALF + pR.x - pR.rx * GAUGE_HALF) * 0.5;
          const fy = (pL.y + pR.y) * 0.5 - 0.075;
          const fz = (pL.z + pL.rz * GAUGE_HALF + pR.z - pR.rz * GAUGE_HALF) * 0.5;
          const bYaw = Math.atan2(pL.tx + pR.tx, pL.tz + pR.tz);
          t.position.set(fx, fy, fz);
          t.rotation.set(0, bYaw, 0);
          t.scale.set(1, 1, 1);
          t.updateMatrix();
          frogMats.push(t.matrix.clone());

          // Guard rail on left branch's outer left rail and right branch's outer right rail.
          for (const [p, lat] of [
            [pL, -0.625],
            [pR, 0.625],
          ] as const) {
            t.position.set(p.x + p.rx * lat, p.y - 0.072, p.z + p.rz * lat);
            t.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
            t.scale.set(1, 1, 1);
            t.updateMatrix();
            guardMats.push(t.matrix.clone());
          }
        }

        // Switch blades: each interior rail in [sToe, sHeel] pivots at its heel and throws at its toe.
        const selected = net.selected(node.id, side);
        const stockL = sampleBranch(net, node, side, bLeft, sToe);
        const stockR = sampleBranch(net, node, side, bRight, sToe);
        for (let k = 0; k < branches.length; k++) {
          const br = branches[k];
          const pHeel = sampleBranch(net, node, side, br.segId, sHeel);
          const closed = selected === br.segId ? 1 : 0;
          if (k > 0) {
            // Left inner blade: heel on br's left rail; toe sits against leftmost stock rail when closed.
            this.blades.push({
              nodeId: node.id,
              side,
              branchSegId: br.segId,
              heelPos: new THREE.Vector3(pHeel.x - pHeel.rx * GAUGE_HALF, pHeel.y, pHeel.z - pHeel.rz * GAUGE_HALF),
              closedToe: new THREE.Vector3(
                stockL.x - stockL.rx * (GAUGE_HALF - 0.045),
                stockL.y,
                stockL.z - stockL.rz * (GAUGE_HALF - 0.045),
              ),
              openToe: new THREE.Vector3(
                stockL.x - stockL.rx * (GAUGE_HALF - 0.21),
                stockL.y,
                stockL.z - stockL.rz * (GAUGE_HALF - 0.21),
              ),
              closedAmt: closed,
            });
          }
          if (k < branches.length - 1) {
            // Right inner blade: heel on br's right rail; toe sits against rightmost stock rail when closed.
            this.blades.push({
              nodeId: node.id,
              side,
              branchSegId: br.segId,
              heelPos: new THREE.Vector3(pHeel.x + pHeel.rx * GAUGE_HALF, pHeel.y, pHeel.z + pHeel.rz * GAUGE_HALF),
              closedToe: new THREE.Vector3(
                stockR.x + stockR.rx * (GAUGE_HALF - 0.045),
                stockR.y,
                stockR.z + stockR.rz * (GAUGE_HALF - 0.045),
              ),
              openToe: new THREE.Vector3(
                stockR.x + stockR.rx * (GAUGE_HALF - 0.21),
                stockR.y,
                stockR.z + stockR.rz * (GAUGE_HALF - 0.21),
              ),
              closedAmt: closed,
            });
          }
        }
      }
    }

    if (ballastGeos.length) {
      const merged = mergeList(ballastGeos);
      for (const g of ballastGeos) g.dispose();
      if (merged) {
        merged.computeBoundingBox();
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, this.mats.ballast);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        this.junctionGroup.add(mesh);
      }
    }

    const emitInst = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      list: THREE.Matrix4[],
      receiveShadow: boolean,
    ) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = receiveShadow;
      inst.frustumCulled = true;
      inst.computeBoundingBox();
      inst.computeBoundingSphere();
      this.junctionGroup.add(inst);
    };
    emitInst(this.juncFrogGeo, this.frogMat, frogMats, true);
    emitInst(this.juncGuardGeo, this.mats.rail, guardMats, true);
    emitInst(this.sleeperGeo, this.mats.sleeper, bearerMats, true);
    this.bladesDirty = true;
    this.flushBlades();
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
        for (const lat1 of [-GAUGE_HALF, GAUGE_HALF]) {
          for (const lat2 of [-GAUGE_HALF, GAUGE_HALF]) {
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

  private endJunctionTrim(net: Network, segId: number, nodeId: number, side: Side, atEndB: boolean) {
    const node = net.nodes.get(nodeId)!;
    const m = computeJunctionMetrics(net, node, side);
    if (!m) return { juncTrim: 0, trimLeftRail: 0, trimRightRail: 0 };
    const idx = m.branches.findIndex((b) => b.segId === segId);
    if (idx < 0) return { juncTrim: 0, trimLeftRail: 0, trimRightRail: 0 };
    const trimBranchLeft = idx > 0 ? m.sHeel : 0;
    const trimBranchRight = idx < m.branches.length - 1 ? m.sHeel : 0;
    // At end b (leaving b toward a), branch-left corresponds to segment +0.7175 (right of a->b).
    return {
      juncTrim: m.sJuncEnd,
      trimLeftRail: atEndB ? trimBranchRight : trimBranchLeft,
      trimRightRail: atEndB ? trimBranchLeft : trimBranchRight,
    };
  }

  private buildSegCache(net: Network, hf: Heightfield, id: number): SegCache {
    const seg = net.segs.get(id)!;
    const g = net.geom.get(id) as SegGeom;
    const mid = Math.floor(g.n / 2);
    const chunk = chunkOfPoint(g.pos[mid * 3], g.pos[mid * 3 + 2]);

    const trimA = this.endJunctionTrim(net, id, seg.a, seg.sa, false);
    const trimB = this.endJunctionTrim(net, id, seg.b, seg.sb, true);

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
      frames.push({ s: i * g.step, x, y, z, rx: -tz / l, rz: tx / l });
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

    const bStart = trimA.juncTrim;
    const bEnd = g.length - trimB.juncTrim;

    let i = 0;
    while (i < frames.length) {
      let j = i;
      while (j + 1 < frames.length && bridge[j + 1] === bridge[i]) j++;
      // Include the next frame so runs meet with no gap.
      const end = Math.min(j + 1, frames.length - 1);
      const run = frames.slice(i, end + 1);
      if (run.length >= 2) {
        if (!bridge[i]) {
          const trimmed =
            bStart > 0 || trimB.juncTrim > 0
              ? sliceFrames(run, Math.max(run[0].s, bStart), Math.min(run[run.length - 1].s, bEnd))
              : run;
          if (trimmed.length >= 2) ballastGeos.push(sweep(trimmed, BALLAST));
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

    const leftFrames =
      trimA.trimLeftRail > 0 || trimB.trimLeftRail > 0
        ? sliceFrames(frames, trimA.trimLeftRail, g.length - trimB.trimLeftRail)
        : frames;
    const rightFrames =
      trimA.trimRightRail > 0 || trimB.trimRightRail > 0
        ? sliceFrames(frames, trimA.trimRightRail, g.length - trimB.trimRightRail)
        : frames;
    const railParts: THREE.BufferGeometry[] = [];
    if (leftFrames.length >= 2)
      railParts.push(
        sweep(
          leftFrames,
          RAIL.map(([a, b]) => [a - GAUGE_HALF, b]),
        ),
      );
    if (rightFrames.length >= 2)
      railParts.push(
        sweep(
          rightFrames,
          RAIL.map(([a, b]) => [a + GAUGE_HALF, b]),
        ),
      );
    const rail = collapse(railParts);

    const t = this.tmp;
    const sleepers: THREE.Matrix4[] = [];
    const spacing = 0.72;
    const count = Math.max(1, Math.floor(g.length / spacing));
    for (let k = 0; k < count; k++) {
      const sAlong = (k + 0.5) * spacing;
      if (sAlong < trimA.juncTrim || sAlong > g.length - trimB.juncTrim) continue;
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
