/**
 * Builds the sound assets in public/audio/:
 *   <bed>.mp3      - long continuous textures (rain, wind) that src/audio.js loops and layers
 *   <thunder>.mp3  - one-shots fired after each lightning strike
 *   <groan>.mp3    - one-shots: something out in the dark, heard now and then
 *   title-voice.mp3 - the title, said aloud
 *   enter-hit.mp3   - one deep hit, for when the way in is taken
 *   manifest.json  - their names and lengths
 *
 * Sounds come from the ElevenLabs sound-generation API. Raw results are cached in
 * tools/audio-raw/, so re-runs cost nothing and need no key; a sound that is not cached yet needs
 * ELEVENLABS_API_KEY, or a key file named by ELEVENLABS_KEY_FILE (default
 * ~/Desktop/elevenlabs-key.txt). ffmpeg trims, levels and encodes.
 *
 * Every continuous texture is checked for the faults these generations are prone to: a steady
 * tone standing out of the spectrum (most often a mains-like buzz: 200 Hz and its harmonics),
 * and a level that wanders (a swell, or thunder that was not asked for). Tones that are found are
 * notched out, each with a filter a few hertz wide, and the result is checked again. The report
 * says what was found, what was removed and what is left.
 *
 * There is no wind here: a generated wind came back as that buzz from 400 Hz to 13 kHz, so
 * src/audio.js makes the wind itself from filtered noise.
 *
 * Run: node tools/build-audio.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rawDir = join(here, 'audio-raw');
const procDir = join(here, 'audio-proc');
const outDir = join(here, '..', 'public', 'audio');
const KEY_FILE = process.env.ELEVENLABS_KEY_FILE ?? join(homedir(), 'Desktop', 'elevenlabs-key.txt');
for (const d of [rawDir, procDir, outDir]) mkdirSync(d, { recursive: true });

// continuous textures; levels and movement are set in src/audio.js
const BEDS = [
    { name: 'rain-asphalt', dur: 22, influence: 0.6, text: 'Steady heavy rain falling on a wet asphalt road at night, heard up close, a dense continuous patter of raindrops hitting tarmac, constant and even, no thunder, no wind, no traffic, no voices, no music' },
    { name: 'rain-puddles', dur: 22, influence: 0.6, text: 'Raindrops falling into shallow puddles of standing water, heard very close, continuous irregular plinks, plops and small splashes, constant and even, no thunder, no wind, no voices, no music' },
    { name: 'rain-wash', dur: 22, influence: 0.55, text: 'Heavy rain over a large empty car park at night heard from a distance, a broad soft continuous wash and hiss of rainfall with water trickling in a gutter, constant and even, no thunder, no traffic, no voices, no music' }
];

// thunder, from overhead to far away; src/audio.js picks by how near the strike was
const THUNDER = [
    { name: 'thunder-near-a', dur: 9, text: 'A lightning strike very close by: one sharp, loud, tearing crack of thunder, then a deep booming rumble that rolls away and fades over several seconds, no rain, no wind, no music' },
    { name: 'thunder-near-b', dur: 10, text: 'A sudden explosive thunderclap directly overhead, a hard crack and a heavy boom, then long low rumbling echoes rolling off into the distance, no rain, no wind, no music' },
    { name: 'thunder-mid-a', dur: 10, text: 'Thunder from a storm a couple of kilometres away, a low rolling rumble that builds, growls and slowly fades, no sharp crack, no rain, no wind, no music' },
    { name: 'thunder-mid-b', dur: 9, text: 'A heavy roll of thunder some distance away, deep overlapping rumbles tumbling across the sky and dying away, no rain, no wind, no music' },
    { name: 'thunder-far-a', dur: 10, text: 'Very distant thunder far away on the horizon, a soft deep rumble, long and muffled, barely there, no rain, no wind, no music' }
];

// something else is out there. One voice each, dry and close: src/audio.js puts them far off
const GROANS = [
    { name: 'groan-a', dur: 4, text: 'A single long low zombie groan, one male undead creature, a slow hoarse guttural moan from deep in the throat, dry close recording, no music, no footsteps, no other sounds' },
    { name: 'groan-b', dur: 4, text: 'One zombie moaning, a drawn-out rasping breathy groan that rises a little and trails off, undead, hungry, dry close recording, no music, no other sounds' },
    { name: 'groan-c', dur: 3, text: 'A short wet gurgling zombie growl, a single undead creature exhaling a low rattling snarl, dry close recording, no music, no other sounds' },
    { name: 'groan-d', dur: 5, text: 'A slow wavering undead moan, one female zombie, a long mournful hollow groan with a rattle in the breath, dry close recording, no music, no other sounds' }
];

// The title, said aloud, as the series says its own on its title screen: one deep voice, slow.
// It is speech, so it comes from the text-to-speech API. Several takes are kept. TITLE_TAKE says
// which one the page uses (b was chosen by ear); all of them are left in tools/audio-proc/ to be
// listened to. `ends` is how many seconds into the finished take the last word is over: what
// follows is echo, and things are timed to the word.
const TITLE_TAKE = process.env.TITLE_TAKE ?? 'b';
const TITLE_VOICE = {
    a: { voice: 'nPczCjzI2devNBz1zQrb', model: 'eleven_v3', text: '[deep, slow, menacing growl] Gaussian... Evil.', ends: 2.1 },   // Brian: deep, resonant
    b: { voice: 'N2lVS1w4EtoT3dr4eOWO', model: 'eleven_v3', text: '[low, gravelly, sinister] Gaussian... Evil.', ends: 3.1 },      // Callum: intense, and the slowest
    c: { voice: 'yoZ06aMxZJJ28mfd3POQ', model: 'eleven_multilingual_v2', text: 'Gaussian... Evil.', ends: 1.4 }                     // Sam: raspy, with no direction
};

// The way in: one ominous boom as the button is pressed, before the title is said. Takes are
// kept as the voice's are; HIT_TAKE says which one the page uses (d was chosen by ear). (A first set of three, asked
// for as deep clean impacts, was turned down: what was wanted was ominous. These are asked for
// as menace: slower, darker, with something in the tail.) `carry` adds overtones for small
// speakers (see CARRY) to a take that has little above its lowest notes. `lead` is how many
// seconds the boom is given to itself before the title is said over it.
// None is used now: on the machine it was judged on, the start of the boom was lost on the way
// out whatever was done about it, and it was dropped. HIT_TAKE=d npm run audio puts take d back.
const HIT_TAKE = process.env.HIT_TAKE ?? '';
const HITS = {
    a: { dur: 7, influence: 0.65, carry: true, lead: 0.9, text: 'An ominous boom: one deep, dark, slow impact like a distant explosion heard from deep underground, swelling and then decaying into a long menacing low rumble. Horror film. A single boom, no music, no melody, no voices' },
    b: { dur: 7, influence: 0.65, lead: 1.9, text: 'Horror film trailer braam: one massive ominous blast of low brass and sub bass, dissonant and full of dread, with a long cavernous reverb tail. A single blast, no rhythm, no melody, no voices' },
    c: { dur: 7, influence: 0.65, carry: true, lead: 0.9, text: 'An ominous boom in a vast dark hall: a giant iron door slamming shut far away, a deep heavy boom with a cold metallic resonance that echoes for seconds. A single boom, horror film, no music, no voices' },
    d: { dur: 7, influence: 0.65, lead: 0.9, text: 'Ominous orchestral hit for a horror film title: bass drum and timpani struck once together, with a dark cluster of low strings and brass swelling underneath and dying away slowly. A single hit, no rhythm, no melody after it' }
};

// A boom is nearly all below 110 Hz, and the speaker of a phone or a laptop gives out nothing
// down there: on one, the hit would be a tick. A copy of the low end, driven hard, makes
// overtones of it (three times the note, five times), which a small speaker can play and the
// ear hears as the same deep note. They are mixed back in under the original.
const CARRY = 'asplit[low][all];[low]lowpass=f=170,volume=18dB,asoftclip=type=tanh,highpass=f=130,lowpass=f=900,volume=-6dB[over];[all][over]amix=inputs=2:normalize=0';

// only needed when a sound isn't cached yet
let apiKey = null;
const key = () => (apiKey ??= process.env.ELEVENLABS_API_KEY ?? readFileSync(KEY_FILE, 'utf8').trim());

async function generate(s) {
    const rawPath = join(rawDir, `${s.name}.mp3`);
    if (existsSync(rawPath)) { console.log(`  ${s.name}: cached`); return rawPath; }
    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
            method: 'POST',
            headers: { 'xi-api-key': key(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: s.text, duration_seconds: s.dur, prompt_influence: s.influence ?? 0.7 })
        });
        if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            writeFileSync(rawPath, buf);
            console.log(`  ${s.name}: generated (${(buf.length / 1024).toFixed(1)} KB)`);
            return rawPath;
        }
        const errText = await res.text();
        console.warn(`  ${s.name}: HTTP ${res.status} (attempt ${attempt}) ${errText.slice(0, 200)}`);
        if (attempt === 3) throw new Error(`Failed to generate ${s.name}`);
        await new Promise(r => setTimeout(r, res.status === 429 ? 4000 * attempt : 1500));
    }
}

async function speak(name, t) {
    const rawPath = join(rawDir, `${name}.mp3`);
    if (existsSync(rawPath)) { console.log(`  ${name}: cached`); return rawPath; }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${t.voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t.text, model_id: t.model, voice_settings: t.model === 'eleven_v3' ? { stability: 0.5, similarity_boost: 0.8 } : { stability: 0.35, similarity_boost: 0.85, style: 0.6, use_speaker_boost: true } })
    });
    if (!res.ok) throw new Error(`Failed to speak ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(rawPath, buf);
    console.log(`  ${name}: spoken (${(buf.length / 1024).toFixed(1)} KB)`);
    return rawPath;
}

const ff = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
const ffErr = args => spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8' }).stderr ?? '';
const duration = p => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' }));
const volume = (p, what) => parseFloat(new RegExp(`${what}_volume:\\s*(-?[\\d.]+) dB`).exec(ffErr(['-i', p, '-af', 'volumedetect', '-f', 'null', 'NUL']))?.[1] ?? '0');

/** @returns {{ sr: number, ch: Float32Array[] }} The samples of a 32-bit float WAV */
function readWav(path) {
    const buf = readFileSync(path);
    let off = 12, channels = 2, sr = 44100, dataOff = 0, dataLen = 0;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); }
        if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, buf.length - off - 8); break; }
        off += 8 + len + (len & 1);
    }
    const frames = Math.floor(dataLen / (4 * channels));
    const ch = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) ch[c][i] = buf.readFloatLE(dataOff + (i * channels + c) * 4);
    return { sr, ch };
}

