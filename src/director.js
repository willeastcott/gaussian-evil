// The shape of a visit.
//
//   title    the card is up; behind it the scene is already drawing, dark, so that nothing has
//            to be built at the moment it is first seen
//   opening  darkness and rain; lightning shows the two of them for an instant; the torch clicks
//            on at their feet and climbs to their faces, while the camera walks in. Any click,
//            key or scroll cuts it short
//   live     the torch and the camera are the visitor's. A move to another shot (glide) is flown
//            for them: the engine's own takes a fifth of a second, which reads as a cut
//   idle     nobody has touched anything for a while: the camera swings slowly about whatever it
//            was looking at and the torch wanders over them, until somebody does
//   demo     the scene plays by itself: a short film that loops (src/demo.js). It can be asked
//            for, on the title card or once inside; and it starts by itself when the idle drift
//            has gone on for a while. Asked for, it runs until a click, a tap or a key. Started
//            by itself, moving the mouse is enough to end it
//
// Two things change hands between the script and the visitor.
//
// The camera: while the script has it, the orbit controls are switched off and the camera is
// placed directly. Handing it back is `controls.focusPoint = ...`, which makes the controls take
// up the camera from wherever it stands.
//
// The torch: `state.pointer`, the point on screen it is aimed at, is a mix of where the script
// points it and where the visitor does (src/aim.js). The mix slides from one to the other, so
// the beam never jumps.
//
// The script also holds the torch whenever the visitor is not aiming it: before they first move
// the mouse, and when the mouse has gone to a button or off the page. Left at the spot where the
// pointer crossed the edge, the beam would be on the ground or out in the rain, and the two of
// them in the dark. So it comes to rest on whatever the camera is looking at, and sways a little
// there, as a torch does in a hand.
import * as pc from 'playcanvas';

const smooth = t => t * t * (3 - 2 * t);
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
const sat = x => Math.min(1, Math.max(0, x));
const TURN = Math.PI * 2;

/**
 * @param {object} o - What is directed.
 * @param {pc.AppBase} o.app - The app.
 * @param {pc.Entity} o.camera - Main camera.
 * @param {object} o.controls - Its CameraControls script.
 * @param {object} o.state - The torch: `pointer` (where it aims) and `power` (0 off .. 1 on).
 * @param {object} o.aim - From createAim: where the visitor points.
 * @param {object|null} o.lightning - From createLightning.
 * @param {object|null} o.sound - From createSoundscape.
 * @param {object} o.demo - From createDemo: the film the scene plays by itself.
 * @param {{ focus: pc.Vec3, position: pc.Vec3 }} o.wide - The shot the opening arrives at.
 * @param {number} o.minHeight - The camera stays this far above the ground.
 * @param {(phase: string, from: string) => void} o.onPhase - Told of every change of phase.
 * @param {() => void} [o.onInvite] - Called in the dark at the end of the demo: the moment to
 * say how the torch is taken.
 * @returns {object} Settings, update(dt), begin(), skip(), watch(), glide() and the phase.
 */
