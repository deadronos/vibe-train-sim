// Checks that the built site starts and works. Looks at console output and game state, not pixels,
// because screenshots are too fragile on software GL. Shader errors reach the console when they first draw.
import type { Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import type { Game } from '../src/game';
import type { Preset } from '../src/world/heightfield';

declare global {
  interface Window {
    __game: Game;
    __readTrainAudio?: () => { left: number; right: number; minPitch: number; maxPitch: number };
  }
}

const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

async function load(page: Page, quality: 'high' | 'low' = 'low') {
  await page.addInitScript((q) => localStorage.setItem('vibe-train-sim/quality', q), quality);
  await page.goto('/');
  await expect(page.locator('#loading')).toHaveClass(/gone/);
}

/** Waits for whole frames, so anything newly on screen has been compiled and drawn. */
const frames = (page: Page, n = 3) =>
  page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
        step(count);
      }),
    n,
  );

test('starts at high quality and draws without errors', async ({ page }) => {
  await load(page, 'high');
  await frames(page);
  await expect(page.locator('#loading')).not.toHaveClass(/failed/);
  expect(await page.evaluate(() => window.__game.sim.trains.length)).toBeGreaterThan(0);
});

test('trains move', async ({ page }) => {
  await load(page);
  const positions = () =>
    page.evaluate(() => {
      const { sim } = window.__game;
      return sim.trains.map((t) => {
        const h = sim.head(t);
        return [h.x, h.z];
      });
    });
  const start = await positions();
  await expect
    .poll(async () => {
      const now = await positions();
      return Math.max(...now.map(([x, z], i) => Math.hypot(x - start[i][0], z - start[i][1])));
    })
    .toBeGreaterThan(1);
});

test('a train pans and shifts pitch while running in the editor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const rates: AudioParam[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- The wrapper forwards the original receiver with call.
    const createBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (this: AudioContext) {
      const source = createBufferSource.call(this);
      rates.push(source.playbackRate);
      return source;
    };
    // oxlint-disable-next-line typescript/unbound-method -- Each native call gets its receiver through Reflect.apply.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, target: AudioNode | AudioParam, ...channels: number[]) {
      if (target instanceof AudioDestinationNode) {
        const splitter = this.context.createChannelSplitter(2);
        const meters = [this.context.createAnalyser(), this.context.createAnalyser()];
        Reflect.apply(connect, this, [splitter]);
        meters.forEach((meter, channel) => Reflect.apply(connect, splitter, [meter, channel, 0]));
        const samples = new Float32Array(meters[0].fftSize);
        const rms = (meter: AnalyserNode) => {
          meter.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        };
        window.__readTrainAudio = () => ({
          left: rms(meters[0]),
          right: rms(meters[1]),
          minPitch: Math.min(...rates.map((rate) => rate.value)),
          maxPitch: Math.max(...rates.map((rate) => rate.value)),
        });
      }
      return Reflect.apply(connect, this, [target, ...channels]);
    };
  });
  await load(page);
  await page.locator('#mode-edit').click();
  await page.locator('[data-tool="train"]').click();
  await page.evaluate(() => {
    const g = window.__game;
    g.setSound({ ambience: 0 });
    const train = g.sim.trains[0];
    g.newWorld('plains', 1, false);
    const y = g.hf.height(0, 0) + 5;
    const a = g.net.addNode(-450, y, 0, 1, 0);
    const b = g.net.addNode(450, y, 0, 1, 0);
    const segment = g.net.addSegment(a.id, 1, b.id, -1);
    g.commitEdit();
    g.addTrain(train, segment.id, 820, -1);
    train.ai = false;
    train.speed = 24;
    g.editor.controls.target.set(0, y, 0);
    g.camera.position.set(0, y + 8, 35);
    g.editor.controls.update();
  });

  const read = () => page.evaluate(() => window.__readTrainAudio!());
  const peak = async () => {
    const { left, right } = await read();
    return Math.max(left, right);
  };
  const placeTrain = (distance: number) =>
    page.evaluate((s) => {
      const { sim } = window.__game;
      const train = sim.trains[0];
      sim.place(train, sim.head(train).seg, s, -1);
      train.speed = 24;
    }, distance);
  await expect.poll(peak).toBeLessThan(0.0001);
  await page.locator('#run-trains').check();
  await expect.poll(peak).toBeLessThan(0.0001);

  await placeTrain(485);
  await expect
    .poll(async () => {
      const { left, right, maxPitch } = await read();
      return right > 0.001 && right > left * 1.5 && maxPitch > 1.02;
    })
    .toBe(true);

  await placeTrain(375);
  await expect
    .poll(async () => {
      const { left, right, minPitch } = await read();
      return left > 0.001 && left > right * 1.5 && minPitch < 0.98;
    })
    .toBe(true);
  await page.locator('#run-trains').uncheck();
  await expect.poll(peak).toBeLessThan(0.0001);
});

