# Next, after the solids pass

What iteration 6 left behind, roughly in the order I would pick it up.

## Where the numbers landed

| | iteration 5 | iteration 6 |
|---|---|---|
| structures | 802 | 783 |
| floating structures | 38 | 0 |
| intersecting pairs of buildings | 489 | 0 |
| navgrid walkable / reachable | 17,914 / 13,420 | 19,019 / 15,007 |
| pruned as unreachable | 25% | 21% |
| box colliders | ~2,180 | 2,269 |
| roof colliders | none | 2,712 hulls |
| worst median frame | 13.7ms | 13.9ms |
| load to playable | 2.2s | 2.3s |

Checks: 191 across twelve suites (15 + 8 + 9 + 6 + 5 + 14 + 21 + 16 + 23 + 9 + 40 + 25), all passing.

## P0 — a fifth of the compound is still sealed

Down from a quarter, and it did not get there the way `NEXT_5.md` expected. Two
changes did the work, neither of them the gates the survey is missing:

- Courtyard-wall runs are cut where a building stands in them, which is what the
  real walls do and which opens every courtyard whose gate-house the survey
  *does* carry.
- Runs now get a doorway roughly every eighteen metres rather than one in the
  middle of each side. A courtyard whose single door opens into another sealed
  courtyard is still sealed, and the compound is full of nested ones.

What is left is the same 4,000 cells: enclosures the survey traces as closed
outlines with nothing inside them the clipping can catch. The honest fix is
still the one from before — find the gates in Overpass, where they are often
nodes on the wall rather than ways — and the check is still `reachableCount`
against `walkableCount` in `tools/bot-test.mjs`.

Worth knowing before anyone tunes this further: the doorway width is sized for
the navgrid, not the eye. Cells are 2m and each is probed at five points, so an
opening much under three metres straddles two cells and both come back blocked.
That is why `DOOR` is 2.6 and why the gate archways have a floor as well as a
cap on their width.

## P0 — frame rate on a phone is still unmeasured

Unchanged from `NEXT_5.md`, and still the biggest unknown in the project. The
worst median is 13.9ms on a desktop RTX 3060 at 1080p — 72fps, inside the
16.67ms budget, and within noise of iteration 5's 13.7ms despite 2,712 new
colliders, because a collider costs no triangles.

The shape of the cost has not changed either: standing in a two-metre alley
costs as much as standing in the great court, because there is no occlusion
culling. `NEXT_5.md`'s two suggestions — a far LOD per district, and a distance
cull with the fog brought in to hide the boundary — both still stand.

## P1 — the course is placed by rule, not by hand

27 pieces across six courtyards, and every one of them is somewhere the plan
says is open ground. That is the right way to *keep* them off the buildings, and
it is not the same thing as placing them well: nothing here knows about lines of
sight, about which way people run into a court, or about pairing a container
with the barricade that makes approaching it a decision. A playtest would
probably move half of them two metres and delete three.

The pieces themselves have obvious gaps too. There is no netting, nothing is
rotated off the cardinals (the colliders are axis-aligned boxes, so a diagonal
container would need a rotated collider — `PhysicsWorld.createStaticBox` already
takes a rotation, `createStaticBoxes` does not), and the container's interior is
unlit, which is atmospheric until you are the one standing in it.

## P1 — the eave is a hull, and the lip is not

Roof colliders are convex hulls of each band of the roof, from the eave ring
upward, and they stop at a floor 1.95m over whatever the building stands on so
that nobody walks their head into a gallery's eave from the courtyard. Two
consequences:

- The flying lip — the outermost 7% of the roof, which tilts down and out — has
  no collider. A ball fired at the very edge of an eave passes through it and
  hits the wall behind.
- On the lowest galleries the first band or two are below the floor line and are
  skipped, so the bottom of those roofs is not paintable either.

Both are cheap to fix and neither is worth fixing blind: the question is whether
anyone notices, and that wants a person shooting at eaves rather than another
test.

## P2 — the survey is a moving target

`src/world/CityPlan.ts` was regenerated this iteration, and the Imperial Garden
had vanished from OpenStreetMap since the last pull — which was a gift, since it
had been a 139m by 96m solid with three pavilions buried in it. The generator's
new rules assume it will come back one day: the containment rule that turns a
footprint with two structures inside it into an enclosure currently fires zero
times, and is kept as a guard rather than as a fix.

Anyone re-running `tools/fetch-osm.mjs` should expect the plan to move under
them, and should run `npm run test:structures` immediately afterwards — it is
four seconds and it is the only thing that will notice.

## P2 — polish, in rough order of what would show

Carried from `NEXT_5.md`, all still true:

- **The moat is swimmable and looks it.**
- **Roof tiles have no courses**, so the gold reads flat at a distance.
- **The archways have no depth** — better than iteration 5, since a gate now has
  a stone base and its opening reaches the ground, but the arch is still a
  rectangular hole rather than an arch.
- The cut ends of courtyard walls are flat faces. A real wall that stops at a
  building has a return or a pier; ours has a section drawing.

## Still unverified from before

`CLAUDE/NEXT_4.md`'s items stand: iOS has never run this, the touch feel has
never been held in a hand, and the round clock still runs while the start card
is up.
