// Pooled, allocation-free instanced particle effects for diesel exhaust, brake sparks, desert dust, impacts, and 3D rain/snow.
import * as THREE from 'three';

import type { Sim } from '../rail/sim';
import { VEHICLES } from '../rail/vehicles';
import type { Heightfield } from '../world/heightfield';

const SMOKE_CAP = 420;
const SPARK_CAP = 180;
const WEATHER_CAP = 1800;
const WEATHER_LOW_CAP = 460;

class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private cr: Float32Array;
  private cg: Float32Array;
  private cb: Float32Array;
  private gravity: number;
  private drag: number;

  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpScale = new THREE.Vector3();
  private tmpMat = new THREE.Matrix4();
  private tmpCol = new THREE.Color();
  private tmpAxis = new THREE.Vector3(0, 1, 0);

  constructor(
    parent: THREE.Group,
    private cap: number,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    gravity: number,
    drag: number,
  ) {
    this.gravity = gravity;
    this.drag = drag;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.cr = new Float32Array(cap);
    this.cg = new Float32Array(cap);
    this.cb = new Float32Array(cap);

    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, white);
    parent.add(this.mesh);
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
  ) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.cr[i] = r;
    this.cg[i] = g;
    this.cb[i] = b;
  }

  step(dt: number, orientToVelocity: boolean) {
    let i = 0;
    const damp = Math.exp(-this.drag * dt);
    while (i < this.count) {
      const a = this.age[i] + dt;
      const l = this.life[i];
      if (a >= l) {
        const last = --this.count;
        if (i < last) {
          this.px[i] = this.px[last];
          this.py[i] = this.py[last];
          this.pz[i] = this.pz[last];
          this.vx[i] = this.vx[last];
          this.vy[i] = this.vy[last];
          this.vz[i] = this.vz[last];
          this.age[i] = this.age[last];
          this.life[i] = this.life[last];
          this.size0[i] = this.size0[last];
          this.size1[i] = this.size1[last];
          this.cr[i] = this.cr[last];
          this.cg[i] = this.cg[last];
          this.cb[i] = this.cb[last];
        }
        continue;
      }
      this.age[i] = a;
      this.vy[i] += this.gravity * dt;
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      this.vz[i] *= damp;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const u = a / l;
      // Smooth grow-in and shrink-to-zero fade so puffs disappear cleanly without per-instance alpha.
      const fade = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      const s = (this.size0[i] + (this.size1[i] - this.size0[i]) * u) * Math.max(0.01, fade);
      this.tmpPos.set(this.px[i], this.py[i], this.pz[i]);
      if (orientToVelocity) {
        const vl = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
        if (vl > 0.05) {
          this.tmpAxis.set(this.vx[i] / vl, this.vy[i] / vl, this.vz[i] / vl);
          this.tmpQuat.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.tmpAxis);
        } else {
          this.tmpQuat.identity();
        }
        this.tmpScale.set(s, s * 2.8, s);
      } else {
        this.tmpQuat.identity();
        this.tmpScale.setScalar(s);
      }
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.mesh.setMatrixAt(i, this.tmpMat);
      this.tmpCol.setRGB(this.cr[i], this.cg[i], this.cb[i]);
      this.mesh.setColorAt(i, this.tmpCol);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.dispose();
  }
}

