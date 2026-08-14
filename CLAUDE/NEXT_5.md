# Next, after the Forbidden City

What iteration 5 left behind, roughly in the order I would pick it up.

## P0 — a quarter of the compound is sealed

The navgrid finds 17,914 walkable cells and prunes 4,494 of them as
unreachable. The pruned quarter is the enclosed courtyards of the Six Eastern
and Six Western Palaces: the survey traces each as a closed outline, and the
gates that pierce them in real life are not tagged, so the enclosure comes out
as a box. Every alley between the quarters is reachable, and so is every court
on the axis — but the private courtyards inside them are not, and two bots used
to spawn in one and stand still for the whole round.

The stopgap is in: long courtyard-wall runs get a 5m doorway cut through the
middle of them, and a bot whose spawn cannot be snapped falls back to a random
reachable point. What is actually wanted is the gates. Two ways to get them:

1. **From the survey.** Overpass has more than `way["barrier"]`; the gates of
   the inner palaces are often tagged as nodes on the wall, or as small
   buildings whose names end in 门. `tools/fetch-osm.mjs` already reads the
   name suffix — it just does not look for gates *on* a courtyard wall.
2. **By construction.** Where a courtyard's outline is crossed by the axis of
   another courtyard's opening, put a gate there. Cheaper, less faithful, and
   guaranteed to connect.

Either way the check is the one that already exists: `reachableCount` against
`walkableCount` in `tools/bot-test.mjs`.

## P0 — frame rate on a phone is still unmeasured

`npm run perf` gives a worst-case median of 13.7ms — 73fps — on a desktop
RTX 3060 at 1080p, which is inside the 16.67ms budget. Nobody has run it on a
phone, and the shape of the cost is the worrying part:

```
  spot              median    p95     worst   calls    tris
  great-court       12.50     22.20   52.20   272      765k
  palace-alley      13.70     16.10   44.70   261      809k
```

**Standing in an alley two metres wide costs as much as standing in the largest
courtyard on the map.** That is frustum culling doing its job and occlusion
culling not existing: the districts in front of the player are submitted whether
or not there is a wall between them, and in a courtyard city there almost always
is. The three render passes — main, shadow, ink prepass — then multiply it.

Two things worth trying, cheapest first:

- **A far LOD per district.** Run `buildStructure` twice, once with the joinery
  and once with masses only, and swap on distance. The joinery — brackets,
  lattice, frieze panels, ridge beasts — is most of the triangle count and none
  of it resolves past about 80m. Memory doubles for the city's geometry, which
  is 170k triangles, so it is affordable.
- **A distance cull on districts.** One line, and it buys a lot, but the
  boundary pops unless the fog is brought in to hide it — and the fog cannot come
  in far without swallowing Jingshan, which is the one thing on the map that
  tells you which way you are facing.

## P1 — the map is bigger than the roster

Eight bots over 331m by 425m is thin. It reads fine in the great court and along
the axis, but whole quarters can go a round without anybody in them. Either the
roster grows to twelve, or the match wants a smaller active zone that moves —
which is a design decision rather than a tuning one, and wants a playtest.

## P1 — the terrace is the only high ground

The compound is flat by nature, and the great terrace is the one place with a
height advantage. The real place has two more that would play well and are
already in the plan: the **wall walk** — the perimeter wall is 8.6m thick and
people walk along it — and the **corner towers**, which stand on it. Getting up
there wants stairs at the gates, and the wall would need a walkable top surface
in `heightAt` rather than being a collider.

## P2 — polish, in rough order of what would show

- **The moat is swimmable and looks it.** Walk in and you stand on the bed two
  metres under, with the water plane drawn over the whole frame. The park had
  the same behaviour in its lake, so this is inherited rather than new, but the
  moat rings the entire map and a player will find it in the first minute.
- **Roof tiles have no courses.** The roofs are flat-shaded planes; the real
  ones are barrel tiles in strong vertical ridges, which is most of what makes
  the gold read as gold at a distance. A vertex-colour stripe along the slope
  would cost nothing.
- **The archways have no depth.** A gate's opening is a gap between two piers
  with a dark lintel over it. A real arch, even four flat faces of one, would be
  visible on every approach.
- **The Golden Water River wants its five bridges.** The layout has them —
  `RIVER_BRIDGES` — and the water mask already parts for them, but nothing
  builds the marble parapets, so they read as gaps rather than as bridges.

## Still unverified from before

`CLAUDE/NEXT_4.md`'s items stand: iOS has never run this, the touch feel has
never been held in a hand, and the round clock still runs while the start card
is up. None of them were touched by this iteration.
