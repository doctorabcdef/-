import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createGame, publicState } from '../src/engine.js';

// Every /api/* request is intercepted, even when GO_TEST_BASE is the live site.
// All writes stay in this process; production games and chat are never changed.
const base = process.env.GO_TEST_BASE || 'http://127.0.0.1:5187';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const hex = value => value.toString(16).padStart(32, '0');
const messages = Array.from({ length: 65 }, (_, index) => ({
  id: index + 1, clientId: hex(index % 2 + 1), requestId: hex(index + 100),
  text: `历史消息 ${String(index + 1).padStart(2, '0')}：一起下好这盘棋`,
  createdAt: new Date(Date.UTC(2026, 9, 7, 8, index)).toISOString(),
}));
const posts = [], reads = [], errors = [], unexpectedRequests = [], hiddenCommits = new Set();
const delayedText = '这条消息应当立即显示，稍后再保存到云端。';
const retryText = '网络刚才中断了，重试也只能出现一次。';
const literalText = '<img src=x onerror="window.chatInjected=true"><script>window.chatInjected=true</script> 只是文字 & 表情 🙂';
let releaseDelayed, delayedReplies = 0;
const delayedGate = new Promise(resolve => { releaseDelayed = resolve; });
const fulfill = (route, data) => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });
const messageKey = message => `${message.clientId}:${message.requestId}`;

