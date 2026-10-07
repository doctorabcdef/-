import { colorName, coordinate, score } from './engine.js';
import { API_BASE } from './config.js';
import { createGameSync } from './sync.js';
import { requestJson } from './http.js';
import { createAutoRefresh } from './poll.js';

const $ = id => document.getElementById(id);
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const api = local ? '/api/game' : `${API_BASE}/api/game`;
const cacheKey = 'yijian:shared-game:v1';
let game = null, revision = -1, updatedAt = '', online = false, busy = false, connectionError = '', showNumbers = false;
let focusedIndex = 0, dialogRevision = -1, toastTimer;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4800);
}

function updateSync() {
  const status = $('sync-status');
  status.classList.toggle('error', !online);
  const label = busy ? '正在保存' : online ? '云端已同步' : game ? '离线 · 只读' : connectionError ? '连接失败' : '连接中';
  // Keep fast unchanged checks from repeatedly announcing the same live status.
  if (status.textContent !== label) status.replaceChildren(document.createElement('i'), document.createTextNode(label));
  const detail = busy ? '棋盘已更新，正在保存到云端…' : online
    ? `已保存${updatedAt ? '于 ' + new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}，电脑和手机打开即续局。`
    : game ? '当前显示最后同步的棋局。恢复连接后才能落子。' : connectionError || '正在获取云端存档，请稍候。';
  if ($('save-detail').textContent !== detail) $('save-detail').textContent = detail;
}

const sync = createGameSync({
  async get(knownRevision, signal) {
    const response = await requestJson(`${api}${knownRevision !== undefined ? `?revision=${knownRevision}` : ''}`, {
      cache: 'no-store', signal,
    });
    const { data } = response;
    if (!response.ok) throw new Error(data?.error || `云端服务暂时不可用（${response.status}），请稍后重试。`);
    return data;
  },
  async post(expectedRevision, action) {
    return requestJson(api, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: expectedRevision, action }), timeoutMs: 15000, keepalive: true });
  },
  cache: data => localStorage.setItem(cacheKey, JSON.stringify(data)),
  onError: toast,
  onSaved(action, current) {
    if (action.type === 'new') toast('新对局已开始，所有设备已共享这张棋盘');
    if (action.type === 'undo') toast(current.mode === 'ai' ? '已撤回到你落子之前' : '已撤回上一手');
  },
  onChange(state) {
    const previous = game;
    ({ game, revision, updatedAt, online, busy, connectionError } = state);
    if (game && game !== previous) render();
    else { updateControls(); updateSync(); }
    if (online) $('board-overlay').classList.add('hidden');
    if (!game && !online) {
      $('board-overlay').classList.remove('hidden');
      $('board-overlay').querySelector('p').textContent = connectionError || '正在连接云端，找回棋局…';
      $('board-overlay').querySelector('.spinner').classList.toggle('hidden', !!connectionError);
      $('retry-button').classList.toggle('hidden', !connectionError);
    }
  },
});
const refresh = () => sync.refresh();
const submit = (action, expectedRevision = revision) => sync.submit(action, expectedRevision);

