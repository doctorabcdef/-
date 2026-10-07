import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../backend/worker.js';
import { CHAT_VOICES } from '../src/chat-voices.js';

const migrationsDirectory = new URL('../backend/drizzle/', import.meta.url);
const migrations = readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrationsDirectory), 'utf8'));
const clientId = 'a'.repeat(32);
const requestId = number => number.toString(16).padStart(32, '0');
const messageBody = (text = '太慢了', number = 1, author = clientId) => ({ clientId: author, requestId: requestId(number), text });

function client(env) {
  return async (path = '/api/chat', body, options = {}) => {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const init = { method, headers: {
      Origin: 'https://doctorabcdef.github.io', 'Content-Type': 'application/json', ...options.headers,
    } };
    if (!['GET', 'HEAD'].includes(method)) init.body = options.raw ?? JSON.stringify(body);
    if (options.stream) { init.body = options.stream; init.duplex = 'half'; }
    const response = await handleRequest(new Request(`https://cloud.test${path}`, init), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
}

function setup(t, beforeMigration = () => {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const [index, sql] of migrations.entries()) { beforeMigration(db, index); db.exec(sql); }
  const operations = [];
  function prepare(sql, args = []) {
    const execute = () => {
      operations.push(sql);
      const statement = db.prepare(sql);
      if (statement.columns().length) return { results: statement.all(...args), meta: {} };
      return { results: [], meta: { changes: statement.run(...args).changes } };
    };
    return {
      bind: (...values) => prepare(sql, values), execute,
      async first() { return execute().results[0]; },
      async all() { return execute(); },
      async run() { return execute(); },
    };
  }
  const env = { DB: {
    prepare,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } };
  return { db, env, call: client(env), operations };
}

function seed(db, count) {
  const insert = db.prepare('INSERT INTO chat_messages (client_id, request_id, text, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= count; i++) {
    // IDs, rather than possibly equal or out-of-order timestamps, define history.
    insert.run(clientId, requestId(i), `消息 ${i}`, new Date(Date.UTC(2026, 9, 7, 0, 0, count - i)).toISOString());
  }
}

test('chat persists across fresh request clients, with server UTC time and no game initialization', async t => {
  const { call, env, db } = setup(t);
  assert.deepEqual((await call()).body, { messages: [], hasMoreBefore: false, hasMoreAfter: false });
  const before = Date.now();
  const sent = await call('/api/chat', messageBody('  搞快点好不 😅  '));
  const after = Date.now();
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.body.message).sort(), ['clientId', 'createdAt', 'id', 'kind', 'nickname', 'requestId', 'text', 'voiceId']);
  assert.equal(sent.body.message.text, '搞快点好不 😅');
  assert.equal(sent.body.message.clientId, clientId);
  assert.equal(sent.body.message.requestId, requestId(1));
  assert.equal(sent.body.message.kind, 'text');
  assert.equal(sent.body.message.voiceId, null);
  assert.equal(sent.body.message.nickname, '');
  assert.match(sent.body.message.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(sent.body.message.createdAt) >= before && Date.parse(sent.body.message.createdAt) <= after);
  const reopened = await client(env)();
  assert.deepEqual(reopened.body.messages, [sent.body.message]);
  assert.equal(reopened.headers.get('Cache-Control'), 'no-store');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
});

test('new games and undo preserve chat, while chat never changes game revision or history', async t => {
  const { call, db, operations } = setup(t);
  await call('/api/game');
  await call('/api/game', { revision: 0, action: { type: 'play', index: 180 } });
  const gameBefore = db.prepare('SELECT * FROM games').get();
  operations.length = 0;
  const sent = await call('/api/chat', messageBody());
  await call('/api/chat?after=0');
  assert.deepEqual(db.prepare('SELECT * FROM games').get(), gameBefore);
  assert.ok(operations.every(sql => !/\bgames\b/.test(sql)));
  assert.equal((await call('/api/game', { revision: 1, action: { type: 'undo' } })).status, 200);
  assert.equal((await call('/api/game', { revision: 2, action: { type: 'new', size: 9, mode: 'ai' } })).status, 200);
  assert.deepEqual((await call()).body.messages, [sent.body.message]);
});

