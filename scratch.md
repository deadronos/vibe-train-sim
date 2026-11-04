# Next issues

Suggested order for the review issues, written on 2026-11-04. [#55](https://github.com/deadronos/vibe-train-sim/issues/55), the gradient bug, and groups 1 and 2 below are done.

## 1. Fix what can hurt a normal session (done)

Do these first. Each is a contained bug, and most players could hit them.

| Issue                                                        | Why now                                                                    | Size   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------ |
| [#3](https://github.com/deadronos/vibe-train-sim/issues/3)   | A corrupt save stops the game from starting until site data is cleared     | Small  |
| [#43](https://github.com/deadronos/vibe-train-sim/issues/43) | Same start-up code as #3: players without WebGL get an endless loading bar | Small  |
| [#33](https://github.com/deadronos/vibe-train-sim/issues/33) | Space can turn off autopilot, and Tab blocks keyboard navigation           | Medium |
| [#34](https://github.com/deadronos/vibe-train-sim/issues/34) | Any edit stops every train when "Keep trains moving while editing" is on   | Medium |
| [#14](https://github.com/deadronos/vibe-train-sim/issues/14) | GPU memory grows with every prop rebuild                                   | Small  |
| [#22](https://github.com/deadronos/vibe-train-sim/issues/22) | The scene is almost black after sunset, for part of every day              | Small  |

## 2. Add a safety net (done)

Do these before any large refactor. The follow-ups #5, #6 and #7 are still open.

- [#9](https://github.com/deadronos/vibe-train-sim/issues/9): remove dead code. A quick warm-up that makes the next steps easier.
- [#10](https://github.com/deadronos/vibe-train-sim/issues/10): test saves, undo and terrain grading.
- [#11](https://github.com/deadronos/vibe-train-sim/issues/11): add a browser smoke test to CI. Nothing checks the running game automatically today.
- [#4](https://github.com/deadronos/vibe-train-sim/issues/4): split `Game`, once the tests above are in. [#5](https://github.com/deadronos/vibe-train-sim/issues/5), [#6](https://github.com/deadronos/vibe-train-sim/issues/6) and [#7](https://github.com/deadronos/vibe-train-sim/issues/7) can follow as needed.

## 3. Make driving a game

Driving by hand has no goal or consequences yet, so this adds the most for players.

1. [#44](https://github.com/deadronos/vibe-train-sim/issues/44): show limits ahead on the desk, so players can drive well.
2. [#59](https://github.com/deadronos/vibe-train-sim/issues/59): add timetabled services and a score, which gives driving a goal.
3. [#58](https://github.com/deadronos/vibe-train-sim/issues/58): add consequences for overspeed and collisions, which fits with the score.
4. [#41](https://github.com/deadronos/vibe-train-sim/issues/41): add a first-run guide, once there is a goal to guide players towards.
5. [#40](https://github.com/deadronos/vibe-train-sim/issues/40): add an overview map.

## 4. Protect players' maps

- [#66](https://github.com/deadronos/vibe-train-sim/issues/66): save full train state. It changes the save format, so build it on the validation from #3.
- [#36](https://github.com/deadronos/vibe-train-sim/issues/36): add save slots and warnings before work is overwritten.
- [#37](https://github.com/deadronos/vibe-train-sim/issues/37), [#35](https://github.com/deadronos/vibe-train-sim/issues/35) and [#38](https://github.com/deadronos/vibe-train-sim/issues/38): fix the remaining editor bugs.

## Cheap wins for any time

- [#49](https://github.com/deadronos/vibe-train-sim/issues/49): stop sound playing in hidden tabs and in edit mode.
- [#50](https://github.com/deadronos/vibe-train-sim/issues/50): add volume and mute controls.
- [#47](https://github.com/deadronos/vibe-train-sim/issues/47): bundle the fonts.

## Wait on these

- **Large graphics work** ([#18](https://github.com/deadronos/vibe-train-sim/issues/18), [#23](https://github.com/deadronos/vibe-train-sim/issues/23)): do [#19](https://github.com/deadronos/vibe-train-sim/issues/19) first, so there are real numbers from slower hardware to compare against.
- **Deeper physics** ([#56](https://github.com/deadronos/vibe-train-sim/issues/56), [#57](https://github.com/deadronos/vibe-train-sim/issues/57)): these matter more once driving has a score. The autopilot must keep stopping accurately through both.
- **Shunting** ([#64](https://github.com/deadronos/vibe-train-sim/issues/64)): this needs a design note first, because it changes how trains reverse.