export function createDirector({ app, camera, controls, state, aim, lightning, sound, demo, wide, minHeight, onPhase, onInvite }) {
    const settings = {
        // ---- the opening: seconds from the way in ----
        from: { position: new pc.Vec3(-0.35, 0.5, 6.2), focus: new pc.Vec3(0, 0.95, 0) },
        arrive: 8.5,            // the camera reaches the wide shot and is handed over
        strike: 2.2,            // lightning, from behind them and to the left
        strikeFrom: -110,       // degrees round the sky: the camera looks along -z
        strikeHeight: 38,
        strikeNear: 0.92,
        torchOn: 4.8,
        torchFrom: [0.5, 0.8],  // the beam starts on the ground at their feet...
        torchTo: [0.5, 0.36],   // ...and ends on their faces
        torchRise: [0.5, 2.6],  // seconds after it comes on that the climb starts and ends
        torchYours: 1.6,        // seconds after it comes on that the visitor may take it
        dark: 0.04,             // ambient light before the torch is on, as a fraction of the usual
        eyesAdjust: 3,          // seconds over which it returns
        // ---- a move to another shot: seconds, for no turn at all and for a half turn ----
        glide: [1.3, 2.6],
        // ---- the torch at rest, when the visitor is not aiming it ----
        rest: [0.5, 0.4],       // where on screen: the camera looks at the middle, faces are a little above
        restAfter: 0.3,         // seconds the mouse must be gone before the torch is taken
        restEase: 0.55,         // seconds (time constant) it takes to come to rest
        sway: [0.04, 0.025],    // how far it wanders about that point, across and up and down
        // ---- idle ----
        idleAfter: 25,          // seconds without the visitor doing anything
        easeIn: 5,              // seconds the drift takes to get going
        swing: 20,              // degrees either way, round the subject
        swingEvery: 44,         // seconds for a full swing
        nod: 2,                 // degrees up and down
        breathe: 0.06,          // fraction of the distance it moves in and out
        // ---- the demo ----
        demoAfter: 35,          // seconds of drifting before the film starts by itself; 0 for never
        demoLead: 1.2,          // seconds of dark between the torch going out and the first shot
        demoDim: 0.5,           // seconds the last of the light takes to go once the torch is out
        deaf: false             // nothing the visitor does is heard: set while the film is rendered to a file (src/capture.js)
    };
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let phase = 'title';
    let clock = 0, began = 0, beganWall = 0, lastActivity = 0;
    let struck = false, lit = false;

    const scripted = new pc.Vec2(settings.torchFrom[0], settings.torchFrom[1]);
    let owner = 0, ownerTarget = 0;     // 0: the script aims the torch .. 1: the visitor does
    let awayFor = 0, restFor = 0;
    // the torch goes to the visitor, unless their mouse is somewhere else
    const giveTorch = () => {
        ownerTarget = aim.away ? 0 : 1;
    };

    const eye = new pc.Vec3(), look = new pc.Vec3();
    const focus = new pc.Vec3(), wanderFrom = new pc.Vec2();
    const orbit = { focus: new pc.Vec3(), yaw: 0, pitch: 0, distance: 1 };
    let idleFor = 0, idleSwing = 0;
    // the demo: where the film has got to, and how it came to be playing
    const take = demo.frame();
    let filmAt = 0, cuesFrom = -1, shotWas = -1;
    let lead = 0;                       // seconds of dark still to go before the first shot
    let byItself = false;               // nobody asked for it
    let drifting = false;               // the camera was drifting when it started, and drifts on through the lead
    // a move between shots: both ends as a point looked at, and the camera's bearing from it
    const flight = { on: false, t: 0, takes: 1, from: { focus: new pc.Vec3(), yaw: 0, pitch: 0, distance: 1 }, to: { focus: new pc.Vec3(), yaw: 0, pitch: 0, distance: 1 } };
    const canvas = app.graphicsDevice.canvas;

    const setPhase = (next) => {
        const from = phase;
        phase = next;
        onPhase(next, from);
    };
    const setAmbient = (k) => {
        if (lightning) lightning.settings.ambient = k;
    };
    const place = () => {
        camera.setPosition(eye);
        camera.lookAt(look);
    };
    // the camera as a bearing and a distance from the point it looks at, and back again
    const bearing = (out, position, point) => {
        eye.copy(position).sub(point);
        out.focus.copy(point);
        out.distance = Math.max(eye.length(), 0.01);
        out.yaw = Math.atan2(eye.x, eye.z);
        out.pitch = Math.asin(pc.math.clamp(eye.y / out.distance, -1, 1));
        return out;
    };
    const stand = (point, yaw, pitch, distance) => {
        eye.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).mulScalar(distance).add(point);
        eye.y = Math.max(eye.y, minHeight);
        look.copy(point);
        place();
    };
    // the controls take up the camera where it stands
    const handBack = () => {
        flight.on = false;
        controls.focusPoint = look;
        controls.enabled = true;
    };

    // the script takes the camera from the start: the scene waits at the first frame of the opening
    controls.enabled = false;
    eye.copy(settings.from.position);
    look.copy(settings.from.focus);
    place();
    state.power = 0;
    setAmbient(settings.dark);
    if (lightning) lightning.settings.enabled = false;

    // the bulb catches: on, a dip, on
    const catches = (s) => {
        if (calm) return smooth(sat(s / 0.6));
        return s < 0.05 ? 1 : s < 0.11 ? 0.25 : s < 0.17 ? 0.9 : s < 0.21 ? 0.6 : 1;
    };

    // the switch clicks both ways
    function setLit(on) {
        if (lit === on) return;
        lit = on;
        sound?.click();
    }

    /** @param {boolean} cut - Whether the opening was cut short. */
    function goLive(cut) {
        setLit(true);
        state.power = 1;
        state.reach = 0;
        setAmbient(1);
        if (lightning) {
            lightning.settings.enabled = true;
            lightning.defer(5 + Math.random() * 6);
        }
        // cut short, the camera is the visitor's from wherever the script had got it to
        if (!controls.enabled) handBack();

        if (aim.mode === 'mouse') {
            // the cursor is wherever the visitor left it: the beam goes there when it next moves
            if (cut) giveTorch();
        } else {
            // a tap or a turn of the phone moves the beam from where it now is
            if (cut) scripted.copy(state.pointer);
            aim.anchor(scripted);
            ownerTarget = 1;
        }
        lastActivity = clock;
        setPhase('live');
    }

    function stepOpening() {
        const o = settings, t = clock - began;

        const k = smoother(sat(t / o.arrive));
        eye.lerp(o.from.position, wide.position, k);
        look.lerp(o.from.focus, wide.focus, k);
        place();

        if (!struck && t >= o.strike) {
            struck = true;
            lightning?.strike({ azimuth: o.strikeFrom * pc.math.DEG_TO_RAD, height: o.strikeHeight, near: o.strikeNear });
        }

        const on = t - o.torchOn;
        if (on >= 0) setLit(true);
        state.power = on >= 0 ? catches(on) : 0;
        setAmbient(pc.math.lerp(o.dark, 1, smooth(sat(on / o.eyesAdjust))));
        const rise = smooth(sat((on - o.torchRise[0]) / (o.torchRise[1] - o.torchRise[0])));
        scripted.set(pc.math.lerp(o.torchFrom[0], o.torchTo[0], rise), pc.math.lerp(o.torchFrom[1], o.torchTo[1], rise));

        if (t >= o.arrive) goLive(false);
    }

    /**
     * Fly the camera to another shot: round whatever it is looking at, not straight through it.
     *
     * @param {pc.Vec3} point - What the shot looks at.
     * @param {pc.Vec3} position - Where it is taken from.
     */
    function glide(point, position) {
        if (phase === 'idle') wake();
        if (phase !== 'live') return;
        // from where the camera is now, which may be part way through another move
        bearing(flight.from, camera.getPosition(), flight.on ? look.clone() : controls.focusPoint);
        bearing(flight.to, position, point);
        look.copy(flight.from.focus);
        // the short way round
        flight.to.yaw = flight.from.yaw + pc.math.clamp(flight.to.yaw - flight.from.yaw - TURN * Math.round((flight.to.yaw - flight.from.yaw) / TURN), -Math.PI, Math.PI);
        flight.takes = pc.math.lerp(settings.glide[0], settings.glide[1], Math.abs(flight.to.yaw - flight.from.yaw) / Math.PI);
        flight.t = 0;
        flight.on = true;
        controls.enabled = false;
        lastActivity = clock;
    }

    function stepGlide(dt) {
        const a = flight.from, b = flight.to;
        flight.t += dt;
        const k = smoother(sat(flight.t / flight.takes));
        focus.lerp(a.focus, b.focus, k);
        stand(focus, pc.math.lerp(a.yaw, b.yaw, k), pc.math.lerp(a.pitch, b.pitch, k), pc.math.lerp(a.distance, b.distance, k));
        if (flight.t >= flight.takes) handBack();
        lastActivity = clock;
    }

    function goIdle() {
        controls.enabled = false;
        bearing(orbit, camera.getPosition(), controls.focusPoint);
        focus.copy(orbit.focus);
        look.copy(focus);
        idleFor = 0;
        idleSwing = 0;
        // the script takes the torch from where it is pointing now
        wanderFrom.copy(state.pointer);
        scripted.copy(state.pointer);
        owner = ownerTarget = 0;
        setPhase('idle');
    }

    // the camera swings slowly about whatever it was looking at
    function drift(dt) {
        const o = settings;
        // the drift gathers way slowly: `idleSwing` is time, run slow to begin with
        idleFor += dt;
        const k = smooth(sat(idleFor / o.easeIn));
        idleSwing += dt * k;

        const yaw = orbit.yaw + o.swing * pc.math.DEG_TO_RAD * Math.sin(idleSwing * TURN / o.swingEvery);
        const pitch = orbit.pitch + o.nod * pc.math.DEG_TO_RAD * Math.sin(idleSwing * TURN / 31);
        const distance = orbit.distance * (1 - o.breathe * (0.5 - 0.5 * Math.cos(idleSwing * TURN / 53)));
        stand(focus, yaw, pitch, distance);
        return k;
    }

    function stepIdle(dt) {
        const k = drift(dt);
        // the torch wanders over them, never quite repeating
        const x = 0.5 + 0.2 * Math.sin(idleSwing * 0.37), y = 0.42 + 0.16 * Math.sin(idleSwing * 0.53 + 1.3);
        scripted.set(pc.math.lerp(wanderFrom.x, x, k), pc.math.lerp(wanderFrom.y, y, k));

        // still nobody: the scene plays its film. (Not for somebody who has asked for less
        // motion: the film has cuts in it, and the drift does not.)
        if (!calm && settings.demoAfter > 0 && idleFor > settings.demoAfter && !document.hidden) startDemo(true);
    }

    function wake() {
        handBack();
        giveTorch();
        setPhase('live');
    }

    // ---- the demo ----

    // Point the torch at a place in the world: find where that place is on screen, which is how
    // the torch is aimed, and how far off it is. (The camera has just been placed. Its own axes
    // are up to date; the matrices the engine keeps for it may not be.)
    const offset = new pc.Vec3();
    function light(point) {
        offset.sub2(point, camera.getPosition());
        const ahead = Math.max(offset.dot(camera.forward), 0.05);
        const half = Math.tan(camera.camera.fov * 0.5 * pc.math.DEG_TO_RAD) * ahead;
        const shape = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
        scripted.set(0.5 + 0.5 * offset.dot(camera.right) / (half * shape), 0.5 - 0.5 * offset.dot(camera.up) / half);
        state.reach = offset.length();
    }

    /**
     * The film, from the top.
     *
     * @param {boolean} unasked - Whether it is starting by itself, with nobody there.
     */
    function startDemo(unasked) {
        const from = phase;
        byItself = unasked;
        drifting = from === 'idle';
        if (flight.on) handBack();
        // On the title card the scene is dark already, and stands at the first frame of the film.
        // From anywhere else the torch goes out first, and the film starts in the dark that
        // leaves: a cut that nobody sees. Until then a camera in the visitor's hands stays there.
        lead = from === 'title' ? 0 : settings.demoLead;
        if (lead > 0) setLit(false);
        else controls.enabled = false;
        filmAt = 0;
        cuesFrom = -1;
        shotWas = -1;
        scripted.copy(state.pointer);
        owner = ownerTarget = 0;
        if (lightning) lightning.settings.enabled = false;
        beganWall = performance.now();
        setPhase('demo');
    }

    function stepDemo(dt) {
        const o = settings;
        if (lead > 0) {
            lead -= dt;
            state.power = 0;
            setAmbient(pc.math.lerp(1, o.dark, smooth(sat((o.demoLead - lead) / o.demoDim))));
            if (drifting) drift(dt);
            if (lead > 0) return;
            controls.enabled = false;
        } else {
            filmAt += dt;
            if (filmAt >= demo.length) {
                // round again: the film ends in the dark, and begins in it
                filmAt -= demo.length;
                cuesFrom = -1;
            }
        }

        demo.sample(filmAt, take);
        stand(take.focus, take.yaw, take.pitch, take.distance);
        light(take.target);
        state.handTarget.copy(take.hand);
        if (take.shot !== shotWas) {
            // a cut: the beam is on its new mark at once, it does not swing across to it
            shotWas = take.shot;
            state.snap = true;
        }

        const on = filmAt - demo.torchOn, off = filmAt - demo.torchOff;
        const burning = on >= 0 && off < 0;
        setLit(burning);
        state.power = burning && !take.blank ? catches(on) * take.power : 0;
        setAmbient(take.blank ? 0 : off >= 0 ? pc.math.lerp(1, o.dark, smooth(sat(off / o.demoDim))) : pc.math.lerp(o.dark, 1, smooth(sat(on / o.eyesAdjust))));

        for (const s of demo.strikes) {
            if (s.at > cuesFrom && s.at <= filmAt) lightning?.strike({ azimuth: s.from * pc.math.DEG_TO_RAD, height: s.height, near: s.near });
        }
        for (const s of demo.groans) {
            if (s.at > cuesFrom && s.at <= filmAt) sound?.groan(s.level);
        }
        if (demo.invite > cuesFrom && demo.invite <= filmAt) onInvite?.();
        cuesFrom = filmAt;
    }

    // anything the visitor does: runs before the canvas hears of it, so that a drag which wakes
    // the scene is already the camera's by the time it starts
    const CUTS = ['Space', 'Enter', 'Escape'];      // the keys that cut the opening, or the demo, short
    const stirred = (e) => {
        // (a key held with Ctrl or Alt is for the browser, not for us)
        if (settings.deaf) return;
        const playing = phase === 'opening' || phase === 'demo';
        if (e.type === 'keydown' && (e.ctrlKey || e.altKey || e.metaKey || (playing && !CUTS.includes(e.code)))) return;
        lastActivity = clock;
        if (phase === 'idle') {
            wake();
        } else if (playing && performance.now() - beganWall > 600) {
            // (the click or key that started it is not also the one that ends it)
            goLive(true);
        } else if (flight.on && e.target === canvas && e.type !== 'keydown') {
            // taking hold of the camera part way through a move stops the move there
            handBack();
        }
    };
    for (const type of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(type, stirred, { capture: true, passive: true });

    /** @param {number} dt - Seconds since the last frame. Call it before the torch is placed. */
    function update(dt) {
        clock += dt;
        if (aim.take() && !settings.deaf) {
            lastActivity = clock;
            if (phase === 'idle') wake();
            else if (phase === 'demo' && byItself) goLive(true);
            if (phase === 'live' || (phase === 'opening' && clock - began > settings.torchOn + settings.torchYours)) ownerTarget = 1;
        }

        if (phase === 'opening') stepOpening();
        else if (phase === 'demo') stepDemo(dt);
        else if (phase === 'idle') stepIdle(dt);
        else if (flight.on) stepGlide(dt);
        else if (phase === 'live' && settings.idleAfter > 0 && clock - lastActivity > settings.idleAfter && !document.hidden) goIdle();

        if (phase === 'live') {
            // the mouse has gone: take the torch from where it points now
            awayFor = aim.away ? awayFor + dt : 0;
            if (ownerTarget === 1 && awayFor > settings.restAfter) {
                scripted.copy(state.pointer);
                owner = ownerTarget = 0;
            }
            // and while the script holds it, bring it to rest
            if (ownerTarget === 0) {
                const o = settings, k = 1 - Math.exp(-dt / o.restEase);
                restFor += dt;
                scripted.x += (o.rest[0] + o.sway[0] * Math.sin(restFor * 0.5) - scripted.x) * k;
                scripted.y += (o.rest[1] + o.sway[1] * Math.sin(restFor * 0.37 + 1.0) - scripted.y) * k;
            }
        }

        owner += (ownerTarget - owner) * (1 - Math.exp(-dt / 0.25));
        state.pointer.lerp(scripted, aim.user, smooth(sat(owner)));
    }

    return {
        settings,
        update,
        /** The way in has been taken: play the opening. */
        begin() {
            if (phase !== 'title') return;
            began = clock;
            beganWall = performance.now();
            setPhase('opening');
        },
        /** Straight to the torch, with no opening. */
        skip() {
            if (phase !== 'title' && phase !== 'opening') return;
            eye.copy(wide.position);
            look.copy(wide.focus);
            place();
            scripted.set(settings.torchTo[0], settings.torchTo[1]);
            goLive(false);
        },
        /** Play the demo: instead of the opening, or from inside the scene. */
        watch() {
            if (phase === 'title' || phase === 'live' || phase === 'idle') startDemo(false);
        },
        /** @param {number} t - Jump to this many seconds into the demo: for trying a shot out. */
        seek(t) {
            if (phase !== 'demo') return;
            lead = 0;
            controls.enabled = false;
            filmAt = cuesFrom = pc.math.clamp(t, 0, demo.length - 0.001);
            shotWas = -1;
        },
        glide,
        idle: goIdle,
        get phase() { return phase; },
        /** Whether the demo that is playing started by itself. */
        get byItself() { return phase === 'demo' && byItself; },
        /** Seconds into the demo. */
        get filmAt() { return filmAt; }
    };
}
