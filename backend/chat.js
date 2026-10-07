const PAGE_SIZE = 50;
const identifier = /^[0-9a-f]{32}$/i;
const columns = 'id, client_id, request_id, text, created_at';
const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const message = row => ({
  id: row.id, clientId: row.client_id, requestId: row.request_id, text: row.text, createdAt: row.created_at,
});

export async function handleChat(request, env, headers) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const before = url.searchParams.getAll('before'), after = url.searchParams.getAll('after');
    if (before.length > 1 || after.length > 1 || (before.length && after.length)) {
      return json({ error: '请只提供一个聊天记录游标' }, 400, headers);
    }
    const direction = before.length ? 'before' : after.length ? 'after' : null;
    const raw = before[0] ?? after[0];
    const cursor = direction ? Number(raw) : null;
    if (direction && (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor) || cursor < 0 || (direction === 'before' && cursor === 0))) {
      return json({ error: '聊天记录游标无效' }, 400, headers);
    }
    const query = env.DB.prepare(`SELECT ${columns} FROM chat_messages${direction ? ` WHERE id ${direction === 'after' ? '>' : '<'} ?` : ''} ORDER BY id ${direction === 'after' ? 'ASC' : 'DESC'} LIMIT ${PAGE_SIZE + 1}`);
    const { results } = await (direction ? query.bind(cursor) : query).all();
    const rows = results.slice(0, PAGE_SIZE);
    if (direction !== 'after') rows.reverse();
    return json({
      messages: rows.map(message),
      hasMoreBefore: direction !== 'after' && results.length > PAGE_SIZE,
      hasMoreAfter: direction === 'after' && results.length > PAGE_SIZE,
    }, 200, headers);
  }

  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: '需要 JSON 请求' }, 415, headers);
  if (Number(request.headers.get('Content-Length')) > 4096) return json({ error: '请求过大' }, 413, headers);
  const reader = request.body?.getReader(), decoder = new TextDecoder();
  let raw = '', bytes = 0;
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
  if (typeof body?.clientId !== 'string' || !identifier.test(body.clientId) ||
      typeof body?.requestId !== 'string' || !identifier.test(body.requestId)) {
    return json({ error: '消息标识无效，请刷新页面后重试' }, 400, headers);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 300) return json({ error: '消息需为 1 至 300 个字符' }, 400, headers);

  // A repeated send with the same key returns the original row, including its
  // server timestamp. The unique index also handles concurrent retries.
  const insert = env.DB.prepare('INSERT OR IGNORE INTO chat_messages (client_id, request_id, text, created_at) VALUES (?, ?, ?, ?)')
    .bind(body.clientId, body.requestId, text, new Date().toISOString());
  const lookup = env.DB.prepare(`SELECT ${columns} FROM chat_messages WHERE client_id = ? AND request_id = ?`)
    .bind(body.clientId, body.requestId);
  const [, saved] = await env.DB.batch([insert, lookup]);
  const row = saved.results[0];
  if (!row) throw new Error('Saved chat message was not found');
  if (row.text !== text) return json({ error: '此消息已发送，请勿使用同一标识发送不同内容' }, 409, headers);
  return json({ message: message(row) }, 200, headers);
}
