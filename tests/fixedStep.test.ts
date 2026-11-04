import { describe, expect, it } from 'vitest';

import { buildDemoNetwork, populateDemoTrains, SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim, STEP, Train } from '../src/rail/sim';
import { Heightfield } from '../src/world/heightfield';

function starter() {
  const hf = new Heightfield('alpine', 1);
  const { net, stations } = buildDemoNetwork(hf);
  const sim = new Sim(net);
  populateDemoTrains(sim, stations);
  return sim;
}

const state = (sim: Sim) => sim.trains.map((t) => ({ headS: t.headS, speed: t.speed, seg: t.trail.at(-1)!.seg }));

function runTo(sim: Sim, steps: number, frame: number) {
  while (sim.steps < steps) sim.update(frame);
}

describe('fixed simulation step', () => {
  it('gives the same results at 30 and 144 fps', () => {
    const a = starter();
    const b = starter();
    runTo(a, 3000, 1 / 30);
    runTo(b, 3000, 1 / 144);
    expect(state(b)).toEqual(state(a));
  });

  it('gives the same results with uneven frames', () => {
    const a = starter();
    const b = starter();
    const frames = [0.004, 0.09, 0.02, 0.2, 0.011];
    runTo(a, 1500, 1 / 60);
    for (let i = 0; b.steps < 1500; i++) b.update(frames[i % frames.length]);
    // The last frame can pay for several steps, so run the first train forward to the same step.
    expect(b.steps).toBeGreaterThanOrEqual(1500);
    runTo(a, b.steps, STEP);
    expect(state(b)).toEqual(state(a));
  });

  it('keeps real time at a low frame rate', () => {
    const sim = starter();
    for (let i = 0; i < 40; i++) sim.update(0.25); // 4 fps for 10 seconds
    expect(sim.steps).toBeGreaterThanOrEqual(299);
    expect(sim.steps).toBeLessThanOrEqual(301);
  });

  it('runs no steps while paused', () => {
    const sim = starter();
    sim.update(1);
    const before = JSON.stringify(state(sim));
    const steps = sim.steps;
    for (let i = 0; i < 100; i++) sim.update(0);
    expect(sim.steps).toBe(steps);
    expect(JSON.stringify(state(sim))).toBe(before);
  });

  it('runs faster when given more time per frame, in the same steps', () => {
    const normal = starter();
    const fast = starter();
    for (let i = 0; i < 60; i++) {
      normal.update(1 / 60);
      fast.update((1 / 60) * 8);
    }
    expect(fast.steps).toBeGreaterThanOrEqual(normal.steps * 7.9);
    runTo(normal, fast.steps, STEP);
    expect(state(fast)).toEqual(state(normal));
  });

  it('caps the work in one update and drops what it cannot catch up on', () => {
    const sim = starter();
    sim.update(1000);
    expect(sim.steps).toBeLessThan(100);
    const steps = sim.steps;
    sim.update(0);
    expect(sim.steps).toBe(steps);
  });
});

describe('drawing between steps', () => {
  function moving() {
    const net = new Network();
    const a = net.addNode(0, 10, 0, 1, 0);
    const b = net.addNode(4000, 10, 0, 1, 0);
    const seg = net.addSegment(a.id, 1, b.id, -1);
    const sim = new Sim(net);
    const t = new Train(1, 'T', SHUTTLE());
    t.ai = false;
    sim.trains.push(t);
    sim.place(t, seg.id, 500, 1);
    t.speed = 30;
    return { sim, t };
  }

  it('moves a drawn train evenly at 144 fps, though the simulation moves in larger steps', () => {
    const { sim, t } = moving();
    const moves: number[] = [];
    let last = sim.drawn(t).x;
    for (let i = 0; i < 300; i++) {
      sim.update(1 / 144);
      const x = sim.drawn(t).x;
      moves.push(x - last);
      last = x;
    }
    const expected = 30 / 144;
    for (const m of moves) expect(Math.abs(m - expected)).toBeLessThan(expected * 0.2);
  });

  it('draws a stopped train exactly where it is', () => {
    const { sim, t } = moving();
    t.speed = 0;
    sim.update(STEP / 2);
    expect(sim.drawn(t).x).toBe(sim.head(t).x);
  });
});
