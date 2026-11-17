// Lineside objects driven by the network: signals, route indicators, speed boards, point levers, buffer stops and stations.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Network, RailNode, Side, SignalType, Station } from '../rail/network';
import { computeSpeedSigns, signalType } from '../rail/network';
import type { Aspect, Sim } from '../rail/sim';
import { keyOf } from '../rail/sim';
import type { Assets } from './assets';

const LAMP_INTENSITY = { red: 26, yellow: 22, green: 16, white: 18 };
const MIN_INST_CAP = 8;

interface RouteVisual {
  left: THREE.MeshStandardMaterial;
  right: THREE.MeshStandardMaterial;
  numMat: THREE.MeshStandardMaterial;
  lastDir: string;
  lastNum: number;
}

interface SignalVisual {
  key: string;
  nodeId: number;
  type: SignalType;
  worldMatrix: THREE.Matrix4;
  route?: RouteVisual;
  glow: THREE.Sprite;
  lastAspect: Aspect | null;
}

interface LeverVisual {
  key: string;
  node: number;
  side: Side;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  lastState: number;
}

interface StationBoardVisual {
  stationId: number;
  mat: THREE.MeshStandardMaterial;
  tex: THREE.CanvasTexture;
}

interface PoolEntry {
  poolKey: string;
  matrix: THREE.Matrix4;
}

interface NodeRecord {
  entries: PoolEntry[];
  signalKeys: string[];
  leverKeys: string[];
  lampPositions: THREE.Vector3[];
  objects: THREE.Object3D[];
  owned: { dispose(): void }[];
  stationId?: number;
}

class InstancedPool {
  mesh: THREE.InstancedMesh | null = null;
  capacity = 0;

  constructor(
    private group: THREE.Group,
    readonly geo: THREE.BufferGeometry,
    readonly mat: THREE.Material,
    readonly castShadow: boolean,
    readonly receiveShadow: boolean,
    private withColor = false,
  ) {}