function buildBoard() {
  const board = $('board'), size = game?.size || 19;
  board.replaceChildren();
  board.style.setProperty('--size', size);
  board.setAttribute('aria-label', `${size} 路围棋棋盘，用方向键移动，回车键落子`);
  board.setAttribute('aria-rowcount', size); board.setAttribute('aria-colcount', size);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1000 1000'); svg.classList.add('board-svg'); svg.setAttribute('aria-hidden', 'true');
  const step = 890 / size, first = 55 + step / 2, last = 945 - step / 2;
  let markup = '<g stroke="#79613e" stroke-width="1" opacity=".84">';
  for (let i = 0; i < size; i++) {
    const position = first + step * i;
    markup += `<path d="M${first} ${position}H${last}M${position} ${first}V${last}"/>`;
  }
  markup += `</g><rect x="${first}" y="${first}" width="${last-first}" height="${last-first}" fill="none" stroke="#79613e" stroke-width="1.7"/>`;
  const stars = size === 19 ? [3, 9, 15] : size === 13 ? [3, 6, 9] : [2, 4, 6];
  for (const r of stars) for (const c of stars) {
    if (size !== 19 && (r === stars[1] || c === stars[1]) && r !== c) continue;
    markup += `<circle cx="${first + c * step}" cy="${first + r * step}" r="${size === 19 ? 4.1 : 5}" fill="#695431"/>`;
  }
  markup += '<g fill="#816945" font-family="Arial,sans-serif" font-size="16" text-anchor="middle" dominant-baseline="central">';
  for (let i = 0; i < size; i++) {
    const position = first + step * i, letter = 'ABCDEFGHJKLMNOPQRST'[i];
    markup += `<text x="${position}" y="31">${letter}</text><text x="${position}" y="971">${letter}</text><text x="27" y="${position}">${size-i}</text><text x="973" y="${position}">${size-i}</text>`;
  }
  svg.innerHTML = `${markup}</g>`;
  board.append(svg);
  const grid = document.createElement('div'); grid.className = 'board-grid';
  for (let r = 0; r < size; r++) {
    const row = document.createElement('div'); row.setAttribute('role', 'row'); row.style.display = 'contents';
    for (let c = 0; c < size; c++) {
      const button = document.createElement('button'), index = r * size + c;
      button.type = 'button'; button.className = 'intersection empty'; button.dataset.index = index;
      button.setAttribute('role', 'gridcell'); button.setAttribute('aria-colindex', c + 1); button.setAttribute('aria-rowindex', r + 1);
      button.tabIndex = index === Math.min(focusedIndex, size * size - 1) ? 0 : -1;
      row.append(button);
    }
    grid.append(row);
  }
  board.append(grid); board.dataset.size = size;
}

function renderBoard() {
  const board = $('board');
  if (Number(board.dataset.size) !== game.size) buildBoard();
  board.dataset.turn = game.turn; board.dataset.phase = game.phase;
  const ownership = game.phase === 'scoring' || (game.phase === 'finished' && game.result?.reason === 'score') ? score(game).territory : [];
  const numbers = new Map();
  game.moves.forEach((move, index) => { if (move.type === 'play') numbers.set(move.index, index + 1); });
  board.querySelectorAll('.intersection').forEach((button, index) => {
    const color = game.board[index], label = coordinate(index, game.size);
    button.classList.toggle('empty', !color);
    button.setAttribute('aria-label', `${label}，${color ? colorName(color) : '空点'}${game.dead.includes(index) ? '，已标记死子' : ''}`);
    button.replaceChildren();
    if (color) {
      const stone = document.createElement('span');
      stone.className = `stone ${color === 1 ? 'black' : 'white'}${game.last === index ? ' last' : ''}${showNumbers ? ' numbered' : ''}${game.dead.includes(index) ? ' dead' : ''}`;
      if (showNumbers) stone.textContent = numbers.get(index) || '';
      button.append(stone);
    }
    if (ownership[index]) {
      const dot = document.createElement('span'); dot.className = `territory ${ownership[index] === 2 ? 'white' : ''}`; button.append(dot);
    }
  });
}

function updateControls() {
  const disabled = !online || !game;
  const aiThinking = game?.mode === 'ai' && game.phase === 'playing' && game.turn === 2;
  $('board').setAttribute('aria-busy', !game ? 'true' : 'false');
  $('board').setAttribute('aria-disabled', disabled || aiThinking ? 'true' : 'false');
  $('pass-button').disabled = disabled || aiThinking || game?.phase !== 'playing';
  $('undo-button').disabled = disabled || !game?.canUndo;
  $('resign-button').disabled = disabled || busy || game?.phase !== 'playing';
  ['new-button', 'mode-local', 'mode-ai', 'resume-button', 'finish-button'].forEach(id => { $(id).disabled = disabled || busy; });
  $('new-form').querySelector('[type="submit"]').disabled = disabled || busy;
  $('confirm-yes').disabled = disabled || busy;
}

