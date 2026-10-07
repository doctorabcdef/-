import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../backend/worker.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  const reads = [], writes = [];
  db.exec('CREATE TABLE games (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const env = { DB: { prepare(sql) { return { bind(...args) { return {
    async first() { const row = db.prepare(sql).get(...args); reads.push({ sql, row }); return row; },
    async run() { writes.push(sql); return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
  }; } }; } } };
  const call = async (body, options = {}) => {
    const response = await handleRequest(new Request(`https://cloud.test/api/game${options.revision !== undefined ? `?revision=${encodeURIComponent(options.revision)}` : ''}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://doctorabcdef.github.io', ...options.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { call, db, env, reads, writes };
}

test('unchanged checks read one metadata row without database writes or full game history', async () => {
  const { call, db, reads, writes } = setup(); await call();
  reads.length = 0; writes.length = 0;
  const check = await call(undefined, { revision: 0 });
  assert.equal(check.status, 200);
  assert.deepEqual(check.body, { unchanged: true, revision: 0 });
  assert.equal(reads.length, 1); assert.equal(reads[0].row.state, null);
  assert.equal(writes.length, 0);
  assert.equal(check.headers.get('Cache-Control'), 'no-store'); db.close();
});

test('changed revision returns the latest game in one read and no writes', async () => {
  const { call, db, reads, writes } = setup(); await call();
  await call({ revision: 0, action: { type: 'play', index: 180 } });
  reads.length = 0; writes.length = 0;
  const check = await call(undefined, { revision: 0 });
  assert.equal(check.status, 200); assert.equal(check.body.revision, 1);
  assert.equal(check.body.game.board[180], 1);
  assert.equal(reads.length, 1); assert.equal(writes.length, 0); db.close();
});

test('concurrent first reads initialize one shared game and return the same saved copy', async () => {
  const { call, db } = setup();
  const [a, b] = await Promise.all([call(), call()]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM games').get().count, 1); db.close();
});

test('save and reopen uses the same cloud game', async () => {
  const { call, db } = setup(); const first = await call();
  assert.equal(first.body.revision, 0);
  const move = await call({ revision: 0, action: { type: 'play', index: 180 } });
  assert.equal(move.status, 200); assert.equal(move.body.game.board[180], 1);
  assert.equal(move.body.game.history, undefined);
  const reopened = await call(); assert.deepEqual(reopened.body, move.body); db.close();
});
test('stale revision cannot overwrite new moves or reset the game', async () => {
  const { call, db } = setup(); await call();
  await call({ revision: 0, action: { type: 'play', index: 180 } });
  const stale = await call({ revision: 0, action: { type: 'new', mode: 'local', size: 9 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.game.board[180], 1); db.close();
});
test('two simultaneous writes permit only one revision winner', async () => {
  const { call, db } = setup(); await call();
  const both = await Promise.all([call({ revision: 0, action: { type: 'play', index: 0 } }), call({ revision: 0, action: { type: 'play', index: 1 } })]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call()).body.game.moves.length, 1); db.close();
});
test('malformed, oversized, and unsupported origin requests are rejected', async () => {
  const { call, db, env } = setup();
  assert.equal((await call({ extra: 'x'.repeat(5000) })).status, 413);
  assert.equal((await call(undefined, { headers: { Origin: 'https://unknown.test' } })).status, 403);
  assert.equal((await handleRequest(new Request('https://cloud.test/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }), env)).status, 400);
  assert.equal((await call({ revision: 0, action: { type: 'play', index: -3 } })).status, 422); db.close();
});
test('AI move and its answer are saved atomically', async () => {
  const { call, db } = setup(); await call();
  await call({ revision: 0, action: { type: 'new', size: 9, mode: 'ai' } });
  const result = await call({ revision: 1, action: { type: 'play', index: 40 } });
  assert.equal(result.body.revision, 2); assert.equal(result.body.game.moves.length, 2);
  assert.equal(result.body.game.turn, 1); db.close();
});
