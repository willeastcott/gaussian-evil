// Bakes the lighting proxy mesh from a 3DGS PLY: a closed, solid mesh of the figures' real surface.
//
//   node tools/bake-proxy.mjs raw/scene.ply public/proxy.glb
//
// The engine's GSplatRelighting script lights a plain mesh with standard lights and uses the
// result to tint the splats per pixel, so the splats need a mesh that matches them. A capture of
// a person is a thin, hollow shell of splats, and where the surface is smooth the shell is made of
// a few large, flat ones. So the mesh is built from what the splats cover, not from where their
// centres are, and from the outside in:
//
//   1. every splat is drawn into a fine voxel grid as the ellipsoid it is (its own rotation and
//      scale, widened by half a voxel so that a disc thinner than a voxel is not missed). A voxel
//      holds how opaque the splats make that point
//   2. voxels opaque enough are the shell. The floor is sealed under it, since nobody captured
//      the soles of their shoes
//   3. the shell is grown by a few voxels to close any gap left in it, and the outside is found
//      by line of sight: a voxel is outside if it can be seen from somewhere in the sky, from the
//      horizon to straight overhead. Everything that cannot be seen is the body: the shell and
//      all that is behind it. That is shrunk by the same few voxels, which puts the surface back
//      where it was but leaves the gaps closed and the inside solid.
//      (Flooding in from the edges of the grid is not enough. A capture has real openings where
//      nothing was photographed: up under the hem of a jacket, under a dress. A flood finds them
//      and hollows the body out; a line of sight from above the ground does not.)
//   4. the solid is smoothed, halved in resolution and turned into a mesh with surface nets.
//      Normals come from the gradient of the smoothed solid, so they always point outwards
//
// The mesh stays in PLY space. It is the surface itself; src/main.js grows a copy outwards for
// the mesh that receives light.
//
// Env: VOXEL (fine voxel in PLY units, default 0.07; the mesh is made at twice that),
// OCCUPIED (how opaque a voxel must be to count as shell, default 0.08: low, because where the
// cameras saw little, such as between two people standing back to back, a surface is only a
// few faint splats, and at a higher bar it comes out full of holes), CLOSE (voxels the shell
// is grown by to close gaps, default 2), VIEWS (directions the outside is looked for from, default
// 64), SMOOTH (smoothing passes, default 2), FLOOR (the floor's
// height in PLY units, default 0.094; y points down), MIN_ISLAND (drop pieces with fewer
// vertices, default 400)
import fs from 'node:fs';

const [, , plyPath, outPath] = process.argv;
if (!plyPath || !outPath) {
    console.error('usage: node tools/bake-proxy.mjs <in.ply> <out.glb>');
    process.exit(1);
}
const h = Number(process.env.VOXEL ?? 0.07);
const occupiedAt = Number(process.env.OCCUPIED ?? 0.08);
const close = Number(process.env.CLOSE ?? 2);
const views = Number(process.env.VIEWS ?? 64);
const smooth = Number(process.env.SMOOTH ?? 2);
const floorY = Number(process.env.FLOOR ?? 0.094);
const minIsland = Number(process.env.MIN_ISLAND ?? 400);
const UNITS_TO_CM = 7.2;        // the stage scale in src/main.js

// ---- read the PLY ----
const buf = fs.readFileSync(plyPath);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.subarray(0, headerEnd).toString('ascii');
const N = Number(/element vertex (\d+)/.exec(header)[1]);
const props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]);
const stride = props.length * 4;
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const dv = new DataView(buf.buffer, buf.byteOffset + headerEnd, N * stride);
const f = (i, name) => dv.getFloat32(i * stride + off[name], true);

const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
        const v = f(i, 'xyz'[k]);
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
    }
}
console.log(`${N} splats, bounds ${mn.map(v => v.toFixed(2))} .. ${mx.map(v => v.toFixed(2))}`);

// ---- 1. what the splats cover ----
// the grid has an even number of voxels each way (it is halved later) and room around the figures
const pad = 8 + close;
const g0 = mn.map(v => v - pad * h);
const even = n => n + (n & 1);
const nx = even(Math.ceil((mx[0] - mn[0]) / h) + 2 * pad), ny = even(Math.ceil((mx[1] - mn[1]) / h) + 2 * pad), nz = even(Math.ceil((mx[2] - mn[2]) / h) + 2 * pad);
const sxy = nx * ny, total = nx * ny * nz;
const clear = new Float32Array(total).fill(1);      // how much light gets through each voxel

