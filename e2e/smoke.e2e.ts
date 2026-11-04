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

test('driving keys take over from the autopilot and move the power lever', async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => window.__game.driven?.ai)).toBe(true);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => window.__game.driven?.ai)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__game.input.lever)).toBeGreaterThan(0.05);
  await expect.poll(() => page.locator('#power-lever').inputValue().then(Number)).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyW');
});

test('the map comes back after a reload', async ({ page }) => {
  await load(page);
  const summary = () =>
    page.evaluate(() => {
      const g = window.__game;
      return { preset: g.hf.preset, seed: g.hf.seed, segs: g.net.segs.size, trains: g.sim.trains.map((t) => t.name) };
    });
  await page.evaluate(() => window.__game.newWorld('desert', 4, true));
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
