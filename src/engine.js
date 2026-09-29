export const BLACK = 1;
export const WHITE = 2;
export const other = color => 3 - color;
export const colorName = color => color === BLACK ? '黑棋' : '白棋';

export function createGame({ size = 19, mode = 'local', komi = 7.5 } = {}) {
  if (![9, 13, 19].includes(size) || !['local', 'ai'].includes(mode) || komi !== 7.5) throw new Error('不支持的对局设置');
  return { format: 1, size, mode, komi, board: Array(size * size).fill(0), turn: BLACK,
    captures: { 1: 0, 2: 0 }, moves: [], history: [], passes: 0, phase: 'playing', dead: [], last: null, result: null };
}

export function neighbors(index, size) {
  const row = Math.floor(index / size), col = index % size, result = [];
  if (row > 0) result.push(index - size);
  if (row < size - 1) result.push(index + size);
  if (col > 0) result.push(index - 1);
  if (col < size - 1) result.push(index + 1);
  return result;
}

export function groupAt(board, index, size) {
  if (!board[index]) return { stones: [], liberties: [] };
  const color = board[index], seen = new Set([index]), liberties = new Set(), queue = [index];
  for (let i = 0; i < queue.length; i++) {
    for (const n of neighbors(queue[i], size)) {
      if (board[n] === 0) liberties.add(n);
      else if (board[n] === color && !seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return { stones: queue, liberties: [...liberties] };
}

function snapshot(state) {
  return { board: state.board.join(''), turn: state.turn, captures: { ...state.captures }, passes: state.passes, last: state.last, phase: state.phase };
}

export function tryMove(state, index) {
  if (state.phase !== 'playing') return { error: '当前不在落子阶段' };
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return { error: '请选择棋盘上的交叉点' };
  if (state.board[index]) return { error: '这里已经有棋子了' };
  const board = [...state.board], captured = [], opponent = other(state.turn), checked = new Set();
  board[index] = state.turn;
  for (const n of neighbors(index, state.size)) {
    if (board[n] !== opponent || checked.has(n)) continue;
    const group = groupAt(board, n, state.size);
    group.stones.forEach(p => checked.add(p));
    if (!group.liberties.length) { captured.push(...group.stones); group.stones.forEach(p => { board[p] = 0; }); }
  }
  if (!groupAt(board, index, state.size).liberties.length) return { error: '禁入点：落子后没有气' };
  const key = board.join('');
  if (state.history.some(h => h.turn === opponent && h.board === key)) return { error: '打劫：不能重现此前相同轮次的局面，请先在别处落子' };
  return { board, captured };
}

export function play(state, index) {
  if (state.moves.length >= 2000) throw new Error('已达到本局 2000 手上限，请停一手数子或开始新局');
  const next = tryMove(state, index);
  if (next.error) throw new Error(next.error);
  return { ...state, board: next.board, turn: other(state.turn), passes: 0, last: index,
    captures: { ...state.captures, [state.turn]: state.captures[state.turn] + next.captured.length },
    moves: [...state.moves, { type: 'play', index, color: state.turn, captured: next.captured.length }],
    history: [...state.history, snapshot(state)] };
}

export function pass(state) {
  if (state.phase !== 'playing') throw new Error('当前不能停一手');
  if (state.moves.length >= 2002) throw new Error('已达到记谱上限，请确认结果或开始新局');
  return { ...state, turn: other(state.turn), passes: state.passes + 1, last: null,
    phase: state.passes + 1 >= 2 ? 'scoring' : 'playing',
    moves: [...state.moves, { type: 'pass', color: state.turn }], history: [...state.history, snapshot(state)] };
}

export function undo(state, count = 1) {
  if (!state.history.length) throw new Error('还没有可以撤回的落子');
  const remaining = Math.max(0, state.history.length - count), old = state.history[remaining];
  return { ...state, ...old, board: [...old.board].map(Number), captures: { ...old.captures },
    history: state.history.slice(0, remaining), moves: state.moves.slice(0, remaining), dead: [], result: null };
}

export function score(state) {
  const board = [...state.board];
  state.dead.forEach(index => { board[index] = 0; });
  const total = { 1: 0, 2: state.komi }, territory = Array(board.length).fill(0), seen = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i]) { total[board[i]]++; continue; }
    if (seen.has(i)) continue;
    const region = [i], borders = new Set(); seen.add(i);
    for (let j = 0; j < region.length; j++) for (const n of neighbors(region[j], state.size)) {
      if (board[n]) borders.add(board[n]);
      else if (!seen.has(n)) { seen.add(n); region.push(n); }
    }
    if (borders.size === 1) {
      const owner = [...borders][0]; total[owner] += region.length;
      region.forEach(index => { territory[index] = owner; });
    }
  }
  return { black: total[1], white: total[2], territory, winner: total[1] > total[2] ? BLACK : WHITE,
    margin: Math.abs(total[1] - total[2]), reason: 'score' };
}

