// Decides whether a key press belongs to the game. Kept free of the DOM so
// the rules can be tested; `gameKey()` below reads the real event.

export interface KeyContext {
  /** Tag name of the focused element, upper case, or '' for none. */
  tag: string;
  /** Input type for an INPUT element, such as 'range' or 'text'. */
  inputType: string;
  editable: boolean;
  dialogOpen: boolean;
  modifier: boolean;
  code: string;
}

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'password', 'tel']);
// Keys a focused slider uses itself, so the game must leave them alone.
const SLIDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function gameKeyAllowed(c: KeyContext): boolean {
  if (c.dialogOpen || c.modifier || c.editable) return false;
  if (c.tag === 'SELECT' || c.tag === 'TEXTAREA') return false;
  if (c.tag === 'INPUT') {
    if (TEXT_INPUTS.has(c.inputType)) return false;
    if (c.inputType === 'range') return !SLIDER_KEYS.has(c.code);
  }
  return true;
}

/** A focused button or link would be activated by Space or Enter. */
export function activatesFocused(c: Pick<KeyContext, 'tag' | 'code'>): boolean {
  return c.code === 'Space' && (c.tag === 'BUTTON' || c.tag === 'A' || c.tag === 'SUMMARY');
}

export function keyContext(e: KeyboardEvent): KeyContext {
  const el = e.target instanceof HTMLElement ? e.target : null;
  return {
    tag: el?.tagName ?? '',
    inputType: el instanceof HTMLInputElement ? el.type : '',
    editable: !!el?.isContentEditable,
    dialogOpen: !!document.querySelector('dialog[open]'),
    modifier: e.ctrlKey || e.metaKey || e.altKey,
    code: e.code,
  };
}

export function gameKey(e: KeyboardEvent): boolean {
  return gameKeyAllowed(keyContext(e));
}
