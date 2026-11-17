// How much fatter is the lighting proxy than the splats it stands in for?
//
//   node tools/proxy-girth.mjs raw/scene.ply public/proxy.glb
//
// For every proxy vertex, the distance to the nearest opaque splat centre. The bodies are thin
// shells of splats, so this is how far the mesh sits outside the surface you actually see.
// Prints percentiles in centimetres, for the whole mesh and for the woman's forearms.
import fs from 'node:fs';

const [, , plyPath, glbPath] = process.argv;
const UNITS_TO_CM = 7.2;        // the stage scale in src/main.js: 0.072 m per PLY unit

// ---- opaque splat centres ----
const buf = fs.readFileSync(plyPath);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.subarray(0, headerEnd).toString('ascii');
const N = Number(/element vertex (\d+)/.exec(header)[1]);
const props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]);
const stride = props.length * 4;
const off = Object.fromEntries(props.map((p, i) => [p, i * 4]));
const dv = new DataView(buf.buffer, buf.byteOffset + headerEnd, N * stride);
const f = (i, name) => dv.getFloat32(i * stride + off[name], true);

const MIN_ALPHA = Number(process.env.ALPHA ?? 0.2);
const CELL = 0.7;
const grid = new Map();
const key = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
let opaque = 0;
const sizes = [];
for (let i = 0; i < N; i++) {
    if (1 / (1 + Math.exp(-f(i, 'opacity'))) < MIN_ALPHA) continue;
    const x = f(i, 'x'), y = f(i, 'y'), z = f(i, 'z');
    const k = key(x, y, z);
    let cell = grid.get(k);
    if (!cell) grid.set(k, cell = []);
    cell.push(x, y, z);
    opaque++;
    if (opaque % 16 === 0) sizes.push(Math.exp(Math.max(f(i, 'scale_0'), f(i, 'scale_1'), f(i, 'scale_2'))));
}
sizes.sort((a, b) => a - b);

// ---- proxy vertices ----
const glb = fs.readFileSync(glbPath);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const acc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
const view = json.bufferViews[acc.bufferView];
const P = new Float32Array(glb.buffer.slice(glb.byteOffset + binStart + view.byteOffset, glb.byteOffset + binStart + view.byteOffset + acc.count * 12));

const nearest = (x, y, z) => {
    let best = Infinity;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!cell) continue;
        for (let j = 0; j < cell.length; j += 3) {
            const d = (cell[j] - x) ** 2 + (cell[j + 1] - y) ** 2 + (cell[j + 2] - z) ** 2;
            if (d < best) best = d;
        }
    }
    return Math.min(Math.sqrt(best), CELL);
};

const all = [], arm = [];
for (let i = 0; i < acc.count; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const d = nearest(x, y, z);
    all.push(d);
    // her forearms and hands: from her chest out to the pistol (PLY space, y down)
    if (x < -5.5 && x > -9.5 && y > -20.5 && y < -17) arm.push(d);
}
const report = (name, a) => {
    a.sort((p, q) => p - q);
    const pct = p => (a[Math.floor(p * (a.length - 1))] * UNITS_TO_CM).toFixed(1);
    console.log(`${name}: ${a.length} vertices; proxy stands off the splats by p10 ${pct(0.1)} cm, p50 ${pct(0.5)} cm, p90 ${pct(0.9)} cm`);
};
console.log(`${opaque} opaque splats; splat radius (longest axis, 1 sigma) p50 ${(sizes[sizes.length >> 1] * UNITS_TO_CM).toFixed(2)} cm`);
report('whole mesh', all);
report('her forearms', arm);
