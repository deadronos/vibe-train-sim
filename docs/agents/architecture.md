# Architecture

## Layers

Dependencies point downward only.

| Layer      | Path                                   | Responsibility                                                                                       |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Interface  | `src/ui/`, `src/ui/panels/`            | HTML interface and per-tool panels; read game state and call `Game` methods                          |
| Editor     | `src/editor/`, `src/editor/tools/`     | Turns pointer input into map edits via `EditorTool` modules and a narrow `EditorHost` view of `Game` |
| Game       | `src/game.ts`                          | Owns the world, frame loop and modes, and coordinates the rest                                       |
| Audio      | `src/audio.ts`                         | Web Audio synthesis; driven by `Game`, `DriverInput` and `Hud`                                       |
| Rendering  | `src/render/`                          | Draws simulation and terrain state with Three.js                                                     |
| Simulation | `src/rail/`, `src/world/`, `src/core/` | Rail model, trains, heights, scenery data and noise (no DOM/GL)                                      |

`src/main.ts` is the entry point and the only module that runs anything on import. Next to `Game`, and needing no WebGL so tests can use them:

- `src/persistence.ts` moves a world to and from save data, browser storage and files.
- `src/saveData.ts` defines the save format and validates it.
- `src/history.ts` holds the undo and redo stacks.
- `src/driverInput.ts` holds held keys and the power lever, and binds the keyboard.
- `src/world/scenery.ts` holds `SceneryType`, `PlacedItem`, `SceneryExclusion`, and the per-cell deterministic `generateScenery()` pass, shared between saves, the editor and `ScatterRenderer`.
- `src/editor/trackPlan.ts` holds pure track-planning geometry and anchor resolution without Three.js or DOM dependencies so unit tests can exercise it directly.

The editor, interface (`src/ui/hud.ts` and per-tool panels in `src/ui/panels/`, which update controls in place to preserve focus) and `driverInput.ts` import `Game` as a type, while `game.ts` creates them. Editor tools talk to `Game` through `EditorHost` (`src/editor/tools/tool.ts`) and run edits through `Editor.edit()` so undo, commit and abandon happen in one place.

The simulation layer's isolation (plus `src/editor/trackPlan.ts`) is a hard rule enforced by `.oxlintrc.json` (`no-restricted-imports` and `no-restricted-globals`): it is what lets `tests/` run the whole railway headlessly.

## Rail model

Defined in `src/rail/network.ts`.

- **Nodes** have a position and a heading. A **segment** leaves a node on side `+1` (along the heading) or `-1` (against it).
- A train arriving on one side always leaves on the other. Two or more segments on one side make that node a **junction**, and `node.sw[side]` holds the selected segment.
- **Signals and stations belong to nodes.** Placing one mid-segment splits the segment. This means block occupancy is exact at segment level, with no partial-segment bookkeeping.
- A signal at `node.signals[side]` governs trains leaving the node on that side, with `type?: 'main' | 'distant' | 'shunt'` (missing defaults to `'main'`).
- **Level crossings:** `Network.crossings` detects unconnected segments whose XZ paths cross with vertical separation under `CROSSING_CLEARANCE` (grade-separated bridges are excluded).
- **Speed limits and boards:** Segments inherit curve `vmax` capped by `LINE_VMAX` and optional `Segment.speedLimit`. `computeSpeedSigns()` derives lineside speed boards and 250 m advance warning boards from limit changes.
- Segment geometry is derived and rebuilt from nodes. It is never saved. `Network` maintains a 64 m spatial grid for `nearest()` and `nearestNode()`, plus per-segment bounds (`segBounds`) and incremental dirty sets (`dirty`, `dirtyNodes`, `dirtyStationSigns`, `speedSignsDirty`, `dirtyBounds`). Throwing points does not bump `version`.

## Simulation

`src/rail/sim.ts` is the entry point, split across `walk.ts` (shared forward track walker), `train.ts` (`Train` model, constants and `TrainStatus` codes formatted by `src/ui/hud.ts`), `routing.ts`, `interlocking.ts`, `physics.ts` and `driverAI.ts`:

