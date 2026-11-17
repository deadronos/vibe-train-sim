# Next issues

Suggested order and batches for the remaining review issues, updated on 2026-11-17 (v0.4.2). 6 feature issues remain across 4 umbrellas (`#21`, `#32`, `#48`, `#68`).

## Completed batches (archive)

- **Code quality, modularity and tests ([#13](https://github.com/deadronos/vibe-train-sim/issues/13), closed):** [#3](https://github.com/deadronos/vibe-train-sim/issues/3)–[#12](https://github.com/deadronos/vibe-train-sim/issues/12) landed across #70, #72, #91 (`#5`, `#8`, `#12`) and #92 (`#6`, `#7`).
- **Session fixes & map safety:** [#14](https://github.com/deadronos/vibe-train-sim/issues/14), [#22](https://github.com/deadronos/vibe-train-sim/issues/22), [#33](https://github.com/deadronos/vibe-train-sim/issues/33)–[#38](https://github.com/deadronos/vibe-train-sim/issues/38), [#43](https://github.com/deadronos/vibe-train-sim/issues/43).
- **Driving & signalling gameplay:** [#40](https://github.com/deadronos/vibe-train-sim/issues/40), [#41](https://github.com/deadronos/vibe-train-sim/issues/41), [#44](https://github.com/deadronos/vibe-train-sim/issues/44), [#55](https://github.com/deadronos/vibe-train-sim/issues/55)–[#63](https://github.com/deadronos/vibe-train-sim/issues/63), [#66](https://github.com/deadronos/vibe-train-sim/issues/66), [#67](https://github.com/deadronos/vibe-train-sim/issues/67) (#73, #74, #78, #79, #84, #85, #86, #88).
- **UI, accessibility, sound basics & allocation cleanup:** [#20](https://github.com/deadronos/vibe-train-sim/issues/20), [#42](https://github.com/deadronos/vibe-train-sim/issues/42), [#46](https://github.com/deadronos/vibe-train-sim/issues/46), [#47](https://github.com/deadronos/vibe-train-sim/issues/47), [#49](https://github.com/deadronos/vibe-train-sim/issues/49), [#50](https://github.com/deadronos/vibe-train-sim/issues/50) (#75, #80, #82, #87, #89).

- **Batch 1 — Editor clarity, camera feel and adaptive quality:** [#39](https://github.com/deadronos/vibe-train-sim/issues/39), [#45](https://github.com/deadronos/vibe-train-sim/issues/45), and [#19](https://github.com/deadronos/vibe-train-sim/issues/19) (partial; physical low-end device measurements remain open on `#19`).
- **Batch 2 — Rendering and edit scalability:** [#15](https://github.com/deadronos/vibe-train-sim/issues/15) (per-node prop rebuilds and station sign updates), [#16](https://github.com/deadronos/vibe-train-sim/issues/16) (incremental grading, spatial grid in `Network`, per-region scatter, brush-area track dirtying), [#17](https://github.com/deadronos/vibe-train-sim/issues/17) (chunk-merged track, shared network prop instancing, instanced bounds for culling), and [#18](https://github.com/deadronos/vibe-train-sim/issues/18) (terrain LODs with skirts, tree LOD1/LOD2 variants, shadow-frustum culling).
- **Batch 3 — Bring trains and cabs to life (visuals + core sound):** [#26](https://github.com/deadronos/vibe-train-sim/issues/26) (instanced rotating wheelsets, body sway/roll/bounce, couplers/gangways, real spotlight + projected AI headlight cones), [#28](https://github.com/deadronos/vibe-train-sim/issues/28) (low-poly `cab_interior` with live dial/lever and reduced-motion-safe head sway), [#29](https://github.com/deadronos/vibe-train-sim/issues/29) (turnout switch blades, frogs, guard rails, blended ballast and smooth blade animation), [#27](https://github.com/deadronos/vibe-train-sim/issues/27) (pooled instanced diesel exhaust, brake sparks, desert dust and impact bursts respecting low quality), and [#51](https://github.com/deadronos/vibe-train-sim/issues/51) (pure Web Audio diesel notches/load/turbo whine, brake squeal/air release, tight-curve flange squeal, node-driven junction clatter, bridge resonance and impact sounds).
- **Batch 4A — Directional & ambient audio:** [#52](https://github.com/deadronos/vibe-train-sim/issues/52) (camera-anchored `AudioListener`, distance-culled `PannerNode` passing-train voices, Doppler shift, and live editor audio in #105), and [#53](https://github.com/deadronos/vibe-train-sim/issues/53) (altitude wind, river/coast water, per-landscape day birds vs night crickets, point/signal lever clunks, station door chimes, and signal-box UI clicks in #106; rain/thunder hooks deferred to `#30`).
- **Batch 4B — Water & terrain materials:** [#24](https://github.com/deadronos/vibe-train-sim/issues/24) (heightfield-driven water depth colour, soft shoreline edges and foam, river downstream flow, Fresnel sky reflection and high-quality planar reflections) and [#25](https://github.com/deadronos/vibe-train-sim/issues/25) (per-vertex `gradeWeight` embankment/ballast shading, noise-broken shores and close-up procedural micro-detail).

---

## Batch 1 remaining item (tracked on #19)

- [#19](https://github.com/deadronos/vibe-train-sim/issues/19): **Finish adaptive quality and performance measurements** (`area: performance`, partly done in #81 and #95) — Physical low-end laptop and phone hardware measurements still tracked on `#19`.

## Batch 4C: Weather, landscape life and shadows

Richer environments day and night once Batch 2 draw budgets and Batch 3 train effects are in place.

- [#30](https://github.com/deadronos/vibe-train-sim/issues/30): **Weather: rain, snow, mist and moving cloud shadows** (`area: visuals`) — pairs with rain/thunder in [#53](https://github.com/deadronos/vibe-train-sim/issues/53).
- [#31](https://github.com/deadronos/vibe-train-sim/issues/31): **Life in the landscape: wind, ground cover and settlements** (`area: visuals`).
- [#23](https://github.com/deadronos/vibe-train-sim/issues/23): **Cascaded shadows and ambient occlusion** (`area: visuals`) — Measure GPU cost with `?debug` alongside `#18`/`#19`.

## Batch 5: Deep rail & track geometry (needs design notes first)

Largest architectural changes to `src/rail/`; plan specs carefully before coding.

- [#65](https://github.com/deadronos/vibe-train-sim/issues/65): **Cant and transition curves** (`area: simulation`) — Per-sample cant, curve speed limits accounting for cant, smooth curvature transitions, and banked track/car roll.
- [#64](https://github.com/deadronos/vibe-train-sim/issues/64): **Shunting: coupling, uncoupling and a reverser** (`area: simulation`) — Needs a design note for the trail/negative-speed model first; enables propelling moves, coupling/splitting, run-around loops, and siding freight duties.
