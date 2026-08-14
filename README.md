# Forbidden City Paintball

A browser paintball game — Three.js + Rapier3D, third-person, single-player
against NPC bots. Hand-drawn look. Nobody dies; hits are counters.

The map is the Forbidden City: all 800-odd structures inside the moat, at their
surveyed positions, from the Meridian Gate up the axis to the Imperial Garden.
The plan comes from OpenStreetMap — see `tools/fetch-osm.mjs` — and the
buildings are generated from their footprints rather than modelled, because no
two of them are the same size.

**Play it: https://raimanx.github.io/forbidden-city-paintball/**



## Setup

```bash
npm install 
npm run dev
```

## Test

```bash
npm run build && npm run preview
```

In another shell
```bash
npm test
```


## The project is started with 

```bash
npm create vite@latest <project name> -- --template vanilla
npm create vite@latest . -- --template vanilla
```

```bash
claude mcp list
claude mcp add blender uvx blender-mcp
claude --dangerously-skip-permissions
```

### prompts

> I want you to make a web based paintball game. Have a read of PROMPT.md and come up with a plan on how you'd implement this project.



## Backed by

Man & Bot ®