async function prepare(options) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    for (const method of ['any', 'timeout']) {
      Object.defineProperty(AbortSignal, method, { configurable: true, writable: true, value: undefined });
    }
  });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/game') {
      if (request.method() !== 'GET') {
        unexpectedRequests.push(`${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return fulfill(route, { revision: 0, game: publicState(createGame({ size: 19 })), updatedAt: '2026-10-07T08:00:00.000Z' });
    }
    if (url.pathname !== '/api/chat') {
      unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'GET') {
      const before = Number(url.searchParams.get('before') || 0);
      const after = Number(url.searchParams.get('after') || 0);
      const direction = url.searchParams.has('before') ? 'before' : url.searchParams.has('after') ? 'after' : null;
      reads.push({ before, after });
      const visible = messages.filter(message => !hiddenCommits.has(messageKey(message)));
      const eligible = visible.filter(message => direction === 'before' ? message.id < before : direction === 'after' ? message.id > after : true);
      const page = direction === 'after' ? eligible.slice(0, 50) : eligible.slice(-50);
      return fulfill(route, {
        messages: page,
        hasMoreBefore: direction !== 'after' && eligible.length > 50,
        hasMoreAfter: direction === 'after' && eligible.length > 50,
      });
    }
    if (request.method() !== 'POST') {
      unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    const body = request.postDataJSON();
    assert.match(body.clientId, /^[0-9a-f]{32}$/i, 'Each sender needs a valid client ID');
    assert.match(body.requestId, /^[0-9a-f]{32}$/i, 'Each message needs an idempotency key');
    assert.equal(typeof body.text, 'string');
    posts.push(body);
    const key = messageKey(body);
    let message = messages.find(item => messageKey(item) === key);
    if (!message) {
      message = { id: messages.at(-1).id + 1, ...body, createdAt: new Date().toISOString() };
      messages.push(message);
    }
    assert.equal(message.text, body.text, 'A retry must preserve the original text');
    if (body.text === delayedText) {
      // Keep GET snapshots behind the POST response while it is deliberately held.
      hiddenCommits.add(key);
      await delayedGate;
      hiddenCommits.delete(key);
      delayedReplies++;
    }
    if (body.text === retryText && posts.filter(item => messageKey(item) === key).length === 1) {
      // Model a committed write whose response is lost. Temporarily stale reads
      // ensure polling cannot acknowledge it before the manual retry is tested.
      hiddenCommits.add(key);
      return route.abort('failed');
    }
    hiddenCommits.delete(key);
    return fulfill(route, { message });
  });
  context.on('page', page => {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
  });
  return context;
}

const waitForMessage = (page, text, status = 'sent') => page.waitForFunction(({ text, status }) => {
  return [...document.querySelectorAll('#chat-messages [data-request-id]')].some(node =>
    node.querySelector('.chat-text')?.textContent === text &&
    node.querySelector('[data-message-status]')?.dataset.messageStatus === status);
}, { text, status });
const sendTyped = async (page, text) => {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  await waitForMessage(page, text);
};
const assertOnce = async (page, text) => {
  assert.equal(await page.locator('#chat-messages .chat-text').evaluateAll((nodes, value) =>
    nodes.filter(node => node.textContent === value).length, text), 1, `Expected exactly one bubble for: ${text}`);
};
const waitLoaded = page => page.waitForFunction(() => document.querySelectorAll('#chat-messages [data-message-id]').length >= 50);
const assertNoOverflow = async page => {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport, `Horizontal overflow: ${JSON.stringify(dimensions)}`);
};

try {
  const desktop = await prepare({ viewport: { width: 1440, height: 1080 } });
  const mobile = await prepare({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await desktop.newPage(), phone = await mobile.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitLoaded(page);
  assert.equal(await page.locator('#chat-messages [data-message-id]').count(), 50);
  assert.equal(await page.locator('#chat-messages [data-message-id="16"]').count(), 1);
  assert.equal(await page.locator('#chat-messages [data-message-id="65"]').count(), 1);
  await page.locator('#chat-older').click();
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages [data-message-id]').length === 65);
  assert.deepEqual(await page.locator('#chat-messages [data-message-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.messageId))), Array.from({ length: 65 }, (_, index) => index + 1));
  assert.ok(reads.some(read => read.before === 16), 'Older history must be fetched from the API');
  await phone.goto(base, { waitUntil: 'domcontentloaded' });
  await waitLoaded(phone);
  assert.deepEqual(await phone.evaluate(() => [typeof AbortSignal.any, typeof AbortSignal.timeout]), ['undefined', 'undefined']);

  await page.locator('#chat-input').fill(delayedText);
  const optimistic = await page.evaluate(async text => {
    const started = performance.now();
    document.getElementById('chat-form').requestSubmit();
    const immediate = [...document.querySelectorAll('#chat-messages .chat-text')].some(node => node.textContent === text);
    await new Promise(requestAnimationFrame);
    return { immediate, frameMs: performance.now() - started };
  }, delayedText);
  assert.equal(optimistic.immediate, true, 'Own message must appear before the cloud responds');
  assert.ok(optimistic.frameMs < 250, `Slow optimistic render: ${optimistic.frameMs} ms`);
  assert.equal(delayedReplies, 0);
  await waitForMessage(page, delayedText, 'sending');
  releaseDelayed();
  await waitForMessage(page, delayedText);
  await waitForMessage(phone, delayedText);

  const draft = '这段正在输入的草稿要保留';
  await page.locator('#chat-input').fill(draft);
  const quickTexts = ['太慢了', '搞快点好不'];
  for (const text of quickTexts) {
    await page.locator('[data-chat-send]').filter({ hasText: text }).click();
    await waitForMessage(page, text);
    assert.equal(await page.locator('#chat-input').inputValue(), draft, 'Quick text must preserve the draft');
  }
  const emojiButton = page.locator('[data-chat-send]').filter({ hasNotText: /太慢了|搞快点好不/ }).first();
  const emoji = await emojiButton.getAttribute('data-chat-send');
  assert.ok(emoji && /\p{Extended_Pictographic}/u.test(emoji), 'There must be an emoji quick-send button');
  await emojiButton.click();
  await waitForMessage(page, emoji);
  assert.equal(await page.locator('#chat-input').inputValue(), draft, 'Emoji quick send must preserve the draft');

  await sendTyped(page, literalText);
  await waitForMessage(phone, literalText);
  for (const current of [page, phone]) {
    assert.equal(await current.locator('#chat-messages script, #chat-messages img').count(), 0, 'Message HTML must stay literal text');
    assert.equal(await current.evaluate(() => window.chatInjected), undefined, 'Message content must not execute');
  }

  await page.locator('#chat-input').fill('中文输入法正在选词');
  const countBeforeIme = posts.length;
  await page.locator('#chat-input').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  assert.equal(posts.length, countBeforeIme, 'IME confirmation must not send an unfinished message');
  assert.equal(await page.locator('#chat-input').inputValue(), '中文输入法正在选词');

  await page.locator('#chat-input').fill(retryText);
  await page.locator('#chat-send').click();
  await waitForMessage(page, retryText, 'failed');
  const failedPost = posts.find(post => post.text === retryText);
  assert.ok(failedPost);
  await page.locator(`[data-chat-retry="${failedPost.requestId}"]`).click();
  await waitForMessage(page, retryText);
  const retryPosts = posts.filter(post => post.text === retryText);
  assert.equal(retryPosts.length, 2);
  assert.deepEqual(retryPosts[0], retryPosts[1], 'Retry must reuse the same sender, request ID and text');
  assert.equal(messages.filter(message => message.text === retryText).length, 1, 'Commit plus retry must not duplicate the stored message');
  await assertOnce(page, retryText);
  await waitForMessage(phone, retryText);
  await assertOnce(phone, retryText);

  const phoneText = '手机上的回复：收到，继续下棋！';
  await sendTyped(phone, phoneText);
  await waitForMessage(page, phoneText);
  assert.notEqual(posts.find(post => post.text === phoneText).clientId, posts.find(post => post.text === delayedText).clientId, 'Separate devices must have separate sender IDs');
  const expected = [delayedText, ...quickTexts, emoji, literalText, retryText, phoneText];
  for (const current of [page, phone]) {
    await current.reload({ waitUntil: 'domcontentloaded' });
    for (const text of expected) { await waitForMessage(current, text); await assertOnce(current, text); }
    await assertNoOverflow(current);
  }
  await page.close();
  const reopened = await desktop.newPage();
  await reopened.goto(base, { waitUntil: 'domcontentloaded' });
  for (const text of expected) { await waitForMessage(reopened, text); await assertOnce(reopened, text); }
  await assertNoOverflow(reopened);
  assert.deepEqual(unexpectedRequests, [], 'No unmocked or unintended API operations are allowed');
  assert.deepEqual(errors, [], 'Pages must not produce JavaScript errors');
  await mkdir('.artifacts', { recursive: true });
  await reopened.screenshot({ path: '.artifacts/chat-desktop.png', fullPage: true });
  await phone.screenshot({ path: '.artifacts/chat-mobile.png', fullPage: true });
  console.log(JSON.stringify({
    result: 'Chat browser checks passed', base, mockedOnly: true, seedMessages: 65,
    sentMessages: expected.length, postRequestsIncludingRetry: posts.length,
    optimisticFrameMs: Math.round(optimistic.frameMs),
    checked: ['history pagination', 'typed/quick/emoji send', 'draft retention', 'cross-device polling', 'refresh/reopen persistence', 'literal HTML', 'IME Enter', 'commit-response-loss retry', 'missing AbortSignal static helpers', '390px overflow', 'page errors'],
    screenshots: ['.artifacts/chat-desktop.png', '.artifacts/chat-mobile.png'],
  }));
} finally {
  releaseDelayed();
  await browser.close();
}
