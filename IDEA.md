# Idea

The goal this project started from. Later decisions live in [docs/agents](docs/agents/); this file only changes if the goal itself changes.

## Initial goal

Build a train simulator as a website, using Three.js or React Three Fiber, in which players can both drive trains and build the railway they run on.

It should have:

- **A map editor mode** with a toggle, for placing tracks, stations and other railway objects
- **Signals and junctions** that affect how trains run
- **An asset pack**, made with Blender where that helps
- **Realistic lighting** and a day/night cycle
- **Varied terrain** and bridges that carry track across it

## What it should feel like

Driving and building are two views of the same world. A line you lay in the editor is one you can drive moments later, and the signals you place control real trains on it.

## Choices made at the start

These filled gaps in the goal. They can change, but [architecture.md](docs/agents/architecture.md) and the code must change with them.

| Open question | Choice | Why |
| --- | --- | --- |
| Three.js or React Three Fiber | Plain Three.js with TypeScript | A per-frame simulation and an imperative editor gain little from React's component model |
| How to make the assets | A Blender Python script that writes one GLB | Models can be rebuilt, reviewed as code and changed without hand-editing binaries |
| How signals work | Block signalling with route locking | It makes signals meaningful and keeps trains apart without a scripted scenario |
| Where the map is stored | Browser storage and JSON files | The game stays a static site with no backend or accounts |

## Out of scope for now

- Tunnels, because the terrain is a heightfield with no holes
- Multiplayer and shared online maps
- Models or names copied from real railway games or operators
