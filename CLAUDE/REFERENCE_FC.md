# Reference — the Forbidden City

Everything the geometry is built from, with its source. Nothing in
`CityLayout.ts` or the Blender kit should carry a number that is not either
here or derived from here.

## Sources

- **OpenStreetMap**, via the Overpass API — building footprints, the moat, the
  city wall and the courtyard walls, with real coordinates. This is the spine of
  the layout: every hall below sits at its true surveyed position, not at a
  position estimated from a plan drawing. Re-fetch with `tools/fetch-osm.mjs`.
- **English and Chinese Wikipedia**, the Palace Museum and Chinese architectural
  sources — heights, materials and the numbers OSM has no field for.

## The frame

Local metric coordinates, origin at the **Hall of Supreme Harmony**
(39.91556 N, 116.39083 E), converted with an equirectangular projection at that
latitude. Axes match the game's convention:

- **+X east**, **−X west**
- **−Z north**, **+Z south**

The whole compound is aligned to the cardinal axes to within a fraction of a
degree, so the projection introduces no meaningful skew.

## Overall

| | metres | source |
|---|---|---|
| North–south, outer wall | 961 | Wikipedia |
| East–west, outer wall | 753 | Wikipedia |
| Interior, wall face to wall face | ~708 E–W × ~926 N–S | OSM |
| Wall height | 7.9 (Wikipedia) / 10 (Chinese sources) — **build at 9** | both |
| Wall thickness | 8.62 at base, tapering to 6.66 at top | Wikipedia |
| Moat | 52 wide, 6 deep | Wikipedia |
| Moat outer bounds | 940 E–W × 1148 N–S, centred 126m north of Taihedian | OSM |
| Corner towers | 27.5 tall, triple eaves, cross-ridge roof, 72 ridges | Chinese sources |
| Surviving buildings | 980, 8,886 bays | Wikipedia |

## The central axis, south to north

True positions from OSM. `z` is metres north (negative) or south (positive) of
the Hall of Supreme Harmony; `w × d` is the footprint's east–west by
north–south extent, eaves included, which runs a few metres over the quoted
structural dimensions.

| Structure | 中文 | z | w × d |
|---|---|---|---|
| Meridian Gate | 午门 | +382 | 190.6 × 110.6 |
| Inner Golden Water River | 内金水河 | +253 | 199.4 × 42.4 |
| Gate of Supreme Harmony | 太和门 | +177 | 71.8 × 53.4 |
| Gate of Pure Standards | 贞度门 | +179 (x −58) | 27.0 × 55.8 |
| Gate of Righteous Conscience | 昭德门 | +175 (x +69) | 27.0 × 55.8 |
| **Hall of Supreme Harmony** | 太和殿 | −37 | 68.0 × 41.3 |
| Hall of Central Harmony | 中和殿 | −100 (est.) | ~25 × 25 |
| Hall of Preserving Harmony | 保和殿 | −160 | 53.3 × 28.7 |
| Gate of Heavenly Purity | 乾清门 | −252 | 37.3 × 32.2 |
| Palace of Heavenly Purity | 乾清宫 | −354 | 51.7 × 28.4 |
| Hall of Union | 交泰殿 | −391 | 21.9 × 22.2 |
| Palace of Earthly Tranquility | 坤宁宫 | −423 | 50.0 × 24.0 |
| Gate of Earthly Tranquility | 坤宁门 | −460 | 20.7 × 14.6 |
| Imperial Garden | 御花园 | −508 | 138.7 × 95.5 |
| Hall of Imperial Peace | 钦安殿 | −530 | 24.1 × 14.1 |
| Wanchun Pavilion | 万春亭 | −511 (x +34) | 17.3 × 18.1 |
| Gate of Divine Might | 神武门 | −596 | 115.3 × 27.6 |

The three-tiered marble terrace under the great halls is the unnamed 133.7 × 80
footprint at z +14 in OSM, which is its southern apron; the terrace proper runs
from roughly z +30 to z −190, carrying all three halls.

## The flanks

East, in order from the south: the Imperial Carriage Store (銮驾库), the
Archive of Veritable Records (实录库) and Red Book Store (红本库), the Gate of
Helping Harmony (熙和门), the **Hall of Literary Glory** (文华殿, x +192, z +142,
37.4 × 50.5) with the Pavilion of Literary Profundity (文渊阁) behind it, the
Belvedere of Embodying Benevolence (体仁阁, x +103, z +68), the East Glorious
Gate (东华门, x +374, z +206) in the east wall, and the Royal Kitchen.

West, mirrored: the Gate of Brave Martial Arts (武英门), the **Hall of Military
Prowess** (武英殿, x −214, z +157, 38.5 × 53.0), the Baoyun Building (宝蕴楼),
the Belvedere of Spreading Righteousness (弘义阁, x −101, z +77), the Imperial
Household Department (内务府), and the West Glorious Gate (西华门) in the west
wall.

The Six Eastern and Six Western Palaces (东六宫 / 西六宫) fill the ground either
side of the Inner Court north of z −250, as dense grids of walled courtyards
around 40 × 60m each — the best close-quarters ground on the map.

## Beyond the walls

**Jingshan** (景山) sits directly on the axis north of the moat: park wall from
z −714 to z −1252, x −261 to +185, with the artificial hill rising 45.7m and the
**Wanchun Pavilion** (万春亭) on its crown. It is the view that orients you from
anywhere in the compound and the single most important thing in the backdrop.
Shouhuang Palace (寿皇殿, 142 × 155) stands behind it at z −1171.

## Materials and colour

| Element | Treatment |
|---|---|
| Roofs | Yellow glazed tile (imperial). Black on the Pavilion of Literary Profundity — a library, black being the water colour. Green on crown-prince buildings. |
| Walls | Cinnabar red, battered slightly, over a grey stone plinth |
| Columns and doors | Cinnabar red; doors studded with gilt bosses, nine by nine on the great gates |
| Under-eave beams | Polychrome *hexi* painting — blue, green, white and gold, on a dark ground |
| Terraces, balustrades, bridges | White marble, with carved dragon ramp slabs on the axis |
| Courtyard paving | Grey fired brick, laid in courses; "golden bricks" (金砖) on the great courts |
| Perimeter wall | Red-purple, with a grey stone base and grey battlements |
| Roof statuettes | Ten on the Hall of Supreme Harmony — unique; fewer, in odd numbers, elsewhere |

## Scale for the game

The compound is 961 × 753m. At the player's 4.4 m/s walk that is three and a
half minutes end to end, which is dead time in a paintball match, so the map is
compressed — but not uniformly, because uniform shrinking makes a balustrade a
kerb and a doorway a hatch.

- **Buildings: 0.70 uniform.** The Hall of Supreme Harmony becomes 45 × 26m and
  24m tall — thirteen times the player's height, which still reads as
  overwhelming — while its steps, railings and door openings stay within a
  stride of human scale.
- **Distances: 0.42.** Courtyards compress harder than the buildings in them,
  which is exactly right: the real courts are ceremonial voids and a paintball
  map wants a crossing you can make under fire.

The interior lands at about **297 × 389m**, which is the same footprint as the
Central Park map it replaces — a map already known to run on a phone — while
occluding vastly more of itself. The court between the Gate of Supreme Harmony
and the great hall comes out at 63m deep, down from 167m: still the longest
sightline in the game.
