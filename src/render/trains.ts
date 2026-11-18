// Draws each train from the simulation: instanced bogies/wheelsets/couplers, sway, headlights and cab interior.
import * as THREE from 'three';

import { LINE_VMAX } from '../rail/network';
import type { Sim, Train } from '../rail/sim';
import { VEHICLES } from '../rail/vehicles';
import type { Assets } from './assets';
import { prefersReducedMotion } from './cameraRig';

const WHEEL_RADIUS = 0.46;
const DIAL_MAX_KMH = Math.ceil((LINE_VMAX * 3.6) / 20) * 20 + 20;
const MIN_INST_CAP = 16;

export interface TrainRenderOpts {
  cameraPos?: THREE.Vector3;
  driven?: Train | null;
  cabActive?: boolean;
  cabLever?: number;
  night?: number;
  rain?: number;
  snow?: number;
  time?: number;
  reducedMotion?: boolean;
}

interface CarVisual {
  root: THREE.Group;
  body: THREE.Object3D;
}

interface TrainVisual {
  group: THREE.Group;
  cars: CarVisual[];
  beamGroup: THREE.Group;
  signature: string;
  /** The consist the order below was worked out for. Reversing a train replaces its cars array. */
  orderFor: Train['cars'] | null;
  /** Car visuals in the train's current car order. */
  ordered: CarVisual[];
}

class TrainInstPool {
  mesh: THREE.InstancedMesh | null = null;
  private cap = 0;

  constructor(
    private group: THREE.Group,
    private geo: THREE.BufferGeometry,
    private mat: THREE.Material,
    private castShadow = true,
    private receiveShadow = true,
  ) {}

  sync(mats: THREE.Matrix4[], count: number) {
    if (count === 0) {
      if (this.mesh) {
        this.mesh.count = 0;
        this.mesh.visible = false;
      }
      return;
    }
    if (!this.mesh || count > this.cap) {
      if (this.mesh) {
        this.group.remove(this.mesh);
        this.mesh.dispose();
      }
      let cap = Math.max(MIN_INST_CAP, this.cap || MIN_INST_CAP);
      while (cap < count) cap *= 2;
      this.cap = cap;
      this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
      this.mesh.castShadow = this.castShadow;
      this.mesh.receiveShadow = this.receiveShadow;
      this.mesh.frustumCulled = true;
      this.group.add(this.mesh);
    }
    this.mesh.visible = true;
    this.mesh.count = count;
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, mats[i]);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingBox();
    this.mesh.computeBoundingSphere();
  }

  dispose() {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
    this.cap = 0;
  }
}

const signature = (t: Train) =>
  t.cars
    .map((c) => c.type)
    .sort()
    .join(',');

function makeBeamConeGeo(): THREE.BufferGeometry {
  const len = 36;
  const r0 = 0.24;
  const r1 = 4.4;
  const segs = 16;
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    // Additive blending treats black as fully transparent, so fading RGB to 0 eliminates hard edges.
    const f = Math.max(0, 1 - z / len);
    const bright = f * f;
    col[i * 3] = 1.0 * bright;
    col[i * 3 + 1] = 0.92 * bright;
    col[i * 3 + 2] = 0.72 * bright;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function makeBeamPoolTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 96, 4, 64, 68, 62);
  grad.addColorStop(0, 'rgba(255, 240, 200, 0.95)');
  grad.addColorStop(0.45, 'rgba(255, 230, 180, 0.32)');
  grad.addColorStop(1, 'rgba(255, 220, 160, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function pushMat(list: THREE.Matrix4[], idx: number, src: THREE.Matrix4): number {
  let m = list[idx];
  if (!m) {
    m = new THREE.Matrix4();
    list[idx] = m;
  }
  m.copy(src);
  return idx + 1;
}

export class TrainRenderer {
  group = new THREE.Group();
  private visuals = new Map<number, TrainVisual>();
  headlight: THREE.SpotLight;

