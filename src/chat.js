import { requestJson } from './http.js';
import { createAutoRefresh } from './poll.js';
import { CHAT_VOICES } from './chat-voices.js';

const CLIENT_KEY = 'yijian:chat-client:v1';
const NICKNAME_KEY = 'yijian:chat-nickname:v1';
// 40 ms of silent PCM audio. Play on the same element in a real user gesture.
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
const idPattern = /^[a-f0-9]{32}$/i;
const voiceClip = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(CHAT_VOICES, id) ? CHAT_VOICES[id] : null;
const normalizeMessage = message => ({ ...message, kind: message.kind ?? 'text', voiceId: message.voiceId ?? null, nickname: message.nickname ?? '' });
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function deviceId() {
  let saved;
  try { saved = localStorage.getItem(CLIENT_KEY); } catch { /* A private browser can still chat during this visit. */ }
  if (idPattern.test(saved || '')) return saved;
  const id = randomId();
  try { localStorage.setItem(CLIENT_KEY, id); } catch { /* Keep the identity in memory for this visit. */ }
  return id;
}
function validMessage(message) {
  return Number.isSafeInteger(message?.id) && message.id > 0 && idPattern.test(message.clientId) &&
    idPattern.test(message.requestId) && typeof message.text === 'string' && message.text.length > 0 &&
    message.text.length <= 500 && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)) &&
    (message.nickname === undefined || typeof message.nickname === 'string' && message.nickname.length <= 24) &&
    ((message.kind ?? 'text') === 'text' && (message.voiceId === undefined || message.voiceId === null) ||
      message.kind === 'voice' && !!voiceClip(message.voiceId) && message.text === voiceClip(message.voiceId).label);
}

export function mountChat({ api }) {
  const panel = document.getElementById('chat-panel');
  if (!panel) return { refresh: async () => {}, destroy() {} };
  try { return createChat(panel, api); }
  catch {
    panel.querySelector('#chat-status').textContent = '聊天暂不可用';
    panel.querySelector('#chat-status').dataset.state = 'error';
    panel.querySelector('#chat-error').textContent = '聊天未能启动，请刷新页面重试。';
    panel.querySelector('#chat-error').classList.remove('hidden');
    return { refresh: async () => {}, destroy() {} };
  }
}

