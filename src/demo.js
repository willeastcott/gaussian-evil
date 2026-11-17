// The demo: the scene plays by itself, as a short film that loops.
//
// Five shots, cut together. Nobody holds the torch: where it points is written down here, along
// with the camera. Lightning comes on cue, so every run is the same.
//
//   the way in   dark; lightning shows the two of them from behind; the torch comes on at their
//                feet and climbs to their faces
//   her          close, and closing
//   him          from further back and from below, cut to on a flash; the shortest shot
//   the water    down by the ground: the beam comes across the puddles to their feet, and
//                lightning fills the water with sky; the longest shot
//   leaving      up and back, turning, until the torch goes out
//
// A shot is a run from one camera to another at a steady speed. The camera is already moving
// when a shot is cut to and still moving when it is cut from: a camera that eases to rest and
// then jumps reads as a mistake, one that is cut off in mid-move reads as a cut.
//
// A camera is written as the point it looks at and its bearing from that point, so the run
// between two of them is an arc round the subject. The torch is written as the point in the
// world it lights, and each shot says where it is held, as an offset from the camera.
//
// One cut goes to the far side of the pair. Where the splats are sorted off the main thread
// (WebGL 2), the first frame after a jump like that is still drawn in the old order, and shows
// it. So that shot opens on a few frames of black (`blank`), and the lightning that follows
// is what shows him: the cut lands on the flash.
//
// src/director.js plays this: it places the camera, turns the lit point into a point on screen
// for the torch, and fires the strikes.
import * as pc from 'playcanvas';

const RAD = pc.math.DEG_TO_RAD;
const sat = x => Math.min(1, Math.max(0, x));
const smooth = t => t * t * (3 - 2 * t);
const v = (x, y, z) => new pc.Vec3(x, y, z);

/**
 * @typedef {object} Subject
 * @property {pc.Vec3} head - The middle of the head.
 * @property {pc.Vec3} facing - The way it faces: level, and of length one.
 * @property {pc.Vec3} hand - Where the torch is held for a close-up: right, up, forward of the camera.
 */

/**
 * @param {object} o - The scene, in world space: metres, the pair standing at the origin, feet on y = 0.
 * @param {{ hand: pc.Vec3 }} o.wide - Where the torch is held when both are in the shot.
 * @param {Subject} o.him - Him.
 * @param {Subject} o.her - Her.
 * @returns {object} The length, the cues, and sample().
 */
