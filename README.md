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

- Train physics: power limits, gradients, rolling resistance, braking and curve speed limits
- Autopilot that follows a timetable, stops at stations and turns around at termini
- Chase, cab and trackside cameras
- Synthesised engine, rail joint and horn sounds

**Railway**

- Track graph with junctions you can throw while driving
- Block signals showing red, yellow and green, with route locking so opposing trains can't enter the same section
- Warnings for passing a signal at danger, buffer stop hits and collisions

**Map editor** (press Tab)

- Lay curved track, branch from existing track and join lines, with radius and gradient checks
- Place signals, stations, scenery and trains
- Bridges appear where track runs high or crosses water; river crossings get a steel truss. You can force a bridge or an embankment per section
- Terrain brushes: raise, lower, smooth and flatten. The ground forms embankments and cuttings around track automatically
- Undo and redo, browser saves, and JSON import and export

**World**

- Alpine, plains, desert and island landscapes, each from a seed
- Day and night cycle with atmospheric sky, clouds, stars, moon and image-based lighting
- Sun shadows, bloom, lit windows, platform lamps and a train headlight

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

`npm run check` checks formatting and lint, runs the tests, then builds.

`npm run assets` needs Blender at `/Applications/Blender.app`. Change the path in `package.json` if yours is elsewhere. The built `assetpack.glb` is included, so you only need Blender to change the models.

## Known limits

- There are no tunnels: track below ground level runs through a cutting, because the terrain is a heightfield.
- Lines crossing at the same level are not interlocked. Trains on them can collide, so join them with a junction or use a bridge.
- Two trains can meet between signals on a single line if the signals allow it. The younger train backs away after about a minute.

## Contributing

Start with [AGENTS.md](AGENTS.md), which links to the architecture, conventions and tooling guides. Code and docs change together in the same pull request.

## License

MIT. See [LICENSE.md](LICENSE.md).
