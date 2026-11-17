// Where the visitor points the torch.
//
//   - a mouse or a pen: wherever it hovers
//   - a touch screen: wherever it was last tapped. A drag turns the camera, so only a tap aims
//   - a phone that reports its orientation: the way its back is facing, as a torch held in the
//     hand would point. Turning the phone moves the beam across the screen by rather more than
//     the same angle, so that a small movement of the wrist is enough
//
// A mouse can also leave: for a button, or off the page altogether. The torch is then not being
// aimed at all (`away`), and where the pointer happened to cross the edge means nothing.
//
// The result is `user`, a point on the canvas as a fraction of its size. Whoever is directing
// the scene decides when the torch follows it (src/director.js).
import * as pc from 'playcanvas';

const TAP_TIME = 350;          // ms: a touch that lifts sooner than this, and has not moved, is a tap
const TAP_SLOP = 12;           // CSS px it may move
const TILT_GAIN = 1.6;         // how much further the beam moves than the phone turns
const TILT_NOTICE = 3;         // degrees of turning that count as the visitor doing something
const EDGE = 0.03;             // the beam stops this far short of the edge of the screen

/**
 * @param {object} o - Options.
 * @param {HTMLCanvasElement} o.canvas - The canvas.
 * @param {pc.Entity} o.camera - Main camera: its field of view scales the tilt.
 * @param {number[]} o.start - Where the torch points to begin with.
 * @returns {object} `user`, `mode`, take(), anchor() and enableTilt().
 */
export function createAim({ canvas, camera, start }) {
    const user = new pc.Vec2(start[0], start[1]);
    const touchFirst = !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let mode = touchFirst ? 'touch' : 'mouse';
    let fresh = false;
    let away = false;              // a mouse that has left the canvas: for a button, or the page

    // ---- mouse and pen: hover; touch: taps ----
    let tap = null;                // { id, x, y, at } while a touch might still be a tap
    let touches = 0;
    const place = (e) => {
        const r = canvas.getBoundingClientRect();
        user.set(pc.math.clamp((e.clientX - r.left) / r.width, 0, 1), pc.math.clamp((e.clientY - r.top) / r.height, 0, 1));
        fresh = true;
    };
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') {
            away = false;
            place(e);
            return;
        }
        touches++;
        tap = touches === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() } : null;
    });
    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'touch') {
            if (mode === 'touch') mode = 'mouse';
            away = false;
            place(e);
        } else if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) {
            tap = null;
        }
    });
    const lift = (e) => {
        if (e.pointerType !== 'touch') return;
        touches = Math.max(0, touches - 1);
        if (e.type === 'pointerup' && tap && tap.id === e.pointerId && performance.now() - tap.at < TAP_TIME) {
            place(e);
            neutral = null;        // the phone, as it is held now, points here
        }
        if (touches === 0 || (tap && tap.id === e.pointerId)) tap = null;
    };
    // (while a drag holds the pointer the canvas keeps it, wherever it goes, and is not left)
    canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch') away = true;
    });
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);

    // ---- tilt ----
    let neutral = null;            // [azimuth, elevation] of the phone when the beam is at `user`
    let noticed = null;            // the same, when the visitor was last seen to turn it
    const wrap = a => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

    function onOrientation(e) {
        if (e.alpha === null || e.beta === null || e.gamma === null) return;
        // which way the back of the phone faces, in the earth's frame (x east, y north, z up):
        // the device's -Z axis turned by Rz(alpha) Rx(beta) Ry(gamma). Taking the direction, not
        // the three angles themselves, keeps it steady when the phone is held upright, where
        // alpha and gamma fight over the same turn
        const a = e.alpha * pc.math.DEG_TO_RAD, b = e.beta * pc.math.DEG_TO_RAD, g = e.gamma * pc.math.DEG_TO_RAD;
        const x = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a);
        const y = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a);
        const z = -Math.cos(g) * Math.cos(b);
        const azimuth = Math.atan2(x, y), elevation = Math.asin(pc.math.clamp(z, -1, 1));

        mode = 'tilt';
        if (!neutral) neutral = [azimuth, elevation];
        if (!noticed) noticed = [azimuth, elevation];

        // the same number of pixels for a degree either way, however the screen is shaped
        const r = canvas.getBoundingClientRect();
        const perRadian = TILT_GAIN / (camera.camera.fov * pc.math.DEG_TO_RAD);
        // (a turn about the vertical covers less ground the further up or down the phone points)
        const level = Math.max(0.2, Math.cos(elevation));
        const kx = perRadian * level * r.height / r.width, ky = perRadian;
        const px = start[0] + wrap(azimuth - neutral[0]) * kx;
        const py = start[1] - (elevation - neutral[1]) * ky;
        user.set(pc.math.clamp(px, EDGE, 1 - EDGE), pc.math.clamp(py, EDGE, 1 - EDGE));
        // a beam held against the edge does not wind up: turning back moves it at once
        neutral[0] += (px - user.x) / kx;
        neutral[1] -= (py - user.y) / ky;

        // a phone lying on a table reports nothing but noise
        const turned = Math.hypot(wrap(azimuth - noticed[0]) * level, elevation - noticed[1]);
        if (turned > TILT_NOTICE * pc.math.DEG_TO_RAD) {
            noticed = [azimuth, elevation];
            fresh = true;
        }
    }

    // with tilt, `start` is where the beam sits when the phone is at its neutral: move both
    const anchor = (point) => {
        user.copy(point);
        start = [point.x, point.y];
        neutral = null;
    };

    /**
     * Must be called from a click or tap: an iPhone asks its owner first.
     *
     * @returns {Promise<boolean>} Whether the phone will be listened to.
     */
    async function enableTilt() {
        if (!touchFirst || typeof DeviceOrientationEvent === 'undefined') return false;
        try {
            const ask = /** @type {any} */ (DeviceOrientationEvent).requestPermission;
            if (typeof ask === 'function' && await ask.call(DeviceOrientationEvent) !== 'granted') return false;
        } catch (err) {
            return false;
        }
        window.addEventListener('deviceorientation', onOrientation);
        return true;
    }

    return {
        user,
        get mode() { return mode; },
        /** Whether the visitor's mouse has left the scene, so that nobody is aiming the torch. */
        get away() { return away; },
        get touch() { return touchFirst; },
        /** @returns {boolean} Whether the visitor has aimed since this was last asked. */
        take() {
            const was = fresh;
            fresh = false;
            return was;
        },
        anchor,
        enableTilt,
        onOrientation
    };
}