export function createDemo({ wide, him, her }) {
    // degrees round from +z, which is how the director measures a camera's bearing
    const facingOf = who => Math.atan2(who.facing.x, who.facing.z) / RAD;
    const camera = (focus, yaw, pitch, distance) => ({ focus, yaw: yaw * RAD, pitch: pitch * RAD, distance });
    // a point on somebody: so far out in front of the head, so far above it
    const on = (who, forward, up) => who.head.clone().add(who.facing.clone().mulScalar(forward)).add(v(0, up, 0));

    const herYaw = facingOf(her), himYaw = facingOf(him);
    const feet = v(0, 0.02, 0.9);              // the ground just in front of them
    const both = v(-0.05, 1.42, 0);            // between the two heads

    // `torch` is a list of [how far through the shot, the point lit]
    const shots = [{
        name: 'the way in',
        at: 0,
        from: camera(v(0, 0.95, 0), -3, -4, 5.4),
        to: camera(v(0, 0.9, 0), 5, -2, 3.7),
        hand: wide.hand,
        torch: [[0, feet], [0.49, feet], [0.76, both], [1, on(her, 0.07, -0.05)]]
    }, {
        name: 'her',
        at: 8,
        from: camera(on(her, 0.07, 0), herYaw - 8, 2, 1.5),
        to: camera(on(her, 0.07, -0.05), herYaw + 22, 3, 1.0),
        hand: her.hand,
        power: 0.85,
        torch: [[0, on(her, 0.1, -0.32)], [0.5, on(her, 0.07, 0)], [1, on(her, 0.07, 0)]]
    }, {
        name: 'him',
        at: 14,
        // Further back than hers, and from lower: his jacket and his pistol are in the shot, and
        // he is not held as long. The torch is well out to the right of the lens and above it. Held
        // beside the lens, as it is for a visitor, it lit his face flat from below; from here it
        // models it, and the lamp, which is off to the left, fills the other side cold.
        from: camera(on(him, 0.07, -0.2), himYaw - 20, -10, 1.7),
        to: camera(on(him, 0.07, -0.14), himYaw + 2, -6, 1.35),
        hand: v(1.5, 0.9, 0.1),
        power: 0.8,
        blank: 0.08,
        torch: [[0, on(him, 0.1, -0.35)], [0.5, on(him, 0.07, 0)], [1, on(him, 0.07, 0)]]
    }, {
        name: 'the water',
        at: 18,
        from: camera(v(0, 0.55, 0), -44, -6.5, 3.7),
        to: camera(v(0, 0.75, 0), -10, -9, 3.0),
        hand: wide.hand,
        torch: [[0, v(-1.0, 0, 0.9)], [0.4, v(-0.1, 0.02, 0.5)], [0.85, v(-0.05, 1.3, 0)], [1, v(-0.05, 1.3, 0)]]
    }, {
        name: 'leaving',
        at: 27.5,
        from: camera(v(0, 0.85, 0), 28, 13, 3.3),
        to: camera(v(0, 0.8, 0), 50, 21, 5.0),
        hand: wide.hand,
        torch: [[0, both], [1, both]]
    }];
    const length = 36.5;

    /**
     * Where everything is at a moment of the film.
     *
     * @param {number} t - Seconds from the start, 0 .. length.
     * @param {object} out - Filled in: shot (its number), focus, yaw, pitch, distance (the camera),
     * target (the point the torch lights), hand (where it is held), power (how bright it burns)
     * and blank (whether the shot is still in the black it opens on).
     * Up close the torch is turned down: at arm's length from a face it burns the face out.
     * @returns {object} `out`.
     */
    function sample(t, out) {
        let i = shots.length - 1;
        while (i > 0 && shots[i].at > t) i--;
        const s = shots[i], until = i + 1 < shots.length ? shots[i + 1].at : length;
        const k = sat((t - s.at) / (until - s.at));

        out.shot = i;
        out.focus.lerp(s.from.focus, s.to.focus, k);
        out.yaw = pc.math.lerp(s.from.yaw, s.to.yaw, k);
        out.pitch = pc.math.lerp(s.from.pitch, s.to.pitch, k);
        out.distance = pc.math.lerp(s.from.distance, s.to.distance, k);
        out.hand.copy(s.hand);
        out.power = s.power ?? 1;
        out.blank = t - s.at < (s.blank ?? 0);

        let j = 0;
        while (j < s.torch.length - 2 && s.torch[j + 1][0] <= k) j++;
        const a = s.torch[j], b = s.torch[j + 1];
        out.target.lerp(a[1], b[1], smooth(sat((k - a[0]) / (b[0] - a[0]))));
        // a torch in a hand is never quite still
        out.target.x += 0.02 * Math.sin(t * 1.3);
        out.target.y += 0.015 * Math.sin(t * 1.9 + 1);
        return out;
    }

    return {
        length,
        shots,
        torchOn: 3.4,           // seconds: the torch clicks on...
        torchOff: 34.9,         // ...and off: the film ends, and begins again, in the dark
        // lightning: when, from where round the sky (degrees: 0 is +x, 90 is +z), how high, how near
        strikes: [
            { at: 1.6, from: -110, height: 38, near: 0.92 },    // behind them and to the left: an outline
            { at: 14.08, from: -6, height: 45, near: 0.85 },    // on the cut to him, over her shoulder
            { at: 22.6, from: -80, height: 28, near: 1 }        // low behind them: long shadows towards the camera
        ],
        // something groans, far off (src/audio.js): when, and how loud in dB
        groans: [{ at: 11.4, level: -11 }, { at: 30.4, level: -8 }],
        invite: 35.4,           // in the dark at the end, whoever is watching is told how to take the torch
        sample,
        /** @returns {object} Somewhere for sample() to write. */
        frame: () => ({ shot: 0, power: 1, blank: false, focus: v(0, 0, 0), yaw: 0, pitch: 0, distance: 1, target: v(0, 0, 0), hand: v(0, 0, 0) })
    };
}
