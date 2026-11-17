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
        thunder: 1
    };

    // the files are fetched straight away; they can only be decoded once there is a context
    const files = fetch('audio/manifest.json').then(r => r.json()).then(async (manifest) => {
        const names = [...(rain ? Object.keys(manifest.beds) : []), ...Object.keys(manifest.thunder)];
        const data = await Promise.all(names.map(n => fetch(`audio/${n}.mp3`).then(r => r.arrayBuffer())));
        return Object.fromEntries(names.map((n, i) => [n, data[i]]));
    });

    let ctx = null, master = null, analyser = null, started = false, on = false, ready = false;
    const buffers = {}, beds = {};
    let wind = null;
    let clock = 0, lastThunder = '';

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
        if (on && ctx && building && (ctx.state !== 'running' || !ready)) {
            building.then(() => ctx.resume()).then(() => rumble(strike));
        } else {
            rumble(strike);
        }
    }

    function rumble({ near, from }) {
        if (!on || !ctx || ctx.state !== 'running') return;
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
        src.start(ctx.currentTime + pc.math.lerp(3.2, 0.2, near) * (0.9 + Math.random() * 0.2));
        src.onended = () => pan.disconnect();
    }
    app.on('lightning:strike', thunder);

    // the switch on the torch: a sharp tick, with a little of the body of the torch under it.
    // Made here, like the wind: it is forty milliseconds long
    function click() {
        if (!on || !ctx || ctx.state !== 'running') return;
        const t = ctx.currentTime + 0.01;

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
        const now = ctx.currentTime;

        for (const [name, b] of Object.entries(beds)) {
            let g = BEDS[name].gain * settings.rain * dbToGain(2 * Math.sin(clock * 2 * Math.PI / b.drift + b.phase));
            // drops in water are a small sound: you hear them when you are down near them
            if (name === 'rain-puddles') g *= pc.math.lerp(0.7, 1.6, pc.math.clamp(1 - camera.getPosition().y / 1.6, 0, 1));
            b.node.gain.setTargetAtTime(g, now, 0.3);
        }
        if (wind) {
            const g = gust(clock);     // 0.1 .. 1
            wind.gain.gain.setTargetAtTime(settings.wind * (0.06 + 0.5 * g * g), now, 0.25);
            wind.band.frequency.setTargetAtTime(170 + 330 * g, now, 0.25);
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

    return { settings, start, stop, click, meter, get running() { return !!ctx && ctx.state === 'running' && on; }, get context() { return ctx; } };
}
