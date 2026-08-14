/**
 * Cuts the recorded frame sequence into the clips that actually get posted.
 *
 * `tools/record.mjs` shoots one master run and writes a manifest saying which
 * frames belong to which beat. This assembles cuts from that by naming beats,
 * so re-cutting for a different platform costs seconds and never requires
 * re-shooting. Both outputs come from the same frames, so what someone sees on
 * X is genuinely the same footage as the long version.
 *
 * The two targets differ in more than length:
 *   x         under X's 2:20 ceiling, and short enough to hold a feed
 *             scroller. yuv420p and a closed GOP, because autoplay in-feed is
 *             unforgiving about anything exotic.
 *   youtube   full length at whatever was recorded, higher bitrate, and a
 *             faster-decoding profile since nobody is scrolling past it.
 *
 * Usage: node tools/encode.mjs [--in DIR] [--only x,youtube]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const IN = opt('in', 'captures/video');
const ONLY = opt('only', null)?.split(',').map((s) => s.trim());
const FRAMES = join(IN, 'frames');
const OUT = join(IN, 'out');

// Located rather than assumed: this is a static build pulled in as a dev
// dependency, and the system may have no ffmpeg of its own at all.
const FFMPEG =
  process.env.FFMPEG_PATH ??
  ['node_modules/ffmpeg-static/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
    .find(existsSync);
if (!FFMPEG) throw new Error('No ffmpeg. `npm i -D ffmpeg-static` or set FFMPEG_PATH.');

const manifest = JSON.parse(readFileSync(join(IN, 'manifest.json'), 'utf8'));
const byName = new Map(manifest.beats.map((b) => [b.name, b]));
const { fps } = manifest;

/**
 * The cuts.
 *
 * `beats` is the running order — it does not have to match the order they were
 * shot in, and does not have to include all of them. The short cut opens on
 * the fight rather than the scenery: three seconds of fountain is a lovely
 * establishing shot in a two-minute film and a reason to scroll past in a
 * feed.
 */
const CUTS = [
  {
    name: 'youtube',
    file: 'forbidden-city-paintball-gameplay-youtube.mp4',
    beats: ['fountain-reveal', 'arcade-approach', 'duel-mall', 'bow-bridge',
            'duel-meadow', 'meadow-skyline', 'mall-sprint', 'duel-open',
            'lake-shore', 'results'],
    crf: 20,
    preset: 'slow',
    extra: ['-profile:v', 'high', '-level', '4.2', '-maxrate', '20M', '-bufsize', '40M'],
  },
  {
    name: 'x',
    file: 'forbidden-city-paintball-gameplay-x.mp4',
    beats: ['duel-meadow', 'fountain-reveal', 'duel-mall', 'bow-bridge',
            'duel-open', 'results'],
    // X re-encodes everything anyway, so the job here is to hand its
    // transcoder a clean source without handing its *uploader* a file big
    // enough to fail on. The cap matters more than the CRF: this renderer
    // lays a paper grain over every frame, and unconstrained h264 will happily
    // spend 35Mbps describing it.
    crf: 21,
    preset: 'slow',
    extra: ['-profile:v', 'main', '-level', '4.0', '-maxrate', '12M', '-bufsize', '24M'],
  },
];

mkdirSync(OUT, { recursive: true });

const run = (args) => execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });

for (const cut of CUTS) {
  if (ONLY && !ONLY.includes(cut.name)) continue;

  const beats = cut.beats.map((name) => byName.get(name)).filter(Boolean);
  const missing = cut.beats.filter((name) => !byName.has(name));
  if (missing.length) console.log(`  (${cut.name}: no frames for ${missing.join(', ')})`);
  if (!beats.length) { console.log(`  ${cut.name}: nothing to cut, skipping`); continue; }

  // A concat list of individual frames, one `file` line each, with a `duration`
  // so ffmpeg paces them.
  //
  // Beats are not contiguous in the sequence once the running order differs
  // from the shooting order, and the image2 demuxer can only read a single
  // ascending numeric range — so the frames are named explicitly instead. It
  // also means a cut costs no copies of the frames on disk.
  const lines = [];
  let frames = 0;
  for (const beat of beats) {
    for (let i = 0; i < beat.count; i++) {
      lines.push(`file '${join(process.cwd(), FRAMES, `${String(beat.first + i).padStart(6, '0')}.jpg`)}'`);
      lines.push(`duration ${(1 / fps).toFixed(6)}`);
      frames++;
    }
  }
  // The concat demuxer ignores the duration of the final entry, so the last
  // frame is listed twice — without it the clip ends one frame short.
  lines.push(lines[lines.length - 2]);

  const listPath = join(OUT, `${cut.name}.txt`);
  writeFileSync(listPath, lines.join('\n'));

  const outPath = join(OUT, cut.file);
  run([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', cut.preset,
    '-crf', String(cut.crf),
    // Chroma subsampling every player in the world can decode. Without it
    // ffmpeg picks yuvj444p from JPEG input and Safari, QuickTime and X's own
    // transcoder all refuse the file.
    '-pix_fmt', 'yuv420p',
    // Keyframe every second, closed. Feed players start mid-download and seek
    // to the nearest one; two seconds of grey is a scroll-past.
    '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0',
    // Lets a player show the first frame before the whole file has arrived.
    '-movflags', '+faststart',
    ...cut.extra,
    outPath,
  ]);

  // The concat list holds absolute paths and is meaningless once the file is
  // muxed; leaving it behind puts junk in the folder somebody uploads from.
  rmSync(listPath, { force: true });

  const bytes = execFileSync('stat', ['-c', '%s', outPath]).toString().trim();
  console.log(`  ${cut.name.padEnd(9)} ${cut.file.padEnd(38)} ` +
              `${(frames / fps).toFixed(1)}s  ${(bytes / 1e6).toFixed(1)}MB  ` +
              `${manifest.width}x${manifest.height}`);
}

console.log(`\nwritten to ${OUT}/`);
