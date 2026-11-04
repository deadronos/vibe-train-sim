import { describe, expect, it } from 'vitest';

import { History } from '../src/history';

describe('history', () => {
  it('has nothing to undo or redo at first', () => {
    const h = new History();
    expect(h.undo('now')).toBeNull();
    expect(h.redo('now')).toBeNull();
  });

  it('walks back and forward through states', () => {
    const h = new History();
    h.push('a');
    h.push('b');
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe('a');
    expect(h.undo('a')).toBeNull();
    expect(h.redo('a')).toBe('b');
    expect(h.redo('b')).toBe('c');
    expect(h.redo('c')).toBeNull();
  });

  it('abandons redo after a new edit', () => {
    const h = new History();
    h.push('a');
    h.undo('b');
    h.push('a2');
    expect(h.redo('now')).toBeNull();
  });

  it('keeps only the most recent 40 states', () => {
    const h = new History();
    for (let i = 0; i < 45; i++) h.push(String(i));
    const seen: string[] = [];
    for (let s = h.undo('now'); s !== null; s = h.undo('now')) seen.push(s);
    expect(seen).toHaveLength(40);
    expect(seen[0]).toBe('44');
    expect(seen.at(-1)).toBe('5');
  });

  it('clears both stacks', () => {
    const h = new History();
    h.push('a');
    h.undo('b');
    h.push('c');
    h.clear();
    expect(h.undo('now')).toBeNull();
    expect(h.redo('now')).toBeNull();
  });
});