const widen = (h / 2) ** 2;
let drawn = 0;
for (let i = 0; i < N; i++) {
    const alpha = Math.min(0.99, 1 / (1 + Math.exp(-f(i, 'opacity'))));
    if (alpha < 0.02) continue;
    const cx = f(i, 'x'), cy = f(i, 'y'), cz = f(i, 'z');
    // rotation (w, x, y, z) and scale -> covariance, widened by half a voxel
    let qw = f(i, 'rot_0'), qx = f(i, 'rot_1'), qy = f(i, 'rot_2'), qz = f(i, 'rot_3');
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    const R = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy),
        2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx),
        2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)
    ];
    // a splat is drawn no bigger than a quarter of a metre: the rare huge one is a floater
    const s = [0, 1, 2].map(k => Math.min(Math.exp(f(i, `scale_${k}`)), 3.5) ** 2);
    const c = new Float64Array(6);      // xx, xy, xz, yy, yz, zz
    for (let k = 0; k < 3; k++) {
        const a = R[k], b = R[3 + k], d = R[6 + k];
        c[0] += a * a * s[k]; c[1] += a * b * s[k]; c[2] += a * d * s[k];
        c[3] += b * b * s[k]; c[4] += b * d * s[k]; c[5] += d * d * s[k];
    }
    c[0] += widen; c[3] += widen; c[5] += widen;
    // its inverse
    const m00 = c[3] * c[5] - c[4] * c[4], m01 = c[2] * c[4] - c[1] * c[5], m02 = c[1] * c[4] - c[2] * c[3];
    const det = c[0] * m00 + c[1] * m01 + c[2] * m02;
    if (!(det > 0)) continue;
    const ixx = m00 / det, ixy = m01 / det, ixz = m02 / det;
    const iyy = (c[0] * c[5] - c[2] * c[2]) / det, iyz = (c[1] * c[2] - c[0] * c[4]) / det, izz = (c[0] * c[3] - c[1] * c[1]) / det;

    // the voxels within three standard deviations
    const ex = 3 * Math.sqrt(c[0]), ey = 3 * Math.sqrt(c[3]), ez = 3 * Math.sqrt(c[5]);
    const x0 = Math.max(0, Math.floor((cx - ex - g0[0]) / h)), x1 = Math.min(nx - 1, Math.ceil((cx + ex - g0[0]) / h));
    const y0 = Math.max(0, Math.floor((cy - ey - g0[1]) / h)), y1 = Math.min(ny - 1, Math.ceil((cy + ey - g0[1]) / h));
    const z0 = Math.max(0, Math.floor((cz - ez - g0[2]) / h)), z1 = Math.min(nz - 1, Math.ceil((cz + ez - g0[2]) / h));
    for (let z = z0; z <= z1; z++) {
        const dz = g0[2] + (z + 0.5) * h - cz;
        for (let y = y0; y <= y1; y++) {
            const dy = g0[1] + (y + 0.5) * h - cy;
            const base = ixy * dy + ixz * dz, rest = iyy * dy * dy + 2 * iyz * dy * dz + izz * dz * dz;
            let v = x0 + nx * y + sxy * z;
            for (let x = x0; x <= x1; x++, v++) {
                const dx = g0[0] + (x + 0.5) * h - cx;
                const q = ixx * dx * dx + 2 * dx * base + rest;
                if (q < 9) clear[v] *= 1 - alpha * Math.exp(-0.5 * q);
            }
        }
    }
    drawn++;
}
console.log(`grid ${nx}x${ny}x${nz} of ${(h * UNITS_TO_CM * 10).toFixed(1)} mm voxels; ${drawn} splats drawn`);

// ---- 2. the shell, on a sealed floor ----
const litres = count => (count * (h * UNITS_TO_CM) ** 3 / 1000).toFixed(1);
let solid = new Uint8Array(total);
let shell = 0;
for (let v = 0; v < total; v++) if (1 - clear[v] > occupiedAt) { solid[v] = 1; shell++; }
// y points down: the floor and everything under it is a slab the figures stand on
const floorRow = Math.floor((floorY - h - g0[1]) / h);
for (let z = 0; z < nz; z++) for (let y = floorRow; y < ny; y++) solid.fill(1, nx * y + sxy * z, nx * y + sxy * z + nx);

