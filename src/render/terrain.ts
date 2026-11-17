// Chunked terrain mesh with distance LODs, edge skirts, shadow culling and procedural shading, plus water.
import * as THREE from 'three';

import type { Heightfield, Preset } from '../world/heightfield';
import { RES, WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';

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
    snowLine: 215,
  },
  plains: {
    grass: 0x5d7f33,
    grass2: 0x8c9440,
    dirt: 0x6a5a3a,
    rock: 0x77726a,
    sand: 0x9c9068,
    snow: 0xeef1f5,
    snowLine: 9000,
  },
  desert: {
    grass: 0xb98f58,
    grass2: 0xc9a56e,
    dirt: 0xa36f42,
    rock: 0x955c3a,
    sand: 0xd9b985,
    snow: 0xeef1f5,
    snowLine: 9000,
  },
  islands: {
    grass: 0x4b7f33,
    grass2: 0x6e9338,
    dirt: 0x6a5a3a,
    rock: 0x6e6b63,
    sand: 0xdcc998,
    snow: 0xeef1f5,
    snowLine: 9000,
  },
};

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
    uSnowLine: { value: 200 },
  };
  private water: THREE.Mesh;
  private waterNormal: THREE.Texture;

  constructor(
    scene: THREE.Scene,
    private hf: Heightfield,
  ) {
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

    this.waterNormal = makeNormalTexture();
    this.waterNormal.repeat.set(1500, 1500);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x174452,
      roughness: 0.13,
      metalness: 0.15,
      normalMap: this.waterNormal,
      normalScale: new THREE.Vector2(0.24, 0.24),
      envMapIntensity: 2.2,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_LEVEL;
    this.water.receiveShadow = true;
    scene.add(this.water);
  }

  private makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 });
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNorm = normal;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWPos;
          varying vec3 vWNorm;
          uniform vec3 uGrass, uGrass2, uDirt, uRock, uSand, uSnow;
          uniform float uSnowLine;
          float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
          float fb(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*vn(p); p = p*2.03+vec2(17.1,9.2); a *= 0.5; } return s; }
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
          vec3 c = mix(uGrass, uGrass2, smoothstep(0.32, 0.68, big + (mid-0.5)*0.35));
          c *= 0.82 + 0.36 * fine;
          c = mix(c, uDirt, smoothstep(0.52, 0.72, mid + (fine-0.5)*0.3) * 0.5);
          // Exposed rock on steep ground.
          float rock = smoothstep(0.11, 0.26, slope + (mid-0.5)*0.12);
          vec3 rockC = uRock * (0.72 + 0.56 * fb(vWPos.xz * vec2(0.09, 0.35) + vWPos.y * 0.12));
          c = mix(c, rockC, rock);
          // Beaches and riverbanks.
          float shore = 1.0 - smoothstep(1.2, 4.2 + mid * 2.5, vWPos.y);
          c = mix(c, uSand * (0.85 + 0.25 * fine), shore);
          // Snow settles on the flatter high ground.
          float snow = smoothstep(uSnowLine - 26.0, uSnowLine + 34.0, vWPos.y + (mid-0.5)*70.0) * (1.0 - smoothstep(0.26, 0.5, slope));
          c = mix(c, uSnow, snow);
          // Wet and dark below the waterline.
          c *= mix(0.55, 1.0, smoothstep(-2.0, 0.4, vWPos.y));
          diffuseColor.rgb = c;
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
          normal = normalize(normal + (viewMatrix * vec4(bump, 0.0)).xyz);
          `,
        );
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
    u.uSnowLine.value = p.snowLine;
  }

  setField(hf: Heightfield) {
    this.hf = hf;
    this.setPalette(hf.preset);
    hf.dirty = [0, 0, RES, RES];
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
          for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
              const gi = cx * CELLS + i * step;
              const gj = cz * CELLS + j * step;
              const k = j * n + i;
              pos.setXYZ(k, gi * cell - half, h[gj * s + gi], gj * cell - half);
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
          // Copy edge positions dropped downward and keep edge normals so skirt slivers match terrain lighting.
          const base = n * n;
          for (let i = 0; i < n; i++) {
            const top = i;
            const sk = base + i;
            pos.setXYZ(sk, pos.getX(top), pos.getY(top) - drop, pos.getZ(top));
            nor.setXYZ(sk, nor.getX(top), nor.getY(top), nor.getZ(top));
          }
          for (let i = 0; i < n; i++) {
            const top = m * n + i;
            const sk = base + n + i;
            pos.setXYZ(sk, pos.getX(top), pos.getY(top) - drop, pos.getZ(top));
            nor.setXYZ(sk, nor.getX(top), nor.getY(top), nor.getZ(top));
          }
          for (let j = 0; j < n; j++) {
            const top = j * n;
            const sk = base + 2 * n + j;
            pos.setXYZ(sk, pos.getX(top), pos.getY(top) - drop, pos.getZ(top));
            nor.setXYZ(sk, nor.getX(top), nor.getY(top), nor.getZ(top));
          }
          for (let j = 0; j < n; j++) {
            const top = j * n + m;
            const sk = base + 3 * n + j;
            pos.setXYZ(sk, pos.getX(top), pos.getY(top) - drop, pos.getZ(top));
            nor.setXYZ(sk, nor.getX(top), nor.getY(top), nor.getZ(top));
          }
          pos.needsUpdate = true;
          nor.needsUpdate = true;
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

  update(time: number) {
    this.waterNormal.offset.set(time * 0.0035, time * 0.0022);
  }
}
