import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, play, pass, undo, score, applyAction, tryMove, chooseAiMove } from '../src/engine.js';

test('alternate turns; occupied and out-of-range moves leave state unchanged', () => {
  const initial = createGame({ size: 9 });
  const next = play(initial, 40);
  assert.equal(next.turn, 2); assert.equal(initial.board[40], 0);
  assert.throws(() => play(next, 40), /已经有棋子/);
  for (const index of [-1, 81, 2.5, '4']) assert.ok(tryMove(next, index).error);
});
test('capture at corner and restore every field on undo', () => {
  let state = createGame({ size: 9 });
  state = play(state, 1); state = play(state, 0);
  const before = state; state = play(state, 9);
  assert.equal(state.board[0], 0); assert.equal(state.captures[1], 1);
  assert.deepEqual(undo(state), before);
});
test('one move captures several opposing groups', () => {
  const state = createGame({ size: 9 });
  [1, 9, 19, 3, 13, 21].forEach(p => { state.board[p] = 1; });
  [10, 12].forEach(p => { state.board[p] = 2; });
  const next = play(state, 11);
  assert.equal(next.captures[1], 2);
});
test('suicide is prohibited; filling the last liberty to capture is legal', () => {
  const state = createGame({ size: 9 }); state.board[1] = 2; state.board[9] = 2;
  assert.throws(() => play(state, 0), /禁入点/);
  [2, 10, 18].forEach(p => { state.board[p] = 1; });
  assert.equal(play(state, 0).captures[1], 2);
});
test('immediate ko recapture is illegal and persisted history still prevents it', () => {
  let state = createGame({ size: 9 });
  [[0,1],[1,0],[2,1]].forEach(([r,c]) => { state.board[r*9+c] = 1; });
  [[1,1],[0,2],[1,3],[2,2]].forEach(([r,c]) => { state.board[r*9+c] = 2; });
  state = play(state, 11);
  assert.equal(state.captures[1], 1);
  assert.throws(() => play(JSON.parse(JSON.stringify(state)), 10), /打劫/);
});
test('two passes lead to scoring; resume resets the pass counter', () => {
  const state = pass(pass(createGame())); assert.equal(state.phase, 'scoring');
  const resumed = applyAction(state, { type: 'resume' });
  assert.equal(resumed.phase, 'playing'); assert.equal(resumed.passes, 0);
  assert.equal(play(pass(createGame()), 4).passes, 0);
});
test('area scoring ignores prisoners and neutral regions; komi is applied once', () => {
  const state = createGame({ size: 9 });
  assert.equal(score(state).black, 0); assert.equal(score(state).white, 7.5);
  state.board[0] = 1; state.board[80] = 2; state.captures[1] = 20;
  assert.equal(score(state).black, 1); assert.equal(score(state).white, 8.5);
  state.board[1] = 1; state.board[9] = 1; state.board[0] = 0;
  assert.equal(score(state).black, 3);
});
test('dead group selection toggles whole group and survives serialization', () => {
  let state = createGame({ size: 9 }); state.board[0] = state.board[1] = 2; state.phase = 'scoring';
  state = applyAction(state, { type: 'dead', index: 0 });
  assert.deepEqual([...state.dead].sort(), [0, 1]);
  state = JSON.parse(JSON.stringify(state));
  state = applyAction(state, { type: 'dead', index: 1 }); assert.deepEqual(state.dead, []);
  assert.throws(() => applyAction(state, { type: 'dead', index: '0' }));
});
test('AI plays one legal white response and undo returns to human turn', () => {
  const initial = createGame({ size: 9, mode: 'ai' });
  const next = applyAction(initial, { type: 'play', index: 40 }, () => 0.5);
  assert.equal(next.moves.length, 2); assert.equal(next.turn, 1);
  assert.deepEqual(applyAction(next, { type: 'undo' }), initial);
  const ended = applyAction(next, { type: 'pass' }); assert.equal(ended.phase, 'scoring');
});
test('AI undo after white pass and black pass never gets stuck on white', () => {
  const initial = createGame({ mode: 'ai', size: 9 });
  const state = pass(pass(play(initial, 40)));
  const next = applyAction(state, { type: 'undo' });
  assert.equal(next.turn, 1); assert.equal(next.moves.length, 2);
});
test('bounded history cannot grow by pass/resume cycles', () => {
  let state = createGame({ size: 9 });
  state.moves = Array(1999).fill({ type: 'pass', color: 1 });
  state = pass(pass(state)); assert.equal(state.phase, 'scoring');
  assert.throws(() => applyAction(state, { type: 'resume' }), /上限/);
  assert.equal(applyAction(state, { type: 'finish' }).phase, 'finished');
  state.phase = 'playing'; state.moves.push({ type: 'pass', color: 2 });
  assert.throws(() => pass(state), /上限/);
  assert.equal(chooseAiMove(state), null);
});
test('new game validates settings and resignation records the winner', () => {
  assert.throws(() => createGame({ size: 7 }));
  const state = applyAction(createGame(), { type: 'resign' });
  assert.equal(state.result.winner, 2); assert.equal(state.phase, 'finished');
  assert.throws(() => play(state, 4));
});
