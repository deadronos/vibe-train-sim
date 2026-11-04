# Keeping docs and code in sync

Docs are part of the change. A pull request that alters behaviour, structure or workflow also updates the docs that describe them. Docs-first changes work the same way: if a pull request changes a documented rule, the code follows in that pull request.

## What to update

| When you change                                              | Update                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Module boundaries, rail model, simulation rules, save format | [architecture.md](architecture.md)                               |
| Coding, asset, interface or test rules                       | [conventions.md](conventions.md)                                 |
| Dependencies, scripts, verification steps, or a new gotcha   | [tooling.md](tooling.md)                                         |
| Player-facing features, controls or known limits             | [README.md](../../README.md) and the help dialog in `index.html` |
| A command or a guide's purpose                               | [AGENTS.md](../../AGENTS.md)                                     |
| The project's goal or scope                                  | [IDEA.md](../../IDEA.md)                                         |

## When code and docs disagree

Don't leave a mismatch in place, even if your task didn't cause it. Work out which side is right, then align the other.

**Align the docs to the code** when the code reflects a deliberate decision:

- The change was intended, for example it's in a recent commit, a pull request or a request from the user
- Tests cover the current behaviour
- The doc simply wasn't updated, or describes something that no longer exists

**Align the code to the docs** when the doc states a rule and the code broke it by accident:

- The doc describes an invariant, such as no Three.js in `src/rail/`
- Nothing suggests the change was intended
- The mismatch causes a bug or breaks a boundary

**Ask when it's unclear.** If neither side is clearly right, or either fix would change behaviour players notice, ask the user or raise it in the pull request. Say what each side claims.

Fix a small mismatch as part of your change and mention it. If it's large or unrelated, handle it separately and say where it's being tracked, so it isn't lost.

## Before opening a pull request

- Check the table above against everything the diff touches.
- Confirm that commands, paths and names mentioned in changed docs still exist.
- Say in the description which docs changed, or why none needed to.

## Writing these docs

Agents load `AGENTS.md` every session and these guides only when needed, so keep each one earning its place.

- Keep `AGENTS.md` short: commands, the guide index and the lockstep rule. Put details in a guide.
- Write what the code can't easily tell you: rules, reasons, contracts and gotchas. Don't list every file or restate function signatures.
- Prefer pointing to a source file over copying values that will go stale.
- Add a gotcha when something cost real time to figure out. Remove it when it no longer applies.
- `IDEA.md` records the goal, not current status, so it only changes when the goal does.
