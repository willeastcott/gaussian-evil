// What stands on the ground, as the ground needs to know it.
//
// The torch, the lamp and the lightning are lights with shadow maps, and their shadows fall on
// the ground as they should. But two things the ground shows are worked out in its own shader
// (src/ground.js), and knew nothing of the figures: the sky that wet ground mirrors, and the
// lamp's image in it, which is most of the light there is on the ground at night. Both ran right
// up to the shoes and under them, so the pair looked pasted on to the picture of a wet road.
//
// The figures do not move from where they stand, so what they hide can be worked out once, when
// the page loads, from the mesh that casts their shadows. One small texture holds three maps:
//
//   r  how much of the sky is hidden from each point of the ground. Whatever is near the ground
//      hides the sky from the ground near it: a sole from the few centimetres round it, a knee
//      from a hand's breadth, a body from half a metre. So the mesh is taken in layers by height,
//      each one's footprint blurred as wide as it is high, and the layers multiplied together
//   g  how nearly the ground is touched: the footprint of what is within three centimetres of it,
//      hardly blurred. This is the dark line under a shoe. A shadow map cannot draw it (it has
//      to be told to ignore what is very close, or everything would shadow itself), so it is put
//      under every light
//   b  the figures as the lamp sees them. A point of the ground from which the lamp is hidden
//      cannot mirror it. This one is looked up through the lamp's own view, not from above, so a
//      shadow three metres long costs no more than a short one
//
// ?contact=0 leaves it out, to compare.
import * as pc from 'playcanvas';

const SIZE = 256;               // texels each way
const EXTENT = 1.5;             // metres from the middle to the edge of the two maps seen from above
const TOUCH = [0.03, 0.012];    // metres: what counts as touching the ground, and how far that is blurred
// the layers that hide the sky: everything lower than this (m), blurred this far (m), hiding this much
const LAYERS = [[0.04, 0.02, 0.6], [0.1, 0.05, 0.45], [0.25, 0.11, 0.4], [0.6, 0.24, 0.35], [1.2, 0.4, 0.25]];

/**
 * Fills a triangle into a grid: the lowest value at each texel it covers.
 *
 * @param {Float32Array} grid - SIZE x SIZE values.
 * @param {number[]} t - Three corners, each x, y (in texels) and a value.
 */
