/**
 * Regenerates `src/world/CityPlan.ts` from OpenStreetMap.
 *
 * The Forbidden City is a surveyed place, and guessing where its halls stand
 * when the real coordinates are a public download would be daft. This pulls
 * every building, wall and watercourse inside the moat from the Overpass API,
 * projects it into the game's metric frame, classifies it, and writes the
 * result out as a TypeScript module.
 *
 * The output is committed, so the build never touches the network. Re-run this
 * only when the plan needs to change:
 *
 *   node tools/fetch-osm.mjs               # fetch and rewrite
 *   node tools/fetch-osm.mjs --dry         # print the summary, write nothing
 *   node tools/fetch-osm.mjs --from x.json # reuse a saved Overpass response
 *
 * The fetch shells out to curl rather than using `fetch`, because Node's own
 * client is blocked in some sandboxes that let curl through, and re-running
 * this on a machine where that is true should not be a puzzle.
 *
 * Coordinates are metres in the game's frame: origin at the Hall of Supreme
 * Harmony, +X east, -Z north. Scaling to play size happens in CityLayout, not
 * here — this file stays true to the survey so the two decisions never get
 * tangled.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

/** Generous enough to take in Jingshan and the whole moat. */
const BBOX = [39.9095, 116.3875, 39.9280, 116.4045];

const QUERY = `[out:json][timeout:180];
(
  way(${BBOX.join(',')})["building"];
  way(${BBOX.join(',')})["historic"];
  way(${BBOX.join(',')})["barrier"];
  way(${BBOX.join(',')})["waterway"];
  way(${BBOX.join(',')})["natural"="water"];
);
out geom;`;

// Origin: the Hall of Supreme Harmony. Equirectangular projection at that
// latitude — the compound is 1km across and aligned to the cardinals, so the
// error against a proper projection is centimetres.
const LAT0 = 39.91556;
const LON0 = 116.39083;
const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos((2 * LAT0 * Math.PI) / 180);
const M_PER_DEG_LON = 111412.84 * Math.cos((LAT0 * Math.PI) / 180);

/**
 * Wall face to wall face, from the OSM city-wall segments, with the south edge
 * pushed out to 400 so the Meridian Gate — which straddles the wall rather than
 * standing inside it, centroid at z 382 — is not filtered out of its own city.
 */
const INTERIOR = { minX: -360, maxX: 360, minZ: -600, maxZ: 400 };

/**
 * Structures OSM does not have, added by hand from published dimensions.
 *
 * Kept deliberately short. Every entry here is a claim the survey cannot check,
 * so it has to be something whose absence would be obvious to anyone who has
 * seen a photograph of the place.
 */
const SUPPLEMENT = [
  // The middle of the three great halls, and the one hole in OSM's axis. Square
  // in plan with a pyramidal roof and a gilt finial, on the same terrace as its
  // neighbours, midway between them.
  {
    zh: '中和殿', en: 'Hall of Central Harmony', kind: 'hall', roof: 'pyramid',
    height: 19, x: -3, z: -100, w: 24.6, d: 24.6,
  },
  // The four corner towers — 角楼 — which OSM does not carry either, and which
  // are the single most photographed thing about the place: 27.5m, three tiers
  // of eaves, a cross-shaped ridge and seventy-two of them in total. They stand
  // *on* the wall at its four corners, so their positions are the wall
  // rectangle's corners rather than anything the survey has to say.
  //
  // 480.5 and 376.5 are the wall's half-extents in real metres; the origin of
  // these coordinates is the Hall of Supreme Harmony, 127m south of the
  // compound's centre.
  ...[
    ['南东角楼', 'South-East Corner Tower', 376.5, 353.5],
    ['南西角楼', 'South-West Corner Tower', -376.5, 353.5],
    ['北东角楼', 'North-East Corner Tower', 376.5, -607.5],
    ['北西角楼', 'North-West Corner Tower', -376.5, -607.5],
  ].map(([zh, en, x, z]) => ({
    zh, en, kind: 'tower', roof: 'triple', height: 27.5,
    x, z, w: 24, d: 24,
  })),
];

/**
 * What a footprint is, decided from its tags and the last character of its
 * Chinese name — which in this vocabulary is a reliable building type:
 * 殿 a hall, 宫 a palace, 门 a gate, 阁/楼 a multi-storey pavilion, 亭 a kiosk.
 */
