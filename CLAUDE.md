# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Forbidden City Paintball — a browser paintball game: Three.js + Rapier3D,
third-person, single-player against NPC bots. Hand-drawn look — Borderlands
linework over Ghibli colour and light. Nobody dies; hits are counters.

The arena is the Forbidden City, built from the survey: `tools/fetch-osm.mjs`
pulls every building, courtyard wall and watercourse inside the moat from
OpenStreetMap and writes `src/world/CityPlan.ts`, which is 780-odd structures at
their true positions. `CityLayout.ts` owns the ground, the compression to
play scale and `FIELD` — the netted central spine a match is played in, which is
a third of the compound; `CityBuilding.ts` turns a footprint into a building;
`CityCourse.ts` is the paintball kit somebody trucked into the courtyards, and
the netting that closes the field; `CityArena.ts` assembles the lot. Central
Park is gone.

`npm run test:structures` is the cheap check on all of it — no browser, four
seconds — and it is what to run after touching the plan or the generator.

Reference dimensions, with sources, are in `CLAUDE/REFERENCE_FC.md`.

 - `CLAUDE/PROMPT_0.md` is the original brief. 
 - `CLAUDE/PLAN_n.md` is what Claude plan to work on after receiving the prompt or feedback of iteration n
 - `CLAUDE/NEXT_n.md` is what Claude wants to work on next after iteration n is executed
 - `CLAUDE/FEEDBACK_n.md` is human feedback on iteration n (mostly in one session)

In addition, 
 - `CLAUDE/CLAUDE_0.md` is the claude file generated with `/init` after the plan 0 is executed. 

## Instruction

 1. If a single agent is working on the project then update files in this folder directly, but don't stage, commit or push; let me do those after revision. 