- **Interlocking** runs about every 0.15 seconds. It rebuilds occupancy, renews claims, and grants a signal to an approaching train only if that signal's block is free of other trains' claims and occupancy. Claims cover nodes (`nodeClaims`) and level crossings (`crossingClaims`), so converging and crossing routes conflict. Calling-on (`shunt`) signals allow entry into a block occupied by a stopped or same-direction train under `SHUNT_VMAX` (25 km/h, `Train.restricted`) while still rejecting opposing moves and conflicting crossings.
- **Aspects and route indications:** `Sim.aspects` and `Sim.indications` track signal aspects, calling-on state, and facing-junction route direction (`left` / `right` / `straight`). Main signals show red when the block isn't free or the signal is held, yellow when the next stopping signal can't be entered, the line dead-ends, or the route diverges onto a slower turnout, otherwise green. Distant signals repeat the next main/shunt signal without blocking a section on their own.
- **Train position** is a trail of `{seg, dir}` pieces plus the head's distance along the last piece. Cars are placed by walking back along the trail. `Train.odometer` tracks cumulative distance travelled (not saved) for wheel spin, suspension bounce and distance-driven rail audio; `collectJunctionDists()` and `tractiveLoad()` expose real junction node distances under the train and normalised locomotive power load.
- **Reversing** swaps head and tail and flips the consist. There is no negative speed.
- **Fixed step:** `Sim.update(dt)` runs whole steps of `STEP` seconds and keeps the remainder, so results don't depend on frame rate. `Game` scales `dt` for pause and fast-forward. Renderers use `Sim.drawn()` and `carPose()`, which show a train part of a step back so it moves smoothly between steps. Simulation code uses `behind()` and `head()`.
- **Vehicles:** `src/rail/vehicles.ts` is the one table of length, mass, brake force, top speed and traction. A new type needs a row there, a model of the same name and an entry in `CAR_TYPES` in `src/saveData.ts`.
- **Forces** come from the whole train. Gravity and curve resistance are averaged by mass over each car. Pulling force is limited by adhesion on the locomotives' weight: above it a manual train slips and loses grip, while the AI stops at the limit. Trains stop at speed 0, so they can't roll back until #64 settles reversing.
- **Brakes:** `t.brake` is the demand and `t.airBrake` is what is applied. It chases the demand over `brakeLag`, which grows with train length, and releases more slowly. Friction fades with speed. `t.dynamic` is the engine brake, which acts at once but fades at walking pace. `t.emergency` is stronger and faster, and cuts power.
- **AI braking** plans from its own train's brakes, with less on a descent, and adds a holding brake to cancel gravity, or it would creep past red signals. Only a heavy train on a steep descent uses the emergency brake.
- **Looking ahead:** `walkTrack()` in `src/rail/walk.ts` follows track ahead along `pickSegment()` for interlocking blocks, route claims, AI braking limits, cab safety warnings and the desk's signal, station, junction and limit readouts. `deskInfo()` predicts braking distance by stepping the train's own brake model forward at full brake, so the desk and the physics can't disagree.
- **Driving by hand:** `driveManual()` runs for a player train each step. It checks the limit, triggers cab safety warnings (`Train.warning`) for restrictive signals or speed drops with acknowledgement (`Sim.acknowledge()`, `Q` key), applies train protection under strict rules (`Sim.strict` — emergency brake for unacknowledged warnings, overspeeding, and SPADs), and counts a stop when the train stands still with its middle within the platform of the station it's due at. Then it holds the doors open for the dwell, with power cut and brakes held, and plans the next stop. Leaving the due station behind counts as a miss. A `Duty` (`src/rail/duty.ts`) on the train scores the run while the player drives, and lives only as long as the player is driving it, so it isn't saved. `damaged` is saved, since it stops the train moving, and `restricted` is saved in `TrainState`.
- **Timetables:** a train's `schedule` lists station ids. `times` holds a departure in seconds of the day for each one, or null, `arrivals` an arrival the driver is due by, and `turns` whether it changes ends before leaving. `Sim.stops()` joins them. `Sim.setConsist()` changes a standing train's vehicles, keeping its head and timetable place. Each train keeps a `log` of its last 40 stops with clock times, for the service diagram in `src/ui/serviceDiagram.ts`. It isn't saved. `Game` copies the clock into `Sim.clock` every frame, and a train whose dwell is over waits until its stop's time (`holdForTimetable()`). `untilTime()` measures across midnight, treating anything more than 12 hours ahead as passed. The clock's time-lapse settings run the sky faster than the trains, so trains only keep time with the clock on Real.
- **AI** plans a route to the next timetabled station, reversing only when no forward route exists. A waiting train backs away only for a true deadlock, where the train holding its block is also stuck. The train with the higher id gives way, and a player-held signal never triggers this.

## Terrain

Defined in `src/world/heightfield.ts`, on a 512-cell grid over 3200 m.