function classify(tags, w, d) {
  const zh = tags.name ?? '';
  const en = tags['name:en'] ?? '';
  const last = zh.slice(-1);
  const area = w * d;

  if (tags.barrier === 'city_wall' || tags.historic === 'citywalls') return 'citywall';
  if (tags.natural === 'water' || tags.waterway) return 'water';
  // Anything with 墙 anywhere in its name is a wall, not a building. Anchoring
  // this to the start of the name — which is what it used to do — let 四合院墙1
  // through as a `range`, and a 62m square courtyard wall built as a range is a
  // solid red block with the Hall of Heroic Splendour inside it.
  if (tags.barrier === 'wall' || tags.building === 'wall' || zh.includes('墙')) {
    return 'courtwall';
  }
  if (tags.historic === 'city_gate' || /Gate$/.test(en) || last === '门') return 'gate';
  // A big unnamed footprint on the axis is not a hall — every hall that size has
  // a name. It is the raised stone platform a group of halls stands on, traced
  // as a building because that is the only tag OSM has for it. Built as a hall
  // it becomes a red wall 60m long across the middle of the compound.
  if (!zh && !en && area > 3000) return 'platform';
  if (last === '亭') return 'kiosk';
  if (last === '阁' || last === '楼' || /Pavillion|Pavilion|Belvedere|Tower/i.test(en)) return 'tower';
  if (last === '殿' || last === '宫' || /^Hall|^Palace/.test(en)) return 'hall';
  // Everything else: the long low ranges of galleries, stores and offices that
  // make up most of the compound's floor area.
  return area > 900 ? 'range' : 'gallery';
}

/** Roof form. The great halls carry hipped roofs; lesser ranges gable-hip. */
function roofOf(kind, area, zh) {
  if (kind === 'kiosk') return 'pyramid';
  if (kind === 'tower') return 'double';
  if (kind === 'citywall' || kind === 'courtwall' || kind === 'water') return 'none';
  if (kind === 'platform') return 'none';
  // Long low ranges of rooms carry a plain gable-hip however big they get —
  // 东长房 is 145m long and still a barracks.
  if (kind === 'range' || kind === 'gallery') return 'gable';
  // 重檐庑殿 — the double-eaved hip — is reserved for the very top of the
  // hierarchy, and giving it away devalues the halls that should have it.
  if (area > 1800 || /太和殿|乾清宫|午门|神武门|坤宁宫/.test(zh)) return 'hip2';
  return 'hip';
}

/** Ridge height in metres, from type and footprint. Sourced where known. */
const KNOWN_HEIGHT = {
  太和殿: 26.9,
  保和殿: 22.0,
  中和殿: 19.0,
  乾清宫: 20.0,
  坤宁宫: 18.0,
  交泰殿: 14.0,
  午门: 37.9,
  神武门: 31.0,
  太和门: 23.8,
  乾清门: 16.0,
  文华殿: 15.0,
  武英殿: 15.0,
  体仁阁: 23.8,
  弘义阁: 23.8,
};

function heightOf(kind, area, zh) {
  const known = KNOWN_HEIGHT[zh];
  if (known) return known;
  switch (kind) {
    case 'citywall': return 9;
    case 'courtwall': return 3.4;
    case 'platform': return 1.6;
    case 'water': return 0;
    case 'kiosk': return 8;
    case 'tower': return 18;
    case 'gate': return Math.min(18, 8 + Math.sqrt(area) * 0.12);
    case 'hall': return Math.min(24, 9 + Math.sqrt(area) * 0.16);
    case 'range': return 8.5;
    default: return 7;
  }
}

/**
 * Which structure wins when two footprints want the same ground.
 *
 * `courtwall` and `platform` are not in the table and take no part: a courtyard
 * wall is an *outline* rather than a solid, and a platform is the thing halls
 * stand on, so both are meant to overlap their neighbours.
 */
const RANK = { gate: 6, hall: 5, tower: 5, kiosk: 4, range: 3, gallery: 2 };

/** Overlap of two footprints along each axis, in metres. Negative when apart. */
function overlapOf(a, b) {
  return {
    x: Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2),
    z: Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2),
  };
}

