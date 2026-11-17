// Prints, in world metres, where the two figures are at each height: used to place the
// breathing / sway fields in src/life.js. node tools/body-profile.mjs raw/scene.ply
import fs from 'node:fs';
const S = 0.072, FLOOR = 0.094, CX = 0.5, CZ = -1.0;
const buf = fs.readFileSync(process.argv[2]);
const he = buf.indexOf('end_header\n') + 11;
const header = buf.subarray(0, he).toString('ascii');
const N = Number(/element vertex (\d+)/.exec(header)[1]);
const props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]);
const stride = props.length * 4, dv = new DataView(buf.buffer, buf.byteOffset + he, N * stride);
const o = n => props.indexOf(n) * 4, oo = o('opacity');
const pts = [];
for (let i = 0; i < N; i++) {
    const a = 1 / (1 + Math.exp(-dv.getFloat32(i * stride + oo, true)));
    if (a < 0.08) continue;
    pts.push([-dv.getFloat32(i * stride, true) * S + CX * S, (FLOOR - dv.getFloat32(i * stride + 4, true)) * S, dv.getFloat32(i * stride + 8, true) * S - CZ * S]);
}
const med = a => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
const q = (a, p) => { a.sort((x, y) => x - y); return a.length ? a[Math.floor(p * (a.length - 1))] : NaN; };
// x histogram at torso height, to find the gap between the two
const hist = new Array(30).fill(0);
for (const p of pts) if (p[1] > 0.9 && p[1] < 1.3) { const b = Math.floor((p[0] + 0.75) / 0.05); if (b >= 0 && b < 30) hist[b]++; }
console.log('x histogram, torso height (bins of 5 cm from -0.75):'); console.log(hist.join(' '));
for (const [name, side] of [['him (x<split)', p => p[0] < -0.02], ['her (x>split)', p => p[0] >= -0.02]]) {
    console.log(name, ' height: n  x[10%,50%,90%]  z[10%,50%,90%]');
    for (let y = 1.8; y >= 0; y -= 0.1) {
        const s = pts.filter(p => side(p) && p[1] >= y && p[1] < y + 0.1);
        const xs = s.map(p => p[0]), zs = s.map(p => p[2]);
        console.log(y.toFixed(1), String(s.length).padStart(6), [q(xs, 0.1), med(xs), q(xs, 0.9)].map(v => v.toFixed(2)).join(' '), ' ', [q(zs, 0.1), med(zs), q(zs, 0.9)].map(v => v.toFixed(2)).join(' '));
    }
}