test('plays gentle world ambience when stopped and responds to ambience setting', async ({ page }) => {
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- Forward receiver with Reflect.apply.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, target: AudioNode | AudioParam, ...channels: number[]) {
      if (target instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        Reflect.apply(connect, this, [analyser]);
        const samples = new Float32Array(analyser.fftSize);
        window.__readTrainAudio = () => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
          return { left: rms, right: rms, minPitch: 1, maxPitch: 1 };
        };
      }
      return Reflect.apply(connect, this, [target, ...channels]);
    };
  });
  await load(page);
  await page.mouse.click(400, 300);
  await page.evaluate(() => {
    const g = window.__game;
    g.setSound({ engine: 0, rail: 0, horn: 0, ambience: 1 });
    g.setTrainSpeed(0);
    g.env.hours = 12;
    g.audio.playDoorChime('open', 1);
    g.audio.playLeverClunk('points', 1);
  });
  await expect.poll(() => page.evaluate(() => window.__readTrainAudio!().left)).toBeGreaterThan(0.0005);

  await page.locator('#btn-menu').click();
  await page.locator('#btn-sound').click();
  const ambSlider = page.locator('#sound-ambience');
  await expect(ambSlider).toBeVisible();
  await page.evaluate(() => {
    const g = window.__game;
    g.env.hours = 23.5;
    g.setSound({ ambience: 0 });
  });
  await expect.poll(() => page.evaluate(() => window.__readTrainAudio!().left)).toBeLessThan(0.0002);
  await page.locator('#dlg-sound button[value="ok"]').click();
});

test('pauses and fast-forwards the railway', async ({ page }) => {
  await load(page);
  const position = () => page.evaluate(() => window.__game.sim.steps);
  await page.locator('[data-speed="0"]').click();
  await frames(page);
  const paused = await position();
  await frames(page, 10);
  expect(await position()).toBe(paused);
  await page.locator('[data-speed="8"]').click();
  await expect.poll(position).toBeGreaterThan(paused + 30);
  await page.keyboard.press('Comma');
  expect(await page.evaluate(() => window.__game.trainSpeed)).toBe(4);
});

test('lays a section of track in the editor, then undoes and redoes it', async ({ page }) => {
  await load(page);
  await page.evaluate(() => window.__game.newWorld('plains', 1, false));
  await page.locator('#mode-edit').click();
  await page.locator('[data-tool="track"]').click();
  await frames(page);

  const segs = () => page.evaluate(() => window.__game.net.segs.size);
  expect(await segs()).toBe(0);
  // A gentle stretch of this map at the starting camera; the editor refuses anything steeper than 7%.
  await page.mouse.click(420, 300);
  await page.mouse.move(620, 300);
  await frames(page);
  await page.mouse.click(620, 300);
  await expect.poll(segs).toBe(1);
  await page.keyboard.press('Escape');

  await page.locator('#btn-undo').click();
  await expect.poll(segs).toBe(0);
  await page.locator('#btn-redo').click();
  await expect.poll(segs).toBe(1);
  await frames(page);

  await page.locator('#mode-drive').click();
  await frames(page);
});

