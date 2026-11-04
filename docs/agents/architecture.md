# Architecture

## Layers

Dependencies point downward only.

| Layer      | Path                                   | Responsibility                                                 |
| ---------- | -------------------------------------- | -------------------------------------------------------------- |
| Interface  | `src/ui/`                              | HTML interface; reads game state and calls `Game` methods      |
| Editor     | `src/editor/`                          | Turns pointer input into map edits                             |
| Game       | `src/main.ts`                          | Owns the world, frame loop, modes, saves and undo              |
| Rendering  | `src/render/`                          | Draws simulation and terrain state with Three.js               |
| Simulation | `src/rail/`, `src/world/`, `src/core/` | Rail model, trains, heights and noise, with no Three.js or DOM |

The editor and interface import `Game` as a type, while `main.ts` creates them.

The simulation layer's isolation is a hard rule: it is what lets `tests/` run the whole railway headlessly.

## Rail model

Defined in `src/rail/network.ts`.

- **Nodes** have a position and a heading. A **segment** leaves a node on side `+1` (along the heading) or `-1` (against it).
- A train arriving on one side always leaves on the other. Two or more segments on one side make that node a **junction**, and `node.sw[side]` holds the selected segment.
- **Signals and stations belong to nodes.** Placing one mid-segment splits the segment. This means block occupancy is exact at segment level, with no partial-segment bookkeeping.
- A signal at `node.signals[side]` governs trains leaving the node on that side.
- Segment geometry is derived and rebuilt from nodes. It is never saved.

## Simulation

`src/rail/sim.ts` handles the following:

- **Interlocking** runs about every 0.15 seconds. It rebuilds occupancy, renews claims, and grants a signal to an approaching train only if that signal's block is free of other trains' claims and occupancy. Claims also cover nodes, so converging routes conflict.
- **Aspects:** red when the block isn't free or the signal is held, yellow when the next signal can't be entered or the line dead-ends, otherwise green.
- **Train position** is a trail of `{seg, dir}` pieces plus the head's distance along the last piece. Cars are placed by walking back along the trail.
- **Reversing** swaps head and tail and flips the consist. There is no negative speed.
- **Gradients** use the slope at the head in the direction of travel. The AI plans with less braking on a descent and adds a holding brake to cancel gravity, or it would creep past red signals.
- **AI** plans a route to the next timetabled station, reversing only when no forward route exists. A waiting train backs away only for a true deadlock, where the train holding its block is also stuck. The train with the higher id gives way, and a player-held signal never triggers this.

## Terrain

Defined in `src/world/heightfield.ts`, on a 512-cell grid over 3200 m.

- `pristine` is the generated noise, `base` adds brush edits, and `h` adds track grading on top. `h` is what gets drawn.
- `grade()` recomputes `h` from `base` and the network. Call it after any track or terrain change.
- `isBridgeSample()` decides bridge or embankment from `base`, so track rendering and grading always agree. Rendering rebuilds bridges from the same data.

## Frame and edit flow

Each frame in `Game.frame()`: read input, update the simulation (paused while editing unless the editor's option is on), sync renderers, update the environment, then render through the bloom composer.

Renderers pull changes rather than being told. `net.dirty` flags segments to rebuild, `net.version` triggers a props rebuild, and `hf.dirty` flags terrain chunks.

After an edit, call `Game.commitEdit()`, which regrades terrain and re-seats trains on the nearest track. Call `Game.pushUndo()` before making the edit. Undo stores whole JSON snapshots, limited to 40.

## Saves

`SaveData` in `src/saveData.ts` stores the preset and seed, sparse terrain edits, the network, placed scenery and each train's position. Terrain noise and geometry are regenerated on load.

`parseSave()` in the same file validates a whole save (types, ids that point to real nodes, allowed values) and returns the data or a reason. It must stay free of Three.js and the DOM so tests can run it. Browser saves and imports both go through it. If you add a field or enum value to `SaveData`, update `parseSave()` and its tests too.

A browser save that fails validation is copied to the `vibe-train-sim/map-v1-backup` key, a fresh starter map starts, and the player gets a toast. A bad import leaves the current map unchanged.

If you change the format incompatibly, bump `v` and handle or reject older saves, since `parseSave()` checks it.

## Start-up failures

`boot()` at the bottom of `src/main.ts` checks for WebGL, creates `Game` and starts it inside one error handler, so any failure replaces the loading bar with a message. Wording and classification live in `src/startupError.ts`. Players get plain advice; developer detail such as `npm run assets` shows only when `import.meta.env.DEV` is true. A `webglcontextlost` event saves the map, stops the frame loop and offers a reload.

## Assets

`tools/blender/build_assetpack.py` writes `public/assets/assetpack.glb`, loaded by `src/render/assets.ts`. The contract between them is in [conventions.md](conventions.md#assets).
