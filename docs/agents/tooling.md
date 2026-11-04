# Tooling

## Stack

| Tool        | Used for                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| Three.js    | Rendering, loaded from npm with addons from `three/addons/`                    |
| TypeScript  | Language, type-checked by `tsc --noEmit`                                       |
| Vite        | Dev server and build, with `base: './'` so `dist/` can be hosted from any path |
| Vitest      | Simulation tests                                                               |
| Oxlint      | Linting, with type-aware rules through `oxlint-tsgolint`                       |
| Oxfmt       | Formatting code, styles, HTML, JSON and Markdown                               |
| Blender 5.x | Asset pack generation, optional unless models change                           |

Exact versions are in `package.json` and `package-lock.json`. Use `npm` and commit the lockfile.

## Commands

| Command           | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `npm run dev`     | Starts the dev server                                        |
| `npm test`        | Runs the tests once                                          |
| `npm run build`   | Type-checks, then builds to `dist/`                          |
| `npm run check`   | Checks formatting and lint, runs the tests, then builds      |
| `npm run lint`    | Lints; warnings also fail, and `lint:fix` applies safe fixes |
| `npm run format`  | Formats files in place; `format:check` only reports          |
| `npm run preview` | Serves the built site                                        |
| `npm run assets`  | Rebuilds `assetpack.glb` and `tools/blender/preview.png`     |

`npm run assets` expects Blender at `/Applications/Blender.app`. Check the preview render after changing models. It is ignored by git.

## Verifying a change

1. Run `npm run check`.
2. For visual or editor changes, run the app and try the change, watching the browser console for errors.
3. For lighting changes, check noon, dusk and night, since a fix for one often breaks another.
4. For terrain or bridge changes, check more than one landscape through **New map**.

## CI and deployment

`.github/workflows/deploy-pages.yml` runs `npm run check` on every pull request and push to `main`, without deploying.

Pushing a tag that starts with `v` runs the same check and, if it passes, deploys to [GitHub Pages](https://deadronos.github.io/vibe-train-sim/):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

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
- **Old saves hide new starter maps.** A change to `src/rail/demoMap.ts` won't appear until you create a new map.
- **Vite reloads restart the state you set by hand.** Editing a file during a browser check reloads the page, so scripted camera or time changes are lost.
- **Bloom threshold is tied to sky brightness.** `src/render/environment.ts` caps the sky below the bloom threshold in `src/main.ts`. Change them together, or the whole sky blooms.
- **The sky patch depends on three.js internals.** It replaces `#include <tonemapping_fragment>` in the Sky shader, so check it after upgrading three.js.
- **`console.log` from passing tests may not appear in non-interactive runs.** Write to a file if you need output from a throwaway test.
