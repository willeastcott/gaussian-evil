// Where the visitor points the torch.
//
//   - a mouse or a pen: wherever it hovers
//   - a touch screen: wherever it was last tapped. A drag turns the camera, so only a tap aims
//
// (A phone used to aim it by the way it was turned, as a torch held in the hand. An iPhone has to
// ask its owner's leave for that, in a dialog, before anything has been seen: it was taken out.)
//
// A mouse can also leave: for a button, or off the page altogether. The torch is then not being
// aimed at all (`away`), and where the pointer happened to cross the edge means nothing.
//
// The result is `user`, a point on the canvas as a fraction of its size. Whoever is directing
// the scene decides when the torch follows it (src/director.js).
import * as pc from 'playcanvas';

const TAP_TIME = 350;          // ms: a touch that lifts sooner than this, and has not moved, is a tap
const TAP_SLOP = 12;           // CSS px it may move

/**
 * @param {object} o - Options.
 * @param {HTMLCanvasElement} o.canvas - The canvas.
 * @param {number[]} o.start - Where the torch points to begin with.
 * @returns {object} `user`, `mode`, take() and anchor().
 */
export function createAim({ canvas, start }) {
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
        }
        if (touches === 0 || (tap && tap.id === e.pointerId)) tap = null;
    };
    // (while a drag holds the pointer the canvas keeps it, wherever it goes, and is not left)
    canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch') away = true;
    });
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);

    // whoever is directing the scene puts the beam somewhere: the visitor's aim starts from there
    const anchor = (point) => {
        user.copy(point);
    };

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
        anchor
    };
}
