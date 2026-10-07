import { createGame, applyAction, publicState } from '../src/engine.js';
import { handleChat } from './chat.js';

const ALLOWED_ORIGINS = new Set(['https://doctorabcdef.github.io']);
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});

export async function handleRequest(request, env) {
  const origin = request.headers.get('Origin');
  const local = env.LOCAL_DEV && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '');
  const permitted = !origin || ALLOWED_ORIGINS.has(origin) || local;
  const headers = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  if (origin && permitted) headers['Access-Control-Allow-Origin'] = origin;
  if (!permitted) return json({ error: '不支持的网页来源' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const url = new URL(request.url);
  if (url.pathname === '/health') return json({ ok: true, service: 'yijian-go' }, 200, headers);
  if (!['/api/game', '/api/chat'].includes(url.pathname)) return json({ error: '未找到接口' }, 404, headers);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: '不支持的请求方式' }, 405, headers);
  try {
    if (url.pathname === '/api/chat') return await handleChat(request, env, headers);
    const requestedRevision = url.searchParams.get('revision');
    const knownRevision = request.method === 'GET' && /^\d+$/.test(requestedRevision || '') && Number.isSafeInteger(Number(requestedRevision))
      ? Number(requestedRevision) : -1;
    // Frequent unchanged checks read only revision metadata, not the full history.
    // Existing games never need a write just because another device is polling.
    const read = () => env.DB.prepare('SELECT revision, updated_at, CASE WHEN revision = ? THEN NULL ELSE state END AS state FROM games WHERE id = ?')
      .bind(knownRevision, 'shared').first();
    let row = await read();
    if (!row) {
      await env.DB.prepare('INSERT OR IGNORE INTO games (id, revision, state, updated_at) VALUES (?, ?, ?, ?)')
        .bind('shared', 0, JSON.stringify(createGame()), new Date().toISOString()).run();
      row = await read(); // Another request may have initialized/updated it first.
    }
    if (request.method === 'GET' && knownRevision === row.revision) return json({ unchanged: true, revision: row.revision }, 200, headers);
    const state = JSON.parse(row.state);
    const payload = () => ({ revision: row.revision, updatedAt: row.updated_at, game: publicState(state) });
    if (request.method === 'GET') {
      return json(payload(), 200, headers);
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: '需要 JSON 请求' }, 415, headers);
    if (Number(request.headers.get('Content-Length')) > 4096) return json({ error: '请求过大' }, 413, headers);
    const reader = request.body?.getReader();
    let raw = '', bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) { await reader.cancel(); return json({ error: '请求过大' }, 413, headers); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: '请求格式错误' }, 400, headers); }
    if (!Number.isInteger(body?.revision) || body.revision !== row.revision) return json({ error: '另一台设备已更新棋局，已为你载入最新进度，请重新操作', ...payload() }, 409, headers);
    // Only actions are accepted. The server checks the rules and computes AI moves.
    let next;
    try { next = applyAction(state, body.action); } catch (error) { return json({ error: error.message }, 422, headers); }
    const updatedAt = new Date().toISOString();
    const updated = await env.DB.prepare('UPDATE games SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .bind(JSON.stringify(next), updatedAt, 'shared', row.revision).run();
    if (!updated.meta.changes) return json({ error: '棋局刚刚有了新变化，请刷新后重试' }, 409, headers);
    return json({ revision: row.revision + 1, updatedAt, game: publicState(next) }, 200, headers);
  } catch (error) {
    console.error('Cloud storage unavailable:', error.message);
    return json({ error: url.pathname === '/api/chat'
      ? '聊天记录暂时无法连接，请稍后重试。'
      : '云端暂时无法连接，请稍后重试。已保存的棋局不会被覆盖。' }, 503, headers);
  }
}

export default { fetch: handleRequest };
