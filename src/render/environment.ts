// Sky, sun and moon, stars, fog, image-based lighting and the day/night cycle.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { smoothstep } from '../core/noise';

const LAT = THREE.MathUtils.degToRad(47);
const DECL = THREE.MathUtils.degToRad(12);

const COLORS = {
  sunHigh: new THREE.Color(1.0, 0.96, 0.88),
  sunLow: new THREE.Color(1.0, 0.5, 0.2),
  moon: new THREE.Color(0.55, 0.68, 1.0),
  fogDay: new THREE.Color(0.66, 0.76, 0.87),
  fogDusk: new THREE.Color(0.86, 0.56, 0.38),
  fogNight: new THREE.Color(0.012, 0.018, 0.035),
  hemiSkyDay: new THREE.Color(0.68, 0.8, 1.0),
  hemiSkyNight: new THREE.Color(0.14, 0.2, 0.38),
  hemiGround: new THREE.Color(0.3, 0.3, 0.28),
};

export class Environment {
  hours = 15.2;
  /** In-game hours per real second. */
  timeScale = 0.02;
  cloudCover = 0.42;
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
  shadowTexelSnap = 0;
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, shadowSize: number) {
    this.sky.scale.setScalar(16000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    const skyMat = this.sky.material as THREE.ShaderMaterial;
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
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    const cam = this.sun.shadow.camera;
    const span = 300;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 10;
    cam.far = 2400;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.9;
    this.shadowTexelSnap = (span * 2) / shadowSize;
    scene.add(this.sun, this.sun.target, this.hemi);

    this.stars = this.makeStars();
    scene.add(this.stars);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(95, 24, 16),
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
      pos[i * 3] = Math.cos(a) * r * 7500;
      pos[i * 3 + 1] = y * 7500;
      pos[i * 3 + 2] = Math.sin(a) * r * 7500;
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

  update(dt: number, focus: THREE.Vector3) {
    this.time += dt;
    this.hours = (this.hours + dt * this.timeScale + 24) % 24;
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
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.turbidity.value = 2.2 + golden * 3.5;
    u.rayleigh.value = 1.05 + golden * 1.6;
    u.mieCoefficient.value = 0.0035;
    u.mieDirectionalG.value = 0.78;
    u.sunPosition.value.copy(this.sunDir).multiplyScalar(450000);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = this.cloudCover;
      u.cloudDensity.value = 0.62;
      u.cloudElevation.value = 0.55;
      if (u.time) u.time.value = this.time;
    }

    // Key light switches between sun and moon around twilight, fading through dark to hide the swap.
    const useMoon = el < -0.02;
    const moonAmt = smoothstep(-0.02, -0.16, el);
    const dir = useMoon ? this.moonDir : this.sunDir;
    this.sun.color.copy(useMoon ? COLORS.moon : COLORS.sunLow.clone().lerp(COLORS.sunHigh, smoothstep(0.0, 0.42, el)));
    this.sun.intensity = useMoon ? 1.15 * moonAmt : 4.0 * smoothstep(-0.02, 0.14, el) * (1 - this.cloudCover * 0.3);

    // Shadow camera tracks the focus point, snapped to shadow texels to stop shimmer.
    const snap = this.shadowTexelSnap * 4;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + dir.x * 1200, focus.y + Math.max(dir.y, 0.08) * 1200, fz + dir.z * 1200);
    this.sun.target.updateMatrixWorld();

    this.hemi.color.copy(COLORS.hemiSkyNight).lerp(COLORS.hemiSkyDay, day);
    this.hemi.groundColor.copy(COLORS.hemiGround).multiplyScalar(0.4 + day * 0.6);
    this.hemi.intensity = 0.42 + golden * day * 0.35;

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(COLORS.fogNight).lerp(COLORS.fogDusk, smoothstep(-0.12, 0.0, el)).lerp(COLORS.fogDay, smoothstep(0.02, 0.34, el));

    (this.stars.material as THREE.PointsMaterial).opacity = this.night;
    this.stars.position.copy(this.tmp.set(focus.x, 0, focus.z));
    this.moon.position.copy(this.moonDir).multiplyScalar(7300).add(this.stars.position);
    this.moon.visible = this.night > 0.02;
    this.sky.position.set(focus.x, 0, focus.z);

    this.renderer.toneMappingExposure = 0.42 + this.night * 0.38;

    // Image-based lighting comes from the sky itself; regenerated only as the sky changes.
    this.envCooldown -= dt;
    const changed = Math.abs(el - this.lastEnvElevation) > 0.012 || Math.abs(this.cloudCover - this.lastEnvCloud) > 0.03;
    if (changed && this.envCooldown <= 0) {
      this.envCooldown = 0.35;
      this.lastEnvElevation = el;
      this.lastEnvCloud = this.cloudCover;
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 20000);
      this.scene.environment = rt.texture;
      this.envRT?.dispose();
      this.envRT = rt;
    }
    this.scene.environmentIntensity = 0.12 + day * 0.72;
  }

  clockText() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
