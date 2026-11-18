// Dev only: render the film (src/demo.js) to a video file, frame by frame.
//
// A screen recording drops frames and takes whatever resolution the laptop manages. Here every
// frame is stepped by exactly 1/60 s, drawn at 1920 x 1080 and handed to the browser's H.264
// encoder (WebCodecs). The sound is not recorded but rendered, by the same code on an
// OfflineAudioContext (src/audio.js). The dev server writes both into captures/ (vite.config.js),
// and tools/finish-video.mjs makes the file to share.
//
// The film loops, and its loop opens on lightning showing the pair in outline. So the video runs
// on past the end of the film into that: the title comes up in the dark, the flash shows the two
// of them under it, and the torch is kept off while the thunder rolls away. The title is said
// aloud as it comes up, so that the name ends just as the lightning strikes.
//
// The title stands low in the picture, over the wet ground: the top of it belongs to the lamp
// and to the two of them.
//
// still() makes one frame of that ending into a picture, for a shared link to show, and icons()
// the page's icons. Both go to captures/ too, to be copied into public/.
//
// From the console of a page opened with ?demo:   __sr.capture.run()   and watch __sr.capture.state.
// A long run can be made in pieces, each in a fresh page: run({ start, end }) in frames, with
// `audio: false` for all but one. The pieces must meet on a cut (the rain is different in every
// page), which at 60 frames a second means 480, 1200 or 1650.

const nextTask = () => new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
});
const sat = x => Math.min(1, Math.max(0, x));
const smooth = t => t * t * (3 - 2 * t);

function wavFromBuffer(buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
    const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) dv.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true);
    return new Blob([dv.buffer], { type: 'audio/wav' });
}

/**
 * The title as on the title card: the page's own lettering and its own wear, drawn as an image.
 *
 * @param {number} W - Width of the video.
 * @param {number} H - Height of the video.
 * @param {number} [wideness] - How far across the picture it reaches, 0..1.
 * @param {number} [down] - How far down the picture its middle is, 0..1.
 * @returns {Promise<HTMLImageElement>} A picture the size of the video, clear but for the title.
 */
