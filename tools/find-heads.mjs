// Prints head centres and facing directions (PLY space) for the two figures, for camera presets.
import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]);
const he = buf.indexOf('end_header\n') + 11;
const header = buf.subarray(0, he).toString('ascii');
const N = Number(/element vertex (\d+)/.exec(header)[1]);
const props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]);
const stride = props.length * 4, dv = new DataView(buf.buffer, buf.byteOffset + he, N * stride);
const o = n => props.indexOf(n) * 4, g = (i, n) => dv.getFloat32(i * stride + o(n), true);
const C0 = 0.28209479177387814;
for (const [name, test] of [['man', (x, y) => x > 1 && y < -22.2], ['woman', (x, y) => x < 1.5 && y < -19.6]]) {
    const head = [0, 0, 0], skin = [0, 0, 0]; let hn = 0, sn = 0, top = 0;
    for (let i = 0; i < N; i++) {
        const x = g(i, 'x'), y = g(i, 'y'), z = g(i, 'z');
        if (!test(x, y)) continue;
        const a = 1 / (1 + Math.exp(-g(i, 'opacity')));
        if (a < 0.1) continue;
        head[0] += x; head[1] += y; head[2] += z; hn++; top = Math.min(top, y);
        const r = 0.5 + C0 * g(i, 'f_dc_0'), gr = 0.5 + C0 * g(i, 'f_dc_1'), b = 0.5 + C0 * g(i, 'f_dc_2');
        if (r > 0.55 && r > gr * 1.15 && gr > b * 1.1 && gr > 0.35) { skin[0] += x; skin[1] += y; skin[2] += z; sn++; }
    }
    const h = head.map(v => v / hn), s = skin.map(v => v / sn);
    const d = [s[0] - h[0], 0, s[2] - h[2]], l = Math.hypot(...d);
    console.log(name, 'head', h.map(v => +v.toFixed(2)), 'top', +top.toFixed(2), 'skin', s.map(v => +v.toFixed(2)), `(${sn} of ${hn})`, 'facing', d.map(v => +(v / l).toFixed(2)));
}
