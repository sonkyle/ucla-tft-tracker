// Tiny static server for previewing site/ locally.
//   node src/serve.js [--port 8080] [--demo]   (--demo serves .demo/site-data as /data)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, arg } from './store.js';

const port = Number(arg('port', 8080));
const siteDir = path.join(ROOT, 'site');
const dataDir = process.argv.includes('--demo') ? path.join(ROOT, '.demo', 'site-data') : path.join(siteDir, 'data');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = urlPath.startsWith('/data/') ? [dataDir, urlPath.slice(6)] : [siteDir, urlPath.slice(1) || 'index.html'];
  const file = path.resolve(base, rel);
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// If the port is taken (e.g. by another dev server), try the next few.
let tryPort = port;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && tryPort < port + 20) {
    console.log(`port ${tryPort} is in use, trying ${tryPort + 1}...`);
    server.listen(++tryPort);
  } else {
    throw err;
  }
});
server.on('listening', () => console.log(`serving ${path.relative(ROOT, dataDir) || dataDir} at http://localhost:${tryPort}`));
server.listen(tryPort);