function render() {
  if (!game) return;
  renderBoard();
  $('size-label').textContent = `${game.size} 路棋盘`;
  $('mode-local').classList.toggle('active', game.mode === 'local');
  $('mode-ai').classList.toggle('active', game.mode === 'ai');
  $('mode-local').setAttribute('aria-pressed', game.mode === 'local');
  $('mode-ai').setAttribute('aria-pressed', game.mode === 'ai');
  $('black-name').textContent = game.mode === 'ai' ? '你' : '黑方';
  $('white-name').textContent = game.mode === 'ai' ? '电脑' : '白方';
  $('black-captures').textContent = game.captures[1]; $('white-captures').textContent = game.captures[2];
  $('black-player').classList.toggle('current', game.phase === 'playing' && game.turn === 1);
  $('white-player').classList.toggle('current', game.phase === 'playing' && game.turn === 2);
  $('turn-stone').className = `stone-icon ${game.turn === 1 ? 'black' : 'white'}`;
  const aiThinking = game.mode === 'ai' && game.phase === 'playing' && game.turn === 2;
  $('turn-title').textContent = game.phase === 'finished' ? `${colorName(game.result.winner)}胜` : game.phase === 'scoring' ? '一起确认终局' : aiThinking ? '电脑思考中' : `轮到${colorName(game.turn)}`;
  $('turn-detail').textContent = game.phase === 'finished' ? game.result.reason === 'resign' ? '对方认输 · 本局结束' : `领先 ${game.result.margin} 目 · 本局结束`
    : game.phase === 'scoring' ? '连续停两手，开始数子' : aiThinking ? '你已落子 · 等待电脑应手' : game.mode === 'ai' ? '你执黑先行 · 电脑入门棋力' : game.passes ? '上一手停着，可以落子或停一手' : '从容落子，好棋不急';
  $('move-count').textContent = `第 ${game.moves.length} 手`;
  $('board-hint').textContent = game.phase === 'scoring' ? '点击棋块标记死子 · 再次点击取消' : game.phase === 'finished' ? '本局已结束 · 可以悔棋或开始新局' : aiThinking ? '电脑思考中 · 可以悔棋' : `点击交叉点落子 · ${colorName(game.turn)}行棋`;
  $('score-panel').classList.toggle('hidden', game.phase !== 'scoring');
  if (game.phase === 'scoring') {
    const result = score(game); $('black-score').textContent = result.black; $('white-score').textContent = result.white;
  }
  if (game.moves.length) {
    $('move-list').replaceChildren();
    game.moves.slice(-40).map((move, index) => ({ ...move, number: Math.max(0, game.moves.length - 40) + index + 1 })).reverse().forEach(move => {
      const item = document.createElement('li');
      const no = document.createElement('span'); no.className = 'move-no'; no.textContent = String(move.number).padStart(2, '0');
      const stone = document.createElement('span'); stone.className = `stone-icon ${move.color === 1 ? 'black' : 'white'} small`; stone.setAttribute('aria-hidden', 'true');
      const description = document.createElement('span'); description.textContent = `${colorName(move.color)}${move.captured ? ` · 提 ${move.captured} 子` : ''}`;
      const place = document.createElement('span'); place.className = 'move-location'; place.textContent = move.type === 'pass' ? '停一手' : coordinate(move.index, game.size);
      item.append(no, stone, description, place); $('move-list').append(item);
    });
    $('record-count').textContent = `${game.moves.length} 手${game.moves.length > 40 ? ' · 最近 40 手' : ''}`;
  } else {
    $('move-list').innerHTML = '<li class="empty-record"><span class="empty-grid" aria-hidden="true">＋</span><p>落下第一子</p><span>从这一手，开始一盘好棋。</span></li>';
    $('record-count').textContent = '本局棋谱';
  }
  $('board-overlay').classList.add('hidden');
  updateControls(); updateSync();
}