test('latest and older pages retain chronological id order with accurate 51-row sentinels', async t => {
  const { call, db } = setup(t); seed(db, 120);
  for (const [path, first, last, hasMoreBefore] of [
    ['/api/chat', 71, 120, true], ['/api/chat?before=71', 21, 70, true], ['/api/chat?before=21', 1, 20, false],
  ]) {
    const result = await call(path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.messages.map(message => message.id), Array.from({ length: last - first + 1 }, (_, i) => first + i));
    assert.equal(result.body.hasMoreBefore, hasMoreBefore);
    assert.equal(result.body.hasMoreAfter, false);
  }
  assert.deepEqual((await call('/api/chat?before=1')).body, { messages: [], hasMoreBefore: false, hasMoreAfter: false });
  const exact = await call('/api/chat?before=51');
  assert.equal(exact.body.messages.length, 50);
  assert.equal(exact.body.hasMoreBefore, false);
});

test('incremental after pages return earliest unseen messages without gaps or duplication', async t => {
  const { call, db } = setup(t); seed(db, 120);
  const received = [];
  for (const [after, count, hasMoreAfter] of [[0, 50, true], [50, 50, true], [100, 20, false], [120, 0, false]]) {
    const result = await call(`/api/chat?after=${after}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.messages.length, count);
    assert.equal(result.body.hasMoreBefore, false);
    assert.equal(result.body.hasMoreAfter, hasMoreAfter);
    received.push(...result.body.messages.map(message => message.id));
  }
  assert.deepEqual(received, Array.from({ length: 120 }, (_, i) => i + 1));
  const sent = await call('/api/chat', messageBody('下一条 👍', 121));
  assert.deepEqual((await call('/api/chat?after=120')).body.messages, [sent.body.message]);
  assert.deepEqual((await call('/api/chat?after=999')).body.messages, []);
});

test('lost-response retries and simultaneous duplicate sends return one original message', async t => {
  const { call, db } = setup(t);
  const body = messageBody('太慢了 😂');
  const first = await call('/api/chat', body);
  const [retryA, retryB] = await Promise.all([call('/api/chat', body), call('/api/chat', body)]);
  for (const retry of [retryA, retryB]) {
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, first.body);
  }
  const fresh = messageBody('第二条', 2);
  const concurrent = await Promise.all([call('/api/chat', fresh), call('/api/chat', fresh)]);
  assert.deepEqual(concurrent[0].body, concurrent[1].body);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 2);
});

test('same key with changed text conflicts, but another client can use the same request id', async t => {
  const { call, db } = setup(t);
  const original = await call('/api/chat', messageBody('太慢了'));
  assert.deepEqual((await call('/api/chat', messageBody('  太慢了  '))).body, original.body);
  const changed = await call('/api/chat', messageBody('搞快点好不'));
  assert.equal(changed.status, 409);
  assert.equal((await call()).body.messages[0].text, '太慢了');
  assert.equal((await call('/api/chat', messageBody('另一个人', 1, 'b'.repeat(32)))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 2);
});

test('text validation trims edges and counts the requested 500 JavaScript code-unit limit', async t => {
  const { call, db } = setup(t);
  let number = 1;
  for (const text of ['a', '  太慢了  ', 'a'.repeat(500), '😀'.repeat(250)]) {
    const result = await call('/api/chat', messageBody(text, number++));
    assert.equal(result.status, 200);
    assert.equal(result.body.message.text, text.trim());
  }
  for (const text of ['', ' \n\t\u00a0 ', 'a'.repeat(501), '😀'.repeat(251), null, 123, ['hello']]) {
    assert.equal((await call('/api/chat', messageBody(text, number++))).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 4);
});

test('append-only voice migration preserves existing text messages and old-client retries', async t => {
  const createdAt = '2026-10-07T12:34:56.000Z';
  const { call, db } = setup(t, (database, index) => {
    if (index === 2) database.prepare('INSERT INTO chat_messages (client_id, request_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, requestId(1), '旧版发来的消息', createdAt);
  });
  const expected = { id: 1, clientId, requestId: requestId(1), text: '旧版发来的消息', createdAt, kind: 'text', voiceId: null, nickname: '' };
  assert.deepEqual((await call()).body.messages, [expected]);
  const retried = await call('/api/chat', messageBody('旧版发来的消息'));
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body.message, expected);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 1);
  const explicitDefaults = await call('/api/chat', { ...messageBody('旧版发来的消息'), kind: 'text', voiceId: null, nickname: '' });
  assert.deepEqual(explicitDefaults.body.message, expected);
});

test('preset voices use canonical registry labels and persist only IDs, not URLs or durations', async t => {
  const { call, db } = setup(t);
  let number = 1;
  for (const [voiceId, expectedLabel] of [['too-slow', '太慢了太慢了'], ['hurry-up', '搞快点好不']]) {
    assert.equal(CHAT_VOICES[voiceId].label, expectedLabel);
    assert.ok(CHAT_VOICES[voiceId].durationSeconds > 0);
    const response = await call('/api/chat', {
      ...messageBody('客户端伪造标题', number++), kind: 'voice', voiceId, nickname: '  棋友  ',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.message.text, expectedLabel);
    assert.equal(response.body.message.kind, 'voice');
    assert.equal(response.body.message.voiceId, voiceId);
    assert.equal(response.body.message.nickname, '棋友');
    assert.equal(response.body.message.durationSeconds, undefined);
    assert.equal(response.body.message.file, undefined);
  }
  const withoutText = messageBody(undefined, number++);
  delete withoutText.text;
  assert.equal((await call('/api/chat', { ...withoutText, kind: 'voice', voiceId: 'too-slow' })).status, 200);
  const storedColumns = db.prepare('PRAGMA table_info(chat_messages)').all().map(column => column.name);
  assert.ok(!storedColumns.includes('duration_seconds') && !storedColumns.includes('file') && !storedColumns.includes('url'));
});

test('voice retries remain single messages and changed nickname, kind, or preset conflicts', async t => {
  const { call, db } = setup(t);
  const voice = { ...messageBody('任意客户端文本'), kind: 'voice', voiceId: 'too-slow', nickname: '小明' };
  const first = await call('/api/chat', voice);
  const retries = await Promise.all([
    call('/api/chat', voice),
    call('/api/chat', { ...voice, text: '另一个客户端标题', nickname: ' 小明 ' }),
  ]);
  for (const retry of retries) { assert.equal(retry.status, 200); assert.deepEqual(retry.body, first.body); }
  for (const change of [
    { nickname: '小红' }, { voiceId: 'hurry-up' },
    { kind: 'text', voiceId: null, text: CHAT_VOICES['too-slow'].label },
  ]) assert.equal((await call('/api/chat', { ...voice, ...change })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 1);
  assert.deepEqual((await call()).body.messages, [first.body.message]);
});

test('nicknames are optional, trimmed, and limited to 24 JavaScript code units', async t => {
  const { call, db } = setup(t);
  let number = 1;
  for (const nickname of ['', '  棋友  ', 'a'.repeat(24), '😀'.repeat(12), ' \n ']) {
    const result = await call('/api/chat', { ...messageBody('你好', number++), nickname });
    assert.equal(result.status, 200);
    assert.equal(result.body.message.nickname, nickname.trim());
  }
  for (const nickname of ['a'.repeat(25), '😀'.repeat(13), null, 123, ['昵称']]) {
    assert.equal((await call('/api/chat', { ...messageBody('你好', number++), nickname })).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 5);
});

test('unsupported kinds, arbitrary voice URLs, prototype keys, and mixed text/voice metadata are rejected', async t => {
  const { call, operations } = setup(t);
  const invalid = [
    { kind: 'image' }, { kind: null }, { kind: '' }, { kind: 'voice' },
    { kind: 'voice', voiceId: null }, { kind: 'voice', voiceId: 'unknown' },
    { kind: 'voice', voiceId: 'https://unknown.test/audio.mp3' },
    { kind: 'voice', voiceId: '__proto__' }, { kind: 'voice', voiceId: 'constructor' },
    { kind: 'voice', voiceId: ['too-slow'] }, { kind: 'text', voiceId: 'too-slow' },
    { kind: 'text', voiceId: '' }, { voiceId: 'hurry-up' },
  ];
  for (const metadata of invalid) assert.equal((await call('/api/chat', { ...messageBody(), ...metadata })).status, 400);
  assert.equal(operations.length, 0);
});

test('voice and nickname metadata survives reopening, older pages, and incremental pages', async t => {
  const { call, db, env } = setup(t);
  const first = await call('/api/chat', { ...messageBody(), kind: 'voice', voiceId: 'too-slow', nickname: '黑方' });
  const insert = db.prepare('INSERT INTO chat_messages (client_id, request_id, text, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 2; i <= 55; i++) insert.run(clientId, requestId(i), `消息 ${i}`, new Date().toISOString());
  const last = await call('/api/chat', { ...messageBody('你好', 56), nickname: '白方' });
  const reopened = await client(env)();
  assert.equal(reopened.body.hasMoreBefore, true);
  assert.deepEqual(reopened.body.messages.at(-1), last.body.message);
  const older = await call(`/api/chat?before=${reopened.body.messages[0].id}`);
  assert.deepEqual(older.body.messages[0], first.body.message);
  const incremental = await call('/api/chat?after=0');
  assert.deepEqual(incremental.body.messages[0], first.body.message);
  assert.deepEqual((await call('/api/chat?after=55')).body.messages, [last.body.message]);
});

test('identifiers and cursor queries reject malformed or ambiguous values before database work', async t => {
  const { call, operations } = setup(t);
  for (const field of ['clientId', 'requestId']) for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 123, null]) {
    assert.equal((await call('/api/chat', { ...messageBody(), [field]: value })).status, 400);
  }
  for (const query of ['before=0', 'before=-1', 'after=-1', 'after=1.5', 'after=9007199254740992', 'after=', 'after=1e2', 'before=2&after=1', 'after=1&after=2']) {
    assert.equal((await call(`/api/chat?${query}`)).status, 400, query);
  }
  assert.equal(operations.length, 0);
  assert.equal((await call('/api/chat', messageBody('允许大写十六进制', 1, 'AB'.repeat(16)))).status, 200);
});

test('malformed JSON, non-JSON bodies, and oversized UTF-8 or declared bodies are rejected', async t => {
  const { call, operations } = setup(t);
  assert.equal((await call('/api/chat', {}, { raw: '{broken' })).status, 400);
  assert.equal((await call('/api/chat', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/chat', {}, { raw: '{}', headers: { 'Content-Length': '4097' } })).status, 413);
  assert.equal((await call('/api/chat', { ...messageBody(), padding: '😀'.repeat(1100) })).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(2048))); },
    cancel() { cancelled = true; },
  });
  assert.equal((await call('/api/chat', {}, { stream })).status, 413);
  assert.equal(cancelled, true, 'Oversized chunked bodies must stop being consumed');
  assert.equal(operations.length, 0);
});

test('chat uses existing CORS and method protection and stores HTML or SQL-looking content as plain text', async t => {
  const { call, db, operations } = setup(t);
  const denied = await call('/api/chat', messageBody(), { headers: { Origin: 'https://unknown.test' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call('/api/chat', undefined, { method: 'DELETE' })).status, 405);
  const preflight = await call('/api/chat', undefined, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://doctorabcdef.github.io');
  assert.equal(operations.length, 0);
  const text = '<img src=x onerror="alert(1)"> 😀 \'); DROP TABLE games; --';
  const sent = await call('/api/chat', messageBody(text));
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.text, text);
  assert.match(sent.headers.get('Content-Type'), /^application\/json/);
  assert.equal((await call()).body.messages[0].text, text);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
});