  sync(matrices: THREE.Matrix4[], colors?: THREE.Color[]) {
    const count = matrices.length;
    if (count === 0) {
      if (this.mesh) {
        this.mesh.count = 0;
        this.mesh.visible = false;
      }
      return;
    }
    if (!this.mesh || count > this.capacity) {
      if (this.mesh) {
        this.group.remove(this.mesh);
        this.mesh.dispose();
      }
      let cap = Math.max(MIN_INST_CAP, this.capacity || MIN_INST_CAP);
      while (cap < count) cap *= 2;
      this.capacity = cap;
      this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
      this.mesh.castShadow = this.castShadow;
      this.mesh.receiveShadow = this.receiveShadow;
      this.mesh.frustumCulled = true;
      if (this.withColor) {
        const c = new THREE.Color(0xffffff);
        for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, c);
      }
      this.group.add(this.mesh);
    }
    this.mesh.visible = true;
    this.mesh.count = count;
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, matrices[i]);
      if (colors && this.withColor) this.mesh.setColorAt(i, colors[i]);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colors && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingBox();
    this.mesh.computeBoundingSphere();
  }

  dispose() {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
    this.capacity = 0;
  }
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function signTexture(text: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16365a';
  g.fillRect(0, 0, 512, 96);
  g.strokeStyle = '#eef0ea';
  g.lineWidth = 5;
  g.strokeRect(6, 6, 500, 84);
  g.fillStyle = '#f4f5f0';
  g.font = '600 56px Overpass, Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function speedSignTexture(kmh: number, advance: boolean) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  if (advance) {
    g.fillStyle = '#15282a';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f0a62b';
    g.fillRect(10, 10, 236, 236);
    g.fillStyle = '#f3efe0';
    g.fillRect(26, 26, 204, 204);
    g.fillStyle = '#15282a';
    g.font = '700 108px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(kmh), 128, 106);
    // Downward chevron warns that a lower limit lies ahead.
    g.beginPath();
    g.moveTo(86, 174);
    g.lineTo(170, 174);
    g.lineTo(128, 214);
    g.closePath();
    g.fill();
  } else {
    g.fillStyle = '#15282a';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f3efe0';
    g.beginPath();
    g.arc(128, 128, 114, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#c9302a';
    g.lineWidth = 22;
    g.beginPath();
    g.arc(128, 128, 103, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#15282a';
    g.font = `700 ${kmh >= 100 ? 96 : 114}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(kmh), 128, 134);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function routeNumTexture(num: number) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e1315';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#f4f1de';
  g.font = '700 92px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hasFacingJunctionInBlock(net: Network, startNode: number, startSide: Side): boolean {
  if (net.attached(startNode, startSide).length > 1) return true;
  const seen = new Set<number>();
  const walk = (segId: number, dir: 1 | -1, depth: number): boolean => {
    if (seen.has(segId) || depth > 16) return false;
    seen.add(segId);
    const e = net.exit(segId, dir);
    const def = net.nodes.get(e.node)!.signals[e.side];
    if (def && signalType(def) !== 'distant') return false;
    if (e.options.length > 1) return true;
    for (const opt of e.options) {
      if (walk(opt, net.entryDir(opt, e.node, e.side), depth + 1)) return true;
    }
    return false;
  };
  for (const opt of net.attached(startNode, startSide)) {
    if (walk(opt, net.entryDir(opt, startNode, startSide), 0)) return true;
  }
  return false;
}

function makeLampMat(color: number, emissive: number, intensity: number) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: intensity,
    roughness: 0.25,
  });
}

function translatedGeo(geo: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0): THREE.BufferGeometry {
  const g = geo.clone();
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

export class PropsRenderer {
  group = new THREE.Group();
  readonly stats = { nodeRebuilds: 0, signUpdates: 0, speedSignRebuilds: 0 };

  private nodeRecords = new Map<number, NodeRecord>();
  private signals = new Map<string, SignalVisual>();
  private levers = new Map<string, LeverVisual>();
  private stationBoards = new Map<number, StationBoardVisual>();
  private invalidated = true;

  private pools = new Map<string, InstancedPool>();
  private dirtyPools = new Set<string>();
  private lampsDirty = false;
  private leversDirty = false;
  private pointLightsDirty = false;

  private lamps: THREE.Vector3[] = [];
  private lightPool: THREE.PointLight[] = [];
  private glowTex = glowTexture();
  private speedTex = new Map<string, THREE.CanvasTexture>();
  private speedFaceMats = new Map<string, THREE.MeshStandardMaterial>();
  private speedPools = new Map<string, InstancedPool>();
  private routeTex = new Map<number, THREE.CanvasTexture>();
  /** Lamps nearest the camera first. Re-sorted in place only once the camera has moved a fair way. */
  private nearLamps: THREE.Vector3[] = [];
  private sortedAt = new THREE.Vector3(Infinity, 0, 0);

  // Reusable scratch objects to keep sync() and update() allocation-free.
  private tmpObj = new THREE.Object3D();
  private tmpPoolMats: THREE.Matrix4[] = [];
  private tmpLeverMats: THREE.Matrix4[] = [];
  private tmpLeverCols: THREE.Color[] = [];
  private leverMatCache: THREE.Matrix4[] = [];
  private leverColCache: THREE.Color[] = [];
  private tmpSpeedBuckets = new Map<string, THREE.Matrix4[]>();
  private tmpLampBuckets = new Map<string, THREE.Matrix4[]>();
  private lampPools = new Map<string, InstancedPool>();
  private leverPool: InstancedPool;

  // Shared geometries and materials reused across the network.
  private armGeo = translatedGeo(new THREE.BoxGeometry(0.46, 0.46, 0.04), 0, 1.35, 0);
  private armMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  private boardGeo = new THREE.PlaneGeometry(6.4, 1.2);
  private postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6);
  private postMat = new THREE.MeshStandardMaterial({ color: 0x25292c, roughness: 0.6 });
  private darkSteelMat = new THREE.MeshStandardMaterial({ color: 0x1b1e20, roughness: 0.55, metalness: 0.4 });
  private brassMat = new THREE.MeshStandardMaterial({ color: 0xc7a350, roughness: 0.35, metalness: 0.7 });
  private amberPaintMat = new THREE.MeshStandardMaterial({ color: 0xf0a62b, roughness: 0.45 });
  private creamPaintMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d2, roughness: 0.5 });
  private concreteMat = new THREE.MeshStandardMaterial({ color: 0x7b7b75, roughness: 0.9 });
  private speedPostGeo = translatedGeo(new THREE.CylinderGeometry(0.045, 0.045, 2.35, 6), 0, 1.15, -0.04);
  private speedBoardGeo = translatedGeo(new THREE.PlaneGeometry(1.15, 1.15), 0, 2.25, 0.005);
  private speedBackGeo = translatedGeo(new THREE.BoxGeometry(1.18, 1.18, 0.04), 0, 2.25, -0.02);
  private routeBoxGeo = translatedGeo(new THREE.BoxGeometry(0.96, 0.58, 0.14), 0, 5.82, 0.08);
  private routeTrimGeo = translatedGeo(new THREE.BoxGeometry(1.02, 0.64, 0.1), 0, 5.82, 0.08);
  private routeNumGeo = new THREE.PlaneGeometry(0.32, 0.38);
  private leftDotsGeo: THREE.BufferGeometry;
  private rightDotsGeo: THREE.BufferGeometry;

  // Baked local geometries for distant and shunt signals so every part can be instanced across the network.
  private distantStaticParts: { key: string; geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean }[];
  private shuntStaticParts: { key: string; geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean }[];
  private mainBodyPrims: { key: string; geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
  private distantLensYellowGeo = (() => {
    const g = new THREE.CylinderGeometry(0.125, 0.125, 0.04, 16);
    g.rotateX(Math.PI / 2);
    g.translate(0, 4.95, 0.16);
    return g;
  })();
  private distantLensGreenGeo = (() => {
    const g = new THREE.CylinderGeometry(0.125, 0.125, 0.04, 16);
    g.rotateX(Math.PI / 2);
    g.translate(0, 4.55, 0.16);
    return g;
  })();
  private shuntLensRedGeo = (() => {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 14);
    g.rotateX(Math.PI / 2);
    g.translate(0.14, 1.24, 0.1);
    return g;
  })();
  private shuntLensWhite1Geo = (() => {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 14);
    g.rotateX(Math.PI / 2);
    g.translate(-0.14, 1.24, 0.1);
    return g;
  })();
  private shuntLensWhite2Geo = (() => {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 14);
    g.rotateX(Math.PI / 2);
    g.translate(0.14, 1.52, 0.1);
    return g;
  })();
  private lampMats = {
    mainRedOn: makeLampMat(0x2a0606, 0xff1a10, LAMP_INTENSITY.red),
    mainRedOff: makeLampMat(0x2a0606, 0xff1a10, 0),
    mainAmberOn: makeLampMat(0x2a1d06, 0xffa010, LAMP_INTENSITY.yellow),
    mainAmberOff: makeLampMat(0x2a1d06, 0xffa010, 0),
    mainGreenOn: makeLampMat(0x062a14, 0x18ff78, LAMP_INTENSITY.green),
    mainGreenOff: makeLampMat(0x062a14, 0x18ff78, 0),
    distYellowOn: makeLampMat(0x2a1d06, 0xffa010, LAMP_INTENSITY.yellow),
    distYellowOff: makeLampMat(0x2a1d06, 0xffa010, 0),
    distGreenOn: makeLampMat(0x062a14, 0x18ff78, LAMP_INTENSITY.green),
    distGreenOff: makeLampMat(0x062a14, 0x18ff78, 0),
    shuntRedOn: makeLampMat(0x2a0606, 0xff1a10, LAMP_INTENSITY.red),
    shuntRedOff: makeLampMat(0x2a0606, 0xff1a10, 0),
    shuntWhiteOn: makeLampMat(0x2a2a26, 0xf4f1de, LAMP_INTENSITY.white),
    shuntWhiteOff: makeLampMat(0x2a2a26, 0xf4f1de, 0),
  };

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    scene.add(this.group);
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xffc27a, 0, 34, 1.8);
      l.castShadow = false;
      this.lightPool.push(l);
      scene.add(l);
    }

    const makeDots = (sgn: number) => {
      const parts: THREE.BufferGeometry[] = [];
      for (let d = 0; d < 4; d++) {
        const g = new THREE.CylinderGeometry(0.038, 0.038, 0.04, 8);
        g.rotateX(Math.PI / 2);
        g.translate(sgn * (0.16 + d * 0.08), -0.1 + d * 0.09, 0.08);
        parts.push(g);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return merged;
    };
    this.leftDotsGeo = makeDots(-1);
    this.rightDotsGeo = makeDots(1);

    const mergeParts = (parts: THREE.BufferGeometry[]) => {
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return merged;
    };

    this.distantStaticParts = [
      {
        key: 'dist:base',
        geo: translatedGeo(new THREE.CylinderGeometry(0.2, 0.28, 0.35, 10), 0, 0.18, 0),
        mat: this.concreteMat,
        shadow: false,
      },
      {
        key: 'dist:steel',
        geo: mergeParts([
          translatedGeo(new THREE.CylinderGeometry(0.065, 0.075, 4.6, 10), 0, 2.45, 0),
          translatedGeo(new THREE.BoxGeometry(0.56, 0.56, 0.05), 0, 2.45, 0.09, Math.PI / 4),
          translatedGeo(new THREE.BoxGeometry(0.46, 0.94, 0.16), 0, 4.75, 0.08),
          ...[5.09, 4.69].map((hy) => translatedGeo(new THREE.BoxGeometry(0.3, 0.03, 0.26), 0, hy, 0.28)),
        ]),
        mat: this.darkSteelMat,
        shadow: true,
      },
      {
        key: 'dist:amber',
        geo: mergeParts([
          ...[1.1, 2.0, 2.9, 3.8].map((by) =>
            translatedGeo(new THREE.CylinderGeometry(0.074, 0.074, 0.42, 10), 0, by, 0),
          ),
          translatedGeo(new THREE.BoxGeometry(0.42, 0.42, 0.06), 0, 2.45, 0.1, Math.PI / 4),
        ]),
        mat: this.amberPaintMat,
        shadow: false,
      },
    ];

    this.shuntStaticParts = [
      {
        key: 'shunt:base',
        geo: translatedGeo(new THREE.BoxGeometry(0.44, 0.2, 0.44), 0, 0.1, 0),
        mat: this.concreteMat,
        shadow: false,
      },
      {
        key: 'shunt:steel',
        geo: mergeParts([
          translatedGeo(new THREE.CylinderGeometry(0.055, 0.065, 1.0, 8), 0, 0.7, 0),
          translatedGeo(new THREE.BoxGeometry(0.62, 0.62, 0.2), 0, 1.38, 0),
        ]),
        mat: this.darkSteelMat,
        shadow: false,
      },
      {
        key: 'shunt:stripe',
        geo: translatedGeo(new THREE.BoxGeometry(0.64, 0.08, 0.22), 0, 1.03, 0),
        mat: this.creamPaintMat,
        shadow: false,
      },
    ];

    this.leverPool = new InstancedPool(this.group, this.armGeo, this.armMat, false, false, true);
    this.initPools();
  }

  private initPools() {
    const registerAsset = (assetName: string, prefix: string, castShadow = true, receiveShadow = true) => {
      this.assets.primitives(assetName).forEach((prim, idx) => {
        const key = `${prefix}:${idx}`;
        this.pools.set(key, new InstancedPool(this.group, prim.geometry, prim.material, castShadow, receiveShadow));
      });
    };

    registerAsset('buffer_stop', 'buffer', false);
    registerAsset('switch_stand', 'lever_stand', false);
    registerAsset('platform', 'platform');
    registerAsset('station_building', 'station_building');
    registerAsset('shelter', 'shelter');
    registerAsset('lamp_post', 'lamp_post');
    this.pools.set('sign_post', new InstancedPool(this.group, this.postGeo, this.postMat, false, true));
    this.pools.set('route:trim', new InstancedPool(this.group, this.routeTrimGeo, this.brassMat, false, false));
    this.pools.set('route:box', new InstancedPool(this.group, this.routeBoxGeo, this.darkSteelMat, false, false));

    for (const part of this.distantStaticParts) {
      this.pools.set(part.key, new InstancedPool(this.group, part.geo, part.mat, part.shadow, true));
    }
    for (const part of this.shuntStaticParts) {
      this.pools.set(part.key, new InstancedPool(this.group, part.geo, part.mat, part.shadow, true));
    }

    const mastPrims = this.assets.primitives('signal_mast');
    let redGeo: THREE.BufferGeometry | null = null;
    let amberGeo: THREE.BufferGeometry | null = null;
    let greenGeo: THREE.BufferGeometry | null = null;
    mastPrims.forEach((prim, idx) => {
      if (prim.name.startsWith('lamp_red')) redGeo = prim.geometry;
      else if (prim.name.startsWith('lamp_amber')) amberGeo = prim.geometry;
      else if (prim.name.startsWith('lamp_green')) greenGeo = prim.geometry;
      else {
        const key = `main:body:${idx}`;
        this.mainBodyPrims.push({ key, geo: prim.geometry, mat: prim.material });
        this.pools.set(key, new InstancedPool(this.group, prim.geometry, prim.material, true, true));
      }
    });
    if (redGeo && amberGeo && greenGeo) {
      this.lampPools.set('main:red:on', new InstancedPool(this.group, redGeo, this.lampMats.mainRedOn, false, false));
      this.lampPools.set('main:red:off', new InstancedPool(this.group, redGeo, this.lampMats.mainRedOff, false, false));
      this.lampPools.set(
        'main:amber:on',
        new InstancedPool(this.group, amberGeo, this.lampMats.mainAmberOn, false, false),
      );
      this.lampPools.set(
        'main:amber:off',
        new InstancedPool(this.group, amberGeo, this.lampMats.mainAmberOff, false, false),
      );
      this.lampPools.set(
        'main:green:on',
        new InstancedPool(this.group, greenGeo, this.lampMats.mainGreenOn, false, false),
      );
      this.lampPools.set(
        'main:green:off',
        new InstancedPool(this.group, greenGeo, this.lampMats.mainGreenOff, false, false),
      );
    }
    this.lampPools.set(
      'dist:yellow:on',
      new InstancedPool(this.group, this.distantLensYellowGeo, this.lampMats.distYellowOn, false, false),
    );
    this.lampPools.set(
      'dist:yellow:off',
      new InstancedPool(this.group, this.distantLensYellowGeo, this.lampMats.distYellowOff, false, false),
    );
    this.lampPools.set(
      'dist:green:on',
      new InstancedPool(this.group, this.distantLensGreenGeo, this.lampMats.distGreenOn, false, false),
    );
    this.lampPools.set(
      'dist:green:off',
      new InstancedPool(this.group, this.distantLensGreenGeo, this.lampMats.distGreenOff, false, false),
    );
    this.lampPools.set(
      'shunt:red:on',
      new InstancedPool(this.group, this.shuntLensRedGeo, this.lampMats.shuntRedOn, false, false),
    );
    this.lampPools.set(
      'shunt:red:off',
      new InstancedPool(this.group, this.shuntLensRedGeo, this.lampMats.shuntRedOff, false, false),
    );
    this.lampPools.set(
      'shunt:white:on',
      new InstancedPool(this.group, this.shuntLensWhite1Geo, this.lampMats.shuntWhiteOn, false, false),
    );
    this.lampPools.set(
      'shunt:white:off',
      new InstancedPool(this.group, this.shuntLensWhite1Geo, this.lampMats.shuntWhiteOff, false, false),
    );
    this.lampPools.set(
      'shunt:white2:on',
      new InstancedPool(this.group, this.shuntLensWhite2Geo, this.lampMats.shuntWhiteOn, false, false),
    );
    this.lampPools.set(
      'shunt:white2:off',
      new InstancedPool(this.group, this.shuntLensWhite2Geo, this.lampMats.shuntWhiteOff, false, false),
    );

    this.speedPools.set('post', new InstancedPool(this.group, this.speedPostGeo, this.postMat, true, true));
    this.speedPools.set('back', new InstancedPool(this.group, this.speedBackGeo, this.darkSteelMat, false, true));
  }

  /** Rebuilds only the nodes, station signs, or speed signs that changed since the last sync. */
  sync(net: Network) {
    if (this.invalidated) {
      this.invalidated = false;
      this.clearAll();
      for (const nid of net.nodes.keys()) net.dirtyNodes.add(nid);
      net.speedSignsDirty = true;
    }

    if (net.dirtyNodes.size > 0) {
      for (const nid of net.dirtyNodes) {
        this.removeNodeProps(nid);
        const node = net.nodes.get(nid);
        if (node) this.buildNodeProps(net, node);
        this.stats.nodeRebuilds++;
      }
      net.dirtyNodes.clear();
    }

    if (net.dirtyStationSigns.size > 0) {
      for (const stId of net.dirtyStationSigns) {
        const st = net.stationById(stId);
        const rec = this.stationBoards.get(stId);
        if (st && rec) {
          rec.tex.dispose();
          const next = signTexture(st.name);
          rec.tex = next;
          rec.mat.map = next;
          rec.mat.needsUpdate = true;
          this.stats.signUpdates++;
        }
      }
      net.dirtyStationSigns.clear();
    }

    if (net.speedSignsDirty) {
      net.speedSignsDirty = false;
      this.rebuildSpeedSigns(net);
      this.stats.speedSignRebuilds++;
    }

    if (this.dirtyPools.size > 0) {
      this.flushDirtyPools();
      this.dirtyPools.clear();
    }

    if (this.pointLightsDirty) {
      this.pointLightsDirty = false;
      this.lamps = [];
      for (const rec of this.nodeRecords.values()) {
        for (const p of rec.lampPositions) this.lamps.push(p);
      }
      this.nearLamps = [];
    }
  }

  invalidate() {
    this.invalidated = true;
  }

  private clearAll() {
    for (const nid of [...this.nodeRecords.keys()]) this.removeNodeProps(nid);
    for (const pool of this.pools.values()) pool.dispose();
    for (const pool of this.lampPools.values()) pool.dispose();
    for (const pool of this.speedPools.values()) pool.dispose();
    this.leverPool.dispose();
    this.signals.clear();
    this.levers.clear();
    this.stationBoards.clear();
    this.lamps = [];
    this.nearLamps = [];
    this.dirtyPools.clear();
    this.lampsDirty = false;
    this.leversDirty = false;
    this.pointLightsDirty = false;
  }

  private removeNodeProps(nid: number) {
    const rec = this.nodeRecords.get(nid);
    if (!rec) return;
    for (const o of rec.objects) this.group.remove(o);
    for (const r of rec.owned) r.dispose();
    for (const key of rec.signalKeys) {
      this.signals.delete(key);
      this.lampsDirty = true;
    }
    for (const key of rec.leverKeys) {
      this.levers.delete(key);
      this.leversDirty = true;
    }
    for (const e of rec.entries) this.dirtyPools.add(e.poolKey);
    if (rec.lampPositions.length > 0) this.pointLightsDirty = true;
    if (rec.stationId !== undefined) this.stationBoards.delete(rec.stationId);
    this.nodeRecords.delete(nid);
  }

  private buildNodeProps(net: Network, node: RailNode) {
    const rec: NodeRecord = {
      entries: [],
      signalKeys: [],
      leverKeys: [],
      lampPositions: [],
      objects: [],
      owned: [],
    };
    for (const side of [1, -1] as Side[]) {
      if (node.signals[side]) this.addSignal(net, node, side, rec);
      const opts = net.attached(node.id, side);
      if (opts.length > 1) this.addLever(node, side, rec);
      if (opts.length === 0 && net.attached(node.id, -side as Side).length > 0) this.addBuffer(node, side, rec);
    }
    const st = net.stationAt(node.id);
    if (st) this.addStation(net, node, st, rec);
    this.nodeRecords.set(node.id, rec);
  }

  private pushAssetInstances(prefix: string, assetName: string, matrix: THREE.Matrix4, rec: NodeRecord) {
    const count = this.assets.primitives(assetName).length;
    for (let i = 0; i < count; i++) {
      const poolKey = `${prefix}:${i}`;
      rec.entries.push({ poolKey, matrix });
      this.dirtyPools.add(poolKey);
    }
  }

  private pushStaticInstance(poolKey: string, matrix: THREE.Matrix4, rec: NodeRecord) {
    rec.entries.push({ poolKey, matrix });
    this.dirtyPools.add(poolKey);
  }

  private flushDirtyPools() {
    for (const key of this.dirtyPools) {
      const pool = this.pools.get(key);
      if (!pool) continue;
      const list = this.tmpPoolMats;
      list.length = 0;
      for (const rec of this.nodeRecords.values()) {
        for (let i = 0; i < rec.entries.length; i++) {
          if (rec.entries[i].poolKey === key) list.push(rec.entries[i].matrix);
        }
      }
      pool.sync(list);
    }
  }

  private rebuildSpeedSigns(net: Network) {
    const signs = computeSpeedSigns(net);
    const posts: THREE.Matrix4[] = [];
    const backs: THREE.Matrix4[] = [];
    for (const list of this.tmpSpeedBuckets.values()) list.length = 0;

    const t = this.tmpObj;
    for (const sign of signs) {
      t.position.set(sign.x + -sign.tz * 2.55, sign.y - 0.2, sign.z + sign.tx * 2.55);
      t.rotation.set(0, Math.atan2(-sign.tx, -sign.tz), 0);
      t.scale.set(1, 1, 1);
      t.updateMatrix();
      const m = t.matrix.clone();
      posts.push(m);
      backs.push(m);

      const texKey = `${sign.advance ? 'adv' : 'main'}:${sign.kmh}`;
      let list = this.tmpSpeedBuckets.get(texKey);
      if (!list) this.tmpSpeedBuckets.set(texKey, (list = []));
      list.push(m);
    }
    this.speedPools.get('post')!.sync(posts);
    this.speedPools.get('back')!.sync(backs);

    for (const [texKey, list] of this.tmpSpeedBuckets) {
      let pool = this.speedPools.get(`face:${texKey}`);
      if (!pool) {
        let tex = this.speedTex.get(texKey);
        if (!tex) {
          const [kind, kmhStr] = texKey.split(':');
          tex = speedSignTexture(Number(kmhStr), kind === 'adv');
          this.speedTex.set(texKey, tex);
        }
        const mat = new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.4,
          emissive: 0xffffff,
          emissiveMap: tex,
          emissiveIntensity: 0.14,
        });
        this.speedFaceMats.set(texKey, mat);
        pool = new InstancedPool(this.group, this.speedBoardGeo, mat, false, false);
        this.speedPools.set(`face:${texKey}`, pool);
      }
      pool.sync(list);
    }
  }

  private setupLampMat(mat: THREE.MeshStandardMaterial, color: number, emissive: number, rec: NodeRecord) {
    mat.color.set(color);
    mat.emissive.set(emissive);
    mat.roughness = 0.25;
    mat.emissiveIntensity = 0;
    rec.owned.push(mat);
    return mat;
  }

  private addSignal(net: Network, node: RailNode, side: Side, rec: NodeRecord) {
    const type = signalType(node.signals[side]);
    const tx = node.dx * side;
    const tz = node.dz * side;
    const yaw = Math.atan2(-tx, -tz);
    const key = keyOf(node.id, side);

    const t = this.tmpObj;
    const lat = type === 'shunt' ? 2.45 : 2.9;
    const back = type === 'shunt' ? 2.5 : 3.0;
    const yOff = type === 'shunt' ? -0.35 : -0.55;
    const px = node.x + -tz * lat - tx * back;
    const py = node.y + yOff;
    const pz = node.z + tx * lat - tz * back;
    t.position.set(px, py, pz);
    t.rotation.set(0, yaw, 0);
    t.scale.set(1, 1, 1);
    t.updateMatrix();
    const worldMatrix = t.matrix.clone();

    if (type === 'shunt') {
      for (const part of this.shuntStaticParts) this.pushStaticInstance(part.key, worldMatrix, rec);
    } else if (type === 'distant') {
      for (const part of this.distantStaticParts) this.pushStaticInstance(part.key, worldMatrix, rec);
    } else {
      for (const prim of this.mainBodyPrims) this.pushStaticInstance(prim.key, worldMatrix, rec);
    }

    let routeVis: RouteVisual | undefined;
    if (type === 'main' && hasFacingJunctionInBlock(net, node.id, side)) {
      this.pushStaticInstance('route:trim', worldMatrix, rec);
      this.pushStaticInstance('route:box', worldMatrix, rec);
      const rGroup = new THREE.Group();
      rGroup.position.set(px, py, pz);
      rGroup.rotation.y = yaw;
      const boxWrap = new THREE.Group();
      boxWrap.position.set(0, 5.82, 0.08);

      const leftMat = this.setupLampMat(new THREE.MeshStandardMaterial(), 0x1b1d1e, 0xf4f1de, rec);
      const rightMat = this.setupLampMat(new THREE.MeshStandardMaterial(), 0x1b1d1e, 0xf4f1de, rec);
      boxWrap.add(new THREE.Mesh(this.leftDotsGeo, leftMat), new THREE.Mesh(this.rightDotsGeo, rightMat));
      const numMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xf4f1de,
        emissiveIntensity: 0,
        roughness: 0.3,
      });
      rec.owned.push(numMat);
      const numMesh = new THREE.Mesh(this.routeNumGeo, numMat);
      numMesh.position.set(0, 0, 0.082);
      boxWrap.add(numMesh);
      rGroup.add(boxWrap);
      this.group.add(rGroup);
      rec.objects.push(rGroup);
      routeVis = { left: leftMat, right: rightMat, numMat, lastDir: '', lastNum: -1 };
    }

    const spriteMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    rec.owned.push(spriteMat);
    const glow = new THREE.Sprite(spriteMat);
    glow.scale.setScalar(type === 'shunt' ? 1.9 : 2.6);
    glow.position.set(px - tx * 0.25, py + (type === 'shunt' ? 1.38 : 4.75), pz - tz * 0.25);
    this.group.add(glow);
    rec.objects.push(glow);

    this.signals.set(key, { key, nodeId: node.id, type, worldMatrix, route: routeVis, glow, lastAspect: null });
    rec.signalKeys.push(key);
    this.lampsDirty = true;
  }

  private addLever(node: RailNode, side: Side, rec: NodeRecord) {
    const tx = node.dx * side;
    const tz = node.dz * side;
    const px = node.x - -tz * 3.1;
    const py = node.y - 0.6;
    const pz = node.z - tx * 3.1;
    const yaw = Math.atan2(tx, tz);
    const t = this.tmpObj;
    t.position.set(px, py, pz);
    t.rotation.set(0, yaw, 0);
    t.scale.set(1, 1, 1);
    t.updateMatrix();
    this.pushAssetInstances('lever_stand', 'switch_stand', t.matrix.clone(), rec);
    const key = keyOf(node.id, side);
    this.levers.set(key, { key, node: node.id, side, px, py, pz, yaw, lastState: -1 });
    rec.leverKeys.push(key);
    this.leversDirty = true;
  }

  private addBuffer(node: RailNode, side: Side, rec: NodeRecord) {
    const tx = node.dx * side;
    const tz = node.dz * side;
    const t = this.tmpObj;
    t.position.set(node.x, node.y - 0.25, node.z);
    t.rotation.set(0, Math.atan2(-tx, -tz), 0);
    t.scale.set(1, 1, 1);
    t.updateMatrix();
    this.pushAssetInstances('buffer', 'buffer_stop', t.matrix.clone(), rec);
  }

  private addStation(net: Network, node: RailNode, st: Station, rec: NodeRecord) {
    const halfLen = st.length / 2;
    const seg1 = net.attached(node.id, 1);
    const seg2 = net.attached(node.id, -1);
    const offset = 1.6 + 2.3;
    const t = this.tmpObj;
    t.scale.set(1, 1, 1);

    const walk = (segs: number[], fromSide: Side, sign: number) => {
      if (!segs.length) return;
      const segId = segs[0];
      const seg = net.segs.get(segId)!;
      const L = net.geom.get(segId)!.length;
      const forward = seg.a === node.id && seg.sa === fromSide;
      for (let d = sign > 0 ? 5 : 15; d < halfLen; d += 10) {
        if (d > L) break;
        const p = net.sample(segId, forward ? d : L - d);
        const flip = forward ? 1 : -1;
        const tx = p.tx * flip * fromSide;
        const tz = p.tz * flip * fromSide;
        const rx = -tz * st.platformSide;
        const rz = tx * st.platformSide;
        t.position.set(p.x + rx * offset, p.y - 0.05, p.z + rz * offset);
        t.rotation.set(0, Math.atan2(rx, rz) + Math.PI / 2, 0);
        t.updateMatrix();
        this.pushAssetInstances('platform', 'platform', t.matrix.clone(), rec);
      }
    };
    walk(seg1, 1, 1);
    walk(seg2, -1, -1);

    const rx = -node.dz * st.platformSide;
    const rz = node.dx * st.platformSide;
    const y = node.y + 1.0;
    const yaw = Math.atan2(rx, rz) + Math.PI / 2;
    const placeInst = (prefix: string, asset: string, along: number, lateral: number, yOff = 0) => {
      t.position.set(node.x + node.dx * along + rx * lateral, y + yOff, node.z + node.dz * along + rz * lateral);
      t.rotation.set(0, yaw, 0);
      t.updateMatrix();
      this.pushAssetInstances(prefix, asset, t.matrix.clone(), rec);
    };
    placeInst('station_building', 'station_building', 4, 14.2, -0.08);
    for (const along of [-42, 42]) placeInst('shelter', 'shelter', along, offset - 0.1);
    for (let along = -st.length / 2 + 12; along < st.length / 2 - 4; along += 26) {
      placeInst('lamp_post', 'lamp_post', along, offset - 1.2);
      rec.lampPositions.push(
        new THREE.Vector3(
          node.x + node.dx * along + rx * (offset - 1.2) + Math.cos(yaw) * 0.75,
          y + 4.5,
          node.z + node.dz * along + rz * (offset - 1.2) - Math.sin(yaw) * 0.75,
        ),
      );
    }
    if (rec.lampPositions.length > 0) this.pointLightsDirty = true;

    const tex = signTexture(st.name);
    const boardMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.5,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      side: THREE.DoubleSide,
    });
    rec.owned.push(boardMat, tex);
    const board = new THREE.Mesh(this.boardGeo, boardMat);
    board.position.set(
      node.x + node.dx * 16 + rx * (offset + 0.2),
      y + 2.5,
      node.z + node.dz * 16 + rz * (offset + 0.2),
    );
    board.rotation.y = Math.atan2(-rx, -rz);
    this.group.add(board);
    rec.objects.push(board);
    rec.stationId = st.id;
    this.stationBoards.set(st.id, { stationId: st.id, mat: boardMat, tex });

    for (const leg of [-2.8, 2.8]) {
      t.position.set(board.position.x + node.dx * leg, y + 1.25, board.position.z + node.dz * leg);
      t.rotation.set(0, 0, 0);
      t.updateMatrix();
      this.pushStaticInstance('sign_post', t.matrix.clone(), rec);
    }
  }

  private flushSignalLamps() {
    for (const list of this.tmpLampBuckets.values()) list.length = 0;
    const push = (bucket: string, m: THREE.Matrix4) => {
      let list = this.tmpLampBuckets.get(bucket);
      if (!list) this.tmpLampBuckets.set(bucket, (list = []));
      list.push(m);
    };
    for (const v of this.signals.values()) {
      const a = v.lastAspect ?? 'red';
      if (v.type === 'shunt') {
        const on = a !== 'red';
        push(on ? 'shunt:red:off' : 'shunt:red:on', v.worldMatrix);
        push(on ? 'shunt:white:on' : 'shunt:white:off', v.worldMatrix);
        push(on ? 'shunt:white2:on' : 'shunt:white2:off', v.worldMatrix);
      } else if (v.type === 'distant') {
        push(a === 'yellow' ? 'dist:yellow:on' : 'dist:yellow:off', v.worldMatrix);
        push(a === 'green' ? 'dist:green:on' : 'dist:green:off', v.worldMatrix);
      } else {
        push(a === 'red' ? 'main:red:on' : 'main:red:off', v.worldMatrix);
        push(a === 'yellow' ? 'main:amber:on' : 'main:amber:off', v.worldMatrix);
        push(a === 'green' ? 'main:green:on' : 'main:green:off', v.worldMatrix);
      }
    }
    for (const [key, pool] of this.lampPools) {
      const list = this.tmpLampBuckets.get(key);
      if (list) pool.sync(list);
      else {
        this.tmpPoolMats.length = 0;
        pool.sync(this.tmpPoolMats);
      }
    }
  }

  /** Lamp states, route indicators, speed board night glow, lever flags and the nearest platform lights. */
  update(sim: Sim, camera: THREE.Camera, night: number) {
    const net = sim.net;
    for (const v of this.signals.values()) {
      const ind = sim.indications.get(v.key);
      const aspect = ind?.aspect ?? sim.aspects.get(v.key) ?? 'red';
      if (aspect !== v.lastAspect) {
        v.lastAspect = aspect;
        this.lampsDirty = true;
        if (v.type === 'shunt') {
          v.glow.material.color.set(aspect === 'red' ? 0xff2a18 : 0xf4f1de);
        } else {
          v.glow.material.color.set(aspect === 'red' ? 0xff2a18 : aspect === 'yellow' ? 0xffa820 : 0x30ff88);
        }
      }
      if (v.route) {
        const route = aspect !== 'red' && ind?.route?.diverging ? ind.route : null;
        const dir = route ? route.dir : 'off';
        const num = route ? route.index + 1 : 0;
        if (dir !== v.route.lastDir || num !== v.route.lastNum) {
          v.route.lastDir = dir;
          v.route.lastNum = num;
          v.route.left.emissiveIntensity = dir === 'left' ? 14 : 0;
          v.route.right.emissiveIntensity = dir === 'right' ? 14 : 0;
          if (num > 0) {
            let tex = this.routeTex.get(num);
            if (!tex) {
              tex = routeNumTexture(num);
              this.routeTex.set(num, tex);
            }
            v.route.numMat.color.setHex(0xffffff);
            v.route.numMat.map = tex;
            v.route.numMat.emissiveMap = tex;
            v.route.numMat.emissiveIntensity = 4;
            v.route.numMat.needsUpdate = true;
          } else {
            v.route.numMat.map = null;
            v.route.numMat.emissiveMap = null;
            v.route.numMat.emissiveIntensity = 0;
            v.route.numMat.color.setHex(0x0e1315);
            v.route.numMat.needsUpdate = true;
          }
        }
      }
      v.glow.material.opacity = 0.15 + night * 0.75;
    }

    if (this.lampsDirty) {
      this.lampsDirty = false;
      this.flushSignalLamps();
    }

    const boardEmissive = 0.14 + night * 0.48;
    for (const m of this.speedFaceMats.values()) m.emissiveIntensity = boardEmissive;

    for (const lever of this.levers.values()) {
      const opts = net.attached(lever.node, lever.side);
      if (!opts.length) continue;
      const idx = opts.indexOf(net.selected(lever.node, lever.side)!);
      const state = idx === 0 ? 0 : 1;
      if (state !== lever.lastState) {
        lever.lastState = state;
        this.leversDirty = true;
      }
    }
    if (this.leversDirty) {
      this.leversDirty = false;
      const mats = this.tmpLeverMats;
      const cols = this.tmpLeverCols;
      mats.length = 0;
      cols.length = 0;
      const t = this.tmpObj;
      let idx = 0;
      for (const lever of this.levers.values()) {
        const state = lever.lastState === 1 ? 1 : 0;
        t.position.set(lever.px, lever.py, lever.pz);
        t.rotation.set(0, lever.yaw + (state === 0 ? 0 : Math.PI / 2), 0);
        t.scale.set(1, 1, 1);
        t.updateMatrix();
        let m = this.leverMatCache[idx];
        if (!m) {
          m = new THREE.Matrix4();
          this.leverMatCache[idx] = m;
        }
        m.copy(t.matrix);
        mats.push(m);
        let c = this.leverColCache[idx];
        if (!c) {
          c = new THREE.Color();
          this.leverColCache[idx] = c;
        }
        c.setHex(state === 0 ? 0x32c46c : 0xe8a820);
        cols.push(c);
        idx++;
      }
      this.leverPool.sync(mats, cols);
    }

    const camPos = camera.position;
    const on = night > 0.25;
    if (on && this.lamps.length) {
      if (this.nearLamps.length !== this.lamps.length || this.sortedAt.distanceToSquared(camPos) > 25 * 25) {
        if (this.nearLamps.length !== this.lamps.length) this.nearLamps = [...this.lamps];
        this.nearLamps.sort((a, b) => a.distanceToSquared(camPos) - b.distanceToSquared(camPos));
        this.sortedAt.copy(camPos);
      }
      const sorted = this.nearLamps;
      for (let i = 0; i < this.lightPool.length; i++) {
        const l = this.lightPool[i];
        const p = sorted[i];
        if (p && p.distanceTo(camPos) < 500) {
          l.position.copy(p);
          l.intensity = 70 * night;
        } else l.intensity = 0;
      }
    } else {
      for (const l of this.lightPool) l.intensity = 0;
    }
  }
}
