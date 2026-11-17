// Sound: rain, wind and thunder.
//
//   - rain is three long recorded textures (tools/build-audio.mjs) playing at once: drops on
//     asphalt, drops in puddles, and the wash of rain further off. Each loops with a crossfade
//     made here on the decoded samples, starts at its own point, runs at a slightly different
//     speed and drifts a couple of decibels on its own slow cycle, so the mix never repeats as a
//     whole. The puddles come forward when the camera is down near the water
//   - wind is made here, from noise through a filter, and follows the very same gusts that move
//     her hair and dress (src/life.js)
//   - thunder follows each lightning strike (src/lightning.js) after the delay its distance
//     gives it: a near strike cracks almost at once, loud and bright, from the side of the sky it
//     came from; a far one rumbles seconds later, quiet and dull
//
//   - the torch clicks when it is switched on (src/director.js)
//   - the title is said aloud when the way in is taken (src/main.js), and under the title of
//     the rendered video (src/capture.js)
//   - and, very occasionally, something groans, a long way off in the dark. A minute or two
//     apart, never the same one twice running, dulled and quiet as a far voice in rain is
//
// The film can be rendered to a file (src/capture.js). Its sound is then not recorded but
// rendered: the same graph is built on an OfflineAudioContext and the same code drives it, so
// whatever would have been played "now" is scheduled at the moment the film has reached.
//
// A browser will not play sound until the page has been clicked or a key pressed, so the first
// such gesture starts it (the way in on the title card, src/title.js, is one); the Sound button
// turns it off and on.
//
// There is no compressor in the chain: Web Audio's adds make-up gain of its own, which once
// lifted a quiet bed by 18 dB. Levels are set by plain gains and checked with the meter below.
import * as pc from 'playcanvas';

import { gust } from './life.js';

const BEDS = {
    // gain; period of its slow drift (s); playback speed
    'rain-asphalt': { gain: 0.8, drift: 23, rate: 1.0 },
    'rain-wash': { gain: 0.6, drift: 37, rate: 0.97 },
    'rain-puddles': { gain: 0.36, drift: 29, rate: 1.03 }
};
const THUNDER = {
    near: ['thunder-near-a', 'thunder-near-b'],
    mid: ['thunder-mid-a', 'thunder-mid-b'],
    far: ['thunder-far-a', 'thunder-mid-a']
};
const GROANS = ['groan-a', 'groan-b', 'groan-c', 'groan-d'];
const dbToGain = db => Math.pow(10, db / 20);

/**
 * @param {object} o - What the sound follows.
 * @param {pc.AppBase} o.app - The app: its clock, and its 'lightning:strike' event.
 * @param {pc.Entity} o.camera - Main camera: the listener.
 * @param {boolean} o.rain - Whether it is raining.
 * @param {HTMLElement} o.button - The Sound button.
 * @returns {object} Settings, start/stop, and a meter.
 */
