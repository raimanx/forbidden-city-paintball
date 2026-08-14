# Next, after the field

What iteration 7 left behind, roughly in the order I would pick it up.

## Where the numbers landed

| | iteration 6 | iteration 7 |
|---|---|---|
| playable area | 331 × 425m (140,000 m²) | 156 × 268m (42,000 m²) |
| square metres per player | ~15,500 | ~4,600 |
| navgrid cells | 165 × 212 | 78 × 134 |
| navgrid walkable / reachable | 19,019 / 15,007 | 6,343 / 5,334 |
| pruned as unreachable | 21% | 16% |
| buildings with interiors | 0 | 7 |
| box colliders | 2,269 | 2,238 |
| roof colliders | 2,712 hulls | 1,172 hulls |
| triangles (roof/timber/stone) | 76k / 99k / 15k | 92k / 88k / 15k |
| worst median frame | 13.9ms | 13.9ms |
| boot: characters / city | 304ms / 356ms | 135ms / 331ms |
| load to playable | 2.3s | 2.4s |

Checks: 197 across twelve suites (15 + 8 + 9 + 6 + 6 + 19 + 21 + 16 + 23 + 9 + 40 + 25), all passing.

## P0 — the field is a decision, not a measurement

156m by 268m is a judgement about nine players on ground this dense, arrived at
by looking at the plan rather than by playing on it. It is the one thing in this
iteration that wants a person rather than a test, and there are three ways it
could be wrong:

- **Too big still.** The whole outer court — river, five bridges, 70m of paving
  — could go, putting the south boundary at the Gate of Supreme Harmony and
  taking the field to 156 × 145m. That is a different game: much more of it in
  the great court, much less walking.
- **Too small.** The Six Palaces beyond the north end are the best
  close-quarters ground in the compound and the field does not reach them.
- **Wrong shape.** It is a corridor: 268m long and 156m wide, with the terrace
  across the middle of it. Both ends are gates and both flanks are galleries, so
  the fight funnels down the axis whether or not that is wanted.

Changing it is one constant — `CityLayout.FIELD` — and everything else follows,
which was the point of doing it that way.

## P0 — frame rate on a phone is still unmeasured

Third iteration with this at the top. 13.9ms worst median on a desktop RTX 3060
at 1080p, unchanged, and still no occlusion culling: standing in a two-metre
alley submits as many triangles as standing in the great court.

The far-city economy added here — no joinery, no roof colliders, no colliders at
all past the margins in `CityBuilding` — buys load time and 1,500 colliders, not
frame time, because the far city is still *drawn*. The next lever is the one
`NEXT_5.md` named: a far LOD per district, or a distance cull with the fog
brought in to hide the boundary.

## P1 — bots cannot use the interiors

The seven hollow buildings are for the player alone. The navgrid is a
heightfield sampled from `heightAt`, which knows nothing about plinths, so every
cell inside a hall is probed at courtyard height + 0.9m — which is inside the
plinth — and comes back blocked. Bots path round the buildings and never in.

Fixing it properly means the navgrid learning about walkable surfaces above the
terrain: a second height layer, or per-cell "floor" heights taken from the
colliders rather than from the ground function. That is also what the terrace's
own steps, the container roofs and the scaffold decks want, so it is one job
rather than four.

## P1 — the galleries are still solid

The long colonnades lining both courts are the most obviously wrong solid left:
in the real compound they are open on the courtyard side, and running down one
under cover is exactly the movement this map lacks. They are 3m deep before
their walls go on, so the hall treatment does not fit — what they want is
columns on the courtyard side and a wall on the outside, which is both the real
building and a much better piece of ground.

## P2 — the netting is a compromise and looks like one

Its collider is 3m and the netting is 2.4m, because a boundary you can vault is
not a boundary. That gap is the only place on the map where the collision is
taller than the thing you can see. Options, none of them free: make the netting
3m and accept that it looks like a fence rather than tape; put scaffold towers
along it at intervals so the eye reads a line of structures; or cheat the other
way and let a player who vaults it fall into an out-of-bounds respawn.

## P2 — polish, carried

- **The moat is swimmable and looks it.** Nobody can reach it from inside the
  netting now, which lowers the priority rather than fixing it.
- **The archways have no depth.** A gate's opening is still a rectangular hole.
- The cut ends of courtyard walls are flat faces where a real wall would have a
  return or a pier.
- The tile courses stop at the second band of roof. Past the eave they are not
  drawn, which is invisible from the ground and obvious from the terrace looking
  down at a gallery.

## Still unverified from before

`CLAUDE/NEXT_4.md`'s items stand: iOS has never run this, the touch feel has
never been held in a hand, and the round clock still runs while the start card
is up.
