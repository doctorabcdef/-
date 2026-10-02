import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../src/http.js';

function clock(t) {
  const timers = new Map();
  let nextId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  return {
    timers,
    expire() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function waitForAbort(signal, error = new DOMException('The request was aborted', 'AbortError')) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(error);
    else signal.addEventListener('abort', () => reject(error), { once: true });
  });
}

test('successful JSON request forwards options and cleans up its deadline and caller listener', async t => {
  const deadline = clock(t), caller = new AbortController();
  const data = { revision: 8, game: { turn: 1 } };
  let receivedUrl, receivedOptions;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    receivedUrl = url;
    receivedOptions = options;
    return { ok: true, status: 200, json: async () => data };
  });
  const result = await requestJson('/api/game', {
    signal: caller.signal, timeoutMs: 1234, method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{"revision":7}',
  });
  assert.deepEqual(result, { ok: true, status: 200, data });
  assert.equal(receivedUrl, '/api/game');
  assert.equal(receivedOptions.method, 'POST');
  assert.deepEqual(receivedOptions.headers, { 'Content-Type': 'application/json' });
  assert.equal(receivedOptions.body, '{"revision":7}');
  assert.notEqual(receivedOptions.signal, caller.signal);
  assert.equal(receivedOptions.timeoutMs, undefined);
  assert.equal(deadline.timers.size, 0);
  caller.abort();
  deadline.expire();
  assert.equal(receivedOptions.signal.aborted, false, 'later caller cancellation must not abort a completed request');
});

test('deadline aborts a stalled fetch and reports a useful timeout message', async t => {
  const deadline = clock(t);
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    requestSignal = signal;
    return waitForAbort(signal);
  });
  const pending = requestJson('/api/game', { timeoutMs: 50 });
  const rejected = assert.rejects(pending, /连接云端超时.*切换网络/);
  assert.equal([...deadline.timers.values()][0].delay, 50);
  deadline.expire();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(deadline.timers.size, 0);
});

test('deadline remains active after headers arrive until response JSON finishes decoding', async t => {
  const deadline = clock(t);
  let requestSignal, notifyBodyStarted;
  const bodyStarted = new Promise(resolve => { notifyBodyStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requestSignal = signal;
    return { ok: true, status: 200, json() {
      notifyBodyStarted();
      return waitForAbort(signal);
    } };
  });
  const pending = requestJson('/api/game', { timeoutMs: 50 });
  const rejected = assert.rejects(pending, /连接云端超时/);
  await bodyStarted;
  assert.equal(deadline.timers.size, 1, 'receiving headers must not clear the body deadline');
  deadline.expire();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(deadline.timers.size, 0);
});

test('caller cancellation preserves AbortError while fetch is pending', async t => {
  const deadline = clock(t), caller = new AbortController();
  const aborted = new DOMException('Caller stopped the request', 'AbortError');
  t.mock.method(globalThis, 'fetch', (url, { signal }) => waitForAbort(signal, aborted));
  const pending = requestJson('/api/game', { signal: caller.signal });
  const rejected = assert.rejects(pending, error => error === aborted && error.name === 'AbortError');
  caller.abort();
  await rejected;
  assert.equal(deadline.timers.size, 0);
});

test('already-aborted caller signal reaches fetch as aborted and preserves AbortError', async t => {
  const deadline = clock(t), caller = new AbortController();
  const aborted = new DOMException('Already cancelled', 'AbortError');
  caller.abort();
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    assert.equal(signal.aborted, true);
    return waitForAbort(signal, aborted);
  });
  await assert.rejects(requestJson('/api/game', { signal: caller.signal }), error => error === aborted);
  assert.equal(deadline.timers.size, 0);
});

test('caller cancellation during body decoding remains an AbortError', async t => {
  const deadline = clock(t), caller = new AbortController();
  const aborted = new DOMException('Body cancelled', 'AbortError');
  let notifyBodyStarted;
  const bodyStarted = new Promise(resolve => { notifyBodyStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => ({
    ok: true, status: 200, json() { notifyBodyStarted(); return waitForAbort(signal, aborted); },
  }));
  const pending = requestJson('/api/game', { signal: caller.signal });
  const rejected = assert.rejects(pending, error => error === aborted);
  await bodyStarted;
  caller.abort();
  await rejected;
  assert.equal(deadline.timers.size, 0);
});

test('409 JSON response preserves the server game for revision conflict reconciliation', async t => {
  const deadline = clock(t);
  const data = { error: '另一台设备已更新棋局', revision: 12, game: { board: [1, 0, 2], turn: 1 } };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 409, json: async () => data }));
  assert.deepEqual(await requestJson('/api/game'), { ok: false, status: 409, data });
  assert.equal(deadline.timers.size, 0);
});

test('invalid JSON in a successful response reports an unreadable cloud response', async t => {
  const deadline = clock(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
  }));
  await assert.rejects(requestJson('/api/game'), /云端响应无法识别.*重试/);
  assert.equal(deadline.timers.size, 0);
});

test('non-JSON HTTP failure includes the server status instead of a parsing error', async t => {
  const deadline = clock(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 503, json: async () => { throw new SyntaxError('HTML error page'); },
  }));
  await assert.rejects(requestJson('/api/game'), /云端服务暂时不可用（503）.*重试/);
  assert.equal(deadline.timers.size, 0);
});

test('network failure gives actionable connection guidance and clears its deadline', async t => {
  const deadline = clock(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(requestJson('/api/game'), /无法连接云端.*切换网络.*系统浏览器/);
  assert.equal(deadline.timers.size, 0);
});
