// Chunked terrain mesh with distance LODs, edge skirts, shadow culling, grading-aware shading, and water.
import * as THREE from 'three';

import type { Heightfield, Preset } from '../world/heightfield';
import { RES, WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';
import type { Environment } from './environment';

export const TERRAIN_CHUNKS = 8;
const CELLS = RES / TERRAIN_CHUNKS;
export const TERRAIN_LOD_STEPS = [1, 2, 4] as const;
const SKIRT_DROPS = [8, 14, 22] as const;
const TERRAIN_LOD_THRESHOLDS = [120, 420] as const;
const TERRAIN_LOD_HYSTERESIS = 30;

export function chunkXZDistance(x: number, z: number, minX: number, minZ: number, maxX: number, maxZ: number): number {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  return Math.hypot(dx, dz);
}

export function selectLod(dist: number, current: number, thresholds: readonly number[], hysteresis: number): number {
  const n = thresholds.length;
  let target = n;
  for (let i = 0; i < n; i++) {
    if (dist < thresholds[i]) {
      target = i;
      break;
    }
  }
  if (current < 0 || current > n || target === current) return target;
  if (target > current) {
    // Stepping down in detail: only switch once past threshold + hysteresis.
    let lod = current;
    while (lod < n && dist >= thresholds[lod] + hysteresis) lod++;
    return lod;
  }
  // Stepping up in detail: only switch once inside threshold - hysteresis.
  let lod = current;
  while (lod > 0 && dist < thresholds[lod - 1] - hysteresis) lod--;
  return lod;
}

/** Builds a shared terrain chunk index buffer with 4 downward edge skirts to prevent LOD seams. */
export function buildTerrainLodIndex(cells: number, step: number): Uint16Array {
  const m = cells / step;
  const n = m + 1;
  const surfaceTris = m * m * 2;
  const skirtTris = m * 4 * 2;
  const out = new Uint16Array((surfaceTris + skirtTris) * 3);
  let w = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      out[w++] = a;
      out[w++] = c;
      out[w++] = b;
      out[w++] = b;
      out[w++] = c;
      out[w++] = d;
    }
  }
  const base = n * n;
  // North edge (j = 0, facing -Z)
  for (let i = 0; i < m; i++) {
    const t = i;
    const t1 = i + 1;
    const s = base + i;
    const s1 = s + 1;
    out[w++] = t;
    out[w++] = t1;
    out[w++] = s;
    out[w++] = t1;
    out[w++] = s1;
    out[w++] = s;
  }
  // South edge (j = m, facing +Z)
  for (let i = 0; i < m; i++) {
    const t = m * n + i;
    const t1 = t + 1;
    const s = base + n + i;
    const s1 = s + 1;
    out[w++] = t;
    out[w++] = s;
    out[w++] = t1;
    out[w++] = t1;
    out[w++] = s;
    out[w++] = s1;
  }
  // West edge (i = 0, facing -X)
  for (let j = 0; j < m; j++) {
    const t = j * n;
    const t1 = (j + 1) * n;
    const s = base + 2 * n + j;
    const s1 = s + 1;
    out[w++] = t;
    out[w++] = s;
    out[w++] = t1;
    out[w++] = t1;
    out[w++] = s;
    out[w++] = s1;
  }
  // East edge (i = m, facing +X)
  for (let j = 0; j < m; j++) {
    const t = j * n + m;
    const t1 = (j + 1) * n + m;
    const s = base + 3 * n + j;
    const s1 = s + 1;
    out[w++] = t;
    out[w++] = t1;
    out[w++] = s;
    out[w++] = t1;
    out[w++] = s1;
    out[w++] = s;
  }
  return out;
}

interface Palette {
  grass: number;
  grass2: number;
  dirt: number;
  rock: number;
  sand: number;
  snow: number;
  embankment: number;
  waterShallow: number;
  waterDeep: number;
  snowLine: number;
}

const PALETTES: Record<Preset, Palette> = {
  alpine: {
    grass: 0x3f6a2c,
    grass2: 0x5f7f33,
    dirt: 0x5c5138,
    rock: 0x6d6a65,
    sand: 0x8f8460,
    snow: 0xeef1f5,
    embankment: 0x70685a,
    waterShallow: 0x2d7a78,
    waterDeep: 0x103344,
    snowLine: 215,
  },
  plains: {
    grass: 0x5d7f33,
    grass2: 0x8c9440,
    dirt: 0x6a5a3a,
    rock: 0x77726a,
    sand: 0x9c9068,
    snow: 0xeef1f5,
    embankment: 0x7a6d56,
    waterShallow: 0x2f6d63,
    waterDeep: 0x133845,
    snowLine: 9000,
  },
  desert: {
    grass: 0xb98f58,
    grass2: 0xc9a56e,
    dirt: 0xa36f42,
    rock: 0x955c3a,
    sand: 0xd9b985,
    snow: 0xeef1f5,
    embankment: 0xb58d60,
    waterShallow: 0x457b70,
    waterDeep: 0x17424b,
    snowLine: 9000,
  },
  islands: {
    grass: 0x4b7f33,
    grass2: 0x6e9338,
    dirt: 0x6a5a3a,
    rock: 0x6e6b63,
    sand: 0xdcc998,
    snow: 0xeef1f5,
    embankment: 0x766c58,
    waterShallow: 0x2c9b92,
    waterDeep: 0x0d3b54,
    snowLine: 9000,
  },
};

