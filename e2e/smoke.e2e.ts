// Checks that the built site starts and works. Looks at console output and game state, not pixels,
// because screenshots are too fragile on software GL. Shader errors reach the console when they first draw.
import type { Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import type { Game } from '../src/game';
import type { Preset } from '../src/world/heightfield';

declare global {
  interface Window {
    __game: Game;
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

  await page.reload();
  await expect(page.locator('#loading')).toHaveClass(/gone/);
  expect(await page.evaluate(() => [window.__game.shadows, window.__game.scenery])).toEqual(['off', 'off']);
  expect(await page.evaluate(() => window.__game.renderer.shadowMap.enabled)).toBe(false);
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
