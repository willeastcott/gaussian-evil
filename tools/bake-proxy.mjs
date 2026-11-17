// Bakes a lighting proxy mesh from a 3DGS PLY.
//
//   node tools/bake-proxy.mjs raw/scene.ply public/proxy.glb
//
// The engine's GSplatRelighting script lights a plain mesh with standard lights and uses the
// result to tint the splats per pixel, so the splats need a mesh that matches them. This makes
// one: splat opacity is accumulated into a voxel grid, blurred, and its iso-surface extracted
// with surface nets. Normals come from the gradient of the blurred field, so they are smooth
// even though the individual gaussians are noisy. The mesh stays in PLY space.
//
// Env: VOXEL (voxel size in PLY units, default 0.14), ISO (fraction of the median density at
// the splat centres, default 0.3), MIN_ISLAND (drop components with fewer vertices, default 400),
// BLUR (smoothing passes over the grid, default 4)
import fs from 'node:fs';

const [, , plyPath, outPath] = process.argv;
if (!plyPath || !outPath) {
    console.error('usage: node tools/bake-proxy.mjs <in.ply> <out.glb>');
    process.exit(1);
}
const h = Number(process.env.VOXEL ?? 0.14);
const isoFrac = Number(process.env.ISO ?? 0.3);
const minIsland = Number(process.env.MIN_ISLAND ?? 400);
const blurPasses = Number(process.env.BLUR ?? 4);

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

const pos = new Float32Array(N * 3), weight = new Float32Array(N), alpha = new Float32Array(N);
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
        const v = f(i, 'xyz'[k]);
        pos[i * 3 + k] = v;
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
    }
    alpha[i] = 1 / (1 + Math.exp(-f(i, 'opacity')));
    const size = Math.exp(Math.max(f(i, 'scale_0'), f(i, 'scale_1'), f(i, 'scale_2')));
    weight[i] = alpha[i] * Math.min(4, Math.max(0.05, (size / h) ** 2));
}
console.log(`${N} splats, bounds ${mn.map(v => v.toFixed(2))} .. ${mx.map(v => v.toFixed(2))}`);

// ---- density grid ----
const pad = 6;
const g0 = mn.map(v => v - pad * h);
const nx = Math.ceil((mx[0] - mn[0]) / h) + 2 * pad, ny = Math.ceil((mx[1] - mn[1]) / h) + 2 * pad, nz = Math.ceil((mx[2] - mn[2]) / h) + 2 * pad;
const sxy = nx * ny;
let G = new Float32Array(nx * ny * nz);
for (let i = 0; i < N; i++) {
    const fx = (pos[i * 3] - g0[0]) / h, fy = (pos[i * 3 + 1] - g0[1]) / h, fz = (pos[i * 3 + 2] - g0[2]) / h;
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const w = weight[i], b = ix + nx * iy + sxy * iz;
    G[b] += w * (1 - tx) * (1 - ty) * (1 - tz); G[b + 1] += w * tx * (1 - ty) * (1 - tz);
    G[b + nx] += w * (1 - tx) * ty * (1 - tz); G[b + nx + 1] += w * tx * ty * (1 - tz);
    G[b + sxy] += w * (1 - tx) * (1 - ty) * tz; G[b + sxy + 1] += w * tx * (1 - ty) * tz;
    G[b + sxy + nx] += w * (1 - tx) * ty * tz; G[b + sxy + nx + 1] += w * tx * ty * tz;
}
for (let pass = 0; pass < blurPasses; pass++) {
    for (const s of [1, nx, sxy]) {
        const T = new Float32Array(G.length);
        for (let i = s; i < G.length - s; i++) T[i] = 0.25 * G[i - s] + 0.5 * G[i] + 0.25 * G[i + s];
        G = T;
    }
}
const sample = (x, y, z) => {
    const fx = (x - g0[0]) / h, fy = (y - g0[1]) / h, fz = (z - g0[2]) / h;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return 0;
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const i = ix + nx * iy + sxy * iz;
    const a = G[i] + (G[i + 1] - G[i]) * tx, b = G[i + nx] + (G[i + nx + 1] - G[i + nx]) * tx;
    const c = G[i + sxy] + (G[i + sxy + 1] - G[i + sxy]) * tx, d = G[i + sxy + nx] + (G[i + sxy + nx + 1] - G[i + sxy + nx]) * tx;
    const e = a + (b - a) * ty, g = c + (d - c) * ty;
    return e + (g - e) * tz;
};

// ---- iso level: a fraction of the median density seen by the splats themselves ----
const atCentre = new Float32Array(N);
for (let i = 0; i < N; i++) atCentre[i] = sample(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
const sorted = Float32Array.from(atCentre).sort();
const pct = p => sorted[Math.floor(p * (N - 1))];
const iso = isoFrac * pct(0.5);
let inside = 0, insideA = 0, totalA = 0;
for (let i = 0; i < N; i++) {
    totalA += alpha[i];
    if (atCentre[i] > iso) { inside++; insideA += alpha[i]; }
}
console.log(`grid ${nx}x${ny}x${nz}, voxel ${h}; density at splat centres p5 ${pct(0.05).toFixed(3)} p25 ${pct(0.25).toFixed(3)} p50 ${pct(0.5).toFixed(3)} p90 ${pct(0.9).toFixed(3)}`);
console.log(`iso ${iso.toFixed(4)}: ${(100 * inside / N).toFixed(1)}% of splats inside (${(100 * insideA / totalA).toFixed(1)}% by opacity)`);

// ---- surface nets ----
const cellVert = new Int32Array(G.length).fill(-1);
const verts = [];
const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const cornerOff = corner.map(c => c[0] + nx * c[1] + sxy * c[2]);
const edges = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (((a ^ b) & ((a ^ b) - 1)) === 0) edges.push([a, b]);
for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const i = x + nx * y + sxy * z;
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
    verts.push(g0[0] + (x + px / n) * h, g0[1] + (y + py / n) * h, g0[2] + (z + pz / n) * h);
}
const quads = [];
const stridesOf = [1, nx, sxy];
for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = x + nx * y + sxy * z, in0 = G[i] > iso;
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
console.log(`surface: ${nv} vertices, ${quads.length / 4} quads`);

// ---- drop small islands (floaters would cast stray shadows) ----
const parent = new Int32Array(nv).map((_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
for (let q = 0; q < quads.length; q += 4) for (let k = 1; k < 4; k++) {
    const a = find(quads[q]), b = find(quads[q + k]);
    if (a !== b) parent[a] = b;
}
const compSize = new Int32Array(nv);
for (let i = 0; i < nv; i++) compSize[find(i)]++;
const sizes = [...compSize].filter(s => s > 0).sort((a, b) => b - a);
console.log(`${sizes.length} components; largest: ${sizes.slice(0, 8).join(', ')}`);
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
    // outward normal = down the density gradient
    let gx = sample(x - h, y, z) - sample(x + h, y, z), gy = sample(x, y - h, z) - sample(x, y + h, z), gz = sample(x, y, z - h) - sample(x, y, z + h);
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
console.log(`kept ${kept} vertices, ${I.length / 3} triangles`);

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
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(outPath, Buffer.concat([head, jh, jsonBuf, bh, bin]));
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
