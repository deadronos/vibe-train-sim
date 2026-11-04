// Driving cameras: chase, cab and trackside. The editor uses MapControls instead.
import * as THREE from 'three';

import type { Sim, Train } from '../rail/sim';
import type { Heightfield } from '../world/heightfield';

export type CamMode = 'chase' | 'cab' | 'trackside';
export const CAM_LABEL: Record<CamMode, string> = { chase: 'Chase', cab: 'Cab', trackside: 'Trackside' };

export class CameraRig {
  mode: CamMode = 'chase';
  yaw = 2.4;
  pitch = 0.22;
  dist = 72;
  cabYaw = 0;
  cabPitch = -0.04;
  private side = new THREE.Vector3();
  private sideValid = false;
  private target = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private smooth = new THREE.Vector3();
  private hasSmooth = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private active: () => boolean,
  ) {
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active()) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', () => (this.dragging = false));
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.active()) return;
      const dx = (e.clientX - this.lastX) * 0.0045;
      const dy = (e.clientY - this.lastY) * 0.0045;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.mode === 'cab') {
        this.cabYaw -= dx;
        this.cabPitch = Math.max(-0.7, Math.min(0.6, this.cabPitch - dy));
      } else {
        this.yaw -= dx;
        this.pitch = Math.max(-0.05, Math.min(1.45, this.pitch + dy));
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.active()) return;
        this.dist = Math.max(16, Math.min(520, this.dist * (1 + e.deltaY * 0.001)));
      },
      { passive: true },
    );
  }

  cycle() {
    const order: CamMode[] = ['chase', 'cab', 'trackside'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    this.sideValid = false;
    this.hasSmooth = false;
    this.cabYaw = 0;
    this.cabPitch = -0.04;
  }

  update(sim: Sim, t: Train, hf: Heightfield, dt: number) {
    const cam = this.camera;
    const head = sim.head(t);
    const fx = head.tx * head.dir;
    const fy = head.ty * head.dir;
    const fz = head.tz * head.dir;
    if (this.mode === 'cab') {
      // Sits at the front of the leading vehicle, clear of its nose, whichever vehicle leads.
      cam.position.set(head.x + fx * 0.3, head.y + 3.05, head.z + fz * 0.3);
      const l = Math.hypot(fx, fz) || 1;
      const a = Math.atan2(fx / l, fz / l) + this.cabYaw;
      this.lookTarget.set(
        cam.position.x + Math.sin(a) * 10,
        cam.position.y + Math.sin(this.cabPitch) * 10 + fy * 10,
        cam.position.z + Math.cos(a) * 10,
      );
      cam.lookAt(this.lookTarget);
      return;
    }
    const mid = sim.behind(t, Math.min(t.length * 0.3, 40));
    this.target.set(mid.x, mid.y + 2.4, mid.z);
    if (this.mode === 'trackside') {
      if (!this.sideValid || this.side.distanceTo(this.target) > 340) {
        const rx = -fz;
        const rz = fx;
        const x = head.x + fx * 210 + rx * 16;
        const z = head.z + fz * 210 + rz * 16;
        this.side.set(x, Math.max(hf.height(x, z), head.y - 4) + 1.9, z);
        this.sideValid = true;
      }
      cam.position.copy(this.side);
      this.lookTarget.copy(this.target);
      cam.lookAt(this.lookTarget);
      return;
    }
    const cp = Math.cos(this.pitch);
    const desiredX = this.target.x + Math.sin(this.yaw) * cp * this.dist;
    const desiredY = this.target.y + Math.sin(this.pitch) * this.dist;
    const desiredZ = this.target.z + Math.cos(this.yaw) * cp * this.dist;
    if (!this.hasSmooth) {
      this.smooth.copy(this.target);
      this.hasSmooth = true;
    }
    this.smooth.lerp(this.target, 1 - Math.exp(-dt * 7));
    const offX = desiredX - this.target.x;
    const offY = desiredY - this.target.y;
    const offZ = desiredZ - this.target.z;
    const cx = this.smooth.x + offX;
    const cz = this.smooth.z + offZ;
    cam.position.set(cx, Math.max(this.smooth.y + offY, hf.height(cx, cz) + 1.8), cz);
    cam.lookAt(this.smooth);
  }
}
