# Plan 6 — the compound as a solid

`CLAUDE/FEEDBACK_5.md`, in the order it was written:

1. Buildings float.
2. Structures intersect each other.
3. Players can walk into structures.
4. Not every surface takes paint.
5. Nothing in the courtyards says a paintball match is being played here.

The first four are one complaint wearing four hats. The city was generated from
798 traced outlines and never checked against itself: a footprint is placed, a
roof is fitted to it, and nothing ever asked whether the thing underneath is on
the ground, whether the thing beside it is in the same cubic metre, or whether
the collider matches what was drawn. Every one of those failures is invisible in
a screenshot from the axis and obvious the moment you walk at one, which is
exactly the class of bug a machine should be finding.

So the shape of this iteration is: **a test that can see them, then the fixes**.

## The test first — `tools/structure-test.mjs`

A Node suite that loads the real world modules through Vite's SSR loader and
builds all 783 structures the way the arena does, then asserts:

- every structure's lowest drawn vertex reaches the ground under it, or the
  platform it stands on;
- no building's collider intersects another building's;
- every building is solid from the pavement to head height;
- every gate has a gap wide enough to walk through, and piers either side of it.

No browser and no physics, so it runs in seconds and can be pointed at every
structure rather than at a handful of probes. What it cannot see — that the
player is actually stopped, that paint actually lands — stays in the browser
suites, which grow the cases for the course and for paint coverage.

## The four fixes

**Floating.** 38 structures, and 35 of them gates. A gate gets no plinth — a
step across the archway is something to hop over to walk through your own gate —
and its piers were being started at the plinth line all the same, so every gate
in the compound hung 0.9m up with clear air underneath it, which is also why a
player could walk under the Meridian Gate anywhere along its frontage rather
than through its arches. Gates get a stone base course down to the lowest ground
under them. Platforms and courtyard-wall runs get the same treatment: levelled
on the highest ground under them, reaching down to the lowest, instead of taking
the height at their centre point.

**Intersections.** 489 pairs, in four groups, each with its own answer:

- *Enclosures traced as buildings.* Fixed in `tools/fetch-osm.mjs`: anything
  with 墙 in its name is a wall, and a footprint with two or more other
  structures standing inside it is the wall around them, not a building.
- *The survey saying the same thing twice.* Dropped, keeping the ranked and
  named one of each pair.
- *Eaves overlapping by a metre or two.* Trimmed, the lesser building giving way
  along whichever axis it is losing by less.
- *Courtyard walls running through buildings* — 265 of the 489, and the one that
  is not a data error. In the real compound a wall runs between buildings and
  stops at the gable of each, so the runs are now cut where a building stands in
  them. Which also opens several hundred more ways through the maze.

**Walking into things.** Falls out of the first fix, plus the collider audit the
test performs.

**Paint.** Two failures. Geometry is merged by material — tile, timber, stone —
and colliders were registered against whichever single mesh the district
happened to have, so a splat on any stone or tiled face found no triangles under
it and was dropped silently. Colliders now carry the surface they were drawn in
and register against all three, best first. And roofs had no collider at all: a
box around an eave that overhangs 2.4m is an invisible ceiling out over the
courtyard, so they are convex hulls of the roof's own bands instead.

## The fifth item — the course

`src/world/CityCourse.ts`. Somebody has hired the place for the afternoon: 20ft
containers with a door cut in one end and a firing slit down one side, scaffold
towers with a plank deck and a pallet stair, plywood barricades, crate stacks,
cable drums, oil drums and a canopy over the staging table. Dealt into the six
courtyards worth fighting in from the seeded rng, with anything that lands on a
building, a terrace skirt, the river or the imperial way rejected.

Two things they are for. The compound is superb at sightlines and hopeless at
cover — the great court is ninety metres of flat brick — and the container is
the only structure on the map with an inside.

## What is deliberately not in this iteration

`CLAUDE/NEXT_5.md`'s performance work: there is still no occlusion culling and no
far LOD, and the frame budget has not been measured on a phone. Nothing here
makes that worse — the roof colliders cost no triangles — and it wants a phone
in a hand rather than another pass over the geometry.