// ---- 3. close the gaps, find the outside, keep the rest ----
// grow or shrink by `r` voxels each way: a pass of running maximum (or minimum) along each axis
function morph(src, r, grow) {
    if (r <= 0) return src;
    let a = src;
    for (const [step, len] of [[1, nx], [nx, ny], [sxy, nz]]) {
        const b = new Uint8Array(total);
        const line = (start) => {
            for (let k = 0; k < len; k++) {
                let hit = grow ? 0 : 1;
                for (let d = -r; d <= r; d++) {
                    const j = k + d;
                    // beyond the grid there is nothing, whether growing or shrinking
                    const val = j < 0 || j >= len ? 0 : a[start + j * step];
                    if (grow ? val : !val) { hit = grow ? 1 : 0; break; }
                }
                b[start + k * step] = hit;
            }
        };
        if (step === 1) for (let l = 0; l < total / nx; l++) line(l * nx);
        else if (step === nx) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) line(x + sxy * z);
        else for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) line(x + nx * y);
        a = b;
    }
    return a;
}

const grown = morph(solid, close, true);

// Light from one direction is carried through the grid a slab at a time along the axis it mostly
// travels on: each voxel takes the light of the four voxels it came through in the slab before,
// unless it is shell, which stops it. A voxel that gets more than half the light from any one
// direction can be seen from there.
const outside = new Uint8Array(total);
const dims = [nx, ny, nz], strides = [1, nx, sxy];
for (let k = 0; k < views; k++) {
    // spread evenly over the sky; y points down, so light from the sky travels towards +y
    const down = (k + 0.5) / views, flat = Math.sqrt(1 - down * down), turn = k * 2.399963;
    const d = [flat * Math.cos(turn), down, flat * Math.sin(turn)];
    const ax = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : (Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2);
    const bx = (ax + 1) % 3, cx2 = (ax + 2) % 3;
    const na = dims[ax], nb = dims[bx], nc = dims[cx2], sa = strides[ax], sb = strides[bx], sc = strides[cx2];
    // where, in the slab before, the light at a voxel came from
    const ob = -d[bx] / Math.abs(d[ax]), oc = -d[cx2] / Math.abs(d[ax]);
    const ib = Math.floor(ob), fb = ob - ib, ic = Math.floor(oc), fc = oc - ic;
    const w00 = (1 - fb) * (1 - fc), w10 = fb * (1 - fc), w01 = (1 - fb) * fc, w11 = fb * fc;
    // slabs carry a border one voxel wide, always lit: light also comes in through the sides
    const pb = nb + 2, size = pb * (nc + 2);
    let before = new Float32Array(size).fill(1), now = new Float32Array(size).fill(1);
    for (let step = 0; step < na; step++) {
        const slab = (d[ax] > 0 ? step : na - 1 - step) * sa;
        for (let jc = 0; jc < nc; jc++) {
            const from = (jc + ic + 1) * pb + ib + 1, to = (jc + 1) * pb + 1, row = slab + jc * sc;
            for (let jb = 0; jb < nb; jb++) {
                const v = row + jb * sb;
                if (grown[v]) { now[to + jb] = 0; continue; }
                const p = from + jb;
                const light = w00 * before[p] + w10 * before[p + 1] + w01 * before[p + pb] + w11 * before[p + pb + 1];
                now[to + jb] = light;
                if (light > 0.5) outside[v] = 1;
            }
        }
        [before, now] = [now, before];
    }
}
const filled = new Uint8Array(total);
for (let v = 0; v < total; v++) filled[v] = outside[v] ? 0 : 1;
solid = morph(filled, close, false);
// take the floor away again: the figures end flat on it
const cutRow = Math.floor((floorY - g0[1]) / h);
let body = 0;
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const row = nx * y + sxy * z;
    if (y >= cutRow) solid.fill(0, row, row + nx);
    else for (let x = 0; x < nx; x++) body += solid[row + x];
}
console.log(`shell: ${litres(shell)} litres of voxels more than ${occupiedAt} opaque. Body: ${litres(body)} litres, with gaps up to ${(2 * close * h * UNITS_TO_CM).toFixed(1)} cm closed and everything out of sight from ${views} directions filled`);
// where that volume is: a person is 60 to 90 litres, most of it between knee and shoulder. A
// figure that comes out far lighter is still hollow. (A dress comes out as a solid bell: what is
// under it cannot be seen from above the ground.)
{
    const split = Math.floor(((mn[0] + mx[0]) / 2 - g0[0]) / h), bands = 5, top = Math.floor((mn[1] - g0[1]) / h);
    const vol = [new Float64Array(bands), new Float64Array(bands)];
    for (let z = 0; z < nz; z++) for (let y = top; y < cutRow; y++) {
        const band = Math.min(bands - 1, Math.floor((cutRow - 1 - y) / (cutRow - top) * bands)), row = nx * y + sxy * z;
        for (let x = 0; x < nx; x++) if (solid[row + x]) vol[x < split ? 0 : 1][band]++;
    }
    for (const [name, v] of [['low x', vol[0]], ['high x', vol[1]]]) {
        console.log(`  figure at ${name}: ${litres(v.reduce((a, b) => a + b, 0))} litres; by fifths of the height from the floor up: ${[...v].map(litres).join(', ')}`);
    }
}

