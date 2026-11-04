# Conventions

## Code

- Use TypeScript in strict mode. Don't use `any`, and use `import type` for anything only used as a type. The linter enforces both.
- Let the formatter decide layout and import order. Don't hand-format around it.
- Copy an array before removing items from it in a loop, for example `for (const c of [...group.children])`. Don't "simplify" these copies.
- Keep Three.js and the DOM out of `src/rail/`, `src/world/` and `src/core/`.
- Prefer small, direct code over abstractions. Add a helper when a second caller needs it, not before.
- Comments explain why, not what.
- Reuse geometry and materials through `Assets`, and use `InstancedMesh` for anything repeated.
- Dispose of GPU resources when rebuilding meshes.

## Units and axes

- Distances are metres, speeds m/s internally and km/h on screen, mass in tonnes, and force in kN.
- Y is up. The rail head is the reference height for track and vehicles.
- Headings are unit vectors in the XZ plane.
- A train keeps signals on its right: for travel `(tx, tz)`, right is `(-tz, tx)`.

## Assets

- Change models by editing `tools/blender/build_assetpack.py` and running `npm run assets`. Never hand-edit the GLB, and commit the regenerated file with the script change.
- Vehicles and signals face Blender `-Y`, which exports as `+Z`, the forward direction for three.js `lookAt`.
- Origins sit on the rail head or ground, at the centre of the footprint.
- Asset names are looked up by string in the game, so renaming one means updating its users.
- Materials named `glow_*` are lit at night using colours set in the `GLOW` table in `src/render/assets.ts`.
- Signal lenses stay separate objects named `lamp_red`, `lamp_amber` and `lamp_green` so they can be lit individually.
- Models must be original. Don't copy specific real games or operators.

## Interface

The look is a signal box: painted steel, enamel plates and brass. The lever frame is the one bold element, so keep everything around it quiet.

- Tokens live at the top of `src/ui/style.css`. Use them rather than new colours.
- Red, yellow and green mean signal aspects. The exception is `.toast.warn`, which uses red for serious events.
- Use sentence case and plain words a player would use. Say what happens, with the same name for an action throughout.
- Error messages say what went wrong and how to fix it, without apologising.
- Keep keyboard focus visible and respect reduced motion.

## Tests

- Put behaviour tests in `tests/`, driving `Network` and `Sim` directly.
- A rail or signalling change needs a test. A bug fix needs one that fails without the fix.
- The 40-minute starter map run guards against collisions and stalled trains. If it fails, fix the cause before touching its thresholds.
- Rendering and editor behaviour currently have no automated tests, so check them in a browser.

## Git

- Write commit subjects in the imperative, describing the change.
- Keep generated output out of commits, apart from `public/assets/assetpack.glb`, which the app needs at runtime.
- Change docs in the same commit or pull request as the code. See [docs-sync.md](docs-sync.md).
