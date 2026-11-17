import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

function assetPackHash() {
  try {
    return createHash('sha256').update(readFileSync('public/assets/assetpack.glb')).digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base: './',
  define: {
    __ASSETPACK_HASH__: JSON.stringify(assetPackHash()),
  },
  build: { chunkSizeWarningLimit: 1200 },
});
