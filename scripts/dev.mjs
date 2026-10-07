import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../backend/worker.js';

await mkdir('.artifacts', { recursive: true });
const db = new DatabaseSync('.artifacts/dev.sqlite');
const journal = JSON.parse(await readFile('backend/drizzle/meta/_journal.json', 'utf8'));
db.exec('CREATE TABLE IF NOT EXISTS _dev_migrations (name TEXT PRIMARY KEY)');
for (const entry of journal.entries) {
  if (db.prepare('SELECT name FROM _dev_migrations WHERE name = ?').get(entry.tag)) continue;
  // Adopt the games table created by earlier versions of this local dev server.
  const legacy = entry.idx === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'").get();
  const sql = legacy ? '' : await readFile(`backend/drizzle/${entry.tag}.sql`, 'utf8');
  db.exec('BEGIN');
  try {
    if (sql) db.exec(sql);
    db.prepare('INSERT INTO _dev_migrations (name) VALUES (?)').run(entry.tag);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function d1(database) {
  function statement(sql, args = []) {
    return {
      bind(...values) { return statement(sql, values); },
      async first() { return database.prepare(sql).get(...args) || null; },
      async all() { return { results: database.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: database.prepare(sql).run(...args).changes } }; },
      execute() {
        const query = database.prepare(sql);
        return query.columns().length ? { results: query.all(...args) } : { meta: { changes: query.run(...args).changes } };
      },
    };
  }
  return { prepare: statement, async batch(statements) {
    database.exec('BEGIN');
    try {
      const results = statements.map(query => query.execute());
      database.exec('COMMIT'); return results;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
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