export function createSoundscape({ app, camera, rain, button }) {
    const settings = {
        volume: 0.7,
        rain: 1,
        wind: 0.5,
        thunder: 1,
        groans: 1,              // 0 for none
        groanFirst: [40, 80],   // seconds before the first one
        groanEvery: [70, 160]   // seconds between them after that
    };

    let spoken = null;      // the title as it is said: how long the sound is, and when its last word ends

    // the files are fetched straight away; they can only be decoded once there is a context
    const files = fetch('audio/manifest.json').then(r => r.json()).then(async (manifest) => {
        const names = [...(rain ? Object.keys(manifest.beds) : []), ...Object.keys(manifest.thunder), ...Object.keys(manifest.groans ?? {}), ...Object.keys(manifest.voice ?? {})];
        spoken = manifest.voice?.['title-voice'] ?? null;
        const data = await Promise.all(names.map(n => fetch(`audio/${n}.mp3`).then(r => r.arrayBuffer())));
        return Object.fromEntries(names.map((n, i) => [n, data[i]]));
    });

    let ctx = null, master = null, analyser = null, started = false, on = false, ready = false;
    const buffers = {}, beds = {};
    let wind = null;
    let clock = 0, lastThunder = '', lastGroan = '';
    const between = r => r[0] + Math.random() * (r[1] - r[0]);
    let nextGroan = between(settings.groanFirst);       // seconds of sound from now

    // While the film is being rendered, `offlineAt` is how many seconds of it there are so far.
    let offlineAt = -1;
    const now = () => (offlineAt >= 0 ? offlineAt : ctx.currentTime);
    const audible = () => !!ctx && on && (offlineAt >= 0 || ctx.state === 'running');

    // a seamless loop: the last `xf` seconds crossfade (equal power) into the start. Done on the
    // decoded samples because the padding an MP3 carries breaks a loop made on the file
    const loopOf = (buf, xf) => {
        const sr = buf.sampleRate, n = buf.length, x = Math.min(Math.floor(xf * sr), n >> 2);
        const out = ctx.createBuffer(buf.numberOfChannels, n - x, sr);
        for (let c = 0; c < buf.numberOfChannels; c++) {
            const src = buf.getChannelData(c), dst = out.getChannelData(c);
            dst.set(src.subarray(0, n - x));
            for (let i = 0; i < x; i++) {
                const w = i / x;
                dst[i] = src[i] * Math.sin(w * Math.PI / 2) + src[n - x + i] * Math.cos(w * Math.PI / 2);
            }
        }
        return out;
    };

    // eight seconds of pink noise, different in each ear
    const noise = () => {
        const sr = ctx.sampleRate, n = sr * 8, buf = ctx.createBuffer(2, n, sr);
        for (let c = 0; c < 2; c++) {
            const d = buf.getChannelData(c);
            let b0 = 0, b1 = 0, b2 = 0;
            for (let i = 0; i < n; i++) {
                const w = Math.random() * 2 - 1;
                b0 = 0.99765 * b0 + w * 0.0990460;
                b1 = 0.96300 * b1 + w * 0.2965164;
                b2 = 0.57000 * b2 + w * 1.0526913;
                d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
            }
        }
        return loopOf(buf, 1);
    };

    async function build() {
        const raw = await files;
        await Promise.all(Object.entries(raw).map(async ([name, data]) => {
            buffers[name] = await ctx.decodeAudioData(data.slice(0));
        }));

        for (const [name, b] of Object.entries(BEDS)) {
            if (!buffers[name]) continue;
            const src = ctx.createBufferSource();
            src.buffer = loopOf(buffers[name], 1.5);
            src.loop = true;
            src.playbackRate.value = b.rate;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            src.connect(gain).connect(master);
            src.start(0, Math.random() * src.buffer.duration);
            beds[name] = { node: gain, drift: b.drift, phase: Math.random() * Math.PI * 2 };
        }

        // wind: noise through a band that opens and climbs as a gust rises
        const src = ctx.createBufferSource();
        src.buffer = noise();
        src.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = 0.7;
        const top = ctx.createBiquadFilter();
        top.type = 'lowpass';
        top.frequency.value = 1600;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(band).connect(top).connect(gain).connect(master);
        src.start();
        wind = { band, gain };
        ready = true;
    }

    // A strike may come while the sound is still being started: the click that asked for the
    // lightning can be the very click that starts the sound. Its thunder waits for the decoding.
    function thunder(strike) {
        if (offlineAt < 0 && on && ctx && building && (ctx.state !== 'running' || !ready)) {
            building.then(() => ctx.resume()).then(() => rumble(strike));
        } else {
            rumble(strike);
        }
    }

    function rumble({ near, from }) {
        if (!audible()) return;
        const pool = THUNDER[near > 0.72 ? 'near' : near > 0.42 ? 'mid' : 'far'].filter(n => buffers[n] && n !== lastThunder);
        if (!pool.length) return;
        const name = lastThunder = pool[Math.floor(Math.random() * pool.length)];

        const src = ctx.createBufferSource();
        src.buffer = buffers[name];
        src.playbackRate.value = 0.92 + Math.random() * 0.12;
        // distance dulls it as well as quietening it
        const dull = ctx.createBiquadFilter();
        dull.type = 'lowpass';
        dull.frequency.value = pc.math.lerp(800, 9000, near * near);
        const gain = ctx.createGain();
        gain.gain.value = dbToGain(pc.math.lerp(-10, -2, near)) * settings.thunder;
        // from the side of the sky the bolt was on, as the camera faces now
        const pan = ctx.createStereoPanner();
        const r = camera.right, len = Math.hypot(from.x, from.z) || 1;
        pan.pan.value = pc.math.clamp((from.x * r.x + from.z * r.z) / len, -1, 1) * 0.7;
        src.connect(dull).connect(gain).connect(pan).connect(master);
        // sound takes about three seconds a kilometre: from next door to a kilometre off
        src.start(now() + pc.math.lerp(3.2, 0.2, near) * (0.9 + Math.random() * 0.2));
        src.onended = () => pan.disconnect();
    }
    app.on('lightning:strike', thunder);

    // the switch on the torch: a sharp tick, with a little of the body of the torch under it.
    // Made here, like the wind: it is forty milliseconds long
    /**
     * Something groans, far off. It comes by itself now and then; a script may also ask for one.
     *
     * @param {number} [level] - How loud, in dB: it is a long way away.
     */
    function groan(level = -9) {
        nextGroan = between(settings.groanEvery);
        if (!audible() || !settings.groans) return;
        const pool = GROANS.filter(n => buffers[n] && n !== lastGroan);
        if (!pool.length) return;
        const name = lastGroan = pool[Math.floor(Math.random() * pool.length)];

        const src = ctx.createBufferSource();
        src.buffer = buffers[name];
        src.playbackRate.value = 0.78 + Math.random() * 0.16;      // slower, and so lower: larger, further
        // distance and rain take the top off a voice
        const dull = ctx.createBiquadFilter();
        dull.type = 'lowpass';
        dull.frequency.value = 900 + Math.random() * 700;
        const gain = ctx.createGain();
        gain.gain.value = dbToGain(level - Math.random() * 4) * settings.groans;
        // off to one side or the other, never dead ahead
        const pan = ctx.createStereoPanner();
        pan.pan.value = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.5);
        // a little of it comes back off the wet ground, late
        const echo = ctx.createDelay(0.5);
        echo.delayTime.value = 0.19 + Math.random() * 0.08;
        const echoGain = ctx.createGain();
        echoGain.gain.value = 0.3;
        src.connect(dull).connect(gain).connect(pan).connect(master);
        gain.connect(echo).connect(echoGain).connect(master);
        src.start(now() + 0.02);
        // (the echo outlives the voice by a quarter of a second)
        src.onended = () => setTimeout(() => { pan.disconnect(); echoGain.disconnect(); }, 600);
    }

    /**
     * The title, said aloud: the series says its own name on its title screen, and so does this.
     *
     * @param {number} [level] - How loud, in dB.
     * @returns {number} How many seconds it takes to say (what is left after that is echo): 0 if
     * there is nothing to say it with.
     */
    function announce(level = 1) {
        const said = buffers['title-voice'];
        if (!audible() || !said) return 0;
        const src = ctx.createBufferSource();
        src.buffer = said;
        const gain = ctx.createGain();
        gain.gain.value = dbToGain(level);
        src.connect(gain).connect(master);
        src.start(now() + 0.02);
        src.onended = () => gain.disconnect();
        return spoken?.ends ?? said.duration;
    }

    function click() {
        if (!audible()) return;
        const t = now() + 0.01;

        const n = Math.floor(ctx.sampleRate * 0.05), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        const tick = ctx.createBufferSource();
        tick.buffer = buf;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 2800;
        band.Q.value = 1.5;
        const tickGain = ctx.createGain();
        tickGain.gain.setValueAtTime(0.5, t);
        tickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
        tick.connect(band).connect(tickGain).connect(master);
        tick.start(t);
        tick.stop(t + 0.05);

        const body = ctx.createOscillator();
        body.frequency.setValueAtTime(190, t);
        body.frequency.exponentialRampToValueAtTime(90, t + 0.06);
        const bodyGain = ctx.createGain();
        bodyGain.gain.setValueAtTime(0.22, t);
        bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        body.connect(bodyGain).connect(master);
        body.start(t);
        body.stop(t + 0.1);
        body.onended = () => bodyGain.disconnect();
    }

    const data = new Float32Array(2048);
    const meter = { rmsDb: -Infinity, peakDb: -Infinity, peakHoldDb: -Infinity };

    app.on('update', (dt) => {
        clock += dt;
        if (!ctx || !on) return;
        const t = now();
        if (offlineAt >= 0) offlineAt += dt;
        // (the film asks for its own groans: none come by chance while it is rendered)
        else if (ctx.state === 'running' && (nextGroan -= dt) <= 0) groan();

        for (const [name, b] of Object.entries(beds)) {
            let g = BEDS[name].gain * settings.rain * dbToGain(2 * Math.sin(clock * 2 * Math.PI / b.drift + b.phase));
            // drops in water are a small sound: you hear them when you are down near them
            if (name === 'rain-puddles') g *= pc.math.lerp(0.7, 1.6, pc.math.clamp(1 - camera.getPosition().y / 1.6, 0, 1));
            b.node.gain.setTargetAtTime(g, t, 0.3);
        }
        if (wind) {
            const g = gust(clock);     // 0.1 .. 1
            wind.gain.gain.setTargetAtTime(settings.wind * (0.06 + 0.5 * g * g), t, 0.25);
            wind.band.frequency.setTargetAtTime(170 + 330 * g, t, 0.25);
        }

        analyser.getFloatTimeDomainData(data);
        let sum = 0, peak = 0;
        for (let i = 0; i < data.length; i++) { sum += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
        const rms = 10 * Math.log10(sum / data.length + 1e-12);
        meter.rmsDb = Number.isFinite(meter.rmsDb) ? meter.rmsDb + (rms - meter.rmsDb) * Math.min(1, dt * 2) : rms;
        meter.peakDb = 20 * Math.log10(peak + 1e-6);
        meter.peakHoldDb = Math.max(meter.peakHoldDb, meter.peakDb);
    });

    const show = () => button?.setAttribute('aria-pressed', String(on));

    // resolves once everything is decoded and playing, whichever call got there first
    let building = null;
    async function start() {
        if (offlineAt >= 0) return;
        on = true;
        show();
        if (!started) {
            started = true;
            ctx = new AudioContext();
            master = ctx.createGain();
            master.gain.value = 0;
            analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            master.connect(analyser).connect(ctx.destination);
            building = build();
        }
        await building;
        await ctx.resume();
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(on ? settings.volume : 0, ctx.currentTime, 0.8);
    }

    function stop() {
        if (offlineAt >= 0) return;
        on = false;
        show();
        if (!ctx) return;
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        setTimeout(() => { if (!on) ctx.suspend(); }, 1200);
    }

    // the first gesture anywhere starts the sound; after that only the button changes it
    const first = (e) => {
        if (button && e.target instanceof Node && button.contains(e.target)) return;
        window.removeEventListener('pointerdown', first, true);
        window.removeEventListener('keydown', first, true);
        if (!started) start();
    };
    window.addEventListener('pointerdown', first, true);
    window.addEventListener('keydown', first, true);
    button?.addEventListener('click', () => (on ? stop() : start()));
    show();

    /**
     * Render to a buffer instead of playing. From now until render() is called, the updates of
     * the scene schedule their sound on an offline graph, at the time those updates have reached.
     *
     * @param {number} seconds - How long the result is.
     * @param {number} [fadeIn] - Seconds it takes to come up at the start.
     * @param {number} [fadeOut] - Seconds it takes to go at the end.
     * @returns {Promise<{ render: () => Promise<AudioBuffer> }>} Call render() when the updates are done.
     */
    async function offline(seconds, fadeIn = 0.5, fadeOut = 2) {
        const live = { ctx, master, analyser, on, wind, ready, beds: { ...beds } };
        const restore = () => {
            offlineAt = -1;
            for (const k of Object.keys(beds)) delete beds[k];
            Object.assign(beds, live.beds);
            ({ ctx, master, analyser, on, wind, ready } = live);
        };
        try {
            ctx = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
            master = ctx.createGain();
            master.gain.setValueAtTime(0, 0);
            master.gain.linearRampToValueAtTime(settings.volume, fadeIn);
            master.gain.setValueAtTime(settings.volume, seconds - fadeOut);
            master.gain.linearRampToValueAtTime(0, seconds);
            analyser = ctx.createAnalyser();
            master.connect(analyser).connect(ctx.destination);
            for (const k of Object.keys(beds)) delete beds[k];
            wind = null;
            await build();
            on = true;
            offlineAt = 0;
        } catch (err) {
            restore();
            throw err;
        }
        return {
            async render() {
                try {
                    return await ctx.startRendering();
                } finally {
                    restore();
                }
            }
        };
    }

    return { settings, start, stop, click, groan, announce, offline, meter, get spoken() { return spoken; }, get running() { return !!ctx && ctx.state === 'running' && on; }, get context() { return ctx; } };
}