/** Grows `a` to take in `b`. */
function union(a, b) {
  const minX = Math.min(a.x - a.w / 2, b.x - b.w / 2);
  const maxX = Math.max(a.x + a.w / 2, b.x + b.w / 2);
  const minZ = Math.min(a.z - a.d / 2, b.z - b.d / 2);
  const maxZ = Math.max(a.z + a.d / 2, b.z + b.d / 2);
  a.x = (minX + maxX) / 2;
  a.z = (minZ + maxZ) / 2;
  a.w = maxX - minX;
  a.d = maxZ - minZ;
}

/** True when `inner`'s centre falls inside `outer`'s rectangle. */
function containsCentre(outer, inner) {
  return Math.abs(inner.x - outer.x) < outer.w / 2 && Math.abs(inner.z - outer.z) < outer.d / 2;
}

/**
 * Makes the survey's footprints stop standing inside each other.
 *
 * OSM traces what a surveyor sees from above: eaves, courtyard outlines, and the
 * occasional garden drawn as one big way. Read literally that is 489 pairs of
 * structures sharing ground, and since every footprint here becomes a solid
 * with a collider round it, each of those is a building growing out of another
 * building. Three rules, in order:
 *
 * 1. **Enclosures.** A footprint with two or more other structures standing
 *    inside it is not a building — it is the wall around them. 御花园, the
 *    Imperial Garden, is traced as a single 139m by 96m way, and built as a
 *    range it is a red block with the Hall of Imperial Peace and both of the
 *    garden's pavilions buried in it.
 * 2. **Duplicates.** Where one footprint covers most of another, the survey has
 *    the same building twice — once as its hall and once as its compound. The
 *    ranked and named one stays.
 * 3. **Trims.** What is left is eaves overlapping by a metre or two. The lesser
 *    building gives way along whichever axis it is losing by less, which keeps
 *    the plan's geometry and only costs the loser its overhang.
 */
