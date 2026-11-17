import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// dev only: POST /__save?file=film.h264&append=1 writes, or adds to, a file in captures/. It is
// how the film gets from the page to the disk when it is rendered to a video (src/capture.js).
const captureSink = {
    name: 'capture-sink',
    configureServer(server) {
        server.middlewares.use('/__save', (req, res) => {
            if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
            const q = new URL(req.url, 'http://x').searchParams;
            const file = (q.get('file') || 'capture.bin').replace(/[^\w.-]/g, '_');
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const dir = path.join(here, 'captures');
                fs.mkdirSync(dir, { recursive: true });
                const dest = path.join(dir, file);
                if (q.get('append') === '1') fs.appendFileSync(dest, Buffer.concat(chunks));
                else fs.writeFileSync(dest, Buffer.concat(chunks));
                res.end('ok');
            });
        });
    }
};

export default defineConfig({
    // relative paths, so the build works from any folder (GitHub Pages serves it from /gaussian-evil/)
    base: './',
    plugins: [captureSink],
    server: { watch: { ignored: ['**/captures/**'] } }
});
