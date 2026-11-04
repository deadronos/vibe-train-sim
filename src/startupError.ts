// Player-facing messages for start-up failures. No Three.js or DOM, so the wording can be tested.

export type StartupFailure = 'no-webgl' | 'download' | 'other';

/** Raised before any WebGL work when the browser can't give us a context. */
export class NoWebGLError extends Error {
  constructor() {
    super('WebGL is not available');
  }
}

/** Raised when the asset pack can't be fetched or read. */
export class AssetLoadError extends Error {
  constructor(cause: unknown) {
    super('The asset pack failed to load', { cause });
  }
}

export function classifyStartupError(err: unknown): StartupFailure {
  if (err instanceof NoWebGLError) return 'no-webgl';
  if (err instanceof AssetLoadError) return 'download';
  // Three.js reports a refused context as a plain Error mentioning WebGL.
  if (err instanceof Error && /webgl|rendering context/i.test(err.message)) return 'no-webgl';
  return 'other';
}

export function describeStartupError(err: unknown, dev: boolean): { failure: StartupFailure; text: string } {
  const failure = classifyStartupError(err);
  let text: string;
  if (failure === 'no-webgl') {
    text =
      'This browser cannot draw the 3D view. Turn on hardware acceleration in the browser settings, or open the game in a recent Chrome, Firefox, Safari or Edge, then reload the page.';
  } else if (failure === 'download') {
    text = 'The game files did not download. Check your connection, then reload the page.';
  } else {
    text = 'The game could not start. Reload the page. If this keeps happening, try another browser.';
  }
  if (dev) {
    const detail = err instanceof Error ? err.message : String(err);
    text += ` [dev: ${detail}${failure === 'download' ? '. Run npm run assets if public/assets/assetpack.glb is missing' : ''}]`;
  }
  return { failure, text };
}

export const CONTEXT_LOST_TEXT =
  'The graphics card stopped the 3D view, so the game paused. Your map is saved in this browser. Reload the page to carry on.';

export const SAVE_RECOVERED_TEXT =
  'Your saved map could not be read, so a new map was started. The old data is kept in this browser as a backup.';
