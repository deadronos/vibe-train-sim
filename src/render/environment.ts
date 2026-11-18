// Sky, sun and moon, stars, fog, image-based lighting, weather transitions and the day/night cycle.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { smoothstep } from '../core/noise';
import type { Weather, WeatherProfile } from '../world/weather';
import { WEATHER_PROFILES } from '../world/weather';

const LAT = THREE.MathUtils.degToRad(47);
const DECL = THREE.MathUtils.degToRad(12);
/** Half the width of ground the sun's shadow map covers, in metres. */
const SHADOW_SPAN = 300;

const COLORS = {
  sunHigh: new THREE.Color(1.0, 0.96, 0.88),
  sunLow: new THREE.Color(1.0, 0.5, 0.2),
  moon: new THREE.Color(0.55, 0.68, 1.0),
  fogDay: new THREE.Color(0.66, 0.76, 0.87),
  fogDusk: new THREE.Color(0.86, 0.56, 0.38),
  fogNight: new THREE.Color(0.012, 0.018, 0.035),
  fogWeatherDay: new THREE.Color(0x6c7a88),
  fogWeatherDusk: new THREE.Color(0x574c52),
  fogSnowDay: new THREE.Color(0xc5d0dc),
  fogSnowDusk: new THREE.Color(0x6a6370),
  hemiSkyDay: new THREE.Color(0.68, 0.8, 1.0),
  hemiSkyOvercast: new THREE.Color(0x7c8b9a),
  hemiSkyNight: new THREE.Color(0.14, 0.2, 0.38),
  hemiGround: new THREE.Color(0.3, 0.3, 0.28),
  white: new THREE.Color(0xdce6ef),
};

/** Hours per second that keeps the clock in step with the trains. Faster rates are a time-lapse of the sky alone. */
export const REAL_TIME = 0.0003;

export class Environment {
  hours = 15.2;
  /** In-game hours per real second. */
  timeScale = 0.02;
  weather: Weather = 'clear';
  cloudCover = WEATHER_PROFILES.clear.cloudCover;
  private cloudOverride: number | null = null;
  readonly weatherState: WeatherProfile = { ...WEATHER_PROFILES.clear };
  readonly cloudDrift = new THREE.Vector2();
  readonly mistColor = new THREE.Color(0.66, 0.76, 0.87);
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
  sunDir = new THREE.Vector3();
  moonDir = new THREE.Vector3();
  /** 0 in daylight, 1 in full darkness. */
  night = 0;
  private sky = new Sky();
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvElevation = 99;
  private lastEnvCloud = -1;
  private envCooldown = 0;
  private stars: THREE.Points;
  private moon: THREE.Mesh;
  private time = 0;
  private stormTimer = 14;
  private flashTimer = 0;
  private thunderDelay = -1;
  private thunderStrength = 0;
  private weatherFog = new THREE.Color();
  shadowTexelSnap = 0;
  shadowFrustum = new THREE.Frustum();
  private shadowMatrix = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  private keyDir = new THREE.Vector3();