function declash(all) {
  const solid = (s) => RANK[s.kind] !== undefined;
  const areaOf = (s) => s.w * s.d;

  // 1 — enclosures. Only the unranked kinds are eligible: the Meridian Gate is
  // a U 191m across with the whole forecourt and its five pavilions inside it,
  // and by this rule alone it would be demoted to a courtyard wall — the one
  // building on the map nobody would forgive.
  let enclosures = 0;
  for (const s of all) {
    if (s.kind !== 'range' && s.kind !== 'gallery') continue;
    if (areaOf(s) < 1500) continue;
    const inside = all.filter((o) => o !== s && solid(o) && containsCentre(s, o)).length;
    if (inside < 2) continue;
    s.kind = 'courtwall';
    s.roof = 'none';
    s.height = 3.4;
    enclosures++;
  }

  // 2 — the stone bases. Two tracings of one base become one, and every base is
  // then grown to take in the buildings standing on it.
  //
  // Growing them is what stops a hall being both raised onto its base and
  // buried in it. The Palace of Heavenly Purity is 68% inside the base under it
  // — the survey traces eaves, and its eaves oversail the stonework — so on any
  // containment test it stands in the courtyard with its plinth inside the
  // platform. A base that reaches to the eave line of what it carries is both
  // truer to the place and unambiguous to build against.
  let platforms = all.filter((s) => s.kind === 'platform');
  for (let pass = 0; pass < 4; pass++) {
    let merged = false;
    for (const a of platforms) {
      for (const b of platforms) {
        if (a === b || a.w === 0 || b.w === 0) continue;
        const o = overlapOf(a, b);
        if (o.x <= 0 || o.z <= 0) continue;
        if ((o.x * o.z) / Math.min(areaOf(a), areaOf(b)) < 0.5) continue;
        union(a, b);
        b.w = 0;
        merged = true;
      }
    }
    platforms = platforms.filter((p) => p.w > 0);
    if (!merged) break;
  }
  for (const p of platforms) {
    for (const s of all) {
      if (!solid(s)) continue;
      const o = overlapOf(p, s);
      if (o.x <= 0 || o.z <= 0) continue;
      if ((o.x * o.z) / areaOf(s) < 0.6) continue;
      union(p, s);
    }
  }

  // 3 — duplicates. Largest first, so a compound swallows its own halls rather
  // than the other way about.
  const kept = [];
  const dropped = [];
  for (const s of [...all].sort((a, b) => areaOf(b) - areaOf(a))) {
    // Platforms are compared with platforms and buildings with buildings: a
    // hall standing on its base is not the survey saying the same thing twice,
    // but the Inner Court's base traced once at 95m and again at 92m is.
    const twinnable = (k) => (s.kind === 'platform' ? k.kind === 'platform' : solid(k));
    if (!solid(s) && s.kind !== 'platform') { kept.push(s); continue; }
    const twin = kept.find((k) => {
      if (!twinnable(k)) return false;
      const o = overlapOf(k, s);
      if (o.x <= 0 || o.z <= 0) return false;
      return (o.x * o.z) / Math.min(areaOf(k), areaOf(s)) > 0.7;
    });
    if (!twin) { kept.push(s); continue; }

    // The better-documented of the two survives, whichever way round they came.
    // Two platforms have no rank between them, so the larger one — which came
    // first — keeps the ground.
    const better = ((RANK[s.kind] ?? 0) - (RANK[twin.kind] ?? 0))
      || ((s.zh ? 1 : 0) - (twin.zh ? 1 : 0));
    if (better > 0) {
      kept[kept.indexOf(twin)] = s;
      dropped.push(twin);
    } else {
      dropped.push(s);
    }
  }

  // 4 — trims. A few passes, because giving way to one neighbour can walk a
  // footprint into the next.
  const CLEAR = 0.5;
  let trimmed = 0;
  for (let pass = 0; pass < 6; pass++) {
    let clashes = 0;
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const a = kept[i];
        const b = kept[j];
        if (!solid(a) || !solid(b)) continue;
        const o = overlapOf(a, b);
        if (o.x <= 0 || o.z <= 0) continue;
        clashes++;
        const order = (RANK[a.kind] - RANK[b.kind]) || (areaOf(a) - areaOf(b));
        const loser = order >= 0 ? b : a;
        const winner = loser === a ? b : a;
        const give = Math.min(o.x, o.z) + CLEAR;
        if (o.x < o.z) {
          if (loser.w - give < 4) { loser.w = 0; continue; }
          loser.x += Math.sign(loser.x - winner.x || 1) * (give / 2);
          loser.w -= give;
        } else {
          if (loser.d - give < 4) { loser.d = 0; continue; }
          loser.z += Math.sign(loser.z - winner.z || 1) * (give / 2);
          loser.d -= give;
        }
        trimmed++;
      }
    }
    if (clashes === 0) break;
  }

  const survivors = kept.filter((s) => s.w > 0 && s.d > 0);
  for (const s of survivors) {
    s.x = Number(s.x.toFixed(1));
    s.z = Number(s.z.toFixed(1));
    s.w = Number(s.w.toFixed(1));
    s.d = Number(s.d.toFixed(1));
  }
  console.log(
    `  declash: ${enclosures} enclosures reclassified, ${dropped.length} duplicates dropped, ` +
    `${trimmed} trims, ${kept.length - survivors.length} footprints trimmed away`,
  );
  return survivors;
}

const toLocal = (lat, lon) => ({
  x: (lon - LON0) * M_PER_DEG_LON,
  z: -(lat - LAT0) * M_PER_DEG_LAT,
});

const dry = process.argv.includes('--dry');
const fromIndex = process.argv.indexOf('--from');
const cached = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;

