# Next issues

Suggested order for the review issues, written on 2026-11-04 and updated on 2026-11-16. Groups 1 to 4 and the cheap wins are done.

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

## Physics batch (done)

[#67](https://github.com/deadronos/vibe-train-sim/issues/67), [#57](https://github.com/deadronos/vibe-train-sim/issues/57), [#56](https://github.com/deadronos/vibe-train-sim/issues/56), [#61](https://github.com/deadronos/vibe-train-sim/issues/61) and [#66](https://github.com/deadronos/vibe-train-sim/issues/66) were done ahead of group 3. Rolling back, part of #56, waits for [#64](https://github.com/deadronos/vibe-train-sim/issues/64).

## 3. Make driving a game (done)

[#44](https://github.com/deadronos/vibe-train-sim/issues/44), [#59](https://github.com/deadronos/vibe-train-sim/issues/59), [#58](https://github.com/deadronos/vibe-train-sim/issues/58), [#41](https://github.com/deadronos/vibe-train-sim/issues/41) and [#40](https://github.com/deadronos/vibe-train-sim/issues/40) landed in #74, #78 and #79.

## 4. Protect players' maps (done)

[#36](https://github.com/deadronos/vibe-train-sim/issues/36) landed in #76, and the editor bugs [#35](https://github.com/deadronos/vibe-train-sim/issues/35), [#37](https://github.com/deadronos/vibe-train-sim/issues/37) and [#38](https://github.com/deadronos/vibe-train-sim/issues/38) in #77.

## Cheap wins (done)

[#49](https://github.com/deadronos/vibe-train-sim/issues/49), [#50](https://github.com/deadronos/vibe-train-sim/issues/50) and [#47](https://github.com/deadronos/vibe-train-sim/issues/47) landed in #75.

[#60](https://github.com/deadronos/vibe-train-sim/issues/60) landed in #84, #85 and #86, and [#42](https://github.com/deadronos/vibe-train-sim/issues/42) with the small-screen layouts after them. Real phones still need a try: emulated sizes don't show touch feel or performance.

## Partly done

- [#20](https://github.com/deadronos/vibe-train-sim/issues/20): the listed allocation sources are fixed (#80). Still needs an allocation profile before and after.
- [#19](https://github.com/deadronos/vibe-train-sim/issues/19): quality applies live, Auto adapts to frame rate, and `?debug` shows a perf overlay (#81). Still needs measurements on a low-end laptop and a phone.
- [#46](https://github.com/deadronos/vibe-train-sim/issues/46): keyboard and screen reader fixes are in (#82). Still needs an axe or Lighthouse audit and a contrast check.

## 5. Next

1. [#62](https://github.com/deadronos/vibe-train-sim/issues/62) and [#63](https://github.com/deadronos/vibe-train-sim/issues/63): more signal types and level crossings of lines, which build on the strict rules.

## Wait on these

- **Large graphics work** ([#18](https://github.com/deadronos/vibe-train-sim/issues/18), [#23](https://github.com/deadronos/vibe-train-sim/issues/23)): measure first with the `?debug` overlay on slower hardware.
- **Shunting** ([#64](https://github.com/deadronos/vibe-train-sim/issues/64)): this needs a design note first, because it changes how trains reverse.
