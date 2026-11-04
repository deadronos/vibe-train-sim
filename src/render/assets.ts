// Loads the Blender asset pack and hands out clones or instancing primitives.
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface Prim {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

// glTF stores emission multiplied by strength, so the colours driven at night live here.
const GLOW: Record<string, [number, number, number, number]> = {
  glow_window: [1.0, 0.62, 0.28, 1.05],
  glow_headlight: [1.0, 0.93, 0.78, 6],
  glow_tail: [1.0, 0.03, 0.015, 5],
  glow_lamp: [1.0, 0.76, 0.42, 10],
};

export class Assets {
  private roots = new Map<string, THREE.Object3D>();
  private prims = new Map<string, Prim[]>();
  glowMats: { mat: THREE.MeshStandardMaterial; strength: number }[] = [];

  async load(url: string, onProgress?: (f: number) => void) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    const seen = new Set<THREE.Material>();
    for (const child of [...gltf.scene.children]) {
      child.updateMatrixWorld(true);
      this.roots.set(child.name, child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (seen.has(m)) return;
        seen.add(m);
        const g = GLOW[m.name];
        if (g) {
          m.emissive.setRGB(g[0], g[1], g[2]);
          m.emissiveIntensity = 0;
          this.glowMats.push({ mat: m, strength: g[3] });
        }
      });
    }
  }

  /** A shared-geometry copy for one-off placements such as cars and signals. */
  clone(name: string): THREE.Object3D {
    const root = this.roots.get(name);
    if (!root) throw new Error(`Asset ${name} is missing from assetpack.glb`);
    const c = root.clone(true);
    c.position.set(0, 0, 0);
    c.rotation.set(0, 0, 0);
    return c;
  }

  /** Geometry and material pairs for InstancedMesh, with transforms baked to the asset origin. */
  primitives(name: string): Prim[] {
    const cached = this.prims.get(name);
    if (cached) return cached;
    const root = this.roots.get(name);
    if (!root) throw new Error(`Asset ${name} is missing from assetpack.glb`);
    const out: Prim[] = [];
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      out.push({ geometry: g, material: mesh.material as THREE.MeshStandardMaterial });
    });
    this.prims.set(name, out);
    return out;
  }

  /** Lights windows and lamps; night is 0 by day and 1 in full darkness. */
  setNight(night: number) {
    for (const g of this.glowMats) g.mat.emissiveIntensity = g.strength * night;
  }
}