test('editor tool panels update controls in place without dropping focus', async ({ page }) => {
  await load(page);
  await page.locator('#mode-edit').click();
  await page.locator('[data-tool="terrain"]').click();
  await frames(page);

  const lowerBtn = page.locator('#brush-modes button[data-mode="lower"]');
  await lowerBtn.focus();
  await page.keyboard.press('Enter');
  await expect(lowerBtn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-mode'))).toBe('lower');

  await page.locator('[data-tool="select"]').click();
  await frames(page);
  const selH = page.locator('#sel-h');
  await page.evaluate(() => {
    const g = window.__game;
    const first = g.net.nodes.keys().next().value;
    if (first !== undefined) {
      g.editor.selected = first;
      g.hud.syncEditor();
    }
  });
  await expect(selH).toBeVisible();
  const initialY = await page.locator('#sel-y').textContent();
  await selH.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#sel-y')).not.toHaveText(initialY ?? '');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('sel-h');

  await page.locator('[data-tool="track"]').click();
  await frames(page);
  const heightSlider = page.locator('#height');
  const initialOffset = await page.locator('#height-val').textContent();
  await heightSlider.focus();
  await page.keyboard.press('BracketRight');
  await expect(page.locator('#height-val')).not.toHaveText(initialOffset ?? '');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('height');
});

test('driving keys take over from the autopilot and move the power lever', async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => window.__game.driven?.ai)).toBe(true);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => window.__game.driven?.ai)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__game.input.lever)).toBeGreaterThan(0.05);
  await expect.poll(() => page.locator('#power-lever').inputValue().then(Number)).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyW');

  await page.evaluate(() => window.__game.setLever(-0.6));
  await expect(page.locator('#train-text')).toHaveText('Air brake on');
  await page.keyboard.down('Space');
  await expect(page.locator('#train-text')).toHaveText('Emergency brake on');
  await page.keyboard.up('Space');
});

test('the map comes back after a reload', async ({ page }) => {
  await load(page);
  const summary = () =>
    page.evaluate(() => {
      const g = window.__game;
      return { preset: g.hf.preset, seed: g.hf.seed, segs: g.net.segs.size, trains: g.sim.trains.map((t) => t.name) };
    });
  await page.evaluate(() => window.__game.newWorld('desert', 4, true));
  await expect.poll(() => page.evaluate(() => window.__game.sim.trains.some((t) => t.speed > 1))).toBe(true);
  const before = await summary();
  await page.reload();
  await expect(page.locator('#loading')).toHaveClass(/gone/);
  expect(await summary()).toEqual(before);
});

for (const preset of ['alpine', 'plains', 'desert', 'islands'] satisfies Preset[]) {
  test(`loads the ${preset} landscape`, async ({ page }) => {
    await load(page);
    await page.evaluate((p) => window.__game.newWorld(p, 1, true), preset);
    await frames(page);
    expect(await page.evaluate(() => window.__game.hf.preset)).toBe(preset);
    expect(await page.evaluate(() => window.__game.sim.trains.length)).toBeGreaterThan(0);
  });
}

test('cycles all camera views, adjusts cab FOV, and flies free camera while trains run', async ({ page }) => {
  await load(page);
  const mode = () => page.evaluate(() => window.__game.rig.mode);
  expect(await mode()).toBe('chase');

  // Cab view + wheel FOV zoom
  await page.keyboard.press('KeyC');
  expect(await mode()).toBe('cab');
  await expect(page.locator('#btn-camera')).toHaveText('Cab view');
  const fovBefore = await page.evaluate(() => window.__game.rig.cabFov);
  await page.mouse.move(480, 300);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => page.evaluate(() => window.__game.rig.cabFov)).toBeLessThan(fovBefore);

  // Trackside -> Cinematic -> Free
  await page.keyboard.press('KeyC');
  expect(await mode()).toBe('trackside');
  await page.keyboard.press('KeyC');
  expect(await mode()).toBe('cinematic');
  await page.keyboard.press('KeyC');
  expect(await mode()).toBe('free');
  await expect(page.locator('#btn-camera')).toHaveText('Free view');

  // Free-fly keys move camera without turning off autopilot while trains keep moving.
  const freeBefore = await page.evaluate(() => window.__game.rig.freePos.toArray());
  const stepsBefore = await page.evaluate(() => window.__game.sim.steps);
  await page.keyboard.down('KeyW');
  await frames(page, 6);
  await page.keyboard.up('KeyW');
  const freeAfter = await page.evaluate(() => window.__game.rig.freePos.toArray());
  const moved = Math.hypot(freeAfter[0] - freeBefore[0], freeAfter[1] - freeBefore[1], freeAfter[2] - freeBefore[2]);
  expect(moved).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__game.driven?.ai)).toBe(true);
  expect(await page.evaluate(() => window.__game.sim.steps)).toBeGreaterThan(stepsBefore);
});

