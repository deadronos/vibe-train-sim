import { describe, expect, it } from 'vitest';

import { activatesFocused, gameKeyAllowed, type KeyContext } from '../src/keyFilter';

const base: KeyContext = {
  tag: 'BODY',
  inputType: '',
  editable: false,
  dialogOpen: false,
  modifier: false,
  code: 'KeyW',
};
const ctx = (o: Partial<KeyContext>): KeyContext => ({ ...base, ...o });

describe('gameKeyAllowed', () => {
  it('accepts plain keys on the page', () => {
    expect(gameKeyAllowed(base)).toBe(true);
  });
  it('ignores keys while a dialog is open', () => {
    expect(gameKeyAllowed(ctx({ dialogOpen: true }))).toBe(false);
    expect(gameKeyAllowed(ctx({ dialogOpen: true, code: 'KeyE' }))).toBe(false);
  });
  it('ignores browser shortcuts such as Cmd+R', () => {
    expect(gameKeyAllowed(ctx({ modifier: true, code: 'KeyR' }))).toBe(false);
  });
  it('ignores text fields, selects and editable content', () => {
    expect(gameKeyAllowed(ctx({ tag: 'INPUT', inputType: 'text' }))).toBe(false);
    expect(gameKeyAllowed(ctx({ tag: 'INPUT', inputType: 'number', code: 'Backspace' }))).toBe(false);
    expect(gameKeyAllowed(ctx({ tag: 'SELECT', code: 'Backspace' }))).toBe(false);
    expect(gameKeyAllowed(ctx({ editable: true }))).toBe(false);
  });
  it('lets driving keys through a focused range input but not its arrow keys', () => {
    expect(gameKeyAllowed(ctx({ tag: 'INPUT', inputType: 'range', code: 'KeyW' }))).toBe(true);
    expect(gameKeyAllowed(ctx({ tag: 'INPUT', inputType: 'range', code: 'ArrowUp' }))).toBe(false);
  });
});

describe('activatesFocused', () => {
  it('flags Space on a button only', () => {
    expect(activatesFocused({ tag: 'BUTTON', code: 'Space' })).toBe(true);
    expect(activatesFocused({ tag: 'BUTTON', code: 'KeyW' })).toBe(false);
    expect(activatesFocused({ tag: 'BODY', code: 'Space' })).toBe(false);
  });
});
