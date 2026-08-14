

# From Claude

The two test flakes recorded here are fixed. Both were the same thing wearing
different hats: six bots with live triggers wander the whole park, and any
measurement that takes more than a second of simulated time can have one walk
into it.

- ui-test — the lens-drip check waited five simulated seconds for blobs to fade,
  during which a bot could tag the player again and put fresh ones on. The bots
  go to the far corner first now.
- arena-test — the undercroft walk is the one probe that has to follow a line
  rather than fall straight down, and five bots spawn within twenty metres of
  the arch. Same fix.

Also fixed while in there: crosshair-test's "a shot lined up on a bot" check cast
from four metres above the bot and reported the terrace ceiling whenever the bot
wandered into the undercroft. It casts from a metre over the head now.

What is left is in `CLAUDE/NEXT_2.md`. The one item that needs a human rather
than a machine is the ammo economy — see its P0.

# Iteration 3 — the phone

The game plays on a phone now: two thumbs, landscape only, fullscreen on the
first tap. Plan in `CLAUDE/PLAN_3.md`, follow-ups in `CLAUDE/NEXT_3.md`,
tests in `npm run test:touch` (`?touch=1` forces the touch build in a desktop
browser, which is how to try it without a phone).

The item that needs a human here is the *feel*: stick radius, look speed and
button placement are all in the `touch` block of `src/core/Config.ts`, and none
of them has been held in a hand yet. iOS in particular has never run this — it
refuses both fullscreen and orientation lock, so it falls back to the rotate
card, and that path is reasoned about rather than observed.

# Iteration 4 — the playtest fixes

All six items in `CLAUDE/FEEDBACK_3.md` are done: a trigger for each hand, aim
back as a toggle, crouch, wave and scores gone, and the selection wash killed.
For iOS, where Safari has no fullscreen at all, the start card now offers to add
the game to the home screen — one tap where the browser allows it, and the Share
steps spelled out where it does not.

Jump went with the other buttons and then came back: without it, anything
between an autostep and a jump — a bench, a low wall, the fountain lip — is a
wall on a phone. It now sits above the right trigger. An auto-hop was tried in
its place first; `CLAUDE/NEXT_4.md` records why the button won.

Plan in `CLAUDE/PLAN_4.md`, consequences in `CLAUDE/NEXT_4.md`.

# Iteration 5 — the Forbidden City

Central Park is gone. The map is now the Forbidden City: 802 structures inside
the moat at their surveyed positions, pulled from OpenStreetMap by
`tools/fetch-osm.mjs` and generated from their footprints — plinth, red wall,
painted frieze, bracket course, lattice doors, golden hipped roof. The wall, the
moat, the great marble terrace, the four corner towers and Jingshan behind the
north wall are built from `CityLayout`; the vats, lions, rockery and cypresses
come from Blender in a 78KB prop set.

Plan in `CLAUDE/PLAN_5.md`, dimensions and their sources in
`CLAUDE/REFERENCE_FC.md`, consequences in `CLAUDE/NEXT_5.md`.

The whole suite passes — 181 checks across eleven files, with the arena tests
rewritten for this map and `tools/geometry-test.mjs` added after a face-winding
bug that cost an afternoon and was invisible in every screenshot.

Two things that want a human rather than a machine:

- **Frame rate on a phone.** 73fps worst-case median on a desktop RTX 3060 at
  1080p, which is inside the budget, but there is no occlusion culling: standing
  in an alley two metres wide submits as many triangles as standing in the great
  court. See `CLAUDE/NEXT_5.md` for what to do about it.
- **A quarter of the compound is sealed.** The enclosed courtyards of the Six
  Palaces are entered through gates the survey does not carry, so the navgrid
  prunes them. Every alley and every major court is reachable; the private
  courtyards inside them are not.
