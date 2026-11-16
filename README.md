# Vibe Train Sim

A train simulator and map editor that runs in the browser, built with Three.js and TypeScript. All 3D models come from a Blender script in this repo.

**[Play it in your browser](https://deadronos.github.io/vibe-train-sim/)**

To run it locally:

```bash
npm install
npm run dev
```

## What's in it

**Driving**

- Train physics: power and adhesion limits, gravity and curve resistance along the whole train, and curve speed limits
- Air, engine and emergency brakes that depend on the train, so a loaded freight takes far longer to stop than an express
- Three locomotive types, and wagons that can be empty or loaded
- A driver's desk with the limit here and the next lower one ahead, the gradient, power and brake levels, an overspeed warning, and a marker comparing braking distance with the room left before a red signal
- Pause and fast-forward
- Saves keep trains moving: they come back where they were, at the same speed and on the same route
- Autopilot that follows a timetable, stops at stations and turns around at termini
- **Timetables** set each train's stops, arrival and departure times, and where it changes ends. Trains wait at a stop until its time on the clock, and a driver's score is due by the timetable. The same dialog changes a standing train's vehicles, and its service diagram plots every train's planned and actual stops against the clock
- Take over any train to drive its service by hand: stop within each platform with the doors open, on time, and you score points. Speeding, passing red signals, missed stops and crashes cost points, and you get a summary with your best score for that landscape when you hand back to the autopilot
- Relaxed or strict rules. Under strict rules train protection brakes a train well over the limit, and a hard hit or a derailment damages the train until you recover it
- Chase, cab and trackside cameras
- An overview map (press O) of the whole railway, showing trains, stations, signal aspects and occupied sections. Click a train to drive it, or a place to go there in the editor
- A short getting-started guide on first visit, which Help can show again
- Synthesised engine, rail joint and horn sounds, with saved volume levels for each, that go quiet in a hidden tab
- Auto graphics lowers the resolution, then the effects, while frames run slow. High and low apply at once, without a reload

**Railway**

- Track graph with junctions you can throw while driving
- Block signals showing red, yellow and green, with route locking so opposing trains can't enter the same section
- Warnings for passing a signal at danger, buffer stop hits and collisions

**Map editor** (press E)

- Lay curved track, branch from existing track and join lines, with radius and gradient checks. Moving, raising or turning a point gets the same checks, and a change that breaks them is undone
- Place signals, stations, scenery and trains. A new train faces the way the arrow shows, and can't be placed on top of another
- Set a platform's length from the Select panel
- Bridges appear where track runs high or crosses water; river crossings get a steel truss. You can force a bridge or an embankment per section
- Terrain brushes: raise, lower, smooth and flatten. The ground forms embankments and cuttings around track automatically
- Undo and redo, browser saves, and JSON import and export. A damaged save is kept as a backup and a new map starts; a bad import leaves your map as it was
- The map saves itself every minute and when you leave the page. **Maps** keeps named copies, and the last three maps replaced by a new map, an import or a load are kept as backups

**World**

- Alpine, plains, desert and island landscapes, each from a seed
- Day and night cycle with atmospheric sky, clouds, stars, moon and image-based lighting
- Sun shadows, bloom, lit windows, platform lamps and a train headlight

**Phones and tablets**

- On narrow screens the menu, the clock controls and the train list fold behind **Menu** and **Trains** buttons, and the desk stacks into a compact block. Turned sideways, the desk fits in one short row
- The desk has Horn and Next train buttons, and the track panel has Snap and Stop laying, so nothing needs a keyboard
- Editor tools that place something show what a tap will do first; tap the same place again to do it

Press `?` in the app for all controls.

## Project layout

| Path                               | Contents                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `src/rail/`                        | Track network, signalling, train physics and AI. No rendering code, so it runs in tests |
| `src/world/`                       | Height data and terrain grading                                                         |
| `src/render/`                      | Terrain, track, bridges, props, trains, sky and cameras                                 |
| `src/editor/`                      | Map editor tools                                                                        |
| `src/ui/`                          | Interface and styling                                                                   |
| `tools/blender/build_assetpack.py` | Generates `public/assets/assetpack.glb` and a preview render                            |
| `tests/`                           | Simulation tests, including a 40-minute run of the starter map                          |
| `e2e/`                             | Browser smoke test of the built site                                                    |

## Commands

```bash
npm run check
```

```bash
npm run format
```

```bash
npm run assets
```

`npm run check` checks formatting and lint, runs the tests, then builds. `npm run test:smoke` runs the browser smoke test, which needs `npx playwright install chromium` once.

`npm run assets` needs Blender at `/Applications/Blender.app`. Change the path in `package.json` if yours is elsewhere. The built `assetpack.glb` is included, so you only need Blender to change the models.

## Known limits

- There are no tunnels: track below ground level runs through a cutting, because the terrain is a heightfield.
- Lines crossing at the same level are not interlocked. Trains on them can collide, so join them with a junction or use a bridge.
- Two trains can meet between signals on a single line if the signals allow it. The younger train backs away after about a minute.

## Contributing

Start with [AGENTS.md](AGENTS.md), which links to the architecture, conventions and tooling guides. Code and docs change together in the same pull request.

## License

MIT. See [LICENSE.md](LICENSE.md).