  /** Changes the shadow map resolution in place, or disables shadow casting when size is 0. */
  setShadowSize(size: number) {
    if (size <= 0) {
      if (!this.sun.castShadow && !this.renderer.shadowMap.enabled) return;
      this.sun.castShadow = false;
      this.renderer.shadowMap.enabled = false;
      this.renderer.shadowMap.needsUpdate = true;
      return;
    }
    const wasOff = !this.renderer.shadowMap.enabled || !this.sun.castShadow;
    this.sun.castShadow = true;
    this.renderer.shadowMap.enabled = true;
    if (this.sun.shadow.mapSize.x === size && this.sun.shadow.map) {
      if (wasOff) this.renderer.shadowMap.needsUpdate = true;
      return;
    }
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.shadowTexelSnap = (SHADOW_SPAN * 2) / size;
    this.renderer.shadowMap.needsUpdate = true;
  }

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    shadowSize: number,
  ) {
    this.sky.scale.setScalar(9000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    const skyMat = this.sky.material;
    // Bloom should catch lamps, not the sky: cap sky radiance below the bloom threshold.
    // The small constant is the night sky colour, matched to the night fog.
    skyMat.fragmentShader = skyMat.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(2.6)) + vec3(0.012, 0.018, 0.035);
      #include <tonemapping_fragment>`,
    );
    this.envSky = new THREE.Mesh(this.sky.geometry, skyMat);
    this.envSky.scale.setScalar(5000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    scene.fog = new THREE.FogExp2(COLORS.fogDay.getHex(), 0.00016);
    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    const span = SHADOW_SPAN;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 600;
    cam.far = 1650;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.9;
    this.setShadowSize(shadowSize);
    scene.add(this.sun, this.sun.target, this.hemi);

    this.stars = this.makeStars();
    scene.add(this.stars);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(56, 24, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.6, 2.4), fog: false }),
    );
    scene.add(this.moon);
    this.update(0, new THREE.Vector3());
  }

  private makeStars() {
    const n = 3400;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const a = Math.random() * Math.PI * 2;
      const y = u * 0.98 + 0.02;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 4500;
      pos[i * 3 + 1] = y * 4500;
      pos[i * 3 + 2] = Math.sin(a) * r * 4500;
      const b = Math.pow(Math.random(), 3) * 2.2 + 0.25;
      const warm = Math.random();
      col[i * 3] = b * (0.85 + warm * 0.15);
      col[i * 3 + 1] = b * 0.92;
      col[i * 3 + 2] = b * (1 - warm * 0.15);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 1.5,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  setWeather(weather: Weather, instant = false) {
    this.weather = weather;
    this.cloudOverride = null;
    const target = WEATHER_PROFILES[weather];
    this.cloudCover = target.cloudCover;
    if (instant) Object.assign(this.weatherState, target);
    if (weather !== 'rain') {
      this.flashTimer = 0;
      this.thunderDelay = -1;
    }
  }

  /** Manual cloud slider adjustment overrides the weather preset's cloud cover while keeping the rest. */
  setCloudCover(cover: number) {
    this.cloudOverride = Math.max(0, Math.min(1, cover));
    this.cloudCover = this.cloudOverride;
  }

  /** Returns thunder strength once when a storm rumble arrives after a flash, otherwise null. */
  consumeThunder(): number | null {
    if (this.thunderDelay < 0) return null;
    if (this.thunderDelay > 0) return null;
    this.thunderDelay = -1;
    return this.thunderStrength;
  }

  /** trainSpeed is the railway's speed multiplier: the clock stops with it, and at REAL_TIME it keeps pace with it. */
  update(dt: number, focus: THREE.Vector3, trainSpeed = 1, reducedMotion = false) {
    this.time += dt;
    this.cloudDrift.set(this.time * 0.006, this.time * 0.0028);

    const target = WEATHER_PROFILES[this.weather];
    const blend = dt > 0 ? 1 - Math.exp(-dt * 1.4) : 1;
    const ws = this.weatherState;
    const targetCloud = this.cloudOverride ?? target.cloudCover;
    ws.cloudCover += (targetCloud - ws.cloudCover) * blend;
    ws.cloudDensity += (target.cloudDensity - ws.cloudDensity) * blend;
    ws.fogDensity += (target.fogDensity - ws.fogDensity) * blend;
    ws.sunDim += (target.sunDim - ws.sunDim) * blend;
    ws.hemiLift += (target.hemiLift - ws.hemiLift) * blend;
    ws.fogTint += (target.fogTint - ws.fogTint) * blend;
    ws.wetness += (target.wetness - ws.wetness) * blend;
    ws.snowCover += (target.snowCover - ws.snowCover) * blend;
    ws.valleyMist += (target.valleyMist - ws.valleyMist) * blend;
    ws.rain += (target.rain - ws.rain) * blend;
    ws.snow += (target.snow - ws.snow) * blend;
    const shadowTarget =
      this.cloudOverride !== null
        ? Math.max(target.cloudShadow, targetCloud * 0.88 * (1 - target.rain * 0.5))
        : target.cloudShadow;
    ws.cloudShadow += (shadowTarget - ws.cloudShadow) * blend;
    this.cloudCover = ws.cloudCover;

    if (this.thunderDelay > 0) this.thunderDelay = Math.max(0, this.thunderDelay - dt);
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
    if (ws.rain > 0.65 && dt > 0) {
      this.stormTimer -= dt;
      if (this.stormTimer <= 0) {
        this.stormTimer = 14 + Math.random() * 14;
        if (!reducedMotion) this.flashTimer = 0.28;
        this.thunderDelay = 1.0 + Math.random() * 1.6;
        this.thunderStrength = 0.45 + Math.random() * 0.5;
      }
    }
    const flash =
      this.flashTimer > 0
        ? (this.flashTimer > 0.16 ? 1 : 0.45) * Math.sin(((this.flashTimer % 0.16) / 0.16) * Math.PI)
        : 0;

    const clock = this.timeScale === REAL_TIME ? trainSpeed : Math.min(trainSpeed, 1);
    this.hours = (this.hours + dt * this.timeScale * clock + 24) % 24;
    const H = ((this.hours - 12) * Math.PI) / 12;
    const sinD = Math.sin(DECL);
    const cosD = Math.cos(DECL);
    const y = Math.sin(LAT) * sinD + Math.cos(LAT) * cosD * Math.cos(H);
    const north = Math.cos(LAT) * sinD - Math.sin(LAT) * cosD * Math.cos(H);
    this.sunDir.set(-cosD * Math.sin(H), y, -north).normalize();
    // The moon runs roughly opposite the sun and stays usefully high at night.
    this.moonDir.set(-this.sunDir.x * 0.8, Math.max(0.3, -this.sunDir.y), -this.sunDir.z * 0.8 + 0.3).normalize();

    const el = this.sunDir.y;
    const day = smoothstep(-0.07, 0.1, el);
    this.night = 1 - smoothstep(-0.14, 0.06, el);
    const golden = 1 - smoothstep(0.02, 0.32, el);

    // Sky scattering.
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.2 + golden * 3.5 + ws.fogTint * 2.5;
    u.rayleigh.value = 1.05 + golden * 1.6 - ws.fogTint * 0.45;
    u.mieCoefficient.value = 0.0035 + ws.fogTint * 0.004;
    u.mieDirectionalG.value = 0.78;
    u.sunPosition.value.copy(this.sunDir).multiplyScalar(450000);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = ws.cloudCover;
      u.cloudDensity.value = ws.cloudDensity;
      u.cloudElevation.value = 0.55;
      if (u.time) u.time.value = this.time;
    }

    // One key light hands over from sun to moon. The sun keeps a faint tail below the
    // horizon (twilight scatter) and the moon is already rising while it fades, so
    // total light never drops below night level in between.
    const toMoon = smoothstep(0.0, -0.1, el);
    const sunI = 4.0 * smoothstep(-0.1, 0.14, el) * (1 - ws.cloudCover * 0.3) * ws.sunDim;
    const moonDim = 1 - ws.fogTint * 0.45;
    const dir = this.keyDir.copy(this.sunDir).lerp(this.moonDir, toMoon).normalize();
    this.sun.color
      .copy(COLORS.sunLow)
      .lerp(COLORS.sunHigh, smoothstep(0.0, 0.42, el))
      .lerp(COLORS.moon, toMoon);
    this.sun.intensity = sunI * (1 - toMoon) + 1.15 * moonDim * toMoon;

    // Shadow camera tracks the focus point, snapped to shadow texels to stop shimmer.
    const snap = this.shadowTexelSnap * 4;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + dir.x * 1200, focus.y + Math.max(dir.y, 0.08) * 1200, fz + dir.z * 1200);
    this.sun.target.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    sc.position.copy(this.sun.position);
    sc.lookAt(this.sun.target.position);
    sc.updateMatrixWorld();
    sc.matrixWorldInverse.copy(sc.matrixWorld).invert();
    this.shadowMatrix.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
    this.shadowFrustum.setFromProjectionMatrix(this.shadowMatrix);

    this.hemi.color
      .copy(COLORS.hemiSkyNight)
      .lerp(COLORS.hemiSkyDay, day)
      .lerp(COLORS.hemiSkyOvercast, ws.fogTint * day);
    this.hemi.groundColor.copy(COLORS.hemiGround).multiplyScalar(0.4 + day * 0.6);
    // Sky-lit fill through civil twilight, peaking as the sun goes under the horizon.
    const twilight = Math.min(smoothstep(0.1, -0.02, el), smoothstep(-0.26, -0.06, el));
    this.hemi.intensity =
      0.42 + golden * day * 0.35 + twilight * 0.5 + ws.hemiLift * (0.25 + day * 0.75) + flash * 1.25;

    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = ws.fogDensity;
    fog.color
      .copy(COLORS.fogNight)
      .lerp(COLORS.fogDusk, smoothstep(-0.12, 0.0, el))
      .lerp(COLORS.fogDay, smoothstep(0.02, 0.34, el));
    this.weatherFog
      .copy(COLORS.fogNight)
      .lerp(ws.snow > 0.3 ? COLORS.fogSnowDusk : COLORS.fogWeatherDusk, smoothstep(-0.12, 0.0, el))
      .lerp(ws.snow > 0.3 ? COLORS.fogSnowDay : COLORS.fogWeatherDay, smoothstep(0.02, 0.34, el));
    fog.color.lerp(this.weatherFog, ws.fogTint);
    this.mistColor.copy(fog.color).lerp(COLORS.white, ws.valleyMist * day * 0.25);

    const cloudOpaque = Math.max(0, 1 - smoothstep(0.35, 0.85, ws.cloudCover));
    (this.stars.material as THREE.PointsMaterial).opacity = this.night * cloudOpaque;
    this.stars.position.copy(this.tmp.set(focus.x, 0, focus.z));
    this.moon.position.copy(this.moonDir).multiplyScalar(4350).add(this.stars.position);
    this.moon.visible = this.night * cloudOpaque > 0.02;
    this.sky.position.set(focus.x, 0, focus.z);

    // Exposure rises through dusk too, otherwise the dim sky-lit scene reads darker than the moonlit night.
    const dusk = smoothstep(0.06, -0.1, el);
    this.renderer.toneMappingExposure = 0.42 + Math.max(this.night, dusk) * 0.38;

    // Image-based lighting comes from the sky itself; regenerated only as the sky changes.
    this.envCooldown -= dt;
    const changed = Math.abs(el - this.lastEnvElevation) > 0.012 || Math.abs(ws.cloudCover - this.lastEnvCloud) > 0.08;
    if (changed && this.envCooldown <= 0) {
      this.envCooldown = 0.6;
      this.lastEnvElevation = el;
      this.lastEnvCloud = ws.cloudCover;
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 10000);
      this.scene.environment = rt.texture;
      this.envRT?.dispose();
      this.envRT = rt;
    }
    this.scene.environmentIntensity = (0.12 + day * 0.72) * (1 - ws.fogTint * 0.25);
  }

  clockText() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
