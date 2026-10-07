import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGame, publicState } from '../src/engine.js';

// All API traffic is isolated, including on GO_TEST_BASE=production. Audio files
// are fetched normally: these checks exercise real AAC decoding and playback.
const base = process.env.GO_TEST_BASE || 'http://127.0.0.1:5187';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const voices = {
  'too-slow': { text: '太慢了太慢了', filename: 'too-slow.m4a', duration: 1.109333 },
  'hurry-up': { text: '搞快点好不', filename: 'hurry-up.m4a', duration: 1.237333 },
};
const hex = number => number.toString(16).padStart(32, '0');
// Legacy responses deliberately omit the newly added fields.
const messages = [
  { id: 1, clientId: hex(1), requestId: hex(101), text: '之前的聊天记录仍然保留。', createdAt: '2026-10-07T08:00:00.000Z' },
  { id: 2, clientId: hex(2), requestId: hex(102), text: '轮到你落子啦。', createdAt: '2026-10-07T08:01:00.000Z' },
];
const posts = [], errors = [], unexpected = [], audioResponses = [];
const fulfill = (route, data) => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });

async function prepare(name, options) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    for (const method of ['any', 'timeout']) Object.defineProperty(AbortSignal, method, { configurable: true, writable: true, value: undefined });
  });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/game' && request.method() === 'GET') {
      return fulfill(route, { revision: 0, game: publicState(createGame({ size: 19 })), updatedAt: '2026-10-07T08:00:00.000Z' });
    }
    if (url.pathname !== '/api/chat' || !['GET', 'POST'].includes(request.method())) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'GET') {
      const direction = url.searchParams.has('before') ? 'before' : url.searchParams.has('after') ? 'after' : null;
      const cursor = Number(url.searchParams.get(direction) || 0);
      const eligible = messages.filter(message => direction === 'before' ? message.id < cursor : direction === 'after' ? message.id > cursor : true);
      return fulfill(route, {
        messages: direction === 'after' ? eligible.slice(0, 50) : eligible.slice(-50),
        hasMoreBefore: direction !== 'after' && eligible.length > 50,
        hasMoreAfter: direction === 'after' && eligible.length > 50,
      });
    }
    const body = request.postDataJSON();
    posts.push({ ...body });
    assert.match(body.clientId, /^[a-f0-9]{32}$/i);
    assert.match(body.requestId, /^[a-f0-9]{32}$/i);
    assert.ok(['text', 'voice'].includes(body.kind));
    assert.equal(typeof body.nickname, 'string');
    assert.ok(body.nickname.length <= 24);
    const voice = body.kind === 'voice' ? voices[body.voiceId] : null;
    if (body.kind === 'voice') {
      assert.ok(voice, 'Only the two allowed voice IDs may be sent');
      assert.equal(body.text, voice.text, 'The voice payload must carry the matching canonical label');
    } else {
      assert.equal(body.voiceId ?? null, null);
      assert.ok(body.text.length > 0 && body.text.length <= 500);
    }
    let message = messages.find(item => item.clientId === body.clientId && item.requestId === body.requestId);
    if (!message) {
      message = { id: messages.at(-1).id + 1, clientId: body.clientId, requestId: body.requestId,
        kind: body.kind, voiceId: voice ? body.voiceId : null, nickname: body.nickname.trim(),
        text: voice ? voice.text : body.text.trim(), createdAt: new Date().toISOString() };
      messages.push(message);
    }
    return fulfill(route, { message });
  });
  context.on('page', page => {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    page.on('response', response => {
      if (new URL(response.url()).pathname.includes('/assets/voices/')) {
        audioResponses.push({ name, url: response.url(), status: response.status(), contentType: response.headers()['content-type'] });
      }
    });
  });
  return context;
}

const row = (page, requestId) => page.locator(`#chat-messages [data-request-id="${requestId}"]`);
const waitSent = (page, requestId) => page.waitForFunction(id => {
  const item = document.querySelector(`#chat-messages [data-request-id="${id}"]`);
  return item?.querySelector('[data-message-status]')?.dataset.messageStatus === 'sent';
}, requestId);
async function sendByClick(page, selector) {
  const start = posts.length;
  await page.locator(selector).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#chat-messages [data-message-status]')].every(node => node.dataset.messageStatus === 'sent'));
  assert.equal(posts.length, start + 1, 'Each send click must create exactly one API request');
  const body = posts[start];
  await waitSent(page, body.requestId);
  return body;
}
async function assertLayout(page) {
  const result = await page.evaluate(() => {
    const panel = document.getElementById('chat-panel'), input = document.getElementById('chat-input');
    const bounds = panel.getBoundingClientRect();
    const clipped = [...panel.querySelectorAll('button, input, textarea, .chat-meta span, .chat-meta time')].filter(element => {
      if (!element.getClientRects().length) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
    }).map(element => element.id || element.textContent.trim());
    return { width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      panel: panel.scrollWidth, panelWidth: panel.clientWidth, inputMax: input.maxLength, nicknameMax: document.getElementById('chat-nickname').maxLength, clipped };
  });
  assert.ok(result.document <= result.width && result.body <= result.width, `Page overflow: ${JSON.stringify(result)}`);
  assert.ok(result.panel <= result.panelWidth + 1, `Chat panel overflow: ${JSON.stringify(result)}`);
  assert.deepEqual(result.clipped, [], 'Chat controls, nicknames and timestamps must stay inside the card');
  assert.equal(result.inputMax, 500);
  assert.equal(result.nicknameMax, 24);
}