async function titleImage(W, H, wideness = W > H ? 0.4 : 0.8, down = 0.815) {
    const SIZE = 104;       // px: the size the wear was drawn for (index.html)
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${SIZE}px Impact`;
    const wide = probe.measureText('GAUSSIAN EVIL').width + 13 * SIZE * 0.01 + SIZE * 0.08;
    // across two fifths of a wide picture, most of an upright one
    const k = W * wideness / wide;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>${document.getElementById('worn').outerHTML}</defs>
        <g transform="translate(${W / 2} ${H * down}) scale(${k} ${k * 1.3})">
            <text filter="url(#worn)" text-anchor="middle" dominant-baseline="central" font-family="Impact, Haettenschweiler, 'Arial Narrow', sans-serif" font-size="${SIZE}" letter-spacing="${SIZE * 0.01}" word-spacing="${SIZE * 0.08}" fill="#ebe8e2"><tspan fill="#c8141b">G</tspan>AUSSIAN <tspan fill="#c8141b">E</tspan>VIL</text>
        </g>
    </svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    return img;
}

/**
 * @param {object} o - The scene.
 * @param {object} o.pc - The engine.
 * @param {object} o.app - The app.
 * @param {object} o.director - From createDirector: it must be playing the demo.
 * @param {object} o.demo - From createDemo.
 * @param {object|null} o.sound - From createSoundscape.
 * @param {() => void} o.relens - Sets the lens for the shape of the canvas.
 * @returns {object} run() and state.
 */
export function createCapture({ pc, app, director, demo, sound, relens }) {
    const device = app.graphicsDevice, canvas = device.canvas;
    const state = { running: false, phase: '', frame: 0, frames: 0, perSecond: 0, error: null, info: null };
    const CSS = 1.5;        // drawn as on a screen with 1.5 device pixels to the pixel

    // the engine's own loop stops: every frame from then on is asked for
    const halt = () => {
        if (app.frameRequestId) cancelAnimationFrame(app.frameRequestId);
        app.frameRequestId = null;
    };
    // the canvas at exactly so many pixels, whatever the window is; and back again
    const fix = (W, H) => {
        document.body.classList.add('capturing');       // (no letterbox, and no lens widened for one: src/main.js)
        device.maxPixelRatio = 1;
        app.setCanvasFillMode(pc.FILLMODE_NONE, W / CSS, H / CSS);
        app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);
        relens();
    };
    const free = (ratio) => {
        document.body.classList.remove('capturing');
        device.maxPixelRatio = ratio;
        app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        relens();
    };
    const save = (file, blob) => fetch(`/__save?file=${file}`, { method: 'POST', body: blob });
    const drawTitle = (g, title, alpha) => {
        g.save();
        g.globalAlpha = alpha;
        g.shadowColor = 'rgba(0, 0, 0, 0.85)';
        g.shadowBlur = 24;
        g.shadowOffsetY = 3;
        g.drawImage(title, 0, 0);
        g.restore();
    };

    /**
     * @param {object} [o] - Options.
     * @param {string} [o.name] - The files are captures/<name>.h264 and captures/<name>.wav.
     * @param {number} [o.width] - Of the video, in pixels.
     * @param {number} [o.height] - Of the video, in pixels.
     * @param {number} [o.fps] - Frames a second.
     * @param {number} [o.qp] - H.264 quantizer: lower is better and bigger.
     * @param {number} [o.start] - First frame to render (earlier ones are only stepped).
     * @param {number} [o.end] - One past the last frame to render.
     * @param {boolean} [o.video] - Whether to render the picture.
     * @param {boolean} [o.audio] - Whether to render the sound: only when no frame is left out before `end`.
     * @param {number} [o.after] - Seconds the video runs on past the end of the film.
     * @returns {Promise<string>} The phase it ended in: 'done' or 'failed'.
     */
    async function run({ name = 'film', width = 1920, height = 1080, fps = 60, qp = 16, start = 0, end = Infinity, video = true, audio = true, after = 5.8 } = {}) {
        if (state.running) return 'busy';
        Object.assign(state, { running: true, phase: 'setup', frame: 0, error: null });
        const was = { torchOn: demo.torchOn, ratio: device.maxPixelRatio, timeScale: app.timeScale };
        const W = width, H = height;
        let track = null, rendered = false;
        try {
            if (director.phase !== 'demo') throw new Error('open the page with ?demo first');
            director.settings.deaf = true;
            app.timeScale = 1;
            if (video) fix(W, H);
            halt();

            const total = Math.round((demo.length + after) * fps);
            const film = Math.round(demo.length * fps);
            const frames = Math.min(end, total);
            state.frames = frames;
            const seconds = total / fps;

            // the timeline of the title that comes up over the end, in seconds of video
            const titleAt = demo.torchOff + 0.6, wordsAt = titleAt + 0.9, fadeAt = seconds - 1.0;
            const title = video ? await titleImage(W, H) : null;
            const comp = document.createElement('canvas');
            comp.width = W; comp.height = H;
            const g = comp.getContext('2d');
            const words = (t) => {
                const a = smooth(sat((t - wordsAt) / 0.8));
                if (a <= 0) return;
                const u = Math.min(W, H) / 1080;
                g.save();
                g.globalAlpha = a;
                g.textAlign = 'center';
                g.shadowColor = 'rgba(0, 0, 0, 0.9)';
                g.shadowBlur = 12 * u;
                g.fillStyle = 'rgba(232, 230, 225, 0.82)';
                g.font = `${27 * u}px "Courier New", Courier, monospace`;
                g.fillText('A homage to the greatest horror game of all time. Made with PlayCanvas.', W / 2, H - 84 * u, W * 0.94);
                g.fillStyle = 'rgba(232, 230, 225, 0.5)';
                g.font = `${19 * u}px "Courier New", Courier, monospace`;
                g.letterSpacing = `${1.2 * u}px`;
                g.fillText('Capture: Adrian Cuesta, Dymensium (CC BY 4.0)   ·   superspl.at/scene/67841e9d', W / 2, H - 44 * u, W * 0.94);
                g.restore();
            };

            // ---- the encoder, and where its output goes ----
            const pending = [];
            let pendingBytes = 0;
            const send = async () => {
                if (!pending.length) return;
                const blob = new Blob(pending);
                pending.length = 0; pendingBytes = 0;
                await fetch(`/__save?file=${name}.h264&append=1`, { method: 'POST', body: blob });
            };
            let encoder = null, quant = false;
            if (video) {
                if (start === 0) await fetch(`/__save?file=${name}.h264`, { method: 'POST', body: new Blob([]) });
                encoder = new VideoEncoder({
                    output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); pending.push(b); pendingBytes += b.length; },
                    error: (e) => { state.error = String(e); }
                });
                let cfg = { codec: 'avc1.640033', width: W, height: H, framerate: fps, avc: { format: 'annexb' }, bitrateMode: 'quantizer', latencyMode: 'quality' };
                quant = (await VideoEncoder.isConfigSupported(cfg)).supported;
                if (!quant) cfg = { ...cfg, bitrateMode: 'variable', bitrate: 60_000_000 };
                encoder.configure(cfg);
                state.info = { quant, codec: cfg.codec, size: [W, H], fps };
            }

            // ---- to the top of the film: through its dark end, so that any lightning has died away ----
            director.seek(demo.length - 1.5);
            for (let k = 0; k < 3 * fps && director.filmAt > 1; k++) app.update(1 / fps);
            director.seek(0);
            track = audio && sound ? await sound.offline(seconds, 0.5, 2) : null;

            // frames are a sixtieth apart by the engine's own clock, which is told the time
            let stamp = 1000;
            app.timeScale = 0;
            app.tick(stamp);
            halt();
            app.timeScale = 1;

            // the frame at which the title starts to be said: so that its last word ends on the lightning
            const sayAt = Math.round((demo.length + demo.strikes[0].at - (sound?.spoken?.ends ?? 2.5)) * fps);
            const WARM = 6;         // frames drawn, and thrown away, before the first of a later piece
            state.phase = 'frames';
            let since = performance.now(), sinceFrame = 0;
            for (let i = 0; i < frames; i++) {
                // past the end of the film it would begin again: the torch stays off
                if (i === film) demo.torchOn = Infinity;
                if (i === sayAt && track) sound.announce();
                if (!video || i < start - WARM) {
                    app.update(1 / fps);
                } else {
                    stamp += 1000 / fps;
                    app.tick(stamp);
                    halt();
                    if (i >= start) {
                        const t = i / fps;
                        g.globalAlpha = 1;
                        g.drawImage(canvas, 0, 0, W, H);
                        const a = smooth(sat((t - titleAt) / 0.9));
                        if (a > 0) drawTitle(g, title, a);
                        words(t);
                        const out = sat((t - fadeAt) / (seconds - fadeAt));
                        if (out > 0) {
                            g.globalAlpha = smooth(out);
                            g.fillStyle = '#000';
                            g.fillRect(0, 0, W, H);
                        }
                        const vf = new VideoFrame(comp, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
                        const key = i === start || i % (fps * 2) === 0;
                        encoder.encode(vf, quant ? { keyFrame: key, avc: { quantizer: qp } } : { keyFrame: key });
                        vf.close();
                        while (encoder.encodeQueueSize > 3) await nextTask();
                        if (pendingBytes > 16e6) await send();
                    }
                }
                if (state.error) throw new Error(state.error);
                state.frame = i + 1;
                if (i % 30 === 29) {
                    const nowMs = performance.now();
                    state.perSecond = +((i + 1 - sinceFrame) * 1000 / (nowMs - since)).toFixed(1);
                    since = nowMs; sinceFrame = i + 1;
                }
                if (video || i % 20 === 0) await nextTask();
            }
            if (encoder) {
                await encoder.flush();
                encoder.close();
                await send();
            }

            if (track) {
                state.phase = 'audio';
                if (frames < total) throw new Error('the sound needs every frame up to the end: leave `end` out');
                rendered = true;
                await fetch(`/__save?file=${name}.wav`, { method: 'POST', body: wavFromBuffer(await track.render()) });
            }
            state.phase = 'done';
        } catch (e) {
            state.error = String(e?.stack || e);
            state.phase = 'failed';
        } finally {
            // (rendering is also what gives the sound back to the page)
            if (track && !rendered) track.render().catch(() => {});
            demo.torchOn = was.torchOn;
            director.settings.deaf = false;
            if (video) free(was.ratio);
            app.timeScale = was.timeScale;
            state.running = false;
            app.tick();     // the engine's loop again
        }
        return state.phase;
    }

    /**
     * One frame as a picture with the title on it: by default the flash that ends the video, at
     * the size a shared link shows.
     *
     * @param {object} [o] - Options.
     * @param {string} [o.name] - The file is captures/<name>.
     * @param {number} [o.width] - In pixels.
     * @param {number} [o.height] - In pixels.
     * @param {number} [o.at] - Seconds into the film: just after its first strike.
     * @param {boolean} [o.title] - Whether the title is drawn on it.
     * @param {() => (() => void)|void} [o.setup] - Called when the film has reached `at`, before the
     * picture is drawn: to show the scene some other way (the capture as it was shot, the mesh
     * that is lit). What it returns is called afterwards, to put things back.
     * @returns {Promise<string>} 'done' or what went wrong.
     */
    async function still({ name = 'share.jpg', width = 1200, height = 630, at = 1.62, title = true, setup = null } = {}) {
        if (state.running) return 'busy';
        state.running = true;
        const was = { ratio: device.maxPixelRatio, timeScale: app.timeScale };
        let undo = null;
        try {
            if (director.phase !== 'demo') throw new Error('open the page with ?demo first');
            director.settings.deaf = true;
            app.timeScale = 1;
            fix(width, height);
            halt();
            director.seek(demo.length - 1.5);
            for (let k = 0; k < 180 && director.filmAt > 1; k++) app.update(1 / 60);
            director.seek(0);
            for (let k = 0; k < Math.round(at * 60); k++) app.update(1 / 60);
            app.timeScale = 0;
            undo = setup?.() ?? null;
            for (let k = 0; k < 6; k++) {
                app.tick();
                halt();
                await nextTask();
            }
            const comp = document.createElement('canvas');
            comp.width = width; comp.height = height;
            const g = comp.getContext('2d');
            g.drawImage(canvas, 0, 0, width, height);
            if (title) drawTitle(g, await titleImage(width, height, 0.46, 0.845), 1);
            const png = name.endsWith('.png');
            await save(name, await new Promise(resolve => comp.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.92)));
            return 'done';
        } catch (e) {
            return String(e?.stack || e);
        } finally {
            undo?.();
            director.settings.deaf = false;
            free(was.ratio);
            app.timeScale = was.timeScale;
            state.running = false;
            app.tick();
        }
    }

    /**
     * The page's icons: the red G of the title on black, as captures/favicon.png and
     * captures/apple-touch-icon.png.
     *
     * @returns {Promise<string>} 'done'.
     */
    async function icons() {
        for (const [name, size] of [['favicon.png', 64], ['apple-touch-icon.png', 180]]) {
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const g = c.getContext('2d');
            g.fillStyle = '#050608';
            g.fillRect(0, 0, size, size);
            g.fillStyle = '#c8141b';
            g.textAlign = 'center';
            g.textBaseline = 'alphabetic';
            g.font = `${size * 0.66}px Impact, Haettenschweiler, "Arial Narrow", sans-serif`;
            // tall, as the title is
            g.translate(size / 2, size * 0.83);
            g.scale(1, 1.3);
            g.fillText('G', 0, 0);
            await save(name, await new Promise(resolve => c.toBlob(resolve, 'image/png')));
        }
        return 'done';
    }

    return { run, still, icons, state };
}