function createChat(panel, api) {
  const $ = id => panel.querySelector(`#${id}`);
  const log = $('chat-messages'), input = $('chat-input'), nickname = $('chat-nickname'), audio = $('chat-audio'), clientId = deviceId();
  try { nickname.value = (localStorage.getItem(NICKNAME_KEY) || '').slice(0, 24); } catch { /* Nicknames still work for this visit. */ }
  const messages = new Map(), pending = new Map(), outbox = [], listeners = [];
  // This page's sends only: another tab may share our clientId and must still be heard.
  const sentHere = new Set(), incomingVoices = [];
  let soundReady = false, soundBlocked = false, playbackRemote = false;
  let online = false, initialized = false, connectionError = '', destroyed = false, suspended = false;
  let reading = null, sending = false, loadingOlder = false, wantsOlder = false;
  let oldest = null, cursor = 0, hasOlder = false, unread = 0, sequence = 0, composing = false;
  let hasSent = false, playbackError = '', playbackKey = null, playbackVoiceId = null, playbackState = 'idle', playbackVersion = 0;
  const connected = () => navigator.onLine !== false;
  const chatActive = () => !suspended;
  const available = () => !destroyed && connected() && chatActive();
  const bind = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 36;
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function updateControls() {
    $('chat-send').disabled = composing || !input.value.trim() || input.value.length > 500;
    setText($('chat-count'), `${input.value.length} / 500`);
    $('chat-older').classList.toggle('hidden', !hasOlder);
    $('chat-older').disabled = loadingOlder || wantsOlder;
    setText($('chat-older'), loadingOlder || wantsOlder ? '正在加载…' : '加载更早消息');
    panel.querySelectorAll('[data-chat-send]').forEach(button => {
      button.disabled = [...pending.values()].some(message => message.status === 'sending' && message.kind === 'text' && message.text === button.dataset.chatSend);
    });
    // Voice shortcuts stay available while earlier messages save in the outbox.
    const hasSending = [...pending.values()].some(message => message.status === 'sending');
    setText($('chat-status'), hasSending ? '正在发送…' : online ? hasSent ? '消息已发送' : '已连接' : connectionError ? '连接中断' : '连接中');
    $('chat-status').dataset.state = online ? 'online' : connectionError ? 'error' : 'loading';
    setText($('chat-error'), playbackError || connectionError);
    $('chat-error').classList.toggle('hidden', !playbackError && !connectionError);
    $('chat-new').classList.toggle('hidden', !unread);
    setText($('chat-new'), unread ? `${unread} 条新消息 ↓` : '有新消息 ↓');
    setText($('chat-sound-hint'), soundBlocked ? '浏览器暂未允许出声，轻点页面任意位置即可播放。' : '');
    $('chat-sound-hint').classList.toggle('hidden', !soundBlocked);
  }
  function updateVoiceButtons() {
    log.querySelectorAll('[data-chat-play]').forEach(button => {
      const clip = voiceClip(button.dataset.voiceId), active = button.closest('.chat-message').dataset.chatKey === playbackKey && playbackState !== 'idle';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', `${active ? '暂停' : '播放'}语音：${clip.label}`);
      setText(button.querySelector('.chat-play-icon'), active ? 'Ⅱ' : '▶');
      setText(button.querySelector('.chat-voice-detail'), `${Math.ceil(clip.durationSeconds)} 秒 · ${active ? playbackState === 'loading' ? '正在加载' : '正在播放' : '点击重播'}`);
    });
  }
  function stopPlayback() {
    playbackVersion++; playbackKey = null; playbackVoiceId = null; playbackState = 'idle';
    playbackRemote = false;
    audio.pause();
    try { audio.currentTime = 0; } catch { /* No metadata has loaded yet. */ }
    updateVoiceButtons();
  }
  function drainIncoming() {
    if (destroyed || suspended || soundBlocked || playbackState !== 'idle') return;
    const next = incomingVoices.shift();
    if (next) playVoice(next.voiceId, next.key, true);
  }
  function playVoice(voiceId, key, remote = false) {
    const clip = voiceClip(voiceId);
    if (!clip || !key) return;
    if (playbackKey === key && playbackState !== 'idle') { stopPlayback(); drainIncoming(); return; }
    const version = ++playbackVersion;
    audio.pause(); playbackKey = key; playbackVoiceId = voiceId; playbackState = 'loading'; playbackError = '';
    playbackRemote = remote;
    const source = new URL(`../assets/voices/${clip.file}`, import.meta.url).href;
    if (audio.src !== source) audio.src = source;
    else if (audio.error) audio.load();
    try { audio.currentTime = 0; } catch { /* play() loads the supplied recording. */ }
    updateVoiceButtons(); updateControls();
    const failed = error => {
      if (version !== playbackVersion || destroyed) return;
      playbackKey = null; playbackVoiceId = null; playbackState = 'idle'; playbackRemote = false;
      if (error?.name === 'NotAllowedError') {
        soundBlocked = true; soundReady = false;
        if (remote) incomingVoices.unshift({ voiceId, key });
      } else playbackError = '语音暂时无法播放，请检查网络后点击重试。';
      updateVoiceButtons(); updateControls();
      drainIncoming();
    };
    try {
      // Calling play synchronously in this click handler preserves the user gesture.
      Promise.resolve(audio.play()).then(() => {
        if (version !== playbackVersion || destroyed) return;
        playbackState = 'playing'; soundReady = true; soundBlocked = false;
        updateVoiceButtons(); updateControls();
      }, failed);
    } catch (error) { failed(error); }
  }
  function enableSound() {
    soundBlocked = false; playbackError = '';
    if (playbackState === 'playing') { soundReady = true; updateControls(); return; }
    soundReady = false;
    // A loading remote message has already left the queue; retry it in this gesture.
    const next = playbackRemote && playbackKey ? { voiceId: playbackVoiceId, key: playbackKey } : incomingVoices.shift();
    stopPlayback();
    if (next) { playVoice(next.voiceId, next.key, true); return; }
    const version = ++playbackVersion;
    playbackState = 'unlocking';
    audio.src = SILENT_AUDIO;
    updateControls();
    const failed = error => {
      if (version !== playbackVersion || destroyed) return;
      playbackState = 'idle'; soundReady = false;
      soundBlocked = error?.name === 'NotAllowedError';
      if (!soundBlocked) playbackError = '语音暂时无法播放，请检查网络后点击重试。';
      updateControls();
    };
    try {
      Promise.resolve(audio.play()).then(() => {
        if (version !== playbackVersion || destroyed) return;
        playbackState = 'idle'; soundReady = true; soundBlocked = false;
        audio.pause(); updateControls(); drainIncoming();
      }, failed);
    } catch (error) { failed(error); }
  }
  function unlockOnInteraction(event) {
    if (!event.isTrusted || destroyed || suspended || soundReady && !soundBlocked ||
        playbackState === 'playing' || playbackState === 'unlocking') return;
    // These controls play directly in their own click handler. Never replace
    // their recording with the silent unlock clip, including on touchend.
    if (event.target.closest?.('[data-chat-voice], [data-chat-play]') || playbackKey && !playbackRemote) return;
    if (event.type === 'keydown' && (event.repeat || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey || ['Control', 'Shift', 'Alt', 'Meta', 'Escape'].includes(event.key))) return;
    enableSound();
  }
  function captureScroll() {
    const top = log.getBoundingClientRect().top;
    const first = [...log.querySelectorAll('.chat-message')].find(element => element.getBoundingClientRect().bottom > top);
    return { bottom: atBottom(), key: first?.dataset.chatKey, offset: first ? first.getBoundingClientRect().top - top : 0, top: log.scrollTop };
  }
  function render({ additions = 0, older = false, firstLoad = false } = {}) {
    const anchor = captureScroll(), fragment = document.createDocumentFragment();
    const all = [...messages.values()].sort((a, b) => a.id - b.id).concat([...pending.values()].sort((a, b) => a.sequence - b.sequence));
    for (const message of all) {
      const own = message.clientId === clientId, row = document.createElement('div');
      row.className = `chat-message${own ? ' own' : ''}`;
      row.dataset.chatKey = `${message.clientId}:${message.requestId}`;
      row.dataset.requestId = message.requestId;
      row.dataset.messageKind = message.kind;
      if (message.id) row.dataset.messageId = message.id;
      const meta = document.createElement('div'); meta.className = 'chat-meta';
      const sender = document.createElement('span'), name = message.nickname || `棋友 ${message.clientId.slice(-4)}`;
      sender.textContent = own ? `我 · ${name}` : name;
      const time = document.createElement('time'); time.dateTime = message.createdAt;
      time.textContent = new Date(message.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      meta.append(sender, time);
      row.append(meta);
      if (message.kind === 'voice') {
        const play = document.createElement('button'); play.type = 'button'; play.className = 'chat-voice-message';
        play.dataset.chatPlay = message.requestId; play.dataset.voiceId = message.voiceId;
        const icon = document.createElement('span'); icon.className = 'chat-play-icon'; icon.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span'); copy.className = 'chat-voice-copy';
        const text = document.createElement('span'); text.className = 'chat-text'; text.textContent = message.text;
        const detail = document.createElement('span'); detail.className = 'chat-voice-detail';
        copy.append(text, detail); play.append(icon, copy); row.append(play);
      } else {
        const text = document.createElement('p'); text.className = 'chat-text'; text.textContent = message.text;
        row.append(text);
      }
      const delivery = document.createElement('span'); delivery.className = 'chat-delivery';
      delivery.dataset.messageStatus = message.status || 'sent';
      if (own) {
        delivery.textContent = message.status === 'sending' ? '发送中…' : message.status === 'failed' ? '发送失败 · 内容已保留' : '已发送';
        if (message.status === 'failed') {
          delivery.title = message.error || '请重试';
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'chat-retry';
          retry.dataset.chatRetry = message.requestId; retry.textContent = '重试';
          delivery.append(retry);
        }
      }
      row.append(delivery);
      fragment.append(row);
    }
    if (!all.length) {
      const empty = document.createElement('p'); empty.className = 'chat-empty';
      empty.textContent = initialized ? '还没有消息，和棋友打个招呼吧。' : '正在加载聊天记录…';
      fragment.append(empty);
    }
    log.replaceChildren(fragment);
    if (firstLoad || anchor.bottom && !older) {
      log.scrollTop = log.scrollHeight; unread = 0;
    } else {
      const match = [...log.querySelectorAll('.chat-message')].find(element => element.dataset.chatKey === anchor.key);
      log.scrollTop = anchor.top;
      if (match) log.scrollTop += match.getBoundingClientRect().top - log.getBoundingClientRect().top - anchor.offset;
      if (!older) unread += additions;
    }
    updateVoiceButtons(); updateControls();
  }
  function merge(incoming, live = false) {
    let additions = 0, changed = false;
    for (const raw of incoming) {
      const message = normalizeMessage(raw);
      if (!messages.has(message.id)) {
        messages.set(message.id, message); additions++; changed = true;
        const key = `${message.clientId}:${message.requestId}`;
        if (live && message.kind === 'voice' && !sentHere.has(key)) {
          incomingVoices.push({ voiceId: message.voiceId, key });
        }
      }
      if (message.clientId === clientId && pending.delete(message.requestId)) { hasSent = true; changed = true; additions = Math.max(0, additions - 1); }
    }
    return { additions, changed };
  }
  async function refresh() {
    if (destroyed || reading || !connected()) return;
    const before = initialized && wantsOlder ? oldest : null;
    const initial = !initialized, after = initial || before !== null ? null : cursor;
    wantsOlder = false; loadingOlder = before !== null;
    const controller = new AbortController(); reading = controller;
    updateControls();
    let moreAfter = false;
    try {
      const query = before !== null ? `before=${before}` : after !== null ? `after=${after}` : '';
      const response = await requestJson(`${api}${query ? `${api.includes('?') ? '&' : '?'}${query}` : ''}`, { cache: 'no-store', signal: controller.signal });
      const data = response.data;
      if (!response.ok) throw new Error(data?.error || '聊天记录暂时无法加载，请稍后重试。');
      if (!Array.isArray(data?.messages) || typeof data.hasMoreBefore !== 'boolean' || typeof data.hasMoreAfter !== 'boolean' ||
          !data.messages.every((message, index) => validMessage(message) && (!index || data.messages[index - 1].id < message.id) &&
            (before === null || message.id < before) && (after === null || message.id > after))) throw new Error('聊天记录格式不正确，请稍后重试。');
      if (data.hasMoreAfter && !data.messages.length) throw new Error('聊天记录分页异常，请稍后重试。');
      const merged = merge(data.messages, !initial && before === null);
      if (initial || before !== null) {
        hasOlder = data.hasMoreBefore;
        if (data.messages.length) oldest = data.messages[0].id;
      } else if (oldest === null && data.messages.length) oldest = data.messages[0].id;
      // Only GET advances this cursor: a POST can arrive ahead of unseen remote messages.
      if (before === null && data.messages.length) cursor = data.messages[data.messages.length - 1].id;
      initialized = true; online = true; connectionError = '';
      moreAfter = before === null && data.hasMoreAfter;
      if (merged.changed || initial) render({ additions: merged.additions, older: before !== null, firstLoad: initial });
      drainIncoming();
    } catch (error) {
      if (!controller.signal.aborted && !destroyed) { online = false; connectionError = error.message || '聊天连接失败，请稍后重试。'; }
    } finally {
      if (reading === controller) reading = null;
      loadingOlder = false;
      if (!destroyed) {
        updateControls();
        if ((wantsOlder || moreAfter) && available()) Promise.resolve().then(refresh);
      }
    }
  }
  async function flush() {
    if (sending || destroyed) return;
    sending = true;
    try {
      while (outbox.length && !destroyed) {
        const item = pending.get(outbox.shift());
        if (!item) continue;
        try {
          if (!connected()) throw new Error('设备已离线，恢复连接后可重试。');
          const response = await requestJson(api, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, requestId: item.requestId, text: item.text, kind: item.kind, voiceId: item.voiceId, nickname: item.nickname }), timeoutMs: 15000, keepalive: true });
          if (!response.ok) throw new Error(response.data?.error || '消息未能发送，请重试。');
          const raw = response.data?.message;
          if (!validMessage(raw)) throw new Error('发送结果尚未确认，请重试核对。');
          const message = normalizeMessage(raw);
          if (message.clientId !== clientId || message.requestId !== item.requestId || message.text !== item.text ||
              message.kind !== item.kind || message.voiceId !== item.voiceId || message.nickname !== item.nickname) throw new Error('发送结果尚未确认，请重试核对。');
          merge([message]); online = true; connectionError = ''; hasSent = true;
        } catch (error) {
          // A GET may already have confirmed a POST whose response was lost.
          if (pending.has(item.requestId)) {
            item.status = 'failed'; item.error = error.message;
            online = false; connectionError = '有消息未发出，内容已保留，可点击消息下方重试。';
          }
        }
        if (!destroyed) render();
      }
    } finally { sending = false; if (!destroyed) updateControls(); }
  }
  function send(text, clearInput = false, voiceId = null) {
    const value = text.trim();
    if (!value || value.length > 500 || destroyed || voiceId !== null && !voiceClip(voiceId)) return;
    const requestId = randomId();
    if (voiceId) sentHere.add(`${clientId}:${requestId}`);
    pending.set(requestId, { clientId, requestId, text: value, kind: voiceId ? 'voice' : 'text', voiceId,
      nickname: nickname.value.trim().slice(0, 24), createdAt: new Date().toISOString(), status: 'sending', sequence: sequence++ });
    if (clearInput) input.value = '';
    outbox.push(requestId); render({ additions: 1 }); void flush();
    return requestId;
  }
  const auto = createAutoRefresh({ refresh, getState: () => ({ online, refreshing: !!reading, busy: false }),
    isVisible: chatActive, isConnected: connected });
  bind(document, 'click', unlockOnInteraction);
  bind(document, 'touchend', unlockOnInteraction);
  bind(document, 'keydown', unlockOnInteraction);
  bind($('chat-form'), 'submit', event => { event.preventDefault(); if (!composing) send(input.value, true); });
  bind(input, 'input', updateControls);
  const saveNickname = () => { try { localStorage.setItem(NICKNAME_KEY, nickname.value.slice(0, 24)); } catch { /* The current nickname remains usable. */ } };
  bind(nickname, 'input', saveNickname); bind(nickname, 'change', saveNickname);
  bind(nickname, 'keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  bind(input, 'compositionstart', () => { composing = true; updateControls(); });
  bind(input, 'compositionend', () => { composing = false; updateControls(); });
  bind(input, 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) {
      event.preventDefault(); send(input.value, true);
    }
  });
  bind(panel, 'click', event => {
    const play = event.target.closest('[data-chat-play]');
    if (play) { playVoice(play.dataset.voiceId, play.closest('.chat-message')?.dataset.chatKey); return; }
    const voice = event.target.closest('[data-chat-voice]');
    if (voice && !voice.disabled) {
      const clip = voiceClip(voice.dataset.chatVoice);
      if (clip) {
        const requestId = send(clip.label, false, voice.dataset.chatVoice);
        // Play in this same click gesture, without waiting for the cloud save.
        if (requestId) playVoice(voice.dataset.chatVoice, `${clientId}:${requestId}`);
      }
      return;
    }
    const quick = event.target.closest('[data-chat-send]');
    if (quick && !quick.disabled) { send(quick.dataset.chatSend); return; }
    const retry = event.target.closest('[data-chat-retry]');
    if (!retry) return;
    const message = pending.get(retry.dataset.chatRetry);
    if (!message || message.status !== 'failed') return;
    message.status = 'sending'; message.error = ''; outbox.push(message.requestId);
    render(); void flush();
  });
  bind($('chat-older'), 'click', () => { if (!hasOlder) return; wantsOlder = true; updateControls(); if (!reading) void refresh(); });
  bind($('chat-new'), 'click', () => { log.scrollTop = log.scrollHeight; unread = 0; updateControls(); });
  bind(log, 'scroll', () => { if (unread && atBottom()) { unread = 0; updateControls(); } });
  bind(document, 'visibilitychange', () => { if (chatActive()) { auto.wake(); drainIncoming(); } else auto.stop(); });
  bind(window, 'focus', () => auto.wake());
  bind(window, 'online', () => auto.wake());
  bind(window, 'pagehide', () => { suspended = true; auto.stop(); stopPlayback(); });
  bind(window, 'pageshow', event => { if (event.persisted) { suspended = false; auto.wake(); drainIncoming(); } });
  bind(window, 'offline', () => { auto.stop(); reading?.abort(); online = false; connectionError = '设备已离线，已显示的消息仍可查看。'; updateControls(); });
  bind(audio, 'ended', () => {
    if (!audio.ended || playbackState === 'unlocking') return;
    playbackVersion++; playbackKey = null; playbackVoiceId = null; playbackState = 'idle'; playbackRemote = false;
    updateVoiceButtons(); drainIncoming();
  });
  bind(audio, 'pause', () => {
    if (audio.paused && !audio.ended && playbackState === 'playing') {
      playbackVersion++; playbackKey = null; playbackVoiceId = null; playbackState = 'idle'; playbackRemote = false;
      soundReady = false; soundBlocked = true;
      updateVoiceButtons(); updateControls();
    }
  });
  bind(audio, 'error', () => {
    if (!audio.error || !playbackKey || destroyed) return;
    playbackVersion++; playbackKey = null; playbackVoiceId = null; playbackState = 'idle'; playbackRemote = false;
    playbackError = '语音暂时无法播放，请检查网络后点击重试。';
    updateVoiceButtons(); updateControls(); drainIncoming();
  });
  updateControls(); void refresh(); auto.start();
  return { refresh, destroy() { destroyed = true; auto.stop(); reading?.abort(); stopPlayback(); listeners.forEach(remove => remove()); } };
}
