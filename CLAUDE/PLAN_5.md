# Plan 5 — the Forbidden City

The brief in `PROMPT_0.md` at the repo root: throw away the Central Park
environment, build the Forbidden City in its place, as much of the whole map as
possible, modelled from reference in Blender. Keep the art direction and the
gameplay. Stay playable on a current phone and load in three to five seconds.

## What the swap touches

The world layer is well contained. Four things outside `src/world/` know that
the map is a park:

- `src/main.ts` — mounts `ParkArenaSystem`, and holds the player spawn and six
  bot spawn hints.
- `src/ai/NavGrid.ts` — imports `PLAY_HALF`, `WATER_Y`, `heightAt`, `slopeAt`.
- `src/gameplay/LootSystem.ts` — imports `LOOT_SPOTS`.
- The test suites, which probe the map by coordinate: `arena-test`, `bot-test`,
  `ui-test`, `crosshair-test`, `match-test`.

`ParkLayout.ts` is the single source of truth for ground height and colour, and
everything else in the world reads it. So the swap is a new layout module
honouring the same contract, a new arena assembler, a new Blender prop kit and a
new backdrop. The renderer, the paint system, characters, physics, HUD, touch
controls and match rules are not touched.

## Scale — the decision the map hangs on

The Forbidden City is 961m north to south by 753m east to west. At the player's
4.4 m/s walk that is three and a half minutes end to end, and roughly eight
times the current arena's footprint to draw. "The whole map" and "runs on a
phone" pull against each other, and the resolution is to compress the ground
rather than drop any of it:

**The entire walled compound, topologically complete, at half scale.** About
480m by 376m inside the walls, with the moat outside that. Every courtyard,
gate and hall in its correct relative position on the axis. Halls keep close to
true height, so they still read as monumental; it is the courtyards that shrink.

The play area — navgrid, bot spawns, loot — covers the central spine from the
Meridian Gate to the Gate of Divine Prowess plus the courts flanking it. The
outer galleries take over the job the woodland belt does today: somewhere to
wander that makes the map feel larger than the fight. The bot roster goes from
six to eight so half a square kilometre of palace is not empty.

The walls and halls are also a performance gift the park never had. Central Park
is an open bowl where nearly everything is in frame at once; a courtyard city
occludes itself. Standing in the court of the Hall of Supreme Harmony you cannot
see the Inner Court at all.

## Phases

### 0 — Reference

Pull the plan drawing, axis photographs and a dimensions table from the
internet: hall footprints, terrace heights, wall and moat widths, roof pitches,
the dougong bracket module, the colours. Recorded in `CLAUDE/REFERENCE_FC.md`
so every number in the geometry is traceable to a source rather than to memory.

### 1 — `src/world/CityLayout.ts`

Replaces `ParkLayout.ts` behind the same exported contract. Simpler than the
park it replaces: the ground is flat paved brick, so `heightAt` is courtyard
level, plus the three-tier marble terrace under the Three Great Halls, plus the
moat carve, plus Jingshan hill off the north wall. `groundColorAt` becomes grey
brick paving, white marble and the ochre of the ramped approaches, with the same
multi-scale noise that keeps the park's lawns from reading as one flat fill.

`LOOT_SPOTS` re-authored: behind the bronze vats, under the galleries, in the
rockery of the Imperial Garden.

### 2 — The Blender kit

The bulk of the work. A modular set authored through the Blender MCP and
exported as one or two GLBs:

- Roofs: hip (*wudian*) and gable-hip (*xieshan*), with the dougong eave bracket
  course baked into a repeating strip rather than modelled per bracket.
- Red colonnade walls, doors, lattice windows.
- Marble balustrades — baluster and rail, instanced — and the carved ramp slabs
  between stair flights.
- The Meridian Gate's U-plan with its five pavilions.
- The corner towers.
- Perimeter wall segments with battlements.
- The five marble bridges over the Inner Golden Water River.
- Bronze lions, water vats, cauldrons, the sundial and grain measure.
- Cypresses for the Imperial Garden, and the Duixiu rockery.

Budget: two megabytes for the lot, Draco-compressed, everything instanced, and
a low-detail twin of each piece for the far ranks — the same near/far split the
tree system already uses.

### 3 — `src/world/CityArena.ts`

Replaces `ParkArena.ts`. Placement data driven from the layout module, one
`InstancedMesh` per kit piece, and every collider registered with
`SurfaceRegistry` so that anything you can shoot, you can paint. The sun is
re-aimed down the north-south axis so the golden roofs catch it.

### 4 — Backdrop

`Cityscape.ts` becomes Jingshan hill with the Wanchun Pavilion on its crown to
the north — the real view, and the thing that tells you which way you are facing
from anywhere inside — with a low grey hutong roofscape ring elsewhere and haze
beyond. `Water.ts` is reused for the moat and the Golden Water River. `Birds.ts`
survives; `Fountain.ts` does not.

### 5 — Retargeting

Player spawn, eight bot spawns, navgrid extents, the dedication plaque's text.

### 6 — Performance and load

Hard gates, measured rather than asserted:

- First playable within five seconds.
- Two megabytes of models, all in.
- Draw calls under about 120.
- `npm run perf` frame time inside the 60fps budget.

If the kit blows the budget, detail comes out of the outer courts first.

### 7 — Tests

`arena-test`'s probes are rewritten against the new geometry: walkable
everywhere a player can spawn or fight, the terraces climbable, the wall and
moat inescapable, paint sticking to palace surfaces. The four other suites that
probe by park coordinate are audited and moved. The load budget in
`arena-test.mjs` goes from four seconds to five, per the brief.

`movement`, `ballistics` and `paint` run against the test course, which is
untouched, and should pass unchanged.

### 8 — Visual pass

Stills from fixed camera positions along the axis, held against the reference
photographs, iterating on colour, roof silhouette and light.

## Risks

**The dougong brackets.** They are what makes an eave read as Chinese rather
than as a generic pagoda, and they are the most expensive thing per hall. Baking
them to a single eave strip and letting the cel outline sell the complexity is
the plan; if it looks flat, the halls on the axis get real brackets and the
outer courts keep the strip.

**Golden roofs in a cel pipeline** can go garish quickly. The likeliest item to
need several iterations.

**The model budget.** 145KB of props covers the park today. A palace kit is a
different order of magnitude, and two megabytes is the ceiling a five-second
load allows.

## Process

Single agent, no fan-out. Work happens on the `worktree-forbidden-city-world`
branch and is committed there; `main` is left alone for review and merge.
