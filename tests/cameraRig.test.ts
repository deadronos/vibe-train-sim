import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDemoNetwork, populateDemoTrains } from '../src/rail/demoMap';
import { Sim } from '../src/rail/sim';
import { CAB_FOV_MAX, CAB_FOV_MIN, CAM_LABEL, CameraRig, clampCabFov, DEFAULT_FOV } from '../src/render/cameraRig';
import { Heightfield } from '../src/world/heightfield';

function makeDomStub() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    setPointerCapture() {},
    dispatch(type: string, e: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
}

function makeRig(reducedMotion = false) {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: reducedMotion }),
  });
  const cam = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.8, 10000);
  const dom = makeDomStub();
  const rig = new CameraRig(cam, dom as unknown as HTMLElement, () => true);
  return { cam, dom, rig };
}

describe('CameraRig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cycles through all five camera modes including cinematic and free', () => {
    const { rig } = makeRig();
    const seen = [rig.mode];
    for (let i = 0; i < 4; i++) {
      rig.cycle();
      seen.push(rig.mode);
    }
    expect(seen).toEqual(['chase', 'cab', 'trackside', 'cinematic', 'free']);
    for (const m of seen) expect(CAM_LABEL[m]).toBeTruthy();
    rig.cycle();
    expect(rig.mode).toBe('chase');
  });

  it('clamps cab FOV on wheel zoom and restores default FOV outside cab view', () => {
    expect(clampCabFov(5)).toBe(CAB_FOV_MIN);
    expect(clampCabFov(120)).toBe(CAB_FOV_MAX);

    const { cam, dom, rig } = makeRig(true);
    const hf = new Heightfield('plains', 1);
    const { net, stations } = buildDemoNetwork(hf);
    const sim = new Sim(net);
    populateDemoTrains(sim, stations);
    const train = sim.trains[0];

    rig.setMode('cab');
    dom.dispatch('wheel', { deltaY: -5000 });
    expect(rig.cabFov).toBe(CAB_FOV_MIN);
    rig.update(sim, train, hf, 0.016);
    expect(cam.fov).toBe(CAB_FOV_MIN);

    dom.dispatch('wheel', { deltaY: 5000 });
    expect(rig.cabFov).toBe(CAB_FOV_MAX);
    rig.update(sim, train, hf, 0.016);
    expect(cam.fov).toBe(CAB_FOV_MAX);

    rig.setMode('chase');
    rig.update(sim, train, hf, 0.016);
    expect(cam.fov).toBe(DEFAULT_FOV);
  });

  it('eases smoothly between camera positions and skips easing under reduced motion', () => {
    const hf = new Heightfield('plains', 1);
    const { net, stations } = buildDemoNetwork(hf);
    const sim = new Sim(net);
    populateDemoTrains(sim, stations);
    const train = sim.trains[0];

    // Normal motion: easing starts near previous position and finishes after transition duration.
    const normal = makeRig(false);
    normal.rig.update(sim, train, hf, 0.016);
    const chasePos = normal.cam.position.clone();
    normal.rig.setMode('cab');
    normal.rig.update(sim, train, hf, 0.05);
    const midDist = normal.cam.position.distanceTo(chasePos);
    normal.rig.update(sim, train, hf, 1.0);
    const endDist = normal.cam.position.distanceTo(chasePos);
    expect(midDist).toBeGreaterThan(0.1);
    expect(midDist).toBeLessThan(endDist);

    // Reduced motion: snaps immediately on the very first frame after mode change.
    const reduced = makeRig(true);
    reduced.rig.update(sim, train, hf, 0.016);
    reduced.rig.setMode('cab');
    reduced.rig.update(sim, train, hf, 0.016);
    const snapPos = reduced.cam.position.clone();
    reduced.rig.update(sim, train, hf, 1.0);
    expect(reduced.cam.position.distanceTo(snapPos)).toBeLessThan(1e-6);
  });

  it('flies free camera in 3D space above terrain even without a driven train', () => {
    const { cam, rig } = makeRig(true);
    const hf = new Heightfield('plains', 1);
    const net = buildDemoNetwork(hf).net;
    const sim = new Sim(net);

    rig.setMode('free');
    rig.freePos.set(0, 100, 0);
    rig.freeYaw = 0;
    rig.freePitch = 0;
    rig.update(sim, null, hf, 0.016);
    const startZ = cam.position.z;

    rig.press('KeyW');
    rig.update(sim, null, hf, 0.5);
    expect(cam.position.z).toBeGreaterThan(startZ + 20);
    rig.releaseKeys();
  });
});
