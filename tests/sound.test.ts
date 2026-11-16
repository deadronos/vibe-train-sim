import { describe, expect, it } from 'vitest';

import { DEFAULT_SOUND } from '../src/audio';
import { parseSound } from '../src/persistence';

describe('sound settings', () => {
  it('uses the defaults when nothing is saved', () => {
    expect(parseSound(null)).toEqual(DEFAULT_SOUND);
    expect(parseSound('loud')).toEqual(DEFAULT_SOUND);
  });

  it('keeps saved values', () => {
    const saved = { muted: true, volume: 0.3, engine: 0, rail: 0.5, horn: 1 };
    expect(parseSound(saved)).toEqual(saved);
  });

  it('replaces only the values that are missing or out of range', () => {
    const s = parseSound({ muted: 'yes', volume: 4, engine: -1, rail: 0.2 });
    expect(s).toEqual({ ...DEFAULT_SOUND, rail: 0.2 });
  });
});