test('updates and persists separate shadow and scenery settings live', async ({ page }) => {
  await load(page);
  await page.locator('#btn-menu').click();
  await page.locator('#btn-graphics').click();
  await expect(page.locator('#dlg-graphics')).toBeVisible();

  await page.locator('#shadows').selectOption('off');
  await page.locator('#scenery').selectOption('off');
  await frames(page);
  expect(await page.evaluate(() => window.__game.renderer.shadowMap.enabled)).toBe(false);
  expect(await page.evaluate(() => window.__game.scatter.generated.length)).toBe(0);
  await page.locator('#dlg-graphics button[value="ok"]').click();

  await page.locator('#btn-menu').click();
  await page.locator('#btn-sound').click();
  await expect(page.locator('#dlg-sound')).toBeVisible();
  await page.locator('#sound-squeal').uncheck();
  await page.locator('#dlg-sound button[value="ok"]').click();

  await page.reload();
  await expect(page.locator('#loading')).toHaveClass(/gone/);
  expect(await page.evaluate(() => [window.__game.shadows, window.__game.scenery])).toEqual(['off', 'off']);
  expect(await page.evaluate(() => window.__game.renderer.shadowMap.enabled)).toBe(false);
  expect(await page.evaluate(() => window.__game.audio.settings.squeal)).toBe(false);
});

test('remove tool previews target, deletes one signal, and box-selects multiple tracks', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const g = window.__game;
    g.newWorld('plains', 1, false);
    const a = g.net.addNode(-90, 20, 0, 1, 0);
    const b = g.net.addNode(0, 20, 0, 1, 0);
    const c = g.net.addNode(90, 20, 0, 1, 0);
    g.net.addSegment(a.id, 1, b.id, -1);
    g.net.addSegment(b.id, 1, c.id, -1);
    b.signals[1] = { hold: false, type: 'main' };
    b.signals[-1] = { hold: false, type: 'distant' };
    g.commitEdit({ scenery: true });
  });
  await page.locator('#mode-edit').click();
  await page.locator('[data-tool="delete"]').click();
  // Wait for the smooth Drive -> Edit camera transition to finish before projecting screen coords.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const g = window.__game;
        const t = g.editor.controls.target;
        return Math.hypot(g.camera.position.x - (t.x + 200), g.camera.position.z - (t.z + 330));
      }),
    )
    .toBeLessThan(1);
  await frames(page);

  // Move pointer onto the side +1 signal post and verify hover status & single-signal removal.
  const sigPx = await page.evaluate(() => {
    const g = window.__game;
    const b = [...g.net.nodes.values()][1];
    return g.editor.project(b.x - 3, b.y, b.z + 2.9);
  });
  await page.mouse.move(sigPx.x, sigPx.y);
  await frames(page);
  await expect(page.locator('#status')).toContainText('main signal');
  await page.mouse.click(sigPx.x, sigPx.y);
  await frames(page);
  const sigsLeft = await page.evaluate(() => {
    const b = [...window.__game.net.nodes.values()][1];
    return [!!b.signals[1], !!b.signals[-1]];
  });
  expect(sigsLeft).toEqual([false, true]);

  // Box-drag across both track segments to remove them together.
  const bounds = await page.evaluate(() => {
    const g = window.__game;
    const pts = [...g.net.nodes.values()].map((n) => g.editor.project(n.x, n.y, n.z));
    return {
      x0: Math.min(...pts.map((p) => p.x)) - 25,
      y0: Math.min(...pts.map((p) => p.y)) - 25,
      x1: Math.max(...pts.map((p) => p.x)) + 25,
      y1: Math.max(...pts.map((p) => p.y)) + 25,
    };
  });
  await page.mouse.move(bounds.x0, bounds.y0);
  await page.mouse.down();
  await page.mouse.move(bounds.x1, bounds.y1, { steps: 6 });
  await expect(page.locator('#box-select')).toBeVisible();
  await expect(page.locator('#status')).toContainText('2 track sections');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__game.net.segs.size)).toBe(0);
});

