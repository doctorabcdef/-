// Older iOS browsers lack AbortSignal.any/timeout. Compose cancellation using
// the basic AbortController API and keep the deadline through body decoding.
export async function requestJson(url, { signal, timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  let timedOut = false, response;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new Error('连接云端超时，请切换网络后重试。');
    if (response && !response.ok) throw new Error(`云端服务暂时不可用（${response.status}），请稍后重试。`);
    if (error instanceof SyntaxError) throw new Error('云端响应无法识别，请稍后重试。');
    throw new Error('无法连接云端，请切换网络或用系统浏览器打开后重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
