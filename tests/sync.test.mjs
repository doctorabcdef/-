import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, play, pass, publicState } from '../src/engine.js';
import { createGameSync, restoreGame } from '../src/sync.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(initial = createGame({ size: 9 })) {
  let server = initial, revision = 0, heldGet = null;
  const requests = [], changes = [], errors = [], saved = [];
  const payload = () => ({ revision, game: publicState(server), updatedAt: '2026-09-29T04:00:00Z' });
  const sync = createGameSync({
    get: async () => heldGet ? heldGet.promise : payload(),
    post(expected, action) { const gate = deferred(); requests.push({ expected, action, gate }); return gate.promise; },
    onChange: state => changes.push(state), onError: message => errors.push(message), cache: data => saved.push(data),
  });
  function complete(index) {
    const request = requests[index]; assert.equal(request.expected, revision);
    server = applyAction(server, request.action, () => 0.5); revision++;
    request.gate.resolve({ ok: true, status: 200, data: payload() });
  }
  return { sync, requests, changes, errors, saved, payload, complete,
    holdGet() { heldGet = deferred(); return heldGet; },
    releaseGet() { heldGet = null; },
    remote(action) { server = applyAction(server, action); revision++; },
  };
}

test('stone and undo display synchronously before their network requests finish', async () => {
  const h = harness(); await h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 });
  assert.equal(h.sync.state().game.board[40], 1); assert.equal(h.sync.state().revision, 0);
  assert.equal(h.sync.state().busy, true); assert.equal(h.saved.length, 1);
  const undone = h.sync.submit({ type: 'undo' });
  assert.equal(h.sync.state().game.board[40], 0); assert.equal(h.requests.length, 1);
  h.complete(0); await tick();
  assert.equal(h.sync.state().game.board[40], 0); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].expected, 1);
  h.complete(1); assert.deepEqual(await Promise.all([placed, undone]), [true, true]); await tick();
  assert.equal(h.payload().game.moves.length, 0); assert.equal(h.sync.state().busy, false);
});

test('rapid local moves queue in order and confirmed responses do not erase later previews', async () => {
  const h = harness(); await h.sync.refresh();
  const actions = [40, 41, 42].map(index => h.sync.submit({ type: 'play', index }));
  assert.equal(h.sync.state().game.moves.length, 3); assert.equal(h.requests.length, 1);
  for (let i = 0; i < 3; i++) { h.complete(i); await tick(); assert.equal(h.sync.state().game.moves.length, 3); }
  assert.deepEqual(await Promise.all(actions), [true, true, true]);
});

test('AI preview shows only the human move and pending undo stays undone after AI reply', async () => {
  const h = harness(createGame({ size: 9, mode: 'ai' })); await h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 });
  assert.equal(h.sync.state().game.moves.length, 1); assert.equal(h.sync.state().game.turn, 2);
  assert.equal(await h.sync.submit({ type: 'play', index: 41 }), false);
  const undone = h.sync.submit({ type: 'undo' });
  assert.equal(h.sync.state().game.moves.length, 0);
  h.complete(0); await tick();
  assert.equal(h.payload().game.moves.length, 2); assert.equal(h.sync.state().game.moves.length, 0);
  h.complete(1); await Promise.all([placed, undone]);
  assert.equal(h.payload().game.turn, 1); assert.equal(h.payload().game.moves.length, 0);
});

test('slow polls started before a click cannot overwrite previews or acknowledgements', async () => {
  const h = harness(); await h.sync.refresh(); const old = h.payload();
  const get = h.holdGet(), polling = h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 });
  get.resolve(old); await polling; h.releaseGet();
  assert.equal(h.sync.state().game.board[40], 1); assert.equal(h.sync.state().online, true);
  h.complete(0); await placed; assert.equal(h.sync.state().revision, 1);
});

test('late poll failure cannot mark a successful save offline', async () => {
  const h = harness(); await h.sync.refresh(); const get = h.holdGet(), polling = h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 }); h.complete(0); await placed;
  get.reject(new Error('stale timeout')); await polling; h.releaseGet();
  assert.equal(h.sync.state().online, true); assert.equal(h.sync.state().revision, 1);
});

test('409 conflict discards dependent operations and displays the other device state', async () => {
  const h = harness(); await h.sync.refresh();
  const a = h.sync.submit({ type: 'play', index: 40 }), b = h.sync.submit({ type: 'play', index: 41 });
  h.remote({ type: 'play', index: 0 });
  h.requests[0].gate.resolve({ ok: false, status: 409, data: { ...h.payload(), error: '另一设备已更新' } });
  assert.deepEqual(await Promise.all([a, b]), [false, false]); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.sync.state().game.board[0], 1);
  assert.equal(h.sync.state().game.board[40], 0); assert.equal(h.sync.state().online, true);
});

test('ambiguous response loss reads back an already committed move without retrying it', async () => {
  const h = harness(); await h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 });
  h.remote({ type: 'play', index: 40 }); h.requests[0].gate.reject(new TypeError('connection lost'));
  assert.equal(await placed, false); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.sync.state().game.moves.length, 1);
  assert.equal(h.sync.state().online, true); assert.equal(h.sync.state().revision, 1);
});

test('422 or failed save restores confirmed board and never caches speculative stones', async () => {
  const h = harness(); await h.sync.refresh();
  const placed = h.sync.submit({ type: 'play', index: 40 });
  h.requests[0].gate.resolve({ ok: false, status: 422, data: { error: '非法落子' } });
  assert.equal(await placed, false); await tick();
  assert.equal(h.sync.state().game.board[40], 0);
  assert.ok(h.saved.every(data => data.game.board[40] === 0));
});

test('stale confirmation and illegal moves fail immediately without a request', async () => {
  const h = harness(play(createGame({ size: 9 }), 40)); await h.sync.refresh();
  assert.equal(await h.sync.submit({ type: 'play', index: 40 }), false);
  assert.equal(await h.sync.submit({ type: 'new', size: 9, mode: 'local' }, -1), false);
  assert.equal(h.requests.length, 0);
});

test('capture and resumed scoring history reconstruct correctly for immediate undo', () => {
  let state = createGame({ size: 9 });
  state = play(play(play(state, 1), 0), 9);
  state = pass(pass(state)); state = applyAction(state, { type: 'resume' }); state = play(state, 40);
  const hydrated = restoreGame(publicState(state));
  assert.deepEqual(hydrated.history, state.history);
  assert.deepEqual(applyAction(hydrated, { type: 'undo' }).board, applyAction(state, { type: 'undo' }).board);
});

test('restored ko history rejects illegal recapture before contacting the cloud', async () => {
  let state = createGame({ size: 9 });
  // Build the position by actual alternating moves, including harmless white moves.
  for (const index of [1, 10, 9, 2, 19, 12, 80, 20]) state = play(state, index);
  state = play(state, 11);
  const h = harness(state); await h.sync.refresh();
  assert.equal(await h.sync.submit({ type: 'play', index: 10 }), false);
  assert.equal(h.requests.length, 0); assert.match(h.errors.at(-1), /打劫/);
});