$('board').addEventListener('click', event => {
  const button = event.target.closest('[data-index]');
  if (!button || !game || game.phase === 'finished') return;
  const index = Number(button.dataset.index);
  if (game.phase === 'scoring' && !game.board[index]) return;
  if (game.phase === 'playing' && game.board[index]) { toast('这里已经有棋子了'); return; }
  void submit({ type: game.phase === 'scoring' ? 'dead' : 'play', index });
});
$('board').addEventListener('keydown', event => {
  const button = event.target.closest('[data-index]'); if (!button || !game) return;
  const index = Number(button.dataset.index), size = game.size;
  const row = Math.floor(index / size), col = index % size;
  let next = index;
  if (event.key === 'ArrowUp') next = Math.max(0, row - 1) * size + col;
  else if (event.key === 'ArrowDown') next = Math.min(size - 1, row + 1) * size + col;
  else if (event.key === 'ArrowLeft') next = row * size + Math.max(0, col - 1);
  else if (event.key === 'ArrowRight') next = row * size + Math.min(size - 1, col + 1);
  else return;
  event.preventDefault(); button.tabIndex = -1;
  const target = $('board').querySelector(`[data-index="${next}"]`); target.tabIndex = 0; target.focus(); focusedIndex = next;
});
$('board').addEventListener('focusin', event => {
  const index = event.target.dataset.index;
  if (index === undefined) return;
  $('board').querySelectorAll('[tabindex="0"]').forEach(button => { button.tabIndex = -1; });
  event.target.tabIndex = 0; focusedIndex = Number(index);
});
$('show-numbers').addEventListener('change', event => { showNumbers = event.target.checked; if (game) renderBoard(); });
$('retry-button').addEventListener('click', async () => { autoSync.stop(); await sync.refresh({ manual: true }); autoSync.start(); });
$('pass-button').addEventListener('click', () => submit({ type: 'pass' }));
$('undo-button').addEventListener('click', () => submit({ type: 'undo' }));
$('resume-button').addEventListener('click', () => submit({ type: 'resume' }));
$('finish-button').addEventListener('click', () => submit({ type: 'finish' }));
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('.close-button,.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
});
function openNew(mode = game?.mode) {
  if (!game) return;
  dialogRevision = revision; $('new-mode').value = mode;
  $('new-form').querySelector(`[name="size"][value="${game.size}"]`).checked = true;
  $('new-dialog').showModal();
}
$('new-button').addEventListener('click', () => openNew());
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { if (button.dataset.mode !== game?.mode) openNew(button.dataset.mode); }));
$('new-form').addEventListener('submit', async event => {
  event.preventDefault();
  const action = { type: 'new', mode: $('new-mode').value, size: Number(new FormData(event.target).get('size')) };
  $('new-dialog').close(); await submit(action, dialogRevision);
});
$('resign-button').addEventListener('click', () => { dialogRevision = revision; $('confirm-title').textContent = `确认${colorName(game.turn)}认输？`; $('confirm-dialog').showModal(); });
$('confirm-yes').addEventListener('click', () => { $('confirm-dialog').close(); void submit({ type: 'resign' }, dialogRevision); });

// Optional WebMCP entry points use the same cloud actions as the visible controls.
if (document.modelContext?.registerTool) {
  const context = document.modelContext;
  const register = tool => { try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch {} };
  register({ name: 'read_go_game', description: 'Read the current shared Go board and whose turn it is.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: async () => { await refresh(); return { revision, online, game }; } });
  register({ name: 'play_go_stone', description: 'Place a stone on the public shared Go board. This changes the game for every visitor.', inputSchema: { type: 'object', properties: { row: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 } }, required: ['row', 'column'], additionalProperties: false }, execute: async input => {
    if (!game || game.phase !== 'playing' || !Number.isInteger(input?.row) || !Number.isInteger(input?.column) || input.row < 0 || input.column < 0 || input.row >= game.size || input.column >= game.size) throw new Error('无效的交叉点');
    if (!await submit({ type: 'play', index: input.row * game.size + input.column })) throw new Error('落子未保存');
    return { revision, turn: game.turn, moves: game.moves.length };
  } });
}

try { sync.restoreCached(JSON.parse(localStorage.getItem(cacheKey))); } catch { /* Load the cloud copy. */ }
if (!game) buildBoard();
updateControls();
void refresh();
const autoSync = createAutoRefresh({
  refresh, getState: sync.state,
  isVisible: () => !document.hidden, isConnected: () => navigator.onLine !== false,
});
autoSync.start();
document.addEventListener('visibilitychange', () => { if (document.hidden) autoSync.stop(); else autoSync.wake(); });
window.addEventListener('focus', () => autoSync.wake());
window.addEventListener('online', () => autoSync.wake());
window.addEventListener('offline', () => { autoSync.stop(); sync.offline(); });
window.addEventListener('pagehide', () => autoSync.stop());
window.addEventListener('pageshow', event => { if (event.persisted) autoSync.wake(); });
window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
