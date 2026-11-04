import { describe, expect, it } from 'vitest';

import { DriverInput } from '../src/driverInput';
import { SHUTTLE } from '../src/rail/demoMap';
import { Train } from '../src/rail/sim';

const train = () => new Train(1, 'T', SHUTTLE());

describe('driver input', () => {
  it('opens the throttle while the power key is held and leaves it when released', () => {
    const input = new DriverInput();
    const t = train();
    input.press('KeyW');
    input.drive(t, 1);
    expect(t.throttle).toBeCloseTo(0.55);
    input.release('KeyW');
    input.drive(t, 1);
    expect(t.throttle).toBeCloseTo(0.55);
    expect(t.brake).toBe(0);
  });

  it('turns a negative lever into brake and clamps both ends', () => {
    const input = new DriverInput();
    const t = train();
    input.press('ArrowDown');
    input.drive(t, 10);
    expect(input.lever).toBe(-1);
    expect(t.throttle).toBe(0);
    expect(t.brake).toBe(1);
    expect(t.dynamic).toBe(1);
    input.releaseAll();
    input.press('ArrowUp');
    input.drive(t, 10);
    expect(input.lever).toBe(1);
  });

  it('applies the emergency brake on Space without moving the lever', () => {
    const input = new DriverInput();
    const t = train();
    input.lever = 0.5;
    input.press('Space');
    input.drive(t, 1);
    expect(t.emergency).toBe(true);
    expect(input.lever).toBe(0.5);
    expect(input.movingLever).toBe(false);
    input.release('Space');
    input.drive(t, 1);
    expect(t.emergency).toBe(false);
  });

  it('uses the engine brake alone for the first part of the brake side', () => {
    const input = new DriverInput();
    const t = train();
    input.lever = -0.125;
    input.drive(t, 0);
    expect(t.dynamic).toBeCloseTo(0.5);
    expect(t.brake).toBe(0);
    input.lever = -0.625;
    input.drive(t, 0);
    expect(t.dynamic).toBe(1);
    expect(t.brake).toBeCloseTo(0.5);
  });

  it('forgets held keys on release all, as when the window loses focus', () => {
    const input = new DriverInput();
    input.press('KeyS');
    expect(input.movingLever).toBe(true);
    input.releaseAll();
    expect(input.movingLever).toBe(false);
  });
});