function createWeatherCurtain(scene: THREE.Scene) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  base.dispose();

  const seeds = new Float32Array(WEATHER_CAP * 4);
  let rng = 0x51a7b39d;
  const next = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  for (let i = 0; i < WEATHER_CAP; i++) {
    seeds[i * 4] = next();
    seeds[i * 4 + 1] = next();
    seeds[i * 4 + 2] = next();
    seeds[i * 4 + 3] = next();
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = WEATHER_CAP;

  const uniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color(0x9fb8cc) },
    uTime: { value: 0 },
    uRain: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uCab: { value: 0 },
    uFogDensity: { value: 0.002 },
    uReduced: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform vec3 uCamPos;
      uniform float uTime, uRain, uSnow, uCab, uReduced;
      varying vec2 vUv;
      varying float vSnow;
      varying float vAlpha;
      varying float vDist;

      void main() {
        vUv = uv;
        float total = max(0.001, uRain + uSnow);
        vSnow = uSnow / total;
        float isRain = 1.0 - vSnow;

        vec3 boxSize = vec3(mix(50.0, 62.0, vSnow), mix(26.0, 24.0, vSnow), mix(50.0, 62.0, vSnow));
        float fallSpeed = mix(19.0 + aSeed.w * 7.0, 1.55 + aSeed.w * 0.85, vSnow);
        vec2 wind = mix(vec2(2.6, 1.4), vec2(1.4, 0.7), vSnow);
        float driftPhase = aSeed.w * 6.2831853 + uTime * (1.1 + aSeed.z * 1.2) * (1.0 - uReduced * 0.75);
        vec2 flutter = vec2(sin(driftPhase), cos(driftPhase * 0.83)) * (0.9 * vSnow);

        vec3 scroll = vec3(wind.x * uTime + flutter.x, -fallSpeed * uTime, wind.y * uTime + flutter.y);
        vec3 wrapped = fract(aSeed.xyz + (scroll - uCamPos) / boxSize);
        vec3 rel = (wrapped - 0.5) * boxSize;
        vec3 worldPos = uCamPos + rel;

        vec3 toCam = uCamPos - worldPos;
        float dist = length(toCam);
        vDist = dist;

        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

        // Rain elongates along fall velocity and faces the camera around its streak axis.
        vec3 velDir = normalize(vec3(wind.x, -fallSpeed, wind.y));
        vec3 viewDir = dist > 0.001 ? toCam / dist : vec3(0.0, 0.0, 1.0);
        vec3 streakRight = cross(velDir, viewDir);
        float srLen = length(streakRight);
        streakRight = srLen > 0.01 ? streakRight / srLen : camRight;

        float rainW = mix(0.03, 0.06, smoothstep(4.0, 26.0, dist));
        float rainH = mix(0.75, 1.25, aSeed.w);
        float flakeS = mix(0.075, 0.145, aSeed.w) * mix(1.0, 1.25, smoothstep(8.0, 28.0, dist));

        vec3 right = mix(streakRight, camRight, vSnow);
        vec3 up = mix(-velDir, camUp, vSnow);
        float w = mix(rainW, flakeS, vSnow);
        float h = mix(rainH, flakeS, vSnow);

        worldPos += right * (position.x * w) + up * (position.y * h);

        // Soft fade at box top/bottom, close lens, cab interior, and low density cutoffs.
        float vFade = 1.0 - smoothstep(0.36, 0.5, abs(wrapped.y - 0.5));
        float hFade = 1.0 - smoothstep(0.38, 0.5, max(abs(wrapped.x - 0.5), abs(wrapped.z - 0.5)));
        float nearFade = smoothstep(0.9, 2.2, dist);
        float cabMask = mix(1.0, smoothstep(2.1, 4.1, dist), uCab);
        float density = clamp(max(uRain, uSnow), 0.0, 1.0);
        float dropKeep = step(aSeed.z, mix(0.28, 1.0, density) * mix(0.85, 1.0, isRain));
        vAlpha = vFade * hFade * nearFade * cabMask * dropKeep * clamp(density * 1.15, 0.0, 1.0);

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFogColor;
      uniform float uNight, uFogDensity;
      varying vec2 vUv;
      varying float vSnow;
      varying float vAlpha;
      varying float vDist;

      void main() {
        if (vAlpha <= 0.005) discard;
        vec2 c = vUv - 0.5;
        float streak = exp(-c.x * c.x * 26.0) * sin(vUv.y * 3.14159265);
        float flake = 1.0 - smoothstep(0.14, 0.5, length(c));
        float shape = mix(streak, flake, vSnow);
        float distFade = exp(-vDist * max(0.018, uFogDensity * 4.5));
        float alpha = vAlpha * shape * mix(0.68, 0.94, vSnow) * distFade;
        if (alpha <= 0.01) discard;

        vec3 rainCol = mix(vec3(0.84, 0.9, 0.96), vec3(0.42, 0.49, 0.62), uNight);
        vec3 snowCol = mix(vec3(0.97, 0.99, 1.0), vec3(0.48, 0.54, 0.68), uNight);
        vec3 col = mix(rainCol, snowCol, vSnow);
        col = mix(col, uFogColor, clamp(1.0 - distFade, 0.0, 0.45));
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return { mesh, geo, mat, uniforms };
}

export class ParticleRenderer {
  group = new THREE.Group();
  enabled = true;

  private smokeGeo = new THREE.IcosahedronGeometry(0.5, 1);
  private sparkGeo = new THREE.BoxGeometry(0.055, 0.16, 0.055);
  private smokeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  });
  private sparkMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  private smoke: ParticlePool;
  private sparks: ParticlePool;
  private weather: ReturnType<typeof createWeatherCurtain>;

  private exhaustAcc = new Map<number, number>();
  private sparkAcc = new Map<number, number>();
  private dustAcc = new Map<number, number>();

  constructor(scene: THREE.Scene) {
    this.smoke = new ParticlePool(this.group, SMOKE_CAP, this.smokeGeo, this.smokeMat, 0.45, 0.85);
    this.sparks = new ParticlePool(this.group, SPARK_CAP, this.sparkGeo, this.sparkMat, -9.8, 0.4);
    this.weather = createWeatherCurtain(scene);
    scene.add(this.group);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) this.clear();
  }

  /** Scales weather precipitation count on low graphics quality while keeping weather visible. */
  setWeatherLow(low: boolean) {
    this.weather.geo.instanceCount = low ? WEATHER_LOW_CAP : WEATHER_CAP;
  }

  /** Updates the GPU-wrapped 3D rain and snow curtain around the camera. */
  updateWeather(opts: {
    cameraPos: THREE.Vector3;
    elapsed: number;
    rain: number;
    snow: number;
    cab: boolean;
    fogColor: THREE.Color;
    fogDensity: number;
    night: number;
    reducedMotion: boolean;
  }) {
    const active = opts.rain > 0.01 || opts.snow > 0.01;
    this.weather.mesh.visible = active;
    if (!active) return;
    const u = this.weather.uniforms;
    u.uCamPos.value.copy(opts.cameraPos);
    u.uFogColor.value.copy(opts.fogColor);
    u.uTime.value = opts.elapsed;
    u.uRain.value = opts.rain;
    u.uSnow.value = opts.snow;
    u.uNight.value = opts.night;
    u.uCab.value = opts.cab ? 1 : 0;
    u.uFogDensity.value = opts.fogDensity;
    u.uReduced.value = opts.reducedMotion ? 1 : 0;
  }

  clear() {
    this.smoke.clear();
    this.sparks.clear();
    this.exhaustAcc.clear();
    this.sparkAcc.clear();
    this.dustAcc.clear();
  }

  dispose() {
    this.clear();
    this.smoke.dispose();
    this.sparks.dispose();
    this.smokeGeo.dispose();
    this.sparkGeo.dispose();
    this.smokeMat.dispose();
    this.sparkMat.dispose();
    this.weather.mesh.removeFromParent();
    this.weather.geo.dispose();
    this.weather.mat.dispose();
  }

  /** Spawns a short impact burst of sparks and dust on collisions or buffer-stop hits. */
  emitBurst(x: number, y: number, z: number, speed: number, night: number) {
    if (!this.enabled) return;
    const scale = Math.max(0.6, Math.min(1.6, speed / 12));
    const sparkBright = night > 0.3 ? 3.0 : 2.2;
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (3 + Math.random() * 9) * scale;
      this.sparks.emit(
        x + (Math.random() - 0.5) * 1.4,
        y + 0.8 + Math.random() * 1.2,
        z + (Math.random() - 0.5) * 1.4,
        Math.cos(a) * spd,
        2 + Math.random() * 6 * scale,
        Math.sin(a) * spd,
        0.3 + Math.random() * 0.35,
        0.9,
        0.35,
        1.0 * sparkBright,
        (0.45 + Math.random() * 0.35) * sparkBright,
        0.08 * sparkBright,
      );
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.5 + Math.random() * 4.5) * scale;
      const shade = 0.45 + Math.random() * 0.2;
      this.smoke.emit(
        x + (Math.random() - 0.5) * 2.0,
        y + 1.0 + Math.random() * 1.2,
        z + (Math.random() - 0.5) * 2.0,
        Math.cos(a) * spd,
        1.4 + Math.random() * 2.5,
        Math.sin(a) * spd,
        1.1 + Math.random() * 0.9,
        0.8,
        2.8,
        shade,
        shade * 0.94,
        shade * 0.86,
      );
    }
  }

  update(sim: Sim, hf: Heightfield, dt: number, simDt: number, night: number) {
    if (!this.enabled) return;

    // Slight ambient lift at night keeps diesel smoke and dust readable in moonlight without glowing.
    const nightLift = night * 0.14;

    if (simDt > 0) {
      const desert = hf.preset === 'desert';
      for (const t of sim.trains) {
        const heavyBrake = t.speed > 10 && (t.emergency || t.airBrake > 0.65);

        // 1. Diesel exhaust from each locomotive stack, scaled by throttle/power.
        const exRate = 1.8 + t.throttle * 14 + (t.slipping ? 4 : 0);
        let exAcc = (this.exhaustAcc.get(t.id) ?? 0) + dt * exRate;
        const exCount = Math.min(4, Math.floor(exAcc));
        exAcc -= exCount;
        this.exhaustAcc.set(t.id, exAcc);

        if (exCount > 0) {
          for (let i = 0; i < t.cars.length; i++) {
            const car = t.cars[i];
            if (!VEHICLES[car.type].traction) continue;
            const p = sim.carPose(t, i);
            const mx = (p.front.x + p.rear.x) * 0.5;
            const my = (p.front.y + p.rear.y) * 0.5;
            const mz = (p.front.z + p.rear.z) * 0.5;
            const dx = p.front.x - p.rear.x;
            const dz = p.front.z - p.rear.z;
            const dl = Math.hypot(dx, dz) || 1;
            const fx = dx / dl;
            const fz = dz / dl;
            const stackOff = car.type === 'loco_light' ? (car.flip ? 1.8 : -1.8) : 1.6;
            for (let k = 0; k < exCount; k++) {
              const s = car.type === 'loco_light' ? stackOff : k % 2 === 0 ? 1.6 : -1.6;
              const shade = Math.max(0.2, 0.56 - t.throttle * 0.34) + nightLift;
              this.smoke.emit(
                mx + fx * s + (Math.random() - 0.5) * 0.16,
                my + 4.28,
                mz + fz * s + (Math.random() - 0.5) * 0.16,
                -fx * t.speed * 0.18 + (Math.random() - 0.5) * 0.9,
                1.5 + t.throttle * 3.6 + Math.random() * 0.8,
                -fz * t.speed * 0.18 + (Math.random() - 0.5) * 0.9,
                1.2 + Math.random() * 0.9,
                0.35 + t.throttle * 0.2,
                1.6 + t.throttle * 1.6,
                shade,
                shade * 0.99,
                shade * 0.97,
              );
            }
          }
        }

        // 2. Brake sparks when braking hard at high speed.
        if (heavyBrake) {
          let spAcc = (this.sparkAcc.get(t.id) ?? 0) + dt * (18 + t.speed * 0.8);
          const spCount = Math.min(6, Math.floor(spAcc));
          spAcc -= spCount;
          this.sparkAcc.set(t.id, spAcc);
          if (spCount > 0) {
            const bright = night > 0.25 ? 3.2 : 2.1;
            const p = sim.carPose(t, 0);
            const fx = p.front.tx * p.front.dir;
            const fz = p.front.tz * p.front.dir;
            const rx = -fz;
            const rz = fx;
            for (let k = 0; k < spCount; k++) {
              const ci = Math.floor(Math.random() * t.cars.length);
              const cp = sim.carPose(t, ci);
              const bogie = Math.random() < 0.5 ? cp.front : cp.rear;
              const side = Math.random() < 0.5 ? -0.72 : 0.72;
              this.sparks.emit(
                bogie.x + rx * side,
                bogie.y + 0.2,
                bogie.z + rz * side,
                -fx * (t.speed * 0.45 + Math.random() * 4) + rx * side * (1.2 + Math.random() * 2),
                1.2 + Math.random() * 2.8,
                -fz * (t.speed * 0.45 + Math.random() * 4) + rz * side * (1.2 + Math.random() * 2),
                0.22 + Math.random() * 0.22,
                0.85,
                0.3,
                1.0 * bright,
                (0.5 + Math.random() * 0.35) * bright,
                0.1 * bright,
              );
            }
          }
        }

        // 3. Desert dust kicked up behind moving trains on the desert preset.
        if (desert && t.speed > 4) {
          const speedFactor = Math.min(1, t.speed / 24);
          let duAcc = (this.dustAcc.get(t.id) ?? 0) + dt * (4 + speedFactor * 14);
          const duCount = Math.min(3, Math.floor(duAcc));
          duAcc -= duCount;
          this.dustAcc.set(t.id, duAcc);
          if (duCount > 0) {
            const ci = Math.min(t.cars.length - 1, Math.floor(Math.random() * t.cars.length));
            const cp = sim.carPose(t, ci);
            const at = Math.random() < 0.5 ? cp.front : cp.rear;
            if (at.y - hf.baseAt(at.x, at.z) < 4.5) {
              const fx = at.tx * at.dir;
              const fz = at.tz * at.dir;
              const rx = -fz;
              const rz = fx;
              for (let k = 0; k < duCount; k++) {
                const side = Math.random() < 0.5 ? -1.1 : 1.1;
                const rCol = 0.74 + nightLift * 0.6;
                const gCol = 0.62 + nightLift * 0.5;
                const bCol = 0.44 + nightLift * 0.4;
                this.smoke.emit(
                  at.x + rx * side + (Math.random() - 0.5) * 0.6,
                  at.y + 0.15,
                  at.z + rz * side + (Math.random() - 0.5) * 0.6,
                  -fx * t.speed * 0.12 + rx * side * (0.7 + Math.random() * 0.8),
                  0.6 + Math.random() * 0.9 * speedFactor,
                  -fz * t.speed * 0.12 + rz * side * (0.7 + Math.random() * 0.8),
                  1.1 + Math.random() * 0.8,
                  0.55,
                  2.4 + speedFactor * 1.4,
                  rCol,
                  gCol,
                  bCol,
                );
              }
            }
          }
        }
      }
    }

    this.smoke.step(dt, false);
    this.sparks.step(dt, true);
  }
}