// in-place radix-2 FFT
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
                [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
            }
        }
    }
}

/**
 * Looks for a steady tone: a narrow band that stands well clear of its neighbourhood in the
 * long-term spectrum, and does so in nearly every frame (noise peaks come and go; a hum stays).
 *
 * @returns {{ hz: number, excess: number, share: number }[]} The tones found.
 */
function findTones(x, sr) {
    const N = 8192, hop = N / 2, bins = N / 2;
    const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const frames = [];
    for (let s = 0; s + N <= x.length; s += hop) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = x[s + i] * hann[i];
        fft(re, im);
        const db = new Float32Array(bins);
        for (let k = 0; k < bins; k++) db[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20);
        frames.push(db);
    }
    const mean = new Float32Array(bins);
    for (const f of frames) for (let k = 0; k < bins; k++) mean[k] += f[k] / frames.length;
    // the neighbourhood: the median over a third of an octave either side
    const around = (arr, k) => {
        const a = Math.max(1, Math.floor(k / 1.26)), b = Math.min(bins - 1, Math.ceil(k * 1.26));
        const v = Array.from(arr.subarray(a, b + 1)).sort((p, q) => p - q);
        return v[v.length >> 1];
    };
    const found = [];
    for (let k = 8; k < bins - 2; k++) {
        const hz = k * sr / N;
        if (hz < 60 || hz > 12000) continue;       // above this is the edge of the source's own band
        const excess = mean[k] - around(mean, k);
        if (excess < 9 || mean[k] < mean[k - 1] || mean[k] < mean[k + 1]) continue;
        let present = 0;
        for (const f of frames) if (f[k] - around(f, k) > 6) present++;
        const share = present / frames.length;
        if (share > 0.7) found.push({ hz, excess, share });
    }
    return found;
}

