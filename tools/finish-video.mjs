/**
 * Finishes a render of the film (src/capture.js leaves captures/<name>.h264 and <name>.wav) into
 * a video for sharing: picture and sound together, H.264 + AAC, ready to stream.
 *
 * The sound is brought to a set loudness by one fixed gain (measured first), with a limiter for
 * the thunder: a rain bed pumps under anything that rides the level.
 *
 * Run: node tools/finish-video.mjs [name] [out.mp4] [fps]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caps = join(here, '..', 'captures');
const name = process.argv[2] ?? 'film';
const out = process.argv[3] ?? join(caps, `gaussian-evil-${name}.mp4`);
const fps = process.argv[4] ?? '60';
const LOUDNESS = -18;       // LUFS, integrated: quiet rain and loud thunder, not a wall of sound
mkdirSync(dirname(out), { recursive: true });

const picture = join(caps, `${name}.h264`), sound = join(caps, `${name}.wav`);
const hasSound = existsSync(sound);

let gain = 0;
if (hasSound) {
    const report = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', sound, '-af', 'ebur128', '-f', 'null', 'NUL'], { encoding: 'utf8' }).stderr ?? '';
    const measured = parseFloat(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(report)?.[1] ?? 'NaN');
    if (Number.isFinite(measured)) gain = LOUDNESS - measured;
    console.log(`sound: ${measured} LUFS, gain ${gain.toFixed(1)} dB`);
}

const args = [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    '-f', 'h264', '-framerate', fps, '-color_range', 'tv', '-i', picture,
    ...(hasSound ? ['-i', sound, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:attack=2:release=120:level=false`] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-maxrate', '24M', '-bufsize', '48M',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(2 * Number(fps)),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...(hasSound ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest'] : []),
    '-movflags', '+faststart',
    out
];
execFileSync('ffmpeg', args, { stdio: 'inherit' });
console.log(`wrote ${out}`);
