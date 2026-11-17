// Writes a copy of a 3DGS PLY mirrored in a horizontal plane, for the wet-floor reflection.
//
//   node tools/mirror-ply.mjs raw/scene.ply raw/mirror.ply [floorY]
//
// Positions are reflected in y = floorY (PLY space, default 0.094: the soles of the feet).
// Rotations are reflected to match: for a mirror in y, quaternion (w, x, y, z) -> (w, -x, y, -z).
// Only the base colour is kept: the reflection is drawn blurred and faint, so the view-dependent
// bands (45 of the 59 floats per splat) would be wasted on it.
import fs from 'node:fs';

const [, , inPath, outPath, floorArg] = process.argv;
if (!inPath || !outPath) {
    console.error('usage: node tools/mirror-ply.mjs <in.ply> <out.ply> [floorY]');
    process.exit(1);
}
const floorY = Number(floorArg ?? 0.094);

const buf = fs.readFileSync(inPath);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.subarray(0, headerEnd).toString('ascii');
const N = Number(/element vertex (\d+)/.exec(header)[1]);
const props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]);
const stride = props.length * 4;
const src = new DataView(buf.buffer, buf.byteOffset + headerEnd, N * stride);

const keep = props.filter(p => !p.startsWith('f_rest_'));
const from = keep.map(p => props.indexOf(p) * 4);
const sign = keep.map(p => (p === 'rot_1' || p === 'rot_3' ? -1 : 1));
const yIndex = keep.indexOf('y');

const outHeader = `ply\nformat binary_little_endian 1.0\nelement vertex ${N}\n${keep.map(p => `property float ${p}`).join('\n')}\nend_header\n`;
const out = Buffer.alloc(N * keep.length * 4);
const dst = new DataView(out.buffer, out.byteOffset, out.length);
for (let i = 0; i < N; i++) {
    for (let k = 0; k < keep.length; k++) {
        let v = src.getFloat32(i * stride + from[k], true) * sign[k];
        if (k === yIndex) v = 2 * floorY - v;
        dst.setFloat32((i * keep.length + k) * 4, v, true);
    }
}
fs.writeFileSync(outPath, Buffer.concat([Buffer.from(outHeader, 'ascii'), out]));
console.log(`wrote ${outPath}: ${N} splats mirrored in y = ${floorY}, ${keep.length} properties each`);