// SLICE=0.7 prints a plan of the figures cut at that fraction of their height: '#' is shell,
// 'o' is inside that was filled, '.' is air. A body that is still hollow shows as a ring
if (process.env.SLICE) {
    const top = Math.floor((mn[1] - g0[1]) / h);
    const y = Math.round(cutRow - 1 - Number(process.env.SLICE) * (cutRow - top));
    const step = 4;
    console.log(`plan at ${process.env.SLICE} of the height (each character is ${(step * h * UNITS_TO_CM).toFixed(0)} cm):`);
    for (let z = 0; z < nz; z += step) {
        let line = '';
        for (let x = 0; x < nx; x += step) {
            const v = x + nx * y + sxy * z;
            line += !solid[v] ? '.' : (1 - clear[v] > occupiedAt ? '#' : 'o');
        }
        if (/[#o]/.test(line)) console.log(`  ${line.replace(/\.+$/, '')}`);
    }
}

// ---- 4. smooth, halve, mesh ----
let field = clear;      // reuse the big array
for (let v = 0; v < total; v++) field[v] = solid[v];
for (let pass = 0; pass < smooth; pass++) {
    for (const s of [1, nx, sxy]) {
        const T = new Float32Array(total);
        for (let i = s; i < total - s; i++) T[i] = 0.25 * field[i - s] + 0.5 * field[i] + 0.25 * field[i + s];
        field = T;
    }
}
const H = 2 * h, cnx = nx / 2, cny = ny / 2, cnz = nz / 2, csxy = cnx * cny;
const G = new Float32Array(cnx * cny * cnz);
for (let z = 0; z < cnz; z++) for (let y = 0; y < cny; y++) for (let x = 0; x < cnx; x++) {
    const v = 2 * x + nx * 2 * y + sxy * 2 * z;
    G[x + cnx * y + csxy * z] = 0.125 * (field[v] + field[v + 1] + field[v + nx] + field[v + nx + 1] + field[v + sxy] + field[v + sxy + 1] + field[v + sxy + nx] + field[v + sxy + nx + 1]);
}
// a coarse voxel's value sits at its centre
const c0 = g0.map(v => v + h);
const sample = (x, y, z) => {
    const fx = (x - c0[0]) / H, fy = (y - c0[1]) / H, fz = (z - c0[2]) / H;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= cnx - 1 || fy >= cny - 1 || fz >= cnz - 1) return 0;
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const i = ix + cnx * iy + csxy * iz;
    const a = G[i] + (G[i + 1] - G[i]) * tx, b = G[i + cnx] + (G[i + cnx + 1] - G[i + cnx]) * tx;
    const c = G[i + csxy] + (G[i + csxy + 1] - G[i + csxy]) * tx, d = G[i + csxy + cnx] + (G[i + csxy + cnx + 1] - G[i + csxy + cnx]) * tx;
    const e = a + (b - a) * ty, g = c + (d - c) * ty;
    return e + (g - e) * tz;
};

const iso = 0.5;
const cellVert = new Int32Array(G.length).fill(-1);
const verts = [];
const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const cornerOff = corner.map(c => c[0] + cnx * c[1] + csxy * c[2]);
const edges = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (((a ^ b) & ((a ^ b) - 1)) === 0) edges.push([a, b]);
for (let z = 0; z < cnz - 1; z++) for (let y = 0; y < cny - 1; y++) for (let x = 0; x < cnx - 1; x++) {
    const i = x + cnx * y + csxy * z;
    let mask = 0;
    for (let c = 0; c < 8; c++) if (G[i + cornerOff[c]] > iso) mask |= 1 << c;
    if (mask === 0 || mask === 255) continue;
    let px = 0, py = 0, pz = 0, n = 0;
    for (const [a, b] of edges) {
        if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
        const va = G[i + cornerOff[a]], vb = G[i + cornerOff[b]], t = (iso - va) / (vb - va);
        px += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
        py += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
        pz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
        n++;
    }
    cellVert[i] = verts.length / 3;
    verts.push(c0[0] + (x + px / n) * H, c0[1] + (y + py / n) * H, c0[2] + (z + pz / n) * H);
}
const quads = [];
const stridesOf = [1, cnx, csxy];
for (let z = 1; z < cnz - 1; z++) for (let y = 1; y < cny - 1; y++) for (let x = 1; x < cnx - 1; x++) {
    const i = x + cnx * y + csxy * z, in0 = G[i] > iso;
    for (let a = 0; a < 3; a++) {
        const in1 = G[i + stridesOf[a]] > iso;
        if (in0 === in1) continue;
        const sb = stridesOf[(a + 1) % 3], sc = stridesOf[(a + 2) % 3];
        const q = [cellVert[i - sb - sc], cellVert[i - sc], cellVert[i], cellVert[i - sb]];
        if (q.includes(-1)) continue;
        if (in0) quads.push(q[0], q[1], q[2], q[3]); else quads.push(q[3], q[2], q[1], q[0]);
    }
}
const nv = verts.length / 3;
console.log(`surface at ${(H * UNITS_TO_CM * 10).toFixed(0)} mm: ${nv} vertices, ${quads.length / 4} quads`);

// ---- drop small pieces (floaters would cast stray shadows) ----
const parent = new Int32Array(nv).map((_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
for (let q = 0; q < quads.length; q += 4) for (let k = 1; k < 4; k++) {
    const a = find(quads[q]), b = find(quads[q + k]);
    if (a !== b) parent[a] = b;
}
const compSize = new Int32Array(nv);
for (let i = 0; i < nv; i++) compSize[find(i)]++;
const sizes = [...compSize].filter(s => s > 0).sort((a, b) => b - a);
console.log(`${sizes.length} pieces; largest: ${sizes.slice(0, 8).join(', ')}`);
const remap = new Int32Array(nv).fill(-1);
let kept = 0;
for (let i = 0; i < nv; i++) if (compSize[find(i)] >= minIsland) remap[i] = kept++;

const P = new Float32Array(kept * 3), Nrm = new Float32Array(kept * 3);
const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nv; i++) {
    const j = remap[i];
    if (j < 0) continue;
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    P[j * 3] = x; P[j * 3 + 1] = y; P[j * 3 + 2] = z;
    [x, y, z].forEach((v, k) => { if (v < bmin[k]) bmin[k] = v; if (v > bmax[k]) bmax[k] = v; });
    // outwards is down the gradient: the solid is 1 inside and 0 outside
    const gx = sample(x - H, y, z) - sample(x + H, y, z), gy = sample(x, y - H, z) - sample(x, y + H, z), gz = sample(x, y, z - H) - sample(x, y, z + H);
    const l = Math.hypot(gx, gy, gz) || 1;
    Nrm[j * 3] = gx / l; Nrm[j * 3 + 1] = gy / l; Nrm[j * 3 + 2] = gz / l;
}
const idx = [];
for (let q = 0; q < quads.length; q += 4) {
    const a = remap[quads[q]], b = remap[quads[q + 1]], c = remap[quads[q + 2]], d = remap[quads[q + 3]];
    if (a < 0) continue;
    idx.push(a, b, c, a, c, d);
}
const I = Uint32Array.from(idx);

// a closed surface has every edge used once in each direction
const edgeUse = new Map();
for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = I[t + k], b = I[t + (k + 1) % 3];
    const key = a < b ? a * kept + b : b * kept + a;
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + (a < b ? 1 : -1));
}
let open = 0;
for (const use of edgeUse.values()) if (use !== 0) open++;
console.log(`kept ${kept} vertices, ${I.length / 3} triangles; ${open === 0 ? 'closed: no open edges' : `${open} OPEN EDGES`}`);

// ---- write the GLB ----
const bin = Buffer.concat([Buffer.from(P.buffer), Buffer.from(Nrm.buffer), Buffer.from(I.buffer)]);
const json = {
    asset: { version: '2.0', generator: 'splat-resident-evil bake-proxy' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'proxy' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 },
        { buffer: 0, byteOffset: P.byteLength, byteLength: Nrm.byteLength, target: 34962 },
        { buffer: 0, byteOffset: P.byteLength + Nrm.byteLength, byteLength: I.byteLength, target: 34963 }
    ],
    accessors: [
        { bufferView: 0, componentType: 5126, count: kept, type: 'VEC3', min: bmin, max: bmax },
        { bufferView: 1, componentType: 5126, count: kept, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: I.length, type: 'SCALAR' }
    ]
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - jsonBuf.length % 4) % 4, 0x20)]);
const glbHead = Buffer.alloc(12);
glbHead.writeUInt32LE(0x46546c67, 0); glbHead.writeUInt32LE(2, 4); glbHead.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(outPath, Buffer.concat([glbHead, jh, jsonBuf, bh, bin]));
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