- `pristine` is the generated noise, `base` adds brush edits, and `h` adds track grading on top. `h` is what gets drawn.
- `grade()` incrementally recomputes `h` from `base` and the network over the cell rectangle touched by brush edits or changed segments and stations. Call it after any track or terrain change.
- `isBridgeSample()` decides bridge or embankment from `base`, so track rendering and grading always agree. Rendering rebuilds bridges from the same data.

## Frame and edit flow

Each frame in `Game.frame()`: read input, update the simulation (paused while editing unless the editor's option is on), sync renderers, update the environment, then render through the bloom composer.

Renderers pull incremental changes rather than being told. `net.dirty` triggers per-segment rebuilds merged into world chunks by `TrackRenderer` (plus unified junction ballast aprons, frogs, guard rails and instanced switch blades animated in `TrackRenderer.update()`); `net.dirtyNodes`, `net.dirtyStationSigns` and `net.speedSignsDirty` update `PropsRenderer` per node or sign while sharing network-wide `InstancedMesh` pools; `hf.dirty` refreshes `TerrainRenderer` chunks across their distance LODs (with edge skirts to prevent seams); `ScatterRenderer` updates only affected `8 × 8` regions across distance LODs while culling `castShadow` to `Environment.shadowFrustum`; `TrainRenderer` instances bogies, wheelsets and couplers/gangways across all trains, switches between the real spotlight and projected AI headlight cones, and manages the cab interior; and `ParticleRenderer` maintains pooled instanced exhaust, spark, dust and impact particles disabled under low quality.

After an edit, call `Game.commitEdit()`, which regrades terrain and calls `Sim.syncTrack()`. That compares segment fingerprints with the last call and re-seats only trains standing on a changed or removed segment, on the nearest track and keeping their speed, platform wait and timetable progress. Other trains are not touched, so an edit that changes no track (scenery, a signal away from them) never slows anyone. Splitting a segment for a signal counts as a change for the trains on it. Call `Game.pushUndo()` before making the edit, and only once something actually changes: selecting must not touch history. Undo stores whole JSON snapshots, limited to 40. An edit that turns out to be invalid calls `Game.abandonEdit()`, which restores the last snapshot without leaving a redo step. Moving, raising or turning a point is checked with `Network.problemAt()`, the same radius and grade rules used when laying track, and refused that way.

## Saves

`SaveData` in `src/saveData.ts` stores the preset and seed, sparse terrain edits, the network, placed scenery, optional scenery `exclusions` for removed generated items, and each train's position. Terrain noise, procedural scenery and geometry are regenerated on load.

`parseSave()` in the same file validates a whole save (types, ids that point to real nodes, allowed values) and returns the data or a reason. It must stay free of Three.js and the DOM so tests can run it. Browser saves and imports both go through it. If you add a field or enum value to `SaveData`, update `parseSave()` and its tests too.

A browser save that fails validation is copied to the `vibe-train-sim/map-v1-backup` key, a fresh starter map starts, and the player gets a toast. A bad import leaves the current map unchanged.

The working map saves every minute, on `pagehide`, when the tab is hidden and on `beforeunload`. A failed autosave warns once per page. A `storage` event on the save key means another tab has the map open, and the player is warned once.

`src/mapLibrary.ts` holds named copies and automatic backups beside the working map, each under its own key with a small index at `vibe-train-sim/library`. Any action that replaces the map (**New map**, import, loading a copy or backup) goes through `Game.replaceMap()`, which backs up the current map first. That is the rule that stops a map being lost: a new way to replace the map must go through it too. Only the newest `BACKUP_COUNT` backups are kept, and older ones are dropped to make room if storage is full.

Each train's full state is saved: trail, speed, route, brakes, dwell and grants, from `Sim.captureState()`. `Sim.restoreState()` puts it back exactly, and if the trail no longer fits the track the train goes on the nearest track, stopped. Version 1 saves have no state, so they load that way too. Undo uses the same path, so undoing an edit doesn't disturb running trains. A new `Train` field that changes how a train runs must be added to `TrainState`.

If you change the format incompatibly, bump `v` and handle or reject older saves, since `parseSave()` checks it.

## Start-up failures

`boot()` in `src/main.ts` checks for WebGL, creates `Game` and starts it inside one error handler, so any failure replaces the loading bar with a message. Wording and classification live in `src/startupError.ts`. Players get plain advice; developer detail such as `npm run assets` shows only when `import.meta.env.DEV` is true. A `webglcontextlost` event saves the map, stops the frame loop and offers a reload.

## Assets

`tools/blender/build_assetpack.py` writes `public/assets/assetpack.glb`, loaded by `src/render/assets.ts`. The contract between them is in [conventions.md](conventions.md#assets).