async function playAndReplay(page, message) {
  assert.equal(await page.locator('#chat-audio').count(), 1, 'The UI must reuse one audio element');
  await page.locator('#chat-audio').evaluate(audio => {
    window.chatMediaEvents = [];
    for (const event of ['loadedmetadata', 'playing', 'ended', 'error']) {
      audio.addEventListener(event, () => window.chatMediaEvents.push({ event, src: audio.currentSrc, duration: audio.duration, time: audio.currentTime }));
    }
  });
  const expectedFile = voices[message.voiceId].filename;
  const control = page.locator(`[data-chat-play="${message.requestId}"][data-voice-id="${message.voiceId}"]`);
  let duration;
  for (let replay = 0; replay < 2; replay++) {
    const before = await page.evaluate(() => window.chatMediaEvents.filter(event => event.event === 'ended').length);
    await control.click();
    await page.waitForFunction(filename => {
      const audio = document.getElementById('chat-audio');
      return audio.currentSrc.endsWith(`/assets/voices/${filename}`) && Number.isFinite(audio.duration) && audio.duration > 0 && audio.currentTime > 0.02 && !audio.paused;
    }, expectedFile);
    const state = await page.locator('#chat-audio').evaluate(audio => ({ src: audio.currentSrc, duration: audio.duration, error: audio.error?.message || null }));
    duration = state.duration;
    assert.ok(Math.abs(duration - voices[message.voiceId].duration) < 0.08, `Unexpected clip duration or swapped audio file: ${duration}`);
    assert.equal(state.error, null);
    await page.waitForFunction(count => window.chatMediaEvents.filter(event => event.event === 'ended').length > count, before, { timeout: 40000 });
    assert.equal(await page.evaluate(() => window.chatMediaEvents.some(event => event.event === 'error')), false);
  }
  return { voiceId: message.voiceId, duration, actualPlaybackAndReplay: true };
}

async function switchPlayingMessage(page, first, second) {
  await page.locator(`[data-chat-play="${first.requestId}"]`).click();
  await page.waitForFunction(filename => {
    const audio = document.getElementById('chat-audio');
    return audio.currentSrc.endsWith(filename) && !audio.paused && audio.currentTime > 0.02;
  }, voices[first.voiceId].filename);
  await page.locator(`[data-chat-play="${second.requestId}"]`).click();
  await page.waitForFunction(filename => {
    const audio = document.getElementById('chat-audio');
    return audio.currentSrc.endsWith(filename) && !audio.paused && audio.currentTime > 0.02;
  }, voices[second.voiceId].filename);
  assert.equal(await page.locator('audio').count(), 1, 'Switching voice bubbles must reuse one player');
  assert.equal(await page.locator('audio').evaluateAll(elements => elements.filter(audio => !audio.paused).length), 1);
  await page.waitForFunction(() => document.getElementById('chat-audio').paused, null, { timeout: 10000 });
}

