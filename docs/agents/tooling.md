# Tooling

## Stack

| Tool        | Used for                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| Three.js    | Rendering, loaded from npm with addons from `three/addons/`                    |
| TypeScript  | Language, type-checked by `tsc --noEmit`                                       |
| Vite        | Dev server and build, with `base: './'` so `dist/` can be hosted from any path |
| Vitest      | Simulation, save and terrain tests                                             |
| Playwright  | Browser smoke test of the built site, on software GL                           |
| Oxlint      | Linting, with type-aware rules through `oxlint-tsgolint`                       |
| Oxfmt       | Formatting code, styles, HTML, JSON and Markdown                               |
| Blender 5.x | Asset pack generation, optional unless models change                           |

Exact versions are in `package.json` and `package-lock.json`. Use `npm` and commit the lockfile.

## Commands

| Command              | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `npm run dev`        | Starts the dev server                                         |
| `npm test`           | Runs the tests once                                           |
| `npm run test:smoke` | Builds, then runs the browser smoke test. Not part of `check` |
| `npm run build`      | Type-checks, then builds to `dist/`                           |
| `npm run check`      | Checks formatting and lint, runs the tests, then builds       |
| `npm run lint`       | Lints; warnings also fail, and `lint:fix` applies safe fixes  |
| `npm run format`     | Formats files in place; `format:check` only reports           |
| `npm run preview`    | Serves the built site                                         |
| `npm run assets`     | Rebuilds `assetpack.glb` and `tools/blender/preview.png`      |

Before the first `test:smoke` on a machine, run `npx playwright install chromium`.

`npm run assets` expects Blender at `/Applications/Blender.app`. Check the preview render after changing models. It is ignored by git.

## Verifying a change

1. Run `npm run check`. For changes to start-up, rendering, the editor or input, also run `npm run test:smoke`.
2. For visual or editor changes, run the app and try the change, watching the browser console for errors.
3. For lighting changes, check noon, dusk and night, since a fix for one often breaks another.
4. For terrain or bridge changes, check more than one landscape through **New map**.

## CI and deployment

`.github/workflows/deploy-pages.yml` runs `npm run check` and the browser smoke test on every pull request and push to `main`, without deploying.

Pushing a tag that starts with `v` runs the same checks and, if it passes, deploys to [GitHub Pages](https://deadronos.github.io/vibe-train-sim/). See [releasing.md](releasing.md) for the full process.

To redeploy a release, run the workflow from the Actions tab and select its tag. The `github-pages` environment must allow `v*` tags, or the deploy is rejected.

The site is served from a subpath, so keep `base: './'` in `vite.config.ts` and build asset URLs from `import.meta.env.BASE_URL`.

## Lint and format settings

Rules are in `.oxlintrc.json` and formatter settings in `.oxfmtrc.json`. Each rule switched off has its reason beside it there.

- To turn a rule off everywhere, add it to the config with a reason.
- For a single justified exception, use `// oxlint-disable-next-line rule-name -- reason`. Unused disable comments are reported.
- Review autofixes, and avoid `--fix-suggestions` and `--fix-dangerously`, which can change behaviour.

## Debugging

`window.__game` exposes the running `Game` in dev and production builds. For example:

```js
__game.env.timeScale = 0; // Stop the clock
__game.env.hours = 21.5; // Jump to night
__game.newWorld('desert', 3, true); // Load a landscape with the starter railway
__game.sim.trains.map((t) => t.statusText);
```

## Gotchas

- **Clearing the save doesn't reset the map.** A `beforeunload` handler saves on reload, so `localStorage.clear()` followed by a reload brings the old map back. Use `__game.newWorld(...)` instead, or **New map** in the app.
- **Testing start-up failures.** To plant a corrupt save, write it from a `beforeunload` listener you add after the game's own, then reload. To see the download message, move `public/assets/assetpack.glb` aside, reload and put it back. `getContext('webgl2')` returning `null` before the page scripts run gives the no-WebGL message, and `renderer.getContext().getExtension('WEBGL_lose_context').loseContext()` triggers the context-lost one. A hidden browser pane pauses `requestAnimationFrame`, so no frames run.
- **Old saves hide new starter maps.** A change to `src/rail/demoMap.ts` won't appear until you create a new map.
- **Vite reloads restart the state you set by hand.** Editing a file during a browser check reloads the page, so scripted camera or time changes are lost.
- **Bloom threshold is tied to sky brightness.** `src/render/environment.ts` caps the sky below the bloom threshold in `src/game.ts`. Change them together, or the whole sky blooms.
- **Dusk must not be darker than night.** The key light hands over from sun to moon between about 18:45 and 19:30, and exposure and sky fill are raised through it. Check every half hour from 17:30 to 21:00 after touching `src/render/environment.ts`. With the pane hidden, set `__game.env.timeScale = 0` and `__game.env.hours`, then call `__game.env.update(0.5, __game.camera.position)` and `__game.composer.render()` yourself before a screenshot.
- **The sky patch depends on three.js internals.** It replaces `#include <tonemapping_fragment>` in the Sky shader, so check it after upgrading three.js.
- **`console.log` from passing tests may not appear in non-interactive runs.** Write to a file if you need output from a throwaway test.
