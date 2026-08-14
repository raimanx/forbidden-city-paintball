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
  if (tags.barrier === 'wall' || tags.building === 'wall' || /^(院墙|城墙|侧墙|左侧墙|右侧墙)/.test(zh)) {
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

// North to south, so the emitted file reads down the axis the way the map does.
structures.sort((a, b) => a.z - b.z || a.x - b.x);

const counts = {};
for (const s of structures) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
console.log(`  ${structures.length} structures inside the walls:`, counts);

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
export type RoofForm = 'hip2' | 'hip' | 'gable' | 'pyramid' | 'double' | 'none';

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

const body = structures
  .map((s) => {
    // Only the English name earns a trailing comment; repeating the Chinese one
    // that is already in the line would just be noise.
    const comment = s.en ? ` // ${s.en}` : '';
    return `  { zh: ${JSON.stringify(s.zh)}, en: ${JSON.stringify(s.en)}, kind: '${s.kind}', roof: '${s.roof}', height: ${s.height}, x: ${s.x}, z: ${s.z}, w: ${s.w}, d: ${s.d} },${comment}`;
  })
  .join('\n');

writeFileSync('src/world/CityPlan.ts', `${header}${body}\n];\n`);
console.log('Wrote src/world/CityPlan.ts');
