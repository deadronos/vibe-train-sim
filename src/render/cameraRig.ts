// Driving cameras: chase, cab, trackside, cinematic and free-fly. The editor uses MapControls instead.
import * as THREE from 'three';

import type { Sim, Train } from '../rail/sim';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL, WORLD_SIZE } from '../world/heightfield';

export type CamMode = 'chase' | 'cab' | 'trackside' | 'cinematic' | 'free';
export const CAM_LABEL: Record<CamMode, string> = {
  chase: 'Chase',
  cab: 'Cab',
  trackside: 'Trackside',
  cinematic: 'Cinematic',
  free: 'Free',
};
const MODE_ORDER: CamMode[] = ['chase', 'cab', 'trackside', 'cinematic', 'free'];

export const DEFAULT_FOV = 58;
export const CAB_FOV_MIN = 28;
export const CAB_FOV_MAX = 85;
export const CAB_YAW_MAX = 1.75;
export const CAB_PITCH_MIN = -0.65;
export const CAB_PITCH_MAX = 0.5;
const TRANSITION_SEC = 0.45;

export function clampCabFov(fov: number): number {
  return Math.max(CAB_FOV_MIN, Math.min(CAB_FOV_MAX, fov));
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export class CameraRig {
  mode: CamMode = 'chase';
  yaw = 2.4;
  pitch = 0.22;
  dist = 72;
  cabYaw = 0;
  cabPitch = -0.04;
  cabFov = DEFAULT_FOV;
  freePos = new THREE.Vector3(0, 80, 120);
  freeYaw = 0;
  freePitch = -0.25;
  focus = new THREE.Vector3();

  private side = new THREE.Vector3();
  private sideValid = false;
  private cineSpot = new THREE.Vector3();
  private cineDrift = new THREE.Vector3();
  private cineTimer = 0;
  private cineCut = 0;
  private cineValid = false;

  private target = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private smooth = new THREE.Vector3();
  private hasSmooth = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private keys = new Set<string>();

  private transT = 1;
  private transDuration = TRANSITION_SEC;
  private fromPos = new THREE.Vector3();
  private fromQuat = new THREE.Quaternion();
  private fromFov = DEFAULT_FOV;
  private goalPos = new THREE.Vector3();
  private goalQuat = new THREE.Quaternion();
  private lookMat = new THREE.Matrix4();
  private scratchDir = new THREE.Vector3();
  private cabLatSmooth = 0;

  /** True once the camera is inside or nearly inside cab view (for showing the cab interior shell). */
  get cabInteriorActive(): boolean {
    return this.mode === 'cab' && this.transT >= 0.55;
  }

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
        this.cabYaw = Math.max(-CAB_YAW_MAX, Math.min(CAB_YAW_MAX, this.cabYaw - dx));
        this.cabPitch = Math.max(CAB_PITCH_MIN, Math.min(CAB_PITCH_MAX, this.cabPitch - dy));
      } else if (this.mode === 'free') {
        this.freeYaw -= dx;
        this.freePitch = Math.max(-1.45, Math.min(1.45, this.freePitch - dy));
      } else {
        this.yaw -= dx;
        this.pitch = Math.max(-0.05, Math.min(1.45, this.pitch + dy));
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.active()) return;
        if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return;
        if (this.mode === 'cab') {
          this.cabFov = clampCabFov(this.cabFov + e.deltaY * 0.03);
        } else if (this.mode === 'free') {
          const cp = Math.cos(this.freePitch);
          const step = -e.deltaY * 0.25;
          this.freePos.x += Math.sin(this.freeYaw) * cp * step;
          this.freePos.y += Math.sin(this.freePitch) * step;
          this.freePos.z += Math.cos(this.freeYaw) * cp * step;
        } else {
          this.dist = Math.max(16, Math.min(520, this.dist * (1 + e.deltaY * 0.001)));
        }
      },
      { passive: true },
    );
  }

  press(code: string) {
    this.keys.add(code);
  }

  release(code: string) {
    this.keys.delete(code);
  }

  releaseKeys() {
    this.keys.clear();
  }

  beginTransition(duration = TRANSITION_SEC) {
    if (prefersReducedMotion() || duration <= 0) {
      this.transT = 1;
      return;
    }
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.fromFov = this.camera.fov;
    this.transDuration = duration;
    this.transT = 0;
  }

  setMode(next: CamMode) {
    if (next === this.mode) return;
    if (next === 'free') {
      this.freePos.copy(this.camera.position);
      const dir = this.camera.getWorldDirection(this.scratchDir);
      this.freeYaw = Math.atan2(dir.x, dir.z);
      this.freePitch = Math.asin(Math.max(-0.98, Math.min(0.98, dir.y)));
    }
    this.mode = next;
    this.sideValid = false;
    this.cineValid = false;
    this.hasSmooth = false;
    this.cabYaw = 0;
    this.cabPitch = -0.04;
    if (next !== 'free') this.releaseKeys();
    this.beginTransition();
  }

  cycle() {
    this.setMode(MODE_ORDER[(MODE_ORDER.indexOf(this.mode) + 1) % MODE_ORDER.length]);
  }

  private clampFree(hf: Heightfield) {
    const limit = WORLD_SIZE * 0.65;
    this.freePos.x = Math.max(-limit, Math.min(limit, this.freePos.x));
    this.freePos.z = Math.max(-limit, Math.min(limit, this.freePos.z));
    const minY = Math.max(hf.height(this.freePos.x, this.freePos.z), WATER_LEVEL) + 1.8;
    this.freePos.y = Math.max(minY, Math.min(1200, this.freePos.y));
  }

  update(sim: Sim, t: Train | null, hf: Heightfield, dt: number) {
    const cam = this.camera;
    const reduced = prefersReducedMotion();

    if (this.mode === 'free') {
      const cp = Math.cos(this.freePitch);
      const fx = Math.sin(this.freeYaw) * cp;
      const fy = Math.sin(this.freePitch);
      const fz = Math.cos(this.freeYaw) * cp;
      const rx = -Math.cos(this.freeYaw);
      const rz = Math.sin(this.freeYaw);
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 220 : 80;
      let mx = 0;
      let my = 0;
      let mz = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
        mx += fx;
        my += fy;
        mz += fz;
      }
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
        mx -= fx;
        my -= fy;
        mz -= fz;
      }
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
        mx += rx;
        mz += rz;
      }
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
        mx -= rx;
        mz -= rz;
      }
      if (this.keys.has('PageUp')) my += 1;
      if (this.keys.has('PageDown')) my -= 1;
      const ml = Math.hypot(mx, my, mz);
      if (ml > 0) {
        const s = (speed * dt) / ml;
        this.freePos.x += mx * s;
        this.freePos.y += my * s;
        this.freePos.z += mz * s;
      }
      this.clampFree(hf);
      this.goalPos.copy(this.freePos);
      this.lookTarget.set(this.freePos.x + fx * 20, this.freePos.y + fy * 20, this.freePos.z + fz * 20);
      this.focus.set(
        this.freePos.x + fx * 80,
        hf.height(this.freePos.x + fx * 80, this.freePos.z + fz * 80),
        this.freePos.z + fz * 80,
      );
      this.applyPose(cam, dt);
      return;
    }

    if (!t) {
      this.goalPos.set(200, 120, 260);
      this.lookTarget.set(0, hf.height(0, 0), 0);
      this.focus.copy(this.lookTarget);
      this.applyPose(cam, dt);
      return;
    }

    const head = sim.drawn(t);
    const fx = head.tx * head.dir;
    const fy = head.ty * head.dir;
    const fz = head.tz * head.dir;
    this.focus.set(head.x, head.y, head.z);

    if (this.mode === 'cab') {
      // Sits at the front of the leading vehicle, clear of its nose, whichever vehicle leads.
      let latOff = 0;
      let bobOff = 0;
      if (!reduced && t.speed > 0.2) {
        const back = sim.drawn(t, 12);
        const bx = back.tx * back.dir;
        const bz = back.tz * back.dir;
        const turn = bx * fz - bz * fx;
        const speedNorm = Math.min(1, t.speed / 30);
        const drawnOdom = t.odometer - t.speed * sim.drawnLag;
        const targetLat =
          Math.max(-0.04, Math.min(0.04, -turn * t.speed * t.speed * 0.0012)) +
          Math.sin(drawnOdom * 0.38) * 0.014 * speedNorm;
        this.cabLatSmooth += (targetLat - this.cabLatSmooth) * Math.min(1, dt * 8);
        latOff = this.cabLatSmooth;
        const jointPhase = Math.max(0, drawnOdom) % 18;
        const jointBob =
          jointPhase < 2.2 ? -0.02 * Math.exp(-jointPhase * 2.4) * Math.sin(jointPhase * 6.5) * speedNorm : 0;
        bobOff = jointBob + Math.sin(drawnOdom * 1.9) * 0.004 * speedNorm;
      } else {
        this.cabLatSmooth = 0;
      }
      const rx = -fz;
      const rz = fx;
      this.goalPos.set(head.x + fx * 0.3 + rx * latOff, head.y + 3.05 + bobOff, head.z + fz * 0.3 + rz * latOff);
      const l = Math.hypot(fx, fz) || 1;
      const a = Math.atan2(fx / l, fz / l) + this.cabYaw;
      this.lookTarget.set(
        this.goalPos.x + Math.sin(a) * 10,
        this.goalPos.y + Math.sin(this.cabPitch) * 10 + fy * 10,
        this.goalPos.z + Math.cos(a) * 10,
      );
      this.applyPose(cam, dt);
      return;
    }

    const mid = sim.drawn(t, Math.min(t.length * 0.3, 40));
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
      this.goalPos.copy(this.side);
      this.lookTarget.copy(this.target);
      this.applyPose(cam, dt);
      return;
    }

    if (this.mode === 'cinematic') {
      this.cineTimer += dt;
      if (!this.cineValid || this.cineTimer > 9.5 || this.cineSpot.distanceTo(this.target) > 280) {
        this.cineTimer = 0;
        this.cineCut++;
        const rx = -fz;
        const rz = fx;
        const sideSign = this.cineCut % 2 === 0 ? 1 : -1;
        const ahead = t.speed > 1.5 ? 110 + (this.cineCut % 3) * 45 : 55;
        const lat = sideSign * (18 + (this.cineCut % 4) * 9);
        const elev = [3.5, 11, 5.5, 18][this.cineCut % 4];
        const x = head.x + fx * ahead + rx * lat;
        const z = head.z + fz * ahead + rz * lat;
        const ground = Math.max(hf.height(x, z), WATER_LEVEL);
        this.cineSpot.set(x, Math.max(ground + 2.2, head.y + elev), z);
        const driftSign = this.cineCut % 3 === 0 ? -1 : 1;
        this.cineDrift.set(rx * sideSign * driftSign * 1.4 + fx * 1.2, 0, rz * sideSign * driftSign * 1.4 + fz * 1.2);
        this.cineValid = true;
      } else if (!reduced) {
        this.cineSpot.addScaledVector(this.cineDrift, dt);
        const floor = Math.max(hf.height(this.cineSpot.x, this.cineSpot.z), WATER_LEVEL) + 2.2;
        if (this.cineSpot.y < floor) this.cineSpot.y = floor;
      }
      this.goalPos.copy(this.cineSpot);
      this.lookTarget.copy(this.target);
      this.applyPose(cam, dt);
      return;
    }

    const cp = Math.cos(this.pitch);
    const desiredX = this.target.x + Math.sin(this.yaw) * cp * this.dist;
    const desiredY = this.target.y + Math.sin(this.pitch) * this.dist;
    const desiredZ = this.target.z + Math.cos(this.yaw) * cp * this.dist;
    if (!this.hasSmooth || reduced) {
      this.smooth.copy(this.target);
      this.hasSmooth = true;
    } else {
      this.smooth.lerp(this.target, 1 - Math.exp(-dt * 7));
    }
    const offX = desiredX - this.target.x;
    const offY = desiredY - this.target.y;
    const offZ = desiredZ - this.target.z;
    const cx = this.smooth.x + offX;
    const cz = this.smooth.z + offZ;
    this.goalPos.set(cx, Math.max(this.smooth.y + offY, hf.height(cx, cz) + 1.8), cz);
    this.lookTarget.copy(this.smooth);
    this.applyPose(cam, dt);
  }

  private applyPose(cam: THREE.PerspectiveCamera, dt: number) {
    this.lookMat.lookAt(this.goalPos, this.lookTarget, cam.up);
    this.goalQuat.setFromRotationMatrix(this.lookMat);
    const targetFov = this.mode === 'cab' ? this.cabFov : DEFAULT_FOV;
    const targetNear = this.mode === 'cab' ? 0.3 : 0.8;
    if (cam.near !== targetNear) {
      cam.near = targetNear;
      cam.updateProjectionMatrix();
    }
    if (this.transT < 1) {
      this.transT = Math.min(1, this.transT + dt / this.transDuration);
      const e = 1 - (1 - this.transT) ** 3;
      cam.position.lerpVectors(this.fromPos, this.goalPos, e);
      cam.quaternion.slerpQuaternions(this.fromQuat, this.goalQuat, e);
      const nextFov = this.fromFov + (targetFov - this.fromFov) * e;
      if (Math.abs(cam.fov - nextFov) > 0.01) {
        cam.fov = nextFov;
        cam.updateProjectionMatrix();
      }
      return;
    }
    cam.position.copy(this.goalPos);
    cam.quaternion.copy(this.goalQuat);
    if (cam.fov !== targetFov) {
      cam.fov = targetFov;
      cam.updateProjectionMatrix();
    }
  }
}