  private dirA = new THREE.Vector3();
  private dirB = new THREE.Vector3();
  private look = new THREE.Vector3();
  private tmpPosA = new THREE.Vector3();
  private tmpPosB = new THREE.Vector3();
  private tmpMidA = new THREE.Vector3();
  private tmpMidB = new THREE.Vector3();
  private tmpAxisA = new THREE.Vector3();
  private tmpAxisB = new THREE.Vector3();
  private tmpEndA = new THREE.Vector3();
  private tmpEndB = new THREE.Vector3();
  private tmpMid = new THREE.Vector3();
  private tmpHead = new THREE.Vector3();
  private tmpObj = new THREE.Object3D();
  private tmpWheelObj = new THREE.Object3D();
  private tmpWheelMat = new THREE.Matrix4();

  private bogieMats: THREE.Matrix4[] = [];
  private wheelMats: THREE.Matrix4[] = [];
  private couplerMats: THREE.Matrix4[] = [];
  private gangwayMats: THREE.Matrix4[] = [];
  private bogieCount = 0;
  private wheelCount = 0;
  private couplerCount = 0;
  private gangwayCount = 0;

  private bogiePools: TrainInstPool[];
  private wheelPools: TrainInstPool[];
  private couplerPool: TrainInstPool;
  private gangwayPool: TrainInstPool;