let data;
if (cached) {
  console.log(`Reading ${cached}…`);
  data = JSON.parse(readFileSync(cached, 'utf8'));
} else {
  console.log('Querying Overpass…');
  const raw = execFileSync(
    'curl',
    ['-s', '--max-time', '240', '-X', 'POST', '--data-binary', '@-', OVERPASS],
    { input: QUERY, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
  data = JSON.parse(raw);
}
console.log(`  ${data.elements.length} elements`);

const structures = [];
for (const el of data.elements) {
  if (!el.geometry || el.geometry.length < 3) continue;
  const tags = el.tags ?? {};

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of el.geometry) {
    const { x, z } = toLocal(p.lat, p.lon);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const w = maxX - minX;
  const d = maxZ - minZ;

  // Inside the walls only. The backdrop — Jingshan, the streets — is built
  // procedurally rather than from footprints, so it is not wanted here.
  if (cx < INTERIOR.minX || cx > INTERIOR.maxX) continue;
  if (cz < INTERIOR.minZ || cz > INTERIOR.maxZ) continue;
  // Below this a footprint is a shed, a stele or a mis-trace.
  if (w * d < 60) continue;
  // The moat and the wall rings are built from the layout module's own numbers;
  // their traced outlines would be a 1000x1000m box in the middle of the map.
  if (w > 400 || d > 400) continue;

  const kind = classify(tags, w, d);
  if (kind === 'water' || kind === 'citywall') continue;

  const zh = tags.name ?? '';
  structures.push({
    zh,
    en: tags['name:en'] ?? '',
    kind,
    roof: roofOf(kind, w * d, zh),
    height: Number(heightOf(kind, w * d, zh).toFixed(1)),
    x: Number(cx.toFixed(1)),
    z: Number(cz.toFixed(1)),
    w: Number(w.toFixed(1)),
    d: Number(d.toFixed(1)),
  });
}

structures.push(...SUPPLEMENT);

const resolved = declash(structures);

// North to south, so the emitted file reads down the axis the way the map does.
resolved.sort((a, b) => a.z - b.z || a.x - b.x);

const counts = {};
for (const s of resolved) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
console.log(`  ${resolved.length} structures inside the walls:`, counts);

if (dry) {
  process.exit(0);
}

const header = `/**
 * The Forbidden City's structures, at their surveyed positions.
 *
 * GENERATED by \`node tools/fetch-osm.mjs\` from OpenStreetMap. Do not edit by
 * hand — edit the generator's classification rules instead, or the layout will
 * silently disagree with the survey the next time anyone re-runs it.
 *
 * Coordinates are metres at true scale in the game's frame: origin at the Hall
 * of Supreme Harmony, +X east, -Z north. \`CityLayout\` applies the play-scale
 * compression; nothing here is pre-scaled.
 *
 * Footprints are OSM's traced outlines, which follow the eaves rather than the
 * walls, so they run a few metres over the structural dimensions. That is the
 * right envelope for placing a roof and the wrong one for placing a collider —
 * see \`CityArena\`, which insets.
 */

/** What the structure is, which decides which kit pieces build it. */
export type StructureKind =
  | 'hall'
  | 'gate'
  | 'tower'
  | 'kiosk'
  | 'range'
  | 'gallery'
  /** A courtyard enclosure, traced as a closed outline. Built as four runs. */
  | 'courtwall'
  /** A raised stone platform that a group of buildings stands on. */
  | 'platform';

/** Roof form. \`hip2\` is the double-eaved hip reserved for the first rank. */
export type RoofForm =
  | 'hip2'
  | 'hip'
  | 'gable'
  | 'pyramid'
  | 'double'
  /** Three tiers of eaves — the corner towers, and nothing else. */
  | 'triple'
  | 'none';

export interface Structure {
  /** Chinese name, empty where OSM has none. */
  readonly zh: string;
  /** English name, empty where OSM has none. */
  readonly en: string;
  readonly kind: StructureKind;
  readonly roof: RoofForm;
  /** Ridge height in metres, at true scale. */
  readonly height: number;
  /** Centre, metres east of the Hall of Supreme Harmony. */
  readonly x: number;
  /** Centre, metres south of the Hall of Supreme Harmony. */
  readonly z: number;
  /** East-west extent, metres. */
  readonly w: number;
  /** North-south extent, metres. */
  readonly d: number;
}

export const STRUCTURES: readonly Structure[] = [
`;

const body = resolved
  .map((s) => {
    // Only the English name earns a trailing comment; repeating the Chinese one
    // that is already in the line would just be noise.
    const comment = s.en ? ` // ${s.en}` : '';
    return `  { zh: ${JSON.stringify(s.zh)}, en: ${JSON.stringify(s.en)}, kind: '${s.kind}', roof: '${s.roof}', height: ${s.height}, x: ${s.x}, z: ${s.z}, w: ${s.w}, d: ${s.d} },${comment}`;
  })
  .join('\n');

writeFileSync('src/world/CityPlan.ts', `${header}${body}\n];\n`);
console.log('Wrote src/world/CityPlan.ts');
