import { createGame, play, pass, applyAction } from './engine.js';

export function validPayload(data) {
  return Number.isInteger(data?.revision) && data.revision >= 0 && data.game?.format === 1 &&
    [9, 13, 19].includes(data.game.size) && Array.isArray(data.game.board) &&
    data.game.board.length === data.game.size ** 2 && data.game.board.every(n => [0, 1, 2].includes(n)) &&
    ['playing', 'scoring', 'finished'].includes(data.game.phase) && [1, 2].includes(data.game.turn) &&
    ['local', 'ai'].includes(data.game.mode) && Array.isArray(data.game.moves) &&
    data.game.moves.length <= 2002 && Array.isArray(data.game.dead) && !!data.game.captures;
}

// The API omits history. Rebuild the exact undo/ko snapshots from actual moves,
// including implicit resumes; never run the random AI while replaying a record.
export function restoreGame(visible) {
  let state = createGame(visible);
  for (const move of visible.moves) {
    if (state.phase === 'scoring') state = { ...state, phase: 'playing', passes: 0, dead: [] };
    if (move.color !== state.turn) throw new Error('棋谱轮次不一致');
    if (move.type === 'play') state = play(state, move.index);
    else if (move.type === 'pass') state = pass(state);
    else throw new Error('无效棋谱');
  }
  if (state.board.join('') !== visible.board.join('') || state.turn !== visible.turn ||
      state.captures[1] !== visible.captures[1] || state.captures[2] !== visible.captures[2]) throw new Error('棋谱与局面不一致');
  return { ...visible, history: state.history, canUndo: state.history.length > 0 };
}

export function previewAction(state, action) {
  if (state.mode === 'ai' && state.turn === 2 && ['play', 'pass'].includes(action.type)) throw new Error('电脑正在思考，请稍候');
  const humanOnly = state.mode === 'ai' && ['play', 'pass', 'resume'].includes(action.type);
  const next = applyAction(humanOnly ? { ...state, mode: 'local' } : state, action);
  if (humanOnly) next.mode = 'ai';
  return { ...next, canUndo: next.history.length > 0 };
}

export function createGameSync({ get, post, onChange, onError = () => {}, onSaved = () => {}, cache = () => {} }) {
  let confirmed = null, visible = null, online = false, sending = false, poll = null, epoch = 0, connectionError = '';
  const queue = [];
  const state = () => ({ game: visible, revision: confirmed?.revision ?? -1, updatedAt: confirmed?.updatedAt ?? '',
    online, busy: sending || queue.length > 0, refreshing: !!poll, connectionError });
  const emit = () => onChange(state());
  function remember(data, cached = false) {
    if (!validPayload(data)) throw new Error('云端存档格式不正确');
    if (confirmed && data.revision < confirmed.revision) return false;
    const game = restoreGame(data.game);
    confirmed = { ...data, game };
    if (!cached) { try { cache(data); } catch { /* Cloud remains authoritative. */ } }
    return true;
  }
  function rebuild() {
    visible = confirmed?.game ?? null;
    for (const item of queue) visible = previewAction(visible, item.action);
  }
  function invalidatePoll() {
    epoch++;
    poll?.abort();
    poll = null;
  }
  async function refresh({ manual = false } = {}) {
    if (manual) { connectionError = ''; emit(); }
    if (sending || queue.length || poll) return;
    const controller = new AbortController(), generation = epoch;
    poll = controller; emit();
    try {
      const data = await get(online ? confirmed?.revision : undefined, controller.signal);
      if (generation !== epoch) return;
      if (data.unchanged) {
        if (!confirmed || data.revision !== confirmed.revision) throw new Error('存档版本不一致');
      } else remember(data);
      online = true; connectionError = ''; rebuild();
    } catch (error) {
      if (generation === epoch) {
        online = false;
        connectionError = error.message || '暂时连不上云端棋盘，请稍后重试。';
      }
    } finally {
      if (poll === controller) { poll = null; emit(); }
    }
  }
  async function drain() {
    if (sending) return;
    sending = true;
    let reconcile = false;
    try {
      while (queue.length) {
        const item = queue[0], expected = confirmed.revision;
        const response = await post(expected, item.action);
        if (!response.ok) {
          if (response.status === 409 && validPayload(response.data)) remember(response.data);
          reconcile = true;
          throw new Error(response.data?.error || '操作未能保存');
        }
        if (!validPayload(response.data) || response.data.revision !== expected + 1) throw new Error('未能确认保存结果');
        remember(response.data); online = true; connectionError = '';
        queue.shift(); item.resolve(true);
        // Keep later previews visible, even when this response contains an AI reply.
        rebuild(); emit(); onSaved(item.action, visible);
      }
    } catch (error) {
      // A timed-out POST may already have committed. Read back; never retry it.
      queue.splice(0).forEach(item => item.resolve(false));
      visible = confirmed?.game ?? null;
      online = false;
      connectionError = '保存结果暂未确认，正在重新读取云端棋局。';
      onError(reconcile ? error.message : '保存结果暂未确认，正在重新读取云端棋局，请勿重复落子');
      reconcile = true;
    } finally {
      sending = false; emit();
      if (reconcile) await refresh();
    }
  }
  function submit(action, expectedRevision = confirmed?.revision) {
    if (!online || !visible) { onError('请等待云端连接后再操作'); return Promise.resolve(false); }
    if (expectedRevision !== confirmed.revision) { onError('棋局已更新，请重新确认本次操作'); return Promise.resolve(false); }
    let next;
    try { next = previewAction(visible, action); }
    catch (error) { onError(error.message); return Promise.resolve(false); }
    invalidatePoll();
    const completed = new Promise(resolve => queue.push({ action, resolve }));
    visible = next; emit(); // Paint immediately, before any cloud response.
    void drain();
    return completed;
  }
  return {
    state, submit, refresh,
    restoreCached(data) { try { remember(data, true); rebuild(); emit(); } catch { /* Load the real cloud copy instead. */ } },
    offline() { invalidatePoll(); online = false; connectionError = '设备已离线，请恢复网络连接后重试。'; emit(); },
  };
}
