// Draws each train from the simulation and provides the headlight of the driven train.
import * as THREE from 'three';

import type { Sim, Train } from '../rail/sim';
import type { Assets } from './assets';

interface CarVisual {
  root: THREE.Group;
  body: THREE.Object3D;
  bogieA: THREE.Object3D;
  bogieB: THREE.Object3D;
}

interface TrainVisual {
  group: THREE.Group;
  cars: CarVisual[];
  signature: string;
}

const signature = (t: Train) =>
  t.cars
    .map((c) => c.type)
    .sort()
    .join(',');

export class TrainRenderer {
  group = new THREE.Group();
  private visuals = new Map<number, TrainVisual>();
  headlight: THREE.SpotLight;
  private dirA = new THREE.Vector3();
  private dirB = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private assets: Assets,
  ) {
    scene.add(this.group);
    this.headlight = new THREE.SpotLight(0xfff3d6, 0, 420, 0.3, 0.6, 1.5);
    scene.add(this.headlight, this.headlight.target);
  }

  private build(t: Train): TrainVisual {
    const group = new THREE.Group();
    const cars = t.cars.map((c) => {
      const root = new THREE.Group();
      const body = this.assets.clone(c.type);
      const bogieA = this.assets.clone('bogie');
      const bogieB = this.assets.clone('bogie');
      root.add(body);
      group.add(root, bogieA, bogieB);
      return { root, body, bogieA, bogieB };
    });
    this.group.add(group);
    return { group, cars, signature: signature(t) };
  }

  sync(sim: Sim) {
    const alive = new Set(sim.trains.map((t) => t.id));
    for (const [id, v] of this.visuals) {
      if (!alive.has(id)) {
        this.group.remove(v.group);
        this.visuals.delete(id);
      }
    }
    for (const t of sim.trains) {
      let v = this.visuals.get(t.id);
      if (!v || v.signature !== signature(t)) {
        if (v) this.group.remove(v.group);
        v = this.build(t);
        this.visuals.set(t.id, v);
      }
      this.pose(sim, t, v);
    }
  }

  clear() {
    for (const v of this.visuals.values()) this.group.remove(v.group);
    this.visuals.clear();
  }

  private pose(sim: Sim, t: Train, v: TrainVisual) {
    // Consist order can reverse, so visuals are re-keyed by car index each frame.
    const ordered = this.assignVisuals(t, v);
    t.cars.forEach((car, i) => {
      const cv = ordered[i];
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
      cv.bogieA.position.set(fx, fy, fz);
      cv.bogieB.position.set(rx, ry, rz);
      this.dirA.set(p.front.tx * p.front.dir, p.front.ty * p.front.dir, p.front.tz * p.front.dir);
      this.dirB.set(p.rear.tx * p.rear.dir, p.rear.ty * p.rear.dir, p.rear.tz * p.rear.dir);
      this.look.copy(cv.bogieA.position).add(this.dirA);
      cv.bogieA.lookAt(this.look);
      this.look.copy(cv.bogieB.position).add(this.dirB);
      cv.bogieB.lookAt(this.look);
    });
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

  /** Beam from the leading vehicle of a train, stronger once it gets dark. */
  updateHeadlight(sim: Sim, t: Train | null, night: number) {
    if (!t || night < 0.08) {
      this.headlight.intensity = 0;
      return;
    }
    const h = sim.drawn(t);
    const fx = h.tx * h.dir;
    const fz = h.tz * h.dir;
    const fy = h.ty * h.dir;
    this.headlight.position.set(h.x + fx * 0.5, h.y + 2.3, h.z + fz * 0.5);
    this.headlight.target.position.set(h.x + fx * 60, h.y + fy * 60 + 0.5, h.z + fz * 60);
    this.headlight.target.updateMatrixWorld();
    this.headlight.intensity = 1100 * night;
  }
}