const NOISE_GLSL = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fb(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*vn(p); p = p*2.03+vec2(17.1,9.2); a *= 0.5; } return s; }
`;

const WEATHER_PARS_GLSL = `
uniform float uNight, uValleyMist, uCloudShadow;
uniform vec2 uCloudDrift;
uniform vec3 uMistColor;
`;

const CLOUD_SHADOW_GLSL = `
#include <lights_fragment_end>
float cloudField = fb(vWPos.xz * 0.0018 + uCloudDrift);
float cloudShadow = mix(1.0, 0.34, smoothstep(0.41, 0.7, cloudField) * uCloudShadow * (1.0 - uNight * 0.85));
reflectedLight.directDiffuse *= cloudShadow;
reflectedLight.directSpecular *= cloudShadow;
`;

const VALLEY_MIST_GLSL = `
if (uValleyMist > 0.005) {
  float mistDist = length(cameraPosition - vWPos);
  float mistNoise = 0.72 + 0.28 * fb(vWPos.xz * 0.0038 + uCloudDrift * 0.65);
  float mistHeight = exp(-max(0.0, vWPos.y - 8.0) * 0.014);
  float mistAmt = clamp((1.0 - exp(-mistDist * 0.0068 * uValleyMist)) * mistHeight * mistNoise * uValleyMist, 0.0, 0.9);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, mistAmt);
}
#include <fog_fragment>
`;

const HEIGHT_MIN = -16;
const HEIGHT_SPAN = 28;

function makeNormalTexture() {
  const size = 256;
  const heights = new Float32Array(size * size);
  // Sum of tiling sine waves keeps the normal map seamless.
  const waves: [number, number, number, number][] = [];
  for (let i = 0; i < 26; i++) {
    const fx = Math.round((Math.random() - 0.5) * 26);
    const fy = Math.round((Math.random() - 0.5) * 26);
    waves.push([fx, fy, Math.random() * Math.PI * 2, 1 / (1 + Math.hypot(fx, fy) * 0.35)]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const [fx, fy, ph, a] of waves) h += Math.sin(((x * fx + y * fy) / size) * Math.PI * 2 + ph) * a;
      heights[y * size + x] = h;
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = heights[y * size + ((x + size - 1) % size)];
      const r = heights[y * size + ((x + 1) % size)];
      const d = heights[((y + size - 1) % size) * size + x];
      const u = heights[((y + 1) % size) * size + x];
      const nx = (l - r) * 0.55;
      const ny = (d - u) * 0.55;
      const nz = 1;
      const il = 1 / Math.hypot(nx, ny, nz);
      const k = (y * size + x) * 4;
      data[k] = (nx * il * 0.5 + 0.5) * 255;
      data[k + 1] = (ny * il * 0.5 + 0.5) * 255;
      data[k + 2] = (nz * il * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

interface TerrainChunk {
  cx: number;
  cz: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  mesh: THREE.Mesh;
  lods: THREE.BufferGeometry[];
  lod: number;
  box: THREE.Box3;
}

export class TerrainRenderer {
  group = new THREE.Group();
  private chunks: TerrainChunk[] = [];
  private material: THREE.MeshStandardMaterial;
  private uniforms = {
    uGrass: { value: new THREE.Color() },
    uGrass2: { value: new THREE.Color() },
    uDirt: { value: new THREE.Color() },
    uRock: { value: new THREE.Color() },
    uSand: { value: new THREE.Color() },
    uSnow: { value: new THREE.Color() },
    uEmbankment: { value: new THREE.Color() },
    uSnowLine: { value: 200 },
    uWetness: { value: 0 },
    uSnowCover: { value: 0 },
    uNight: { value: 0 },
    uValleyMist: { value: 0 },
    uCloudShadow: { value: 0 },
    uCloudDrift: { value: new THREE.Vector2() },
    uMistColor: { value: new THREE.Color(0x9ab4c8) },
  };
  private water: THREE.Mesh;
  private waterNormal: THREE.Texture;
  private heightData: Uint8Array;
  private heightTex: THREE.DataTexture;
  private dummyTex: THREE.DataTexture;
  private reflCam = new THREE.PerspectiveCamera();
  private reflRT: THREE.WebGLRenderTarget | null = null;
  private reflWidth = 640;
  private reflHeight = 360;
  private planarEnabled = false;
  private reflPos = new THREE.Vector3();
  private reflNormal = new THREE.Vector3(0, 1, 0);
  private reflCamPos = new THREE.Vector3();
  private reflRot = new THREE.Matrix4();
  private reflLook = new THREE.Vector3();
  private reflView = new THREE.Vector3();
  private reflTarget = new THREE.Vector3();
  private reflPlane = new THREE.Plane();
  private reflClip = new THREE.Vector4();
  private reflQ = new THREE.Vector4();
  private savedViewport = new THREE.Vector4();
  private savedScissor = new THREE.Vector4();
  private waterUniforms: {
    uTime: { value: number };
    uHeightMap: { value: THREE.DataTexture };
    uWaterNormal: { value: THREE.Texture };
    uWaterShallow: { value: THREE.Color };
    uWaterDeep: { value: THREE.Color };
    uFoamColor: { value: THREE.Color };
    uSkyHorizon: { value: THREE.Color };
    uSkyZenith: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uNight: { value: number };
    uRain: { value: number };
    uValleyMist: { value: number };
    uCloudShadow: { value: number };
    uCloudDrift: { value: THREE.Vector2 };
    uMistColor: { value: THREE.Color };
    uReflectionMap: { value: THREE.Texture };
    uTextureMatrix: { value: THREE.Matrix4 };
    uHasPlanar: { value: number };
  };

  constructor(
    private scene: THREE.Scene,
    private hf: Heightfield,
  ) {
    this.heightData = new Uint8Array((RES + 1) * (RES + 1) * 4);
    this.heightTex = new THREE.DataTexture(this.heightData, RES + 1, RES + 1, THREE.RGBAFormat);
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.generateMipmaps = false;

    this.dummyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this.dummyTex.needsUpdate = true;

    this.waterNormal = makeNormalTexture();
    this.waterUniforms = {
      uTime: { value: 0 },
      uHeightMap: { value: this.heightTex },
      uWaterNormal: { value: this.waterNormal },
      uWaterShallow: { value: new THREE.Color() },
      uWaterDeep: { value: new THREE.Color() },
      uFoamColor: { value: new THREE.Color(0xeaf4f7) },
      uSkyHorizon: { value: new THREE.Color(0x9ab4c8) },
      uSkyZenith: { value: new THREE.Color(0x4674a8) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.88) },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uValleyMist: { value: 0 },
      uCloudShadow: { value: 0 },
      uCloudDrift: { value: new THREE.Vector2() },
      uMistColor: { value: new THREE.Color(0x9ab4c8) },
      uReflectionMap: { value: this.dummyTex },
      uTextureMatrix: { value: new THREE.Matrix4() },
      uHasPlanar: { value: 0 },
    };

    this.material = this.makeMaterial();
    this.setPalette(hf.preset);
    const indexAttrs = TERRAIN_LOD_STEPS.map((step) => new THREE.BufferAttribute(buildTerrainLodIndex(CELLS, step), 1));
    const chunkSize = WORLD_SIZE / TERRAIN_CHUNKS;
    const half = WORLD_SIZE / 2;

    for (let cz = 0; cz < TERRAIN_CHUNKS; cz++) {
      for (let cx = 0; cx < TERRAIN_CHUNKS; cx++) {
        const lods = TERRAIN_LOD_STEPS.map((step, lodIdx) => {
          const n = CELLS / step + 1;
          const vertCount = n * n + 4 * n;
          const g = new THREE.BufferGeometry();
          g.setIndex(indexAttrs[lodIdx]);
          g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
          g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
          g.setAttribute('aGrade', new THREE.BufferAttribute(new Float32Array(vertCount), 1));
          return g;
        });
        const mesh = new THREE.Mesh(lods[0], this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { cx, cz };
        const minX = cx * chunkSize - half;
        const minZ = cz * chunkSize - half;
        this.chunks.push({
          cx,
          cz,
          minX,
          minZ,
          maxX: minX + chunkSize,
          maxZ: minZ + chunkSize,
          mesh,
          lods,
          lod: 0,
          box: new THREE.Box3(),
        });
        this.group.add(mesh);
      }
    }
    scene.add(this.group);

    this.water = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), this.makeWaterMaterial());
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_LEVEL;
    this.water.receiveShadow = true;
    this.water.renderOrder = -1;
    scene.add(this.water);
  }

  private makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 });
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aGrade;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nvarying float vGrade;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNorm = normal;\nvGrade = aGrade;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWPos;
          varying vec3 vWNorm;
          varying float vGrade;
          uniform vec3 uGrass, uGrass2, uDirt, uRock, uSand, uSnow, uEmbankment;
          uniform float uSnowLine, uWetness, uSnowCover;
          ${WEATHER_PARS_GLSL}
          ${NOISE_GLSL}
          `,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec3 wn = normalize(vWNorm);
          float slope = 1.0 - wn.y;
          float big = fb(vWPos.xz * 0.006);
          float mid = fb(vWPos.xz * 0.05);
          float fine = fb(vWPos.xz * 0.6);
          float detail = fb(vWPos.xz * 3.6);
          float camDist = length(cameraPosition - vWPos);
          float detailFade = 1.0 - smoothstep(35.0, 210.0, camDist);

          vec3 c = mix(uGrass, uGrass2, smoothstep(0.32, 0.68, big + (mid - 0.5) * 0.35));
          c *= (0.82 + 0.36 * fine) * mix(1.0, 0.84 + 0.32 * detail, detailFade);
          c = mix(c, uDirt, smoothstep(0.52, 0.72, mid + (fine - 0.5) * 0.3) * 0.5);

          // Suppress natural cliff rock on track-graded embankments and cuttings.
          float gradeOuter = smoothstep(0.08, 0.62, vGrade);
          float gradeBed = smoothstep(0.66, 0.96, vGrade);
          float rock = smoothstep(0.11, 0.26, slope + (mid - 0.5) * 0.12) * (1.0 - gradeOuter);
          vec3 rockC = uRock * (0.72 + 0.56 * fb(vWPos.xz * vec2(0.09, 0.35) + vWPos.y * 0.12));
          c = mix(c, rockC, rock);

          vec3 shoulderC = mix(uGrass2, uDirt, 0.42 + (mid - 0.5) * 0.25) * (0.88 + 0.24 * fine);
          c = mix(c, shoulderC, gradeOuter * 0.55);
          vec3 bedC = uEmbankment * (0.84 + 0.32 * fine) * mix(1.0, 0.78 + 0.44 * detail, detailFade);
          c = mix(c, bedC, gradeBed);

          // Noise-broken beaches and riverbanks on flatter shores, yielding to roadbeds.
          float shoreNoise = (big - 0.5) * 3.8 + (mid - 0.5) * 2.4 + (fine - 0.5) * 1.1;
          float flatMask = 1.0 - smoothstep(0.22, 0.48, slope);
          float shore = (1.0 - smoothstep(-0.4, 4.8 + shoreNoise, vWPos.y)) * flatMask * (1.0 - smoothstep(0.42, 0.84, vGrade));
          vec3 sandC = uSand * (0.86 + 0.24 * fine) * mix(1.0, 0.88 + 0.24 * detail, detailFade);
          c = mix(c, sandC, shore);

          // Snow settles on the flatter high ground, plus dynamic snowfall accumulation.
          float highSnow = smoothstep(uSnowLine - 26.0, uSnowLine + 34.0, vWPos.y + (mid - 0.5) * 70.0) * (1.0 - smoothstep(0.26, 0.5, slope));
          float landAboveWater = smoothstep(0.05, 1.25, vWPos.y);
          float stormSnow = uSnowCover * landAboveWater * (1.0 - smoothstep(0.28, 0.64, slope + (mid - 0.5) * 0.14)) * (1.0 - gradeBed * 0.42);
          float snowMask = clamp(max(highSnow, stormSnow), 0.0, 1.0);
          c = mix(c, uSnow * (0.94 + 0.06 * fine), snowMask);

          // Wet and dark near/below the waterline, plus rain-slicked ground and puddles.
          float shoreWet = 1.0 - smoothstep(-1.4, 0.75 + fine * 0.35, vWPos.y);
          float puddleNoise = fb(vWPos.xz * 0.13) * 0.72 + fb(vWPos.xz * 0.52) * 0.28;
          float puddleMask = smoothstep(0.42, 0.72, puddleNoise) * (1.0 - smoothstep(0.06, 0.22, slope)) * landAboveWater;
          float rainWet = uWetness * (1.0 - snowMask) * landAboveWater;
          c *= mix(1.0, 0.54, shoreWet);
          c *= mix(1.0, 0.72 - 0.14 * puddleMask, rainWet);
          diffuseColor.rgb = c;
          `,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.88, snowMask * 0.65);
          roughnessFactor = mix(roughnessFactor, mix(0.36, 0.1, puddleMask), rainWet);
          `,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          float e = 0.35;
          float n0 = fb(vWPos.xz * 0.45);
          float nx = fb((vWPos.xz + vec2(e, 0.0)) * 0.45);
          float nz = fb((vWPos.xz + vec2(0.0, e)) * 0.45);
          vec3 bump = vec3(n0 - nx, 0.0, n0 - nz) * 1.3;
          if (detailFade > 0.01) {
            float ed = 0.12;
            float d0 = fb(vWPos.xz * 2.4);
            float dx = fb((vWPos.xz + vec2(ed, 0.0)) * 2.4);
            float dz = fb((vWPos.xz + vec2(0.0, ed)) * 2.4);
            bump += vec3(d0 - dx, 0.0, d0 - dz) * (0.85 * detailFade);
          }
          bump *= (1.0 - rainWet * puddleMask * 0.78);
          normal = normalize(normal + (viewMatrix * vec4(bump, 0.0)).xyz);
          `,
        )
        .replace('#include <lights_fragment_end>', CLOUD_SHADOW_GLSL)
        .replace('#include <fog_fragment>', VALLEY_MIST_GLSL);
    };
    return mat;
  }

  private makeWaterMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.05,
      transparent: true,
      depthWrite: false,
      envMapIntensity: 1.5,
    });
    const uniforms = this.waterUniforms;
    const stride = `${RES + 1}.0`;
    const halfWorld = (WORLD_SIZE / 2).toFixed(1);
    const worldSize = WORLD_SIZE.toFixed(1);
    const resStr = `${RES}.0`;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform mat4 uTextureMatrix;\nvarying vec3 vWPos;\nvarying vec4 vReflUv;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvec4 wPos4 = modelMatrix * vec4(position, 1.0);\nvWPos = wPos4.xyz;\nvReflUv = uTextureMatrix * wPos4;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWPos;
          varying vec4 vReflUv;
          uniform float uTime, uHasPlanar, uRain;
          ${WEATHER_PARS_GLSL}
          uniform sampler2D uHeightMap, uWaterNormal, uReflectionMap;
          uniform vec3 uWaterShallow, uWaterDeep, uFoamColor, uSkyHorizon, uSkyZenith, uSunDir, uSunColor;
          ${NOISE_GLSL}
          vec3 unpackWaterN(vec2 uv) {
            vec3 n = texture2D(uWaterNormal, uv).xyz * 2.0 - 1.0;
            return vec3(n.x, 0.0, n.y);
          }
          `,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec2 hUv = clamp(((vWPos.xz + ${halfWorld}) / ${worldSize}) * (${resStr} / ${stride}) + (0.5 / ${stride}), vec2(0.5 / ${stride}), vec2((${resStr} + 0.5) / ${stride}));
          float groundH = texture2D(uHeightMap, hUv).r * ${HEIGHT_SPAN.toFixed(1)} + (${HEIGHT_MIN.toFixed(1)});
          float submerge = ${WATER_LEVEL.toFixed(1)} - groundH;
          float edgeMask = smoothstep(-0.06, 0.22, submerge);
          if (edgeMask <= 0.002) discard;
          float depth = max(0.0, submerge);

          float riverZ = 170.0 * sin(vWPos.x * 0.0021 + 1.1) + 70.0 * sin(vWPos.x * 0.0051);
          float dzdx = 0.357 * cos(vWPos.x * 0.0021 + 1.1) + 0.357 * cos(vWPos.x * 0.0051);
          float inWorld = (1.0 - smoothstep(1450.0, 1600.0, abs(vWPos.x))) * (1.0 - smoothstep(1450.0, 1600.0, abs(vWPos.z)));
          float riverMask = inWorld * (1.0 - smoothstep(22.0, 105.0, abs(vWPos.z - riverZ)));
          vec2 flowDir = normalize(vec2(1.0, dzdx));

          float nFoam = vn(vWPos.xz * 0.32 + vec2(uTime * 0.12, -uTime * 0.08));
          float wave = 0.5 + 0.5 * sin(depth * 11.0 - uTime * 2.1 + nFoam * 4.5);
          float shoreBand = smoothstep(0.0, 0.14, depth) * (1.0 - smoothstep(0.18, 1.05, depth));
          float foam = shoreBand * smoothstep(0.32, 0.78, wave * 0.65 + nFoam * 0.55) * 0.72 * mix(1.0, 0.45, uNight);

          vec3 waterC = mix(uWaterShallow, uWaterDeep, smoothstep(0.0, 4.5, depth));
          diffuseColor.rgb = mix(waterC, uFoamColor, foam);
          diffuseColor.a = edgeMask * max(mix(0.38, 0.96, smoothstep(0.0, 3.2, depth)), foam * 0.85);
          `,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(0.08, 0.72, foam);
          `,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          vec2 flowShift = flowDir * (-uTime * 0.055 * riverMask);
          vec3 wn1 = unpackWaterN(vWPos.xz * 0.022 + flowShift + vec2(uTime * 0.016, uTime * 0.01));
          vec3 wn2 = unpackWaterN(vWPos.xz * 0.053 + flowShift * 1.4 - vec2(uTime * 0.011, -uTime * 0.014));
          vec2 rainChop = vec2(
            vn(vWPos.xz * 2.6 + vec2(uTime * 6.5, -uTime * 5.2)) - 0.5,
            vn(vWPos.xz * 2.6 + vec2(-uTime * 5.8, uTime * 6.1) + 19.3) - 0.5
          ) * (uRain * 0.22);
          vec3 wNorm = normalize(vec3(rainChop.x, 1.0, rainChop.y) + (wn1 + wn2) * (0.19 * (1.0 - foam * 0.7)));
          normal = normalize((viewMatrix * vec4(wNorm, 0.0)).xyz);
          `,
        )
        .replace('#include <lights_fragment_end>', CLOUD_SHADOW_GLSL)
        .replace(
          '#include <opaque_fragment>',
          `vec3 V = normalize(cameraPosition - vWPos);
          float ndv = clamp(dot(wNorm, V), 0.0, 1.0);
          float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 4.5);
          vec3 R = reflect(-V, wNorm);
          vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));
          float sunSpec = pow(max(dot(R, uSunDir), 0.0), 180.0) * smoothstep(-0.02, 0.25, uSunDir.y) * (1.0 - uRain * 0.65);
          skyRefl += uSunColor * sunSpec * 0.75;
          vec3 reflColor = skyRefl;
          if (uHasPlanar > 0.5 && vReflUv.w > 0.05) {
            vec2 rUv = clamp(vReflUv.xy / vReflUv.w + wNorm.xz * (0.032 * (1.0 - foam)), vec2(0.002), vec2(0.998));
            vec3 planar = texture2D(uReflectionMap, rUv).rgb;
            reflColor = mix(skyRefl, planar, smoothstep(0.05, 0.35, vReflUv.w));
          }
          outgoingLight = mix(outgoingLight, reflColor, fresnel * (1.0 - foam * 0.85) * 0.82);
          #include <opaque_fragment>
          `,
        )
        .replace('#include <fog_fragment>', VALLEY_MIST_GLSL);
    };
    return mat;
  }

  setPalette(preset: Preset) {
    const p = PALETTES[preset];
    const u = this.uniforms;
    u.uGrass.value.set(p.grass);
    u.uGrass2.value.set(p.grass2);
    u.uDirt.value.set(p.dirt);
    u.uRock.value.set(p.rock);
    u.uSand.value.set(p.sand);
    u.uSnow.value.set(p.snow);
    u.uEmbankment.value.set(p.embankment);
    u.uSnowLine.value = p.snowLine;
    this.waterUniforms.uWaterShallow.value.set(p.waterShallow);
    this.waterUniforms.uWaterDeep.value.set(p.waterDeep);
  }

  setField(hf: Heightfield) {
    this.hf = hf;
    this.setPalette(hf.preset);
    hf.dirty = [0, 0, RES, RES];
  }

  setPlanarReflections(enabled: boolean) {
    this.planarEnabled = enabled;
    if (!enabled) {
      this.waterUniforms.uHasPlanar.value = 0;
      this.waterUniforms.uReflectionMap.value = this.dummyTex;
      this.reflRT?.dispose();
      this.reflRT = null;
    }
  }

  resize(width: number, height: number) {
    const w = Math.min(768, Math.max(256, Math.round(width * 0.5)));
    const h = Math.min(480, Math.max(240, Math.round(height * 0.5)));
    if (w === this.reflWidth && h === this.reflHeight) return;
    this.reflWidth = w;
    this.reflHeight = h;
    if (this.reflRT) {
      this.reflRT.setSize(w, h);
    }
  }

  private ensureReflectionTarget() {
    if (!this.reflRT) {
      this.reflRT = new THREE.WebGLRenderTarget(this.reflWidth, this.reflHeight, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        samples: 0,
      });
    }
    return this.reflRT;
  }

  /** Renders planar water reflection using a mirrored camera clipped at WATER_LEVEL. */
  renderReflection(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
    if (!this.planarEnabled) {
      this.waterUniforms.uHasPlanar.value = 0;
      return;
    }
    this.reflPos.set(0, WATER_LEVEL, 0);
    this.reflCamPos.setFromMatrixPosition(camera.matrixWorld);
    this.reflView.subVectors(this.reflPos, this.reflCamPos);
    if (this.reflView.dot(this.reflNormal) >= -0.05) {
      this.waterUniforms.uHasPlanar.value = 0;
      return;
    }

    this.reflView.reflect(this.reflNormal).negate().add(this.reflPos);
    this.reflRot.extractRotation(camera.matrixWorld);
    this.reflLook.set(0, 0, -1).applyMatrix4(this.reflRot).add(this.reflCamPos);
    this.reflTarget.subVectors(this.reflPos, this.reflLook).reflect(this.reflNormal).negate().add(this.reflPos);

    const rc = this.reflCam;
    rc.position.copy(this.reflView);
    rc.up.set(0, 1, 0).applyMatrix4(this.reflRot).reflect(this.reflNormal);
    rc.lookAt(this.reflTarget);
    rc.fov = camera.fov;
    rc.aspect = camera.aspect;
    rc.near = camera.near;
    rc.far = camera.far;
    rc.updateMatrixWorld();
    rc.matrixWorldInverse.copy(rc.matrixWorld).invert();
    rc.projectionMatrix.copy(camera.projectionMatrix);
    rc.projectionMatrix.elements[8] *= -1;
    rc.projectionMatrix.elements[12] *= -1;

    const texMat = this.waterUniforms.uTextureMatrix.value;
    texMat
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(rc.projectionMatrix)
      .multiply(rc.matrixWorldInverse);

    // Oblique near-plane clipping prevents underwater terrain from bleeding into the reflection.
    this.reflPlane.setFromNormalAndCoplanarPoint(this.reflNormal, this.reflPos).applyMatrix4(rc.matrixWorldInverse);
    this.reflClip.set(
      this.reflPlane.normal.x,
      this.reflPlane.normal.y,
      this.reflPlane.normal.z,
      this.reflPlane.constant,
    );
    const pe = rc.projectionMatrix.elements;
    const q = this.reflQ;
    q.set(
      (Math.sign(this.reflClip.x) + pe[8]) / pe[0],
      (Math.sign(this.reflClip.y) + pe[9]) / pe[5],
      -1,
      (1 + pe[10]) / pe[14],
    );
    this.reflClip.multiplyScalar(2 / this.reflClip.dot(q));
    pe[2] = this.reflClip.x;
    pe[6] = this.reflClip.y;
    pe[10] = this.reflClip.z + 1;
    pe[14] = this.reflClip.w;

    const rt = this.ensureReflectionTarget();
    this.waterUniforms.uReflectionMap.value = rt.texture;
    this.waterUniforms.uHasPlanar.value = 1;

    const prevRT = renderer.getRenderTarget();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);
    const prevScissorTest = renderer.getScissorTest();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;

    // Swap terrain chunks down to coarse LOD2 during reflection to keep triangle budget lean.
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.lod < 2) c.mesh.geometry = c.lods[2];
    }
    this.water.visible = false;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(rt);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, this.reflWidth, this.reflHeight);
      renderer.clear();
      renderer.render(this.scene, rc);
    } finally {
      this.water.visible = true;
      for (let i = 0; i < this.chunks.length; i++) {
        const c = this.chunks[i];
        if (c.lod < 2) c.mesh.geometry = c.lods[c.lod];
      }
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.setRenderTarget(prevRT);
      renderer.setViewport(this.savedViewport);
      renderer.setScissor(this.savedScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  /** Rewrites the LOD geometries of chunks overlapping the field's dirty rectangle. */
  sync() {
    const d = this.hf.dirty;
    if (!d) return;
    this.hf.dirty = null;
    const half = WORLD_SIZE / 2;
    const cell = WORLD_SIZE / RES;
    const s = this.hf.stride;
    const h = this.hf.h;
    const gw = this.hf.gradeWeight;

    for (let gj = d[1]; gj <= d[3]; gj++) {
      const row = gj * s;
      for (let gi = d[0]; gi <= d[2]; gi++) {
        const k = row + gi;
        const normH = Math.max(0, Math.min(1, (h[k] - HEIGHT_MIN) / HEIGHT_SPAN));
        const p = k * 4;
        this.heightData[p] = Math.round(normH * 255);
        this.heightData[p + 3] = 255;
      }
    }
    this.heightTex.needsUpdate = true;

    // Normals sample one cell out, so neighbouring chunks need refreshing too.
    const minC = Math.max(0, Math.floor((d[0] - 1) / CELLS));
    const maxC = Math.min(TERRAIN_CHUNKS - 1, Math.floor((d[2] + 1) / CELLS));
    const minR = Math.max(0, Math.floor((d[1] - 1) / CELLS));
    const maxR = Math.min(TERRAIN_CHUNKS - 1, Math.floor((d[3] + 1) / CELLS));

    for (let cz = minR; cz <= maxR; cz++) {
      for (let cx = minC; cx <= maxC; cx++) {
        const chunk = this.chunks[cz * TERRAIN_CHUNKS + cx];
        for (let lodIdx = 0; lodIdx < TERRAIN_LOD_STEPS.length; lodIdx++) {
          const step = TERRAIN_LOD_STEPS[lodIdx];
          const drop = SKIRT_DROPS[lodIdx];
          const m = CELLS / step;
          const n = m + 1;
          const g = chunk.lods[lodIdx];
          const pos = g.attributes.position as THREE.BufferAttribute;
          const nor = g.attributes.normal as THREE.BufferAttribute;
          const grade = g.attributes.aGrade as THREE.BufferAttribute;
          for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
              const gi = cx * CELLS + i * step;
              const gj = cz * CELLS + j * step;
              const k = j * n + i;
              const hk = gj * s + gi;
              pos.setXYZ(k, gi * cell - half, h[hk], gj * cell - half);
              grade.setX(k, gw[hk]);
              const l = h[gj * s + Math.max(0, gi - 1)];
              const r = h[gj * s + Math.min(RES, gi + 1)];
              const u = h[Math.max(0, gj - 1) * s + gi];
              const dn = h[Math.min(RES, gj + 1) * s + gi];
              const nx = l - r;
              const nz = u - dn;
              const ny = 2 * cell;
              const il = 1 / Math.hypot(nx, ny, nz);
              nor.setXYZ(k, nx * il, ny * il, nz * il);
            }
          }
          // Copy edge positions dropped downward and keep edge normals and grading weights on skirt slivers.
          const base = n * n;
          const copySkirt = (top: number, sk: number) => {
            pos.setXYZ(sk, pos.getX(top), pos.getY(top) - drop, pos.getZ(top));
            nor.setXYZ(sk, nor.getX(top), nor.getY(top), nor.getZ(top));
            grade.setX(sk, grade.getX(top));
          };
          for (let i = 0; i < n; i++) copySkirt(i, base + i);
          for (let i = 0; i < n; i++) copySkirt(m * n + i, base + n + i);
          for (let j = 0; j < n; j++) copySkirt(j * n, base + 2 * n + j);
          for (let j = 0; j < n; j++) copySkirt(j * n + m, base + 3 * n + j);
          pos.needsUpdate = true;
          nor.needsUpdate = true;
          grade.needsUpdate = true;
          g.computeBoundingBox();
          g.computeBoundingSphere();
        }
        chunk.box.copy(chunk.lods[0].boundingBox!);
      }
    }
  }

  /** Picks per-chunk LOD from camera distance and culls shadow casting outside the sun shadow frustum. */
  updateLOD(camPos: THREE.Vector3, shadowFrustum: THREE.Frustum | null) {
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const dist = chunkXZDistance(camPos.x, camPos.z, c.minX, c.minZ, c.maxX, c.maxZ);
      const nextLod = selectLod(dist, c.lod, TERRAIN_LOD_THRESHOLDS, TERRAIN_LOD_HYSTERESIS);
      if (nextLod !== c.lod) {
        c.lod = nextLod;
        c.mesh.geometry = c.lods[nextLod];
      }
      c.mesh.castShadow = shadowFrustum !== null && shadowFrustum.intersectsBox(c.box);
    }
  }

  update(time: number, env?: Environment) {
    this.waterUniforms.uTime.value = time;
    if (!env) return;
    const ws = env.weatherState;
    const fogColor = (this.scene.fog as THREE.FogExp2).color;
    this.uniforms.uWetness.value = ws.wetness;
    this.uniforms.uSnowCover.value = ws.snowCover;
    this.uniforms.uNight.value = env.night;
    this.uniforms.uValleyMist.value = ws.valleyMist;
    this.uniforms.uCloudShadow.value = ws.cloudShadow;
    this.uniforms.uCloudDrift.value.copy(env.cloudDrift);
    this.uniforms.uMistColor.value.copy(env.mistColor);

    this.waterUniforms.uNight.value = env.night;
    this.waterUniforms.uRain.value = ws.rain;
    this.waterUniforms.uValleyMist.value = ws.valleyMist;
    this.waterUniforms.uCloudShadow.value = ws.cloudShadow;
    this.waterUniforms.uCloudDrift.value.copy(env.cloudDrift);
    this.waterUniforms.uMistColor.value.copy(env.mistColor);
    this.waterUniforms.uSkyHorizon.value.copy(fogColor);
    this.waterUniforms.uSkyZenith.value.copy(env.hemi.color).multiplyScalar(0.55 + (1 - env.night) * 0.65);
    this.waterUniforms.uSunDir.value.copy(env.sun.position).sub(env.sun.target.position).normalize();
    this.waterUniforms.uSunColor.value.copy(env.sun.color).multiplyScalar(Math.min(2, env.sun.intensity * 0.45));
  }
}
