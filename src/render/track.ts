// Builds rails, sleepers, ballast and bridges for each segment by sweeping profiles along its curve.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Network, SegGeom } from '../rail/network';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL } from '../world/heightfield';
import type { Assets } from './assets';

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
  ruststeel: new THREE.MeshStandardMaterial({ color: 0x5a3f2e, metalness: 0.55, roughness: 0.62 }),
});

interface SegMesh {
  group: THREE.Group;
  disposables: THREE.BufferGeometry[];
}

export class TrackRenderer {
  group = new THREE.Group();
  private meshes = new Map<number, SegMesh>();
  private mats = MATS();
  private sleeperGeo = new THREE.BoxGeometry(2.5, 0.14, 0.26);
  private strutGeo = new THREE.BoxGeometry(0.16, 0.16, 1);
  private tmp = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    scene.add(this.group);
  }

  clear() {
    for (const id of [...this.meshes.keys()]) this.remove(id);
  }

  private remove(id: number) {
    const m = this.meshes.get(id);
    if (!m) return;
    this.group.remove(m.group);
    for (const g of m.disposables) g.dispose();
    m.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.meshes.delete(id);
  }

  /** Rebuilds every segment flagged dirty on the network. */
  sync(net: Network, hf: Heightfield) {
    for (const id of net.dirty) {
      this.remove(id);
      if (net.segs.has(id)) this.build(net, hf, id);
    }
    net.dirty.clear();
  }

  private build(net: Network, hf: Heightfield, id: number) {
    const seg = net.segs.get(id)!;
    const g = net.geom.get(id) as SegGeom;
    const group = new THREE.Group();
    const disposables: THREE.BufferGeometry[] = [];
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
    const steelGeos: THREE.BufferGeometry[] = [];
    const piers: Frame[] = [];
    const abutments: { f: Frame; flip: boolean }[] = [];
    const struts: [THREE.Vector3, THREE.Vector3][] = [];
    const hasBridge = bridge.some(Boolean);

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
          if (overWater) this.addTruss(run, steelGeos, struts);
          else girderGeos.push(sweep(run, GIRDER));
          // Railings on both sides.
          steelGeos.push(sweep(run, BOX(-2.85, 0.75, 0.03, 0.03)), sweep(run, BOX(2.85, 0.75, 0.03, 0.03)));
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

    const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, castShadow: boolean) => {
      if (!geos.length) return;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const x of geos) x.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push(merged);
    };
    addMerged(ballastGeos, this.mats.ballast, false);
    addMerged(deckGeos, this.mats.deck, true);
    addMerged(girderGeos, this.mats.girder, true);
    addMerged(steelGeos, this.mats.girder, true);
    const rails = [
      sweep(
        frames,
        RAIL.map(([a, b]) => [a - 0.7175, b]),
      ),
      sweep(
        frames,
        RAIL.map(([a, b]) => [a + 0.7175, b]),
      ),
    ];
    addMerged(rails, this.mats.rail, false);

    // Sleepers.
    const spacing = 0.72;
    const count = Math.max(1, Math.floor(g.length / spacing));
    const sleepers = new THREE.InstancedMesh(this.sleeperGeo, this.mats.sleeper, count);
    const t = this.tmp;
    for (let k = 0; k < count; k++) {
      const p = net.sample(id, (k + 0.5) * spacing);
      t.position.set(p.x, p.y - 0.23, p.z);
      t.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
      t.scale.set(1, 1, 1);
      t.updateMatrix();
      sleepers.setMatrixAt(k, t.matrix);
    }
    sleepers.receiveShadow = true;
    sleepers.frustumCulled = true;
    sleepers.computeBoundingSphere();
    group.add(sleepers);

    if (hasBridge) this.addBridgeInstances(group, piers, abutments, struts);
    this.group.add(group);
    this.meshes.set(id, { group, disposables });
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

  private addBridgeInstances(
    group: THREE.Group,
    piers: Frame[],
    abutments: { f: Frame; flip: boolean }[],
    struts: [THREE.Vector3, THREE.Vector3][],
  ) {
    const t = this.tmp;
    const place = (name: string, list: { f: Frame; flip?: boolean }[]) => {
      if (!list.length) return;
      for (const prim of this.assets.primitives(name)) {
        const inst = new THREE.InstancedMesh(prim.geometry, prim.material, list.length);
        list.forEach(({ f, flip }, k) => {
          t.position.set(f.x, f.y - 0.62, f.z);
          t.rotation.set(0, Math.atan2(f.rx, f.rz) - Math.PI / 2 + (flip ? Math.PI : 0), 0);
          t.scale.set(1, 1, 1);
          t.updateMatrix();
          inst.setMatrixAt(k, t.matrix);
        });
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        group.add(inst);
      }
    };
    place(
      'pier',
      piers.map((f) => ({ f })),
    );
    place('abutment', abutments);
    if (struts.length) {
      const inst = new THREE.InstancedMesh(this.strutGeo, this.mats.girder, struts.length);
      struts.forEach(([a, b], k) => {
        t.position.copy(a).add(b).multiplyScalar(0.5);
        t.scale.set(1, 1, a.distanceTo(b));
        t.lookAt(b);
        t.updateMatrix();
        inst.setMatrixAt(k, t.matrix);
      });
      inst.castShadow = true;
      inst.frustumCulled = false;
      group.add(inst);
    }
  }
}