test('keeps starter-map draw calls and triangles below budget and performs incremental edits cleanly', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('vibe-train-sim/quality', 'high'));
  await page.goto('/?debug');
  await expect(page.locator('#loading')).toHaveClass(/gone/);
  await frames(page, 6);

  const starter = await page.evaluate(() => {
    const g = window.__game;
    return {
      calls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      nodeRebuilds: g.props.stats.nodeRebuilds,
      signUpdates: g.props.stats.signUpdates,
    };
  });
  expect(starter.calls).toBeLessThan(285);
  expect(starter.triangles).toBeLessThan(335_000);

  // Throwing points must not rebuild any props nodes.
  await page.evaluate(() => {
    const g = window.__game;
    const junc = [...g.net.nodes.values()].find((n) => g.net.isJunction(n.id));
    if (junc) {
      const side = g.net.attached(junc.id, 1).length > 1 ? 1 : -1;
      g.net.throwSwitch(junc.id, side);
    }
  });
  await frames(page, 3);
  expect(await page.evaluate(() => window.__game.props.stats.nodeRebuilds)).toBe(starter.nodeRebuilds);

  // Renaming a station updates only the sign without rebuilding node props.
  await page.evaluate(() => {
    const g = window.__game;
    const st = g.net.stations[0];
    st.name = 'Newhaven';
    g.net.markStationRenamed(st.id);
  });
  await frames(page, 3);
  const afterRename = await page.evaluate(() => ({
    nodeRebuilds: window.__game.props.stats.nodeRebuilds,
    signUpdates: window.__game.props.stats.signUpdates,
  }));
  expect(afterRename.nodeRebuilds).toBe(starter.nodeRebuilds);
  expect(afterRename.signUpdates).toBe(starter.signUpdates + 1);

  // Placing one scenery item rebuilds only a single scatter region with zero procedural regens.
  const placeStats = await page.evaluate(() => {
    const g = window.__game;
    const regens0 = g.scatter.stats.regionRegens;
    const mesh0 = g.scatter.stats.regionMeshRebuilds;
    g.addPlacedScenery({ type: 'tree_pine', x: 50, z: 50, rot: 0, scale: 1 });
    g.scatter.sync(g.hf, g.net);
    return {
      regens: g.scatter.stats.regionRegens - regens0,
      meshes: g.scatter.stats.regionMeshRebuilds - mesh0,
    };
  });
  expect(placeStats).toEqual({ regens: 0, meshes: 1 });

  // Build a 500-segment network, run a local node move + terrain brush, and sweep camera without errors.
  const bigStats = await page.evaluate(() => {
    const g = window.__game;
    g.newWorld('plains', 2, false);
    const cols = 25;
    const rows = 20;
    const spacing = 110;
    const grid: ReturnType<typeof g.net.addNode>[][] = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c <= cols; c++) {
        const x = (c - cols / 2) * spacing;
        const z = (r - rows / 2) * spacing;
        row.push(g.net.addNode(x, g.hf.baseAt(x, z) + 2, z, 1, 0));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) g.net.addSegment(grid[r][c].id, 1, grid[r][c + 1].id, -1);
    }
    g.commitEdit({ scenery: true });
    g.hf.grade(g.net);
    g.terrain.sync();
    g.track.sync(g.net, g.hf);
    g.props.sync(g.net);
    g.scatter.sync(g.hf, g.net);

    const segRebuilds0 = g.track.stats.segRebuilds;
    const mid = grid[10][12];
    g.net.moveNode(mid.id, mid.x + 2, mid.y, mid.z + 2);
    g.commitEdit();
    g.terrain.sync();
    g.track.sync(g.net, g.hf);
    g.props.sync(g.net);
    const segRebuildsAfterMove = g.track.stats.segRebuilds - segRebuilds0;

    // Brush locally and verify only nearby track segments are flagged dirty.
    g.hf.brush('raise', -900, -900, 60, 0.5);
    g.hf.grade(g.net);
    const nearby = g.net.segmentsInBounds(-968, -968, -832, -832);
    for (const id of nearby) g.net.dirty.add(id);
    const dirtyCount = g.net.dirty.size;
    g.track.sync(g.net, g.hf);

    return { segs: g.net.segs.size, segRebuildsAfterMove, dirtyCount };
  });
  expect(bigStats.segs).toBe(500);
  expect(bigStats.segRebuildsAfterMove).toBeLessThan(10);
  expect(bigStats.dirtyCount).toBeLessThan(20);
  await frames(page, 4);
  expect(await page.evaluate(() => window.__game.renderer.info.render.calls)).toBeLessThan(350);

  // Verify terrain grading weights feed chunk geometry and toggling high/low water reflections works cleanly.
  const hasGradedWeights = await page.evaluate(() => window.__game.hf.gradeWeight.some((w) => w > 0.9));
  expect(hasGradedWeights).toBe(true);
  await page.evaluate(() => window.__game.setQuality('low'));
  await frames(page, 3);
  await page.evaluate(() => window.__game.setQuality('high'));
  await frames(page, 3);
});
