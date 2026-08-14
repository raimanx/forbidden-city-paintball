# Plan 7 — the field, and the inside of a hall

`CLAUDE/FEEDBACK_6.md`:

1. Shrink the map, and keep a core playing area fit for the number of players.
2. Make the buildings more detailed — and give them interiors players can go
   inside.
3. The long strip in the middle of the biggest open area still does not accept
   paint.
4. There is a wall in the middle of the giant stair that a player can walk
   inside.

Two of these are ten-line bugs and two are the shape of the map. The bugs first,
because they are the ones that have been wrong for two iterations.

## 3 and 4 — two things drawn and never collided

Both are the same mistake in the same file. `CityArena` draws the **imperial
way** — the strip of pale stone down the axis, the longest and most-walked line
on the map — as geometry with no collider under it. Balls passed through it into
the terrain, and a splat projected onto ground 12cm *below* the strip is a splat
hidden by the strip. The **dragon ramp** up the middle of the terrace stairs is
the same: drawn, never collided, so the one object standing in the middle of the
biggest staircase in the compound was something a player walked into and then
stood inside. Both get colliders, both get a test, and the stairs move onto the
imperial way's centreline while I am there — they were 1.8m off it, which is why
the ramp looked like a wall dropped into the stair rather than the axis
continuing up it.

## 1 — the field

The walled compound is 331m by 425m. Nine players in 140,000 square metres is
nobody in it: two minutes of walking between contacts, and whole quarters that
go a round without anyone in them.

So the match is bounded to the compound's central spine — `CityLayout.FIELD`,
156m by 268m, about 4,600 square metres a player — and the rest of the palace
becomes scenery you can see and shoot at but not walk into. What is inside it is
the whole composition and the best of the ground: the Meridian Gate, the outer
court with the Golden Water River and its five bridges, the Gate of Supreme
Harmony, the great court, the terrace and the three great halls, the flanking
belvederes and side gates, and the Gate of Heavenly Purity across the north end.

Two thirds of that boundary is the palace itself — the two great gates close the
ends, and much of both flanks is gallery wall. The rest is **debris netting on
scaffold posts with hazard tape above it**, which is what anybody running a game
in a hired space actually puts up, and the one boundary that can be honest
without being ugly: you can see the Forbidden City through it and be in no doubt
that the ground beyond is not yours.

Everything that knows where the game happens moves onto it: the navgrid, the
bot spawns, the loot spots, the course zones and the arena tests. And three
things get spent on proximity instead of on all 783 structures — joinery, roof
colliders, and colliders at all — which is the far LOD `NEXT_5.md` asked for,
arriving as a side effect.

## 2 — insides

Seven buildings near the field are now **hollow**: walls with doorways through
them, a stone floor, a timber ceiling, a row of columns, and stone steps up the
0.9m plinth, which is twice what a player can climb. The Hall of Supreme
Harmony, the Hall of Preserving Harmony, both belvederes on the great court, and
the halls of Literary Glory and Military Prowess. A hall's architecture is an
open front and a hall you walk into, so this is also the truer building.

And a detail pass on everything inside the netting, because the same distance
rule that lets the far city go plain is what pays for it:

- **筒瓦**, the barrel tile courses, as a raised rib per course on the band of
  roof nearest the eave — most of what makes gold read as gold;
- **匾额**, the name board over each hall's central doorway;
- **门钉**, the gold studs on the doors, and mullions on the lattice windows;
- plinths that actually carry their walls. At 94% of the footprint a small
  building's plinth came out narrower than the wall standing on it, leaving a
  hand's breadth of wall with nothing under it the whole way round.

## What is deliberately not in this iteration

The **galleries** are still solid. The long colonnades that line the courts
would be the best cover on the map if you could run down them, and they are the
obvious next interior — but they are 3m deep before their walls, so they want a
different treatment from a hall: columns on the courtyard side rather than a
wall with doors in it.

And **occlusion culling** still does not exist. The far-city economy here helps
load time and collider count rather than frame time, and the phone remains
unmeasured.