try {
  const desktop = await prepare('desktop', { viewport: { width: 1440, height: 1080 } });
  const mobile = await prepare('mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await desktop.newPage(), phone = await mobile.newPage();
  for (const current of [page, phone]) {
    await current.goto(base, { waitUntil: 'domcontentloaded' });
    await waitSent(current, hex(101));
    assert.equal(await row(current, hex(101)).getAttribute('data-message-kind'), 'text', 'Old chat records remain ordinary text');
    assert.ok((await row(current, hex(101)).textContent()).includes('之前的聊天记录仍然保留。'));
    assert.deepEqual(await current.evaluate(() => [typeof AbortSignal.any, typeof AbortSignal.timeout]), ['undefined', 'undefined']);
    await assertLayout(current);
    await current.locator('#chat-audio').evaluate(audio => {
      window.chatAutomaticPlaybackStarts = 0;
      audio.addEventListener('playing', () => { window.chatAutomaticPlaybackStarts++; });
    });
  }
  await page.locator('#chat-nickname').fill('桌边棋友');
  await phone.locator('#chat-nickname').fill('手机棋友');
  const draft = '正在思考下一步，这段草稿要留着。';
  await page.locator('#chat-input').fill(draft);
  const firstVoice = await sendByClick(page, '[data-chat-voice="too-slow"]');
  assert.deepEqual({ kind: firstVoice.kind, voiceId: firstVoice.voiceId, text: firstVoice.text, nickname: firstVoice.nickname },
    { kind: 'voice', voiceId: 'too-slow', text: '太慢了太慢了', nickname: '桌边棋友' });
  assert.equal(await page.locator('#chat-input').inputValue(), draft);
  await waitSent(phone, firstVoice.requestId);
  assert.ok((await row(phone, firstVoice.requestId).locator('.chat-meta').textContent()).includes('桌边棋友'));
  await page.locator('#chat-nickname').fill('改名后的棋友');
  const secondVoice = await sendByClick(page, '[data-chat-voice="hurry-up"]');
  assert.deepEqual({ kind: secondVoice.kind, voiceId: secondVoice.voiceId, text: secondVoice.text, nickname: secondVoice.nickname },
    { kind: 'voice', voiceId: 'hurry-up', text: '搞快点好不', nickname: '改名后的棋友' });
  assert.equal(await page.locator('#chat-input').inputValue(), draft);
  await waitSent(phone, secondVoice.requestId);
  for (const current of [page, phone]) {
    assert.ok((await row(current, firstVoice.requestId).locator('.chat-meta').textContent()).includes('桌边棋友'), 'Nickname edits must not rewrite old messages');
    assert.ok((await row(current, secondVoice.requestId).locator('.chat-meta').textContent()).includes('改名后的棋友'));
    assert.equal(await row(current, firstVoice.requestId).getAttribute('data-message-kind'), 'voice');
  }
  for (const text of ['太慢了', '搞快点好不']) {
    const sent = await sendByClick(page, `[data-chat-send="${text}"]`);
    assert.equal(sent.kind, 'text', 'Original quick phrases must remain text messages');
    assert.equal(sent.voiceId ?? null, null);
    assert.equal(sent.text, text);
    assert.equal(await page.locator('#chat-input').inputValue(), draft);
    await waitSent(phone, sent.requestId);
  }
  const longText = '棋'.repeat(500);
  await phone.locator('#chat-input').fill(longText);
  assert.ok((await phone.locator('#chat-count').textContent()).includes('500'));
  const longMessage = await sendByClick(phone, '#chat-send');
  assert.equal(longMessage.text, longText);
  assert.equal(longMessage.nickname, '手机棋友');
  assert.notEqual(longMessage.clientId, firstVoice.clientId);
  await waitSent(page, longMessage.requestId);
  for (const current of [page, phone]) {
    assert.equal(await current.evaluate(() => window.chatAutomaticPlaybackStarts), 0, 'Sending or receiving a voice message must not autoplay');
    assert.equal(await current.locator('#chat-audio').evaluate(audio => audio.paused), true);
    await assertLayout(current);
    await current.reload({ waitUntil: 'domcontentloaded' });
    for (const message of [firstVoice, secondVoice, longMessage]) await waitSent(current, message.requestId);
    assert.equal(await row(current, longMessage.requestId).locator('.chat-text').textContent(), longText);
    assert.ok((await row(current, firstVoice.requestId).locator('.chat-meta').textContent()).includes('桌边棋友'));
  }
  assert.equal(await page.locator('#chat-nickname').inputValue(), '改名后的棋友', 'Desktop nickname persists locally');
  assert.equal(await phone.locator('#chat-nickname').inputValue(), '手机棋友', 'Another device retains its own nickname');

  const playback = [];
  for (const message of [firstVoice, secondVoice]) {
    const result = await Promise.all([playAndReplay(page, message), playAndReplay(phone, message)]);
    playback.push({ desktop: result[0], mobile: result[1] });
  }
  await switchPlayingMessage(page, firstVoice, secondVoice);
  for (const name of ['desktop', 'mobile']) for (const voice of Object.values(voices)) {
    assert.ok(audioResponses.some(response => response.name === name && response.url.endsWith(`/assets/voices/${voice.filename}`) && [200, 206].includes(response.status)), `Real audio must load: ${name}/${voice.filename}`);
  }
  for (const width of [320, 540, 768]) {
    await phone.setViewportSize({ width, height: 844 });
    await assertLayout(phone);
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  // Leave a compact, typical conversation in view for visual review, while the
  // long-message persistence and wrapping assertions above retain their coverage.
  for (const current of [page, phone]) {
    await current.locator('#chat-messages').evaluate((log, requestId) => {
      const first = log.querySelector(`[data-request-id="${requestId}"]`);
      log.scrollTop += first.getBoundingClientRect().top - log.getBoundingClientRect().top;
    }, firstVoice.requestId);
    await assertLayout(current);
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/chat-voice-desktop.png', fullPage: true });
  await phone.screenshot({ path: '.artifacts/chat-voice-mobile.png', fullPage: true });
  await page.locator('#chat-panel').screenshot({ path: '.artifacts/chat-voice-card-desktop.png' });
  await phone.locator('#chat-panel').screenshot({ path: '.artifacts/chat-voice-card-mobile.png' });
  console.log(JSON.stringify({ result: 'Voice chat browser checks passed', base, mockedApiOnly: true, actualAudio: true,
    sentMessages: posts.length, playback, checked: ['legacy history', 'voice mapping', 'nickname snapshots/local persistence', 'text quick phrases', '500-character cross-device history', 'draft retention', 'no voice autoplay', 'real audio playback/replay', 'single-player switching', '320/390/540/768px layout', 'missing AbortSignal statics', 'page errors'],
    screenshots: ['chat-voice-desktop.png', 'chat-voice-mobile.png', 'chat-voice-card-desktop.png', 'chat-voice-card-mobile.png'] }));
} finally { await browser.close(); }