function fill(grid, t) {
    const ax = t[0], ay = t[1], av = t[2], bx = t[3], by = t[4], bv = t[5], cx = t[6], cy = t[7], cv = t[8];
    // its corners, whatever else: a triangle smaller than a texel may cover no texel's middle
    for (let k = 0; k < 9; k += 3) {
        const i = Math.floor(t[k]), j = Math.floor(t[k + 1]);
        if (i >= 0 && j >= 0 && i < SIZE && j < SIZE && t[k + 2] < grid[j * SIZE + i]) grid[j * SIZE + i] = t[k + 2];
    }
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(SIZE - 1, Math.floor(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(SIZE - 1, Math.floor(Math.max(ay, by, cy)));
    for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        for (let i = i0; i <= i1; i++) {
            const x = i + 0.5;
            const wa = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
            const wb = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
            const wc = 1 - wa - wb;
            if (wa < 0 || wb < 0 || wc < 0) continue;
            const value = wa * av + wb * bv + wc * cv;
            if (value < grid[j * SIZE + i]) grid[j * SIZE + i] = value;
        }
    }
}

/**
 * Blurs a grid in place: three passes of a box, which is near enough a Gaussian.
 *
 * @param {Float32Array} grid - SIZE x SIZE values.
 * @param {number} sigma - How far, in texels.
 */
function blur(grid, sigma) {
    const reach = Math.max(1, Math.round(sigma));
    const line = new Float32Array(SIZE);
    const pass = (start, step) => {
        for (let k = 0; k < SIZE; k++) line[k] = grid[start + k * step];
        let sum = 0;
        for (let k = 0; k <= reach && k < SIZE; k++) sum += line[k];
        for (let k = 0; k < SIZE; k++) {
            grid[start + k * step] = sum / (2 * reach + 1);
            if (k + reach + 1 < SIZE) sum += line[k + reach + 1];
            if (k - reach >= 0) sum -= line[k - reach];
        }
    };
    for (let n = 0; n < 3; n++) {
        for (let j = 0; j < SIZE; j++) pass(j * SIZE, 1);
        for (let i = 0; i < SIZE; i++) pass(i, SIZE);
    }
}

/**
 * @param {object} o - What it is made from.
 * @param {pc.GraphicsDevice} o.device - The device.
 * @param {pc.Mesh} o.mesh - The figures' surface: the mesh that casts their shadows.
 * @param {pc.Mat4} o.transform - From the mesh to the world.
 * @param {object} o.ground - The ground (src/ground.js), which is told.
 * @param {pc.Vec3|null} o.lamp - Where the lamp is, if there is one.
 * @returns {object} The texture, and the numbers it was made with.
 */
export function createContact({ device, mesh, transform, ground, lamp }) {
    const positions = [], indices = [];
    mesh.getPositions(positions);
    mesh.getIndices(indices);
    const count = positions.length / 3;
    const world = new Float32Array(positions.length);
    const p = new pc.Vec3(), centre = new pc.Vec3();
    for (let i = 0; i < count; i++) {
        transform.transformPoint(p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]), p);
        world[i * 3] = p.x; world[i * 3 + 1] = p.y; world[i * 3 + 2] = p.z;
        centre.add(p);
    }
    centre.mulScalar(1 / count);

    // ---- from above: how high the lowest of the figures is over each point of the ground ----
    const low = new Float32Array(SIZE * SIZE).fill(Infinity);
    const toTexel = SIZE / (2 * EXTENT);
    const tri = new Array(9);
    for (let k = 0; k < indices.length; k += 3) {
        for (let c = 0; c < 3; c++) {
            const v = indices[k + c] * 3;
            tri[c * 3] = (world[v] + EXTENT) * toTexel;
            tri[c * 3 + 1] = (world[v + 2] + EXTENT) * toTexel;
            tri[c * 3 + 2] = world[v + 1];
        }
        if (Math.min(tri[2], tri[5], tri[8]) < LAYERS[LAYERS.length - 1][0]) fill(low, tri);
    }
    const under = (height, sigma) => {
        const g = new Float32Array(SIZE * SIZE);
        for (let k = 0; k < g.length; k++) g[k] = low[k] < height ? 1 : 0;
        blur(g, sigma * toTexel);
        return g;
    };
    const sky = new Float32Array(SIZE * SIZE).fill(1);
    for (const [height, sigma, weight] of LAYERS) {
        const g = under(height, sigma);
        for (let k = 0; k < sky.length; k++) sky[k] *= 1 - weight * g[k];
    }
    const touch = under(TOUCH[0], TOUCH[1]);

    // ---- from the lamp: the figures' outline ----
    const seen = new Float32Array(SIZE * SIZE).fill(1);
    const view = new Float32Array(16);
    if (lamp) {
        const forward = new pc.Vec3().sub2(centre, lamp).normalize();
        const right = new pc.Vec3().cross(forward, pc.Vec3.UP).normalize();
        const up = new pc.Vec3().cross(right, forward);
        // how wide a view takes them all in, with a margin for the blur
        let spread = 0;
        const along = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            p.set(world[i * 3] - lamp.x, world[i * 3 + 1] - lamp.y, world[i * 3 + 2] - lamp.z);
            const z = p.dot(forward), x = p.dot(right) / z, y = p.dot(up) / z;
            along[i * 3] = x; along[i * 3 + 1] = y; along[i * 3 + 2] = z;
            spread = Math.max(spread, Math.abs(x), Math.abs(y));
        }
        spread *= 1.1;
        for (let k = 0; k < indices.length; k += 3) {
            for (let c = 0; c < 3; c++) {
                const v = indices[k + c] * 3;
                tri[c * 3] = (0.5 + 0.5 * along[v] / spread) * SIZE;
                tri[c * 3 + 1] = (0.5 + 0.5 * along[v + 1] / spread) * SIZE;
                tri[c * 3 + 2] = 0;
            }
            fill(seen, tri);
        }
        for (let k = 0; k < seen.length; k++) seen[k] = 1 - seen[k];
        // the lamp is not a point: its shadows have a soft edge
        blur(seen, 1.2);
        // The world to that view, as the shader wants it: xy / w is where to look in the map.
        // (a matrix is held a column at a time)
        const s = 0.5 / spread;
        const row = (n, a, b) => {
            const x = a.x * s + b.x * 0.5, y = a.y * s + b.y * 0.5, z = a.z * s + b.z * 0.5;
            view[n] = x; view[4 + n] = y; view[8 + n] = z; view[12 + n] = -(x * lamp.x + y * lamp.y + z * lamp.z);
        };
        row(0, right, forward);
        row(1, up, forward);
        view[3] = forward.x; view[7] = forward.y; view[11] = forward.z; view[15] = -forward.dot(lamp);
    } else {
        seen.fill(0);
    }

    // ---- one texture of the three ----
    const data = new Uint8Array(SIZE * SIZE * 4);
    for (let j = 0; j < SIZE; j++) {
        for (let i = 0; i < SIZE; i++) {
            const k = j * SIZE + i;
            // nothing at the edges: beyond them the texture repeats its last texel
            const edge = Math.min(i, j, SIZE - 1 - i, SIZE - 1 - j);
            const fade = Math.min(1, edge / 12);
            data[k * 4] = Math.round(255 * (1 - sky[k]) * fade);
            data[k * 4 + 1] = Math.round(255 * touch[k] * fade);
            data[k * 4 + 2] = Math.round(255 * seen[k] * fade);
            data[k * 4 + 3] = 255;
        }
    }
    const texture = new pc.Texture(device, {
        name: 'ground-contact',
        width: SIZE,
        height: SIZE,
        format: pc.PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: pc.FILTER_LINEAR,
        magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        levels: [data]
    });

    Object.assign(ground.settings.contact, { texture, extent: EXTENT, view });
    return { texture, data, size: SIZE, extent: EXTENT, view };
}