const monoOf = (ch) => {
    const m = new Float32Array(ch[0].length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (ch[0][i] + ch[1][i]);
    return m;
};
const describe = tones => tones.map(t => `${t.hz.toFixed(0)} Hz (+${t.excess.toFixed(0)} dB)`).join(', ');

// a continuous texture: any steady tone notched out, trimmed to its steady stretch (generations
// often fade in or out at the ends), stereo, set to a common average level. The app loops it
// with a crossfade.
function bed({ name }, rawPath, mean = -24) {
    const wav = join(procDir, `${name}.wav`);
    ff(['-i', rawPath, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', wav]);
    const found = findTones(monoOf(readWav(wav).ch), 44100);
    let left = [];
    if (found.length) {
        const notched = join(procDir, `${name}-notched.wav`);
        // a constant few hertz wide, however high the tone: harmonics sit only 200 Hz apart
        ff(['-i', wav, '-af', found.map(t => `bandreject=f=${t.hz.toFixed(1)}:width_type=h:w=14`).join(','), '-c:a', 'pcm_f32le', notched]);
        ff(['-i', notched, '-c:a', 'pcm_f32le', wav]);
        left = findTones(monoOf(readWav(wav).ch), 44100);
    }
    const { sr, ch } = readWav(wav);
    const frames = ch[0].length;

    // quarter-second levels; keep from the first to the last window within 5 dB of the median
    const win = Math.round(sr / 4), lv = [];
    for (let s = 0; s + win <= frames; s += win) {
        let a = 0;
        for (let i = s; i < s + win; i++) a += ch[0][i] * ch[0][i] + ch[1][i] * ch[1][i];
        lv.push(10 * Math.log10(a / (2 * win) + 1e-20));
    }
    const med = [...lv].sort((p, q) => p - q)[lv.length >> 1];
    let a = 0, b = lv.length - 1;
    while (a < b && lv[a] < med - 5) a++;
    while (b > a && lv[b] < med - 5) b--;
    const t0 = a * 0.25, t1 = (b + 1) * 0.25;
    const kept = lv.slice(a, b + 1);

    console.log(`  ${name}: steady ${t0.toFixed(2)}-${t1.toFixed(2)} s; level ranges ${(Math.min(...kept) - med).toFixed(1)}..+${(Math.max(...kept) - med).toFixed(1)} dB about its median`);
    console.log(found.length ? `    tones notched: ${describe(found)}\n    left after notching: ${left.length ? describe(left) : 'none'}` : '    no steady tone');

    const g = mean - volume(wav, 'mean');
    const out = join(outDir, `${name}.mp3`);
    ff(['-i', wav, '-af', `atrim=${t0}:${t1},asetpts=N/SR/TB,volume=${g.toFixed(2)}dB,alimiter=limit=0.7`, '-codec:a', 'libmp3lame', '-q:a', '5', '-ac', '2', out]);
    return +duration(out).toFixed(3);
}

// a one-shot: leading silence trimmed, the tail faded, peak set to `peak` dB
function oneShot({ name }, rawPath, peak = -2, notch = true, out = join(outDir, `${name}.mp3`), shape = '') {
    const trimmed = join(procDir, `${name}.wav`);
    ff(['-i', rawPath, '-af',
        'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01,areverse,' +
        'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.05,afade=t=in:d=0.6,areverse',
        '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', trimmed]);
    // the same buzz can sit under a rumble. (Not looked for in a voice: a held note is a steady tone)
    const found = notch ? findTones(monoOf(readWav(trimmed).ch), 44100) : [];
    if (found.length) {
        const notched = join(procDir, `${name}-notched.wav`);
        ff(['-i', trimmed, '-af', found.map(t => `bandreject=f=${t.hz.toFixed(1)}:width_type=h:w=14`).join(','), '-c:a', 'pcm_f32le', notched]);
        ff(['-i', notched, '-c:a', 'pcm_f32le', trimmed]);
    }
    if (shape) {
        const shaped = join(procDir, `${name}-shaped.wav`);
        ff(['-i', trimmed, '-af', shape, '-c:a', 'pcm_f32le', shaped]);
        ff(['-i', shaped, '-c:a', 'pcm_f32le', trimmed]);
    }
    const g = peak - volume(trimmed, 'max');
    ff(['-i', trimmed, '-af', `volume=${g.toFixed(2)}dB`, '-codec:a', 'libmp3lame', '-q:a', '4', '-ac', '2', out]);

    // where its energy is: a crack is over in a moment, a rumble takes its time
    const { sr, ch } = readWav(trimmed);
    let total = 0, early = 0, top = 0, topAt = 0;
    for (let i = 0; i < ch[0].length; i++) {
        const e = ch[0][i] * ch[0][i];
        total += e;
        if (i < sr) early += e;
        if (e > top) { top = e; topAt = i; }
    }
    const dur = +duration(out).toFixed(3);
    console.log(`  ${name}: ${dur.toFixed(2)} s, loudest at ${(topAt / sr).toFixed(2)} s, ${(100 * early / total).toFixed(0)}% of its energy in the first second, mean ${volume(out, 'mean').toFixed(1)} dB` + (found.length ? `; tones notched: ${describe(found)}` : '; no steady tone'));
    return dur;
}

// a spoken line: the silence trimmed off, dropped three semitones and slowed by a tenth, with a
// short echo as of a big empty room, and its peak set
function spoken(name, rawPath, out, peak = -1.5) {
    const tmp = join(procDir, `${name}.wav`);
    ff(['-i', rawPath, '-af',
        'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,' +
        'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,' +
        'asetrate=44100*0.84,aresample=44100,atempo=1.08,highpass=f=50,apad=pad_dur=0.7,aecho=0.8:0.7:75|140:0.25|0.14',
        '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', tmp]);
    const g = peak - volume(tmp, 'max');
    ff(['-i', tmp, '-af', `volume=${g.toFixed(2)}dB`, '-codec:a', 'libmp3lame', '-q:a', '3', '-ac', '2', out]);
    const dur = +duration(out).toFixed(3);
    console.log(`  ${name}: ${dur.toFixed(2)} s, mean ${volume(out, 'mean').toFixed(1)} dB`);
    return dur;
}

console.log('Sounds (generated by ElevenLabs unless cached):');
const manifest = { beds: {}, thunder: {}, groans: {}, voice: {}, hit: {} };
for (const b of BEDS) manifest.beds[b.name] = bed(b, await generate(b));
for (const t of THUNDER) manifest.thunder[t.name] = oneShot(t, await generate(t));
for (const g of GROANS) manifest.groans[g.name] = oneShot(g, await generate(g), -3, false);
for (const [take, t] of Object.entries(TITLE_VOICE)) {
        const raw = await speak(`title-voice-${take}`, t);
        const used = take === TITLE_TAKE;
        const dur = spoken(`title-voice-${take}`, raw, used ? join(outDir, 'title-voice.mp3') : join(procDir, `title-voice-${take}.mp3`));
        if (used) manifest.voice['title-voice'] = { length: dur, ends: t.ends };
}
for (const [take, h] of Object.entries(HITS)) {
    const name = `enter-hit-${take}`, used = take === HIT_TAKE;
    // (not searched for steady tones: the note of a boom is one, and is the point of it)
    const dur = oneShot({ name }, await generate({ name, ...h }), -1.5, false, used ? join(outDir, 'enter-hit.mp3') : join(procDir, `${name}.mp3`), h.carry ? CARRY : '');
    if (used) manifest.hit['enter-hit'] = { length: dur, lead: h.lead };
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('done');
