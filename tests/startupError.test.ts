import { describe, expect, it } from 'vitest';

import { AssetLoadError, describeStartupError, NoWebGLError } from '../src/startupError';

describe('describeStartupError', () => {
  it('explains missing WebGL without developer advice', () => {
    const r = describeStartupError(new NoWebGLError(), false);
    expect(r.failure).toBe('no-webgl');
    expect(r.text).toMatch(/3D view/);
    expect(r.text).not.toMatch(/npm/);
  });

  it('treats a renderer constructor failure as no WebGL', () => {
    expect(describeStartupError(new Error('Error creating WebGL context.'), false).failure).toBe('no-webgl');
  });

  it('explains a failed download without developer advice', () => {
    const r = describeStartupError(new AssetLoadError(new Error('404')), false);
    expect(r.failure).toBe('download');
    expect(r.text).toMatch(/connection/);
    expect(r.text).not.toMatch(/npm|404/);
  });

  it('gives other errors a plain message and keeps the detail for dev builds only', () => {
    const err = new TypeError('boom');
    expect(describeStartupError(err, false).text).not.toMatch(/boom/);
    expect(describeStartupError(err, true).text).toMatch(/boom/);
  });

  it('shows the npm hint for a failed download in dev builds only', () => {
    const err = new AssetLoadError(new Error('404'));
    expect(describeStartupError(err, true).text).toMatch(/npm run assets/);
    expect(describeStartupError(err, false).text).not.toMatch(/npm run assets/);
  });
});