export function chooseAiMove(state, random = Math.random) {
  if (state.phase !== 'playing') return null;
  if (state.moves.length >= 2000) return null;
  // Beginner opponent: capture, rescue threatened groups, connect, and prefer open points.
  if (state.passes > 0) return null;
  let best = -Infinity, chosen = null;
  const size = state.size, center = (size - 1) / 2;
  const groups = new Map();
  state.board.forEach((color, index) => {
    if (color && !groups.has(index)) {
      const group = groupAt(state.board, index, size);
      group.stones.forEach(p => groups.set(p, group));
    }
  });
  for (let index = 0; index < state.board.length; index++) {
    if (state.board[index]) continue;
    const adjacent = neighbors(index, size);
    if (adjacent.every(n => state.board[n] === state.turn)) continue;
    const trial = tryMove(state, index);
    if (trial.error) continue;
    const own = groupAt(trial.board, index, size), row = Math.floor(index / size), col = index % size;
    const edge = Math.min(row, col, size - 1 - row, size - 1 - col);
    let value = trial.captured.length * 30 + random() * 2;
    if (own.liberties.length === 1) value -= 35 + own.stones.length * 4;
    const checked = new Set();
    for (const n of adjacent) {
      const group = groups.get(n);
      if (!group || checked.has(group)) continue;
      checked.add(group);
      if (state.board[n] === state.turn && group.liberties.length === 1 && own.liberties.length > 1) value += 22 + group.stones.length * 5;
      if (state.board[n] !== state.turn && trial.board[n]) {
        const after = groupAt(trial.board, n, size);
        if (after.liberties.length === 1) value += 10 + after.stones.length * 2;
      }
    }
    const friends = adjacent.filter(n => state.board[n] === state.turn).length;
    const enemies = adjacent.filter(n => state.board[n] === other(state.turn)).length;
    value += enemies ? 3 : 0;
    value += friends === 1 ? 1 : friends > 2 ? -4 : 0;
    value += Math.min(own.liberties.length, 4) * 0.3;
    value -= edge === 0 ? 4 : edge === 1 ? 1.5 : 0;
    if (state.moves.length < size) {
      value += edge === Math.min(3, Math.floor(size / 3)) ? 3 : 0;
      value -= (Math.abs(row - center) + Math.abs(col - center)) * 0.08;
      if (!friends && !enemies) value += 2;
    }
    if (value > best) { best = value; chosen = index; }
  }
  return chosen;
}

export function applyAction(state, action, random = Math.random) {
  if (!action || typeof action.type !== 'string') throw new Error('无效操作');
  let next;
  switch (action.type) {
    case 'new': return createGame({ size: action.size, mode: action.mode });
    case 'play': next = play(state, action.index); break;
    case 'pass': next = pass(state); break;
    case 'undo': {
      let count = 1;
      if (state.mode === 'ai') {
        while (count < state.history.length && state.history[state.history.length - count].turn !== BLACK) count++;
      }
      return undo(state, count);
    }
    case 'dead': {
      if (state.phase !== 'scoring' || !Number.isInteger(action.index) || action.index < 0 || action.index >= state.board.length || !state.board[action.index]) throw new Error('请在数子阶段点击需要标记的死子');
      const group = groupAt(state.board, action.index, state.size).stones;
      return { ...state, dead: state.dead.includes(action.index) ? state.dead.filter(p => !group.includes(p)) : [...state.dead, ...group] };
    }
    case 'resume':
      if (state.phase !== 'scoring') throw new Error('当前不在数子阶段');
      if (state.moves.length >= 2000) throw new Error('已达到 2000 手上限，请确认结果或开始新局');
      next = { ...state, phase: 'playing', passes: 0, dead: [], result: null }; break;
    case 'finish':
      if (state.phase !== 'scoring') throw new Error('请先连续停两手进入数子');
      return { ...state, phase: 'finished', result: score(state) };
    case 'resign':
      if (state.phase !== 'playing') throw new Error('当前不能认输');
      return { ...state, phase: 'finished', result: { reason: 'resign', winner: other(state.mode === 'ai' ? BLACK : state.turn) } };
    default: throw new Error('不支持的操作');
  }
  if (next.mode === 'ai' && next.phase === 'playing' && next.turn === WHITE) {
    const index = chooseAiMove(next, random);
    next = index === null ? pass(next) : play(next, index);
  }
  return next;
}

export function publicState(state) {
  const { history, ...visible } = state;
  return { ...visible, canUndo: history.length > 0 };
}

export function coordinate(index, size) {
  return `${'ABCDEFGHJKLMNOPQRST'[index % size]}${size - Math.floor(index / size)}`;
}