  private couplerGeo = new THREE.BoxGeometry(0.24, 0.18, 1);
  private gangwayGeo = new THREE.BoxGeometry(1.48, 2.25, 1);
  private couplerMat = new THREE.MeshStandardMaterial({ color: 0x1c1e20, roughness: 0.65, metalness: 0.75 });
  private gangwayMat = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.88, metalness: 0.15 });

  private beamConeGeo = makeBeamConeGeo();
  private beamPoolGeo = (() => {
    const g = new THREE.PlaneGeometry(8.6, 36);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.08, 19.5);
    return g;
  })();
  private beamPoolTex = makeBeamPoolTexture();
  private beamConeMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private beamPoolMat = new THREE.MeshBasicMaterial({
    map: this.beamPoolTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  private cabMesh: THREE.Object3D;
  private cabNeedle: THREE.Object3D | null = null;
  private cabLever: THREE.Object3D | null = null;
  private cabBodyHidden: THREE.Object3D | null = null;
  private cabWiperL: THREE.Group;
  private cabWiperR: THREE.Group;
  private cabGlass: THREE.Mesh;
  private cabGlassUniforms = {
    uTime: { value: 0 },
    uRain: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uWiperAngle: { value: 0 },
    uWiping: { value: 0 },
    uReduced: { value: 0 },
  };
  private wiperPhase = 0;
  private lastWiperT = -1;

  constructor(
    private scene: THREE.Scene,
    private assets: Assets,
  ) {
    scene.add(this.group);
    this.headlight = new THREE.SpotLight(0xfff3d6, 0, 440, 0.32, 0.62, 1.45);
    scene.add(this.headlight, this.headlight.target);

    this.bogiePools = assets
      .ownPrimitives('bogie')
      .map((p) => new TrainInstPool(this.group, p.geometry, p.material, true, true));
    this.wheelPools = assets
      .ownPrimitives('bogie', 'wheelset_front')
      .map((p) => new TrainInstPool(this.group, p.geometry, p.material, true, true));
    this.couplerPool = new TrainInstPool(this.group, this.couplerGeo, this.couplerMat, false, true);
    this.gangwayPool = new TrainInstPool(this.group, this.gangwayGeo, this.gangwayMat, true, true);

    this.cabMesh = this.assets.clone('cab_interior');
    this.cabMesh.visible = false;
    this.cabMesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = true;
    });
    this.cabNeedle = this.cabMesh.getObjectByName('cab_dial_needle') ?? null;
    this.cabLever = this.cabMesh.getObjectByName('cab_lever') ?? null;

    // Windscreen rain/frost overlay and twin wipers attached inside the front window aperture.
    const wiperMat = new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.55, metalness: 0.4 });
    const hubGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.03, 10);
    hubGeo.rotateX(Math.PI / 2);
    const armGeo = new THREE.BoxGeometry(0.018, 0.68, 0.016);
    armGeo.translate(0, 0.34, 0);
    const makeWiper = (x: number, parkAngle: number) => {
      const g = new THREE.Group();
      g.position.set(x, 2.5, 1.245);
      g.rotation.z = parkAngle;
      const hub = new THREE.Mesh(hubGeo, wiperMat);
      const arm = new THREE.Mesh(armGeo, wiperMat);
      arm.position.z = 0.01;
      g.add(hub, arm);
      this.cabMesh.add(g);
      return g;
    };
    this.cabWiperL = makeWiper(-0.52, 1.08);
    this.cabWiperR = makeWiper(0.52, -1.08);

    const glassGeo = new THREE.PlaneGeometry(2.38, 1.08);
    const glassMat = new THREE.ShaderMaterial({
      uniforms: this.cabGlassUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        void main() {
          vLocal = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uRain, uSnow, uNight, uWiperAngle, uWiping, uReduced;
        varying vec2 vLocal;

        float h21(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.45);
          return fract(p.x * p.y);
        }

        float dropletLayer(vec2 uv, float scale, float speed, float snowMode) {
          vec2 st = uv * scale;
          float colId = floor(st.x);
          st.y += mix(uTime * speed * (0.45 + 0.55 * h21(vec2(colId, 3.1))), 0.0, snowMode);
          vec2 id = floor(st);
          vec2 gv = fract(st) - 0.5;
          float r1 = h21(id);
          float r2 = h21(id + 19.37);
          vec2 off = vec2(r1 - 0.5, r2 - 0.5) * 0.54;
          float d = length(gv - off);
          float rad = mix(0.08, 0.21, fract(r1 * 17.3));
          float drop = 1.0 - smoothstep(rad * 0.45, rad, d);
          return drop * step(0.32, r2);
        }

        float wipeMask(vec2 p, vec2 pivot) {
          vec2 d = p - pivot;
          float r = length(d);
          if (r < 0.08 || r > 0.72 || d.y < 0.02) return 0.0;
          float ang = -atan(d.x, d.y);
          float sector = smoothstep(-0.88, -0.78, ang) * (1.0 - smoothstep(0.78, 0.88, ang));
          float radial = smoothstep(0.08, 0.14, r) * (1.0 - smoothstep(0.68, 0.72, r));
          float behind = clamp(1.0 - abs(ang - uWiperAngle) * 0.58, 0.25, 1.0);
          return sector * radial * mix(0.68, 1.0, behind);
        }

        void main() {
          float precip = clamp(max(uRain, uSnow), 0.0, 1.0);
          if (precip <= 0.01) discard;
          float snowMode = uSnow / max(0.001, uRain + uSnow);
          float dripT = 1.0 - uReduced * 0.85;

          // Coordinates relative to wiper pivots at (+/-0.52, 2.50 - 3.03 = -0.53).
          float cleared = max(wipeMask(vLocal, vec2(-0.52, -0.53)), wipeMask(vLocal, vec2(0.52, -0.53)));
          cleared *= uWiping;

          float dropsA = dropletLayer(vLocal, 12.0, 0.28 * dripT, snowMode);
          float dropsB = dropletLayer(vLocal + vec2(3.7, 1.9), 22.0, 0.18 * dripT, snowMode);
          float pattern = clamp(dropsA * 0.82 + dropsB * 0.62, 0.0, 1.0) * precip;
          pattern *= (1.0 - cleared * 0.92);

          // Subtle perimeter misting outside the wiped arcs.
          float edge = smoothstep(0.72, 1.22, abs(vLocal.x)) + smoothstep(0.34, 0.54, vLocal.y);
          float sheen = clamp(edge * 0.22 * precip * (1.0 - cleared * 0.85), 0.0, 0.28);

          float alpha = clamp(pattern * mix(0.48, 0.56, snowMode) + sheen, 0.0, 0.62);
          if (alpha <= 0.01) discard;

          vec3 rainCol = mix(vec3(0.76, 0.84, 0.92), vec3(0.28, 0.34, 0.46), uNight);
          vec3 frostCol = mix(vec3(0.9, 0.94, 0.99), vec3(0.38, 0.44, 0.58), uNight);
          vec3 col = mix(rainCol, frostCol, snowMode);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this.cabGlass = new THREE.Mesh(glassGeo, glassMat);
    this.cabGlass.position.set(0, 3.03, 1.242);
    this.cabGlass.visible = false;
    this.cabMesh.add(this.cabGlass);

    scene.add(this.cabMesh);
  }

  private build(t: Train): TrainVisual {
    const group = new THREE.Group();
    const cars = t.cars.map((c) => {
      const root = new THREE.Group();
      const body = this.assets.clone(c.type);
      root.add(body);
      group.add(root);
      return { root, body };
    });

    const beamGroup = new THREE.Group();
    const cone = new THREE.Mesh(this.beamConeGeo, this.beamConeMat);
    cone.position.set(0, 2.12, 0.35);
    const pool = new THREE.Mesh(this.beamPoolGeo, this.beamPoolMat);
    beamGroup.add(cone, pool);
    beamGroup.visible = false;
    group.add(beamGroup);

    this.group.add(group);
    return { group, cars, beamGroup, signature: signature(t), orderFor: null, ordered: [] };
  }

  sync(sim: Sim, opts: TrainRenderOpts = {}) {
    if (this.cabBodyHidden) {
      this.cabBodyHidden.visible = true;
      this.cabBodyHidden = null;
    }

    const alive = new Set(sim.trains.map((t) => t.id));
    for (const [id, v] of this.visuals) {
      if (!alive.has(id)) {
        this.group.remove(v.group);
        this.visuals.delete(id);
      }
    }

    this.bogieCount = 0;
    this.wheelCount = 0;
    this.couplerCount = 0;
    this.gangwayCount = 0;

    const reduced = opts.reducedMotion ?? prefersReducedMotion();
    for (const t of sim.trains) {
      let v = this.visuals.get(t.id);
      // Signatures are only compared when the consist changes, so steady running builds no strings.
      if (!v || (v.orderFor !== t.cars && v.signature !== signature(t))) {
        if (v) this.group.remove(v.group);
        v = this.build(t);
        this.visuals.set(t.id, v);
      }
      this.pose(sim, t, v, reduced);
    }

    for (const pool of this.bogiePools) pool.sync(this.bogieMats, this.bogieCount);
    for (const pool of this.wheelPools) pool.sync(this.wheelMats, this.wheelCount);
    this.couplerPool.sync(this.couplerMats, this.couplerCount);
    this.gangwayPool.sync(this.gangwayMats, this.gangwayCount);

    this.syncCab(sim, opts, reduced);
  }

  clear() {
    if (this.cabBodyHidden) {
      this.cabBodyHidden.visible = true;
      this.cabBodyHidden = null;
    }
    this.cabMesh.visible = false;
    for (const v of this.visuals.values()) this.group.remove(v.group);
    this.visuals.clear();
    for (const pool of this.bogiePools) pool.sync(this.bogieMats, 0);
    for (const pool of this.wheelPools) pool.sync(this.wheelMats, 0);
    this.couplerPool.sync(this.couplerMats, 0);
    this.gangwayPool.sync(this.gangwayMats, 0);
  }

  dispose() {
    this.clear();
    for (const pool of this.bogiePools) pool.dispose();
    for (const pool of this.wheelPools) pool.dispose();
    this.couplerPool.dispose();
    this.gangwayPool.dispose();
    this.couplerGeo.dispose();
    this.gangwayGeo.dispose();
    this.couplerMat.dispose();
    this.gangwayMat.dispose();
    this.beamConeGeo.dispose();
    this.beamPoolGeo.dispose();
    this.beamPoolTex.dispose();
    this.beamConeMat.dispose();
    this.beamPoolMat.dispose();
  }

  private pushBogie(pos: THREE.Vector3, dir: THREE.Vector3, wheelAngle: number) {
    const o = this.tmpObj;
    o.position.copy(pos);
    o.scale.set(1, 1, 1);
    this.look.copy(pos).add(dir);
    o.lookAt(this.look);
    o.updateMatrix();
    const bi = this.bogieCount;
    this.bogieCount = pushMat(this.bogieMats, bi, o.matrix);
    const bMat = this.bogieMats[bi];

    const wo = this.tmpWheelObj;
    wo.rotation.set(wheelAngle, 0, 0);
    wo.scale.set(1, 1, 1);
    wo.position.set(0, 0.46, 0.95);
    wo.updateMatrix();
    this.tmpWheelMat.multiplyMatrices(bMat, wo.matrix);
    this.wheelCount = pushMat(this.wheelMats, this.wheelCount, this.tmpWheelMat);

    wo.position.set(0, 0.46, -0.95);
    wo.updateMatrix();
    this.tmpWheelMat.multiplyMatrices(bMat, wo.matrix);
    this.wheelCount = pushMat(this.wheelMats, this.wheelCount, this.tmpWheelMat);
  }

  private pose(sim: Sim, t: Train, v: TrainVisual, reduced: boolean) {
    // Consist order can reverse, so visuals are re-keyed by car index whenever the consist changes.
    if (v.orderFor !== t.cars) {
      v.ordered = this.assignVisuals(t, v);
      v.orderFor = t.cars;
    }
    const ordered = v.ordered;
    const drawnOdom = t.odometer - t.speed * sim.drawnLag;
    const wheelAngle = drawnOdom / WHEEL_RADIUS;
    const speedNorm = Math.min(1, t.speed / 30);
    const brakeLoad = t.emergency ? 1.3 : Math.max(t.airBrake, t.dynamic * 0.6);

    let carOffset = 0;
    for (let i = 0; i < t.cars.length; i++) {
      const car = t.cars[i];
      const cv = ordered[i];
      const len = VEHICLES[car.type].length;
      const p = sim.carPose(t, i);
      const fx = p.front.x;
      const fy = p.front.y;
      const fz = p.front.z;
      const rx = p.rear.x;
      const ry = p.rear.y;
      const rz = p.rear.z;
      cv.root.position.set((fx + rx) / 2, (fy + ry) / 2, (fz + rz) / 2);
      const sign = car.flip ? -1 : 1;
      this.look.set(
        cv.root.position.x + (fx - rx) * sign,
        cv.root.position.y + (fy - ry) * sign,
        cv.root.position.z + (fz - rz) * sign,
      );
      cv.root.lookAt(this.look);

      this.tmpPosA.set(fx, fy, fz);
      this.tmpPosB.set(rx, ry, rz);
      this.dirA.set(p.front.tx * p.front.dir, p.front.ty * p.front.dir, p.front.tz * p.front.dir);
      this.dirB.set(p.rear.tx * p.rear.dir, p.rear.ty * p.rear.dir, p.rear.tz * p.rear.dir);
      this.pushBogie(this.tmpPosA, this.dirA, wheelAngle);
      this.pushBogie(this.tmpPosB, this.dirB, wheelAngle);

      if (!reduced && t.speed > 0.15) {
        const turn = this.dirB.x * this.dirA.z - this.dirB.z * this.dirA.x;
        const wheelbase = Math.max(8, len * 0.64);
        const centrifugal = Math.max(-0.045, Math.min(0.045, (turn / wheelbase) * t.speed * t.speed * 0.012));
        const sway = Math.sin(drawnOdom * 0.38 + i * 1.9) * 0.024 * speedNorm;
        const carDist = Math.max(0, drawnOdom - carOffset);
        const jointPhase = carDist % 18;
        const bounce =
          jointPhase < 2.2 ? -0.024 * Math.exp(-jointPhase * 2.2) * Math.sin(jointPhase * 6.0) * speedNorm : 0;
        const pitch = (t.throttle * 0.006 - brakeLoad * 0.009) * sign;
        cv.body.position.set((sway + centrifugal * 0.45) * sign, bounce, 0);
        cv.body.rotation.set(pitch, 0, -centrifugal * sign);
      } else {
        cv.body.position.set(0, 0, 0);
        cv.body.rotation.set(0, 0, 0);
      }
      carOffset += len + 0.8;

      if (i > 0) {
        const prev = ordered[i - 1];
        const prevLen = VEHICLES[t.cars[i - 1].type].length;
        const halfA = (prevLen - 1.0) * 0.5;
        const halfB = (len - 1.0) * 0.5;
        const pp = sim.carPose(t, i - 1);
        this.tmpMidA.set(pp.front.x, pp.front.y, pp.front.z);
        this.tmpMidB.set(pp.rear.x, pp.rear.y, pp.rear.z);
        this.tmpAxisA.subVectors(this.tmpMidA, this.tmpMidB).normalize();
        this.tmpAxisB.subVectors(this.tmpPosA, this.tmpPosB).normalize();
        const gangway = t.cars[i - 1].type === 'coach' && car.type === 'coach';
        const yOff = gangway ? 2.35 : 1.02;
        this.tmpEndA.copy(prev.root.position).addScaledVector(this.tmpAxisA, -halfA);
        this.tmpEndA.y += yOff;
        this.tmpEndB.copy(cv.root.position).addScaledVector(this.tmpAxisB, halfB);
        this.tmpEndB.y += yOff;
        const gap = Math.max(0.35, this.tmpEndA.distanceTo(this.tmpEndB));
        this.tmpMid.addVectors(this.tmpEndA, this.tmpEndB).multiplyScalar(0.5);
        const co = this.tmpObj;
        co.position.copy(this.tmpMid);
        co.scale.set(1, 1, gap + (gangway ? 0.3 : 0.2));
        co.lookAt(this.tmpEndB);
        co.updateMatrix();
        if (gangway) this.gangwayCount = pushMat(this.gangwayMats, this.gangwayCount, co.matrix);
        else this.couplerCount = pushMat(this.couplerMats, this.couplerCount, co.matrix);
      }
    }
  }

  private syncCab(sim: Sim, opts: TrainRenderOpts, reduced: boolean) {
    const t = opts.driven ?? null;
    if (!opts.cabActive || !t || !t.cars.length || !VEHICLES[t.cars[0].type].traction) {
      this.cabMesh.visible = false;
      return;
    }
    const v = this.visuals.get(t.id);
    if (v && v.ordered.length) {
      v.ordered[0].body.visible = false;
      this.cabBodyHidden = v.ordered[0].body;
    }

    const h = sim.drawn(t);
    const fx = h.tx * h.dir;
    const fy = h.ty * h.dir;
    const fz = h.tz * h.dir;
    this.cabMesh.position.set(h.x, h.y, h.z);
    this.look.set(h.x + fx, h.y + fy, h.z + fz);
    this.cabMesh.lookAt(this.look);
    if (!reduced && v && v.ordered.length) {
      // Carry leading car's roll onto the cab frame so window pillars move naturally around the driver.
      this.cabMesh.rotateZ(v.ordered[0].body.rotation.z * (t.cars[0].flip ? -1 : 1));
    }
    this.cabMesh.visible = true;

    if (this.cabNeedle) {
      const frac = Math.max(0, Math.min(1, (t.speed * 3.6) / DIAL_MAX_KMH));
      this.cabNeedle.rotation.y = (135 - frac * 270) * (Math.PI / 180);
    }
    if (this.cabLever) {
      const lever = t.ai
        ? t.throttle > 0
          ? t.throttle
          : -Math.max(t.airBrake, t.dynamic)
        : (opts.cabLever ?? t.throttle - Math.max(t.brake, t.dynamic));
      this.cabLever.rotation.x = Math.max(-1, Math.min(1, lever)) * 0.55;
    }

    const rain = opts.rain ?? 0;
    const snow = opts.snow ?? 0;
    const wetPrecip = rain > 0.03 || snow > 0.03;
    const time = opts.time ?? 0;
    const dt = this.lastWiperT >= 0 ? Math.max(0, Math.min(0.1, time - this.lastWiperT)) : 0;
    this.lastWiperT = time;

    this.cabGlass.visible = wetPrecip;
    if (wetPrecip && !reduced) {
      const rate = rain > snow ? 2.4 + rain * 1.1 : 1.5 + snow * 0.6;
      this.wiperPhase = (this.wiperPhase + dt * rate) % (Math.PI * 2);
      const angle = Math.sin(this.wiperPhase) * 0.78;
      this.cabWiperL.rotation.z = angle;
      this.cabWiperR.rotation.z = angle;
      this.cabGlassUniforms.uWiperAngle.value = angle;
      this.cabGlassUniforms.uWiping.value = 1;
    } else if (wetPrecip) {
      this.cabWiperL.rotation.z = 0;
      this.cabWiperR.rotation.z = 0;
      this.cabGlassUniforms.uWiperAngle.value = 0;
      this.cabGlassUniforms.uWiping.value = 1;
    } else {
      this.cabWiperL.rotation.z = 1.08;
      this.cabWiperR.rotation.z = -1.08;
      this.cabGlassUniforms.uWiping.value = 0;
    }
    this.cabGlassUniforms.uTime.value = time;
    this.cabGlassUniforms.uRain.value = rain;
    this.cabGlassUniforms.uSnow.value = snow;
    this.cabGlassUniforms.uNight.value = opts.night ?? 0;
    this.cabGlassUniforms.uReduced.value = reduced ? 1 : 0;
  }

  private assignVisuals(t: Train, v: TrainVisual): CarVisual[] {
    const pool = new Map<string, CarVisual[]>();
    for (const cv of v.cars) {
      const type = cv.body.name;
      const list = pool.get(type) ?? [];
      list.push(cv);
      pool.set(type, list);
    }
    return t.cars.map((c) => pool.get(c.type)!.shift()!);
  }

  /** Real headlight for the driven/nearest train, and cheap projected beam cones for AI trains at dusk/night. */
  updateHeadlight(sim: Sim, driven: Train | null, night: number, cameraPos?: THREE.Vector3) {
    const beamVis = night >= 0.06;
    const smoothNight = Math.max(0, Math.min(1, (night - 0.05) / 0.55));
    this.beamConeMat.opacity = 0.16 * smoothNight;
    this.beamPoolMat.opacity = 0.34 * smoothNight;

    // Pick which train gets the single real SpotLight: driven if close/active, else nearest to camera.
    let spotTrain: Train | null = driven;
    if (cameraPos && sim.trains.length) {
      let bestDist = Infinity;
      let nearest: Train | null = null;
      for (const tr of sim.trains) {
        const th = sim.drawn(tr);
        const d2 = this.tmpHead.set(th.x, th.y, th.z).distanceToSquared(cameraPos);
        if (d2 < bestDist) {
          bestDist = d2;
          nearest = tr;
        }
      }
      if (!spotTrain) {
        if (bestDist < 480 * 480) spotTrain = nearest;
      } else {
        const dh = sim.drawn(spotTrain);
        const dDriven = this.tmpHead.set(dh.x, dh.y, dh.z).distanceToSquared(cameraPos);
        if (dDriven > 360 * 360 && bestDist < 420 * 420) spotTrain = nearest;
      }
    }

    if (!spotTrain || night < 0.08) {
      this.headlight.intensity = 0;
    } else {
      const h = sim.drawn(spotTrain);
      const fx = h.tx * h.dir;
      const fz = h.tz * h.dir;
      const fy = h.ty * h.dir;
      this.headlight.position.set(h.x + fx * 0.5, h.y + 2.3, h.z + fz * 0.5);
      this.headlight.target.position.set(h.x + fx * 65, h.y + fy * 65 + 0.4, h.z + fz * 65);
      this.headlight.target.updateMatrixWorld();
      this.headlight.intensity = 1200 * night;
    }

    for (const tr of sim.trains) {
      const v = this.visuals.get(tr.id);
      if (!v) continue;
      if (!beamVis || tr === spotTrain) {
        v.beamGroup.visible = false;
        continue;
      }
      const h = sim.drawn(tr);
      const fx = h.tx * h.dir;
      const fy = h.ty * h.dir;
      const fz = h.tz * h.dir;
      v.beamGroup.position.set(h.x, h.y, h.z);
      this.look.set(h.x + fx, h.y + fy, h.z + fz);
      v.beamGroup.lookAt(this.look);
      v.beamGroup.visible = true;
    }
  }
}
