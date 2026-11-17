// Loads the Blender asset pack and hands out clones or instancing primitives.
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface Prim {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

// glTF stores emission multiplied by strength, so the colours driven at night live here.
const GLOW: Record<string, [number, number, number, number]> = {
  glow_window: [1.0, 0.62, 0.28, 1.05],
  glow_cab: [1.0, 0.85, 0.55, 0.8],
  glow_headlight: [1.0, 0.93, 0.78, 6],
  glow_tail: [1.0, 0.03, 0.015, 5],
  glow_lamp: [1.0, 0.76, 0.42, 10],
};

export class Assets {
  private roots = new Map<string, THREE.Object3D>();
  private prims = new Map<string, Prim[]>();
  private ownPrims = new Map<string, Prim[]>();
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
      out.push({ name: o.name, geometry: g, material: mesh.material as THREE.MeshStandardMaterial });
    });
    this.prims.set(name, out);
    return out;
  }

  /** Local-space primitives belonging directly to a named asset or child sub-object (without sub-group children). */
  ownPrimitives(rootName: string, nodeName?: string): Prim[] {
    const key = nodeName ? `${rootName}:${nodeName}` : rootName;
    const cached = this.ownPrims.get(key);
    if (cached) return cached;
    const root = this.roots.get(rootName);
    if (!root) throw new Error(`Asset ${rootName} is missing from assetpack.glb`);
    const target = nodeName ? root.getObjectByName(nodeName) : root;
    if (!target) throw new Error(`Node ${nodeName} is missing from asset ${rootName}`);
    const out: Prim[] = [];
    if ((target as THREE.Mesh).isMesh) {
      const m = target as THREE.Mesh;
      out.push({ name: m.name, geometry: m.geometry, material: m.material as THREE.MeshStandardMaterial });
    } else {
      for (const child of target.children) {
        const m = child as THREE.Mesh;
        if (!m.isMesh) continue;
        out.push({ name: m.name, geometry: m.geometry, material: m.material as THREE.MeshStandardMaterial });
      }
    }
    this.ownPrims.set(key, out);
    return out;
  }

  /** Lights windows and lamps; night is 0 by day and 1 in full darkness. */
  setNight(night: number) {
    for (const g of this.glowMats) g.mat.emissiveIntensity = g.strength * night;
  }
}
