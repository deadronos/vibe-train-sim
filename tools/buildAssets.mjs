import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function onPath(name, envPath = process.env.PATH ?? '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Finds Blender from `BLENDER`, common per-platform install paths, or `PATH`. */
export function findBlender(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (env.BLENDER) return env.BLENDER;

  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Blender.app/Contents/MacOS/Blender',
      path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'),
    );
  } else if (platform === 'win32') {
    const base = 'C:\\Program Files\\Blender Foundation';
    if (exists(base)) {
      for (const entry of fs.readdirSync(base).sort().reverse()) {
        candidates.push(path.join(base, entry, 'blender.exe'));
      }
    }
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }

  for (const p of candidates) if (exists(p)) return p;
  return onPath(platform === 'win32' ? 'blender.exe' : 'blender', env.PATH);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const blender = findBlender();
  if (!blender) {
    console.error('Blender was not found. Set BLENDER=/path/to/blender and run npm run assets again.');
    process.exit(1);
  }
  execFileSync(blender, ['--background', '--factory-startup', '--python', 'tools/blender/build_assetpack.py'], {
    stdio: 'inherit',
  });
}
