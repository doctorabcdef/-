import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../backend/worker.js';

await mkdir('.artifacts', { recursive: true });
const db = new DatabaseSync('.artifacts/dev.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, updated_at TEXT NOT NULL)');
export function d1(database) {
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return database.prepare(sql).get(...args) || null; },
    async run() { const result = database.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
  }; } }; } };
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const root = resolve('.');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:5187');
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    const chunks = []; let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 4096) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const response = await handleRequest(request, { DB: d1(db), LOCAL_DEV: true });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  try {
    const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(root, `.${name}`);
    if (!path.startsWith(root + sep) || name.includes('/.') || !['.html', '.js', '.css', '.svg'].includes(extname(path))) throw new Error('Blocked');
    const content = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(5187, '127.0.0.1', () => console.log('Go preview: http://127.0.0.1:5187'));
