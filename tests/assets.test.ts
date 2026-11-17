// @ts-expect-error -- Vitest runs in Node; tsconfig keeps browser-only types so runtime code stays clean.
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VEHICLES } from '../src/rail/vehicles';
import { SCENERY_TYPES } from '../src/world/scenery';
// @ts-expect-error -- Small build helper in tools/ stays plain Node ESM without a .d.ts file.
import { findBlender } from '../tools/buildAssets.mjs';

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; children?: number[] }[];
  materials?: { name?: string }[];
}

function readGlbJson(fileUrl: URL): GltfJson {
  const bytes: Uint8Array = fs.readFileSync(fileUrl);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  expect(view.getUint32(4, true)).toBe(2);
  const jsonLen = view.getUint32(12, true);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen));
  return JSON.parse(text) as GltfJson;
}

describe('assetpack.glb contract', () => {
  const glb = readGlbJson(new URL('../public/assets/assetpack.glb', import.meta.url));
  const nodes = glb.nodes ?? [];
  const rootIndices = glb.scenes?.[glb.scene ?? 0]?.nodes ?? [];
  const rootNames = new Set(rootIndices.map((i) => nodes[i]?.name).filter((n): n is string => Boolean(n)));

  it('includes every vehicle, scenery, track and prop model named in code', () => {
    const required = [
      ...Object.keys(VEHICLES),
      ...Object.keys(SCENERY_TYPES),
      'tree_pine_lod1',
      'tree_pine_lod2',
      'tree_oak_lod1',
      'tree_oak_lod2',
      'tree_birch_lod1',
      'tree_birch_lod2',
      'bogie',
      'cab_interior',
      'pier',
      'abutment',
      'signal_mast',
      'switch_stand',
      'buffer_stop',
      'platform',
      'station_building',
      'shelter',
      'lamp_post',
    ];
    for (const name of required) {
      expect(rootNames.has(name), `missing root asset "${name}"`).toBe(true);
    }
  });

  it('keeps the separate signal lamp meshes on signal_mast', () => {
    const mastIndex = rootIndices.find((i) => nodes[i]?.name === 'signal_mast');
    expect(mastIndex).toBeDefined();
    const seen = new Set<string>();
    const visit = (idx: number) => {
      const n = nodes[idx];
      if (!n) return;
      if (n.name) seen.add(n.name);
      for (const child of n.children ?? []) visit(child);
    };
    visit(mastIndex!);
    for (const lamp of ['lamp_red', 'lamp_amber', 'lamp_green']) {
      expect(seen.has(lamp), `missing "${lamp}" on signal_mast`).toBe(true);
    }
  });

  it('keeps separate wheelsets on bogie and animated controls on cab_interior', () => {
    const collectChildren = (rootName: string) => {
      const idx = rootIndices.find((i) => nodes[i]?.name === rootName);
      expect(idx, `missing root "${rootName}"`).toBeDefined();
      const seen = new Set<string>();
      const visit = (i: number) => {
        const n = nodes[i];
        if (!n) return;
        if (n.name) seen.add(n.name);
        for (const c of n.children ?? []) visit(c);
      };
      visit(idx!);
      return seen;
    };

    const bogieParts = collectChildren('bogie');
    expect(bogieParts.has('wheelset_front')).toBe(true);
    expect(bogieParts.has('wheelset_rear')).toBe(true);

    const cabParts = collectChildren('cab_interior');
    expect(cabParts.has('cab_dial_needle')).toBe(true);
    expect(cabParts.has('cab_lever')).toBe(true);
  });

  it('includes every glow_* night-lighting material', () => {
    const materials = new Set((glb.materials ?? []).map((m) => m.name).filter((n): n is string => Boolean(n)));
    for (const mat of ['glow_window', 'glow_cab', 'glow_headlight', 'glow_tail', 'glow_lamp']) {
      expect(materials.has(mat), `missing material "${mat}"`).toBe(true);
    }
  });
});

describe('findBlender', () => {
  it('prefers the BLENDER environment variable when set', () => {
    expect(findBlender({ BLENDER: '/custom/blender' }, 'linux', () => false)).toBe('/custom/blender');
  });

  it('falls back to the platform default path when present', () => {
    expect(findBlender({}, 'darwin', (p: string) => p === '/Applications/Blender.app/Contents/MacOS/Blender')).toBe(
      '/Applications/Blender.app/Contents/MacOS/Blender',
    );
    expect(findBlender({}, 'linux', (p: string) => p === '/usr/bin/blender')).toBe('/usr/bin/blender');
  });
});
