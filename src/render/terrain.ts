// Chunked terrain mesh with procedural slope and height shading, plus the water surface.
import * as THREE from 'three';
import { Heightfield, Preset, RES, WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';

const CHUNKS = 16;
const CELLS = RES / CHUNKS;

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
  alpine: { grass: 0x3f6a2c, grass2: 0x5f7f33, dirt: 0x5c5138, rock: 0x6d6a65, sand: 0x8f8460, snow: 0xeef1f5, snowLine: 215 },
  plains: { grass: 0x5d7f33, grass2: 0x8c9440, dirt: 0x6a5a3a, rock: 0x77726a, sand: 0x9c9068, snow: 0xeef1f5, snowLine: 9000 },
  desert: { grass: 0xb98f58, grass2: 0xc9a56e, dirt: 0xa36f42, rock: 0x955c3a, sand: 0xd9b985, snow: 0xeef1f5, snowLine: 9000 },
  islands: { grass: 0x4b7f33, grass2: 0x6e9338, dirt: 0x6a5a3a, rock: 0x6e6b63, sand: 0xdcc998, snow: 0xeef1f5, snowLine: 9000 },
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

export class TerrainRenderer {
  group = new THREE.Group();
  private chunks: THREE.Mesh[] = [];
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

  constructor(scene: THREE.Scene, private hf: Heightfield) {
    this.material = this.makeMaterial();
    this.setPalette(hf.preset);
    const index: number[] = [];
    const n = CELLS + 1;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const indexAttr = new THREE.BufferAttribute(new Uint16Array(index), 1);
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const g = new THREE.BufferGeometry();
        g.setIndex(indexAttr);
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
        const mesh = new THREE.Mesh(g, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { cx, cz };
        this.chunks.push(mesh);
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
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNorm = normal;');
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

  /** Rewrites the chunks overlapping the field's dirty rectangle. */
  sync() {
    const d = this.hf.dirty;
    if (!d) return;
    this.hf.dirty = null;
    const half = WORLD_SIZE / 2;
    const cell = WORLD_SIZE / RES;
    const s = this.hf.stride;
    const h = this.hf.h;
    const n = CELLS + 1;
    // Normals sample one cell out, so neighbouring chunks need refreshing too.
    const minC = Math.max(0, Math.floor((d[0] - 1) / CELLS));
    const maxC = Math.min(CHUNKS - 1, Math.floor((d[2] + 1) / CELLS));
    const minR = Math.max(0, Math.floor((d[1] - 1) / CELLS));
    const maxR = Math.min(CHUNKS - 1, Math.floor((d[3] + 1) / CELLS));
    for (let cz = minR; cz <= maxR; cz++) {
      for (let cx = minC; cx <= maxC; cx++) {
        const mesh = this.chunks[cz * CHUNKS + cx];
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const nor = mesh.geometry.attributes.normal as THREE.BufferAttribute;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const gi = cx * CELLS + i;
            const gj = cz * CELLS + j;
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
        pos.needsUpdate = true;
        nor.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
        mesh.geometry.computeBoundingBox();
      }
    }
  }

  update(time: number) {
    this.waterNormal.offset.set(time * 0.0035, time * 0.0022);
  }
}
