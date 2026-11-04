# Vibe Train Sim

A browser train simulator and map editor built with Three.js and TypeScript. It is a static site with no backend. The project's goal is in [IDEA.md](IDEA.md).

## Commands

```bash
npm run dev     # Start the app
npm test        # Run the simulation tests
npm run build   # Type-check and build
npm run assets  # Rebuild the Blender asset pack
```

Before finishing a code change, run `npm test` and `npm run build`. For anything visual, also look at it in a browser.

## Read when relevant

| Read this | Before you |
| --- | --- |
| [architecture.md](docs/agents/architecture.md) | Change how modules fit together, or touch the rail model, saves or rendering flow |
| [conventions.md](docs/agents/conventions.md) | Write code, interface text, assets or tests |
| [tooling.md](docs/agents/tooling.md) | Run, debug or verify anything, or change dependencies |
| [docs-sync.md](docs/agents/docs-sync.md) | Open a pull request, or find code and docs that disagree |

## Keep docs and code in lockstep

Code and the docs that describe it change in the same commit or pull request. If they disagree, don't leave it: align one to the other, using the rules in [docs-sync.md](docs/agents/docs-sync.md).
