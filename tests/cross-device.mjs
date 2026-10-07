import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createGame, applyAction, publicState } from '../src/engine.js';

// Both browser contexts use this isolated API fixture, even against production.
// No move, undo, or polling request reaches the real shared game.
const base = process.env.GO_TEST_BASE || 'http://127.0.0.1:5187';
const baseline = process.env.GO_TEST_BASELINE === '1';
const networkRttMs = 80;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isGame = url => url.pathname === '/api/game';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
});
let closing = false, game = createGame({ size: 9, mode: 'local' }), revision = 0;
const actions = [], errors = [], samples = [];
const payload = () => ({ revision, game: publicState(game), updatedAt: new Date().toISOString() });
const waitSynced = page => page.waitForFunction(
  () => document.getElementById('sync-status').textContent.includes('云端已同步'),
  null, { timeout: 10000 },
);

async function device(name, options) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  if (name === 'mobile') await context.addInitScript(() => {
    for (const method of ['any', 'timeout']) {
      Object.defineProperty(AbortSignal, method, { configurable: true, writable: true, value: undefined });
    }
  });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route(isGame, async route => {
    try {
      const request = route.request();
      if (request.method() === 'OPTIONS') return await route.fulfill({ status: 204, headers });
      await delay(networkRttMs / 2);
      let data, status = 200;
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.equal(body.revision, revision, 'A synchronized sender must use the current server revision');
        game = applyAction(game, body.action, () => 0.5);
        revision++;
        actions.push({ device: name, type: body.action.type, revision, committedAt: Date.now() });
        data = payload();
      } else {
        assert.equal(request.method(), 'GET');
        const known = new URL(request.url()).searchParams.get('revision');
        data = known === String(revision) ? { unchanged: true, revision } : payload();
      }
      await delay(networkRttMs / 2);
      await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(data) });
    } catch (error) {
      if (!closing) throw error;
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitSynced(page);
  assert.equal(await page.evaluate(() => document.hidden), false, `${name} must remain visible for polling`);
  if (name === 'mobile') assert.deepEqual(
    await page.evaluate(() => [typeof AbortSignal.any, typeof AbortSignal.timeout]), ['undefined', 'undefined'],
  );
  return { name, context, page };
}

async function expectBoard(page) {
  const board = await page.locator('#board .intersection').evaluateAll(buttons => buttons.map(button =>
    button.querySelector('.stone.black') ? 1 : button.querySelector('.stone.white') ? 2 : 0,
  ));
  assert.deepEqual(board, game.board);
  assert.equal(await page.locator('#move-count').textContent(), `第 ${game.moves.length} 手`);
}

async function measure(sender, receiver, type, index, round) {
  // Begin immediately after an ordinary receiver poll: this exposes the full
  // polling interval instead of accidentally reporting a lucky near-zero wait.
  await receiver.page.waitForResponse(response =>
    isGame(new URL(response.url())) && response.request().method() === 'GET', { timeout: 10000 },
  );
  await waitSynced(sender.page);
  await receiver.page.evaluate(({ index, occupied }) => {
    window.__crossDeviceObservedAt = null;
    window.__crossDeviceObserver?.disconnect();
    window.__crossDeviceObserver = new MutationObserver(() => {
      const stone = document.querySelector(`[data-index="${index}"] .stone.black`);
      if (!!stone === occupied) {
        window.__crossDeviceObservedAt = Date.now();
        window.__crossDeviceObserver.disconnect();
      }
    });
    window.__crossDeviceObserver.observe(document.getElementById('board'), { childList: true, subtree: true });
  }, { index, occupied: type === 'play' });
  const startedAt = await sender.page.evaluate(({ type, index }) => {
    const started = Date.now();
    document.querySelector(type === 'play' ? `[data-index="${index}"]` : '#undo-button').click();
    return started;
  }, { type, index });
  await receiver.page.waitForFunction(() => window.__crossDeviceObservedAt !== null, null, { timeout: 10000 });
  const observedAt = await receiver.page.evaluate(() => window.__crossDeviceObservedAt);
  await waitSynced(sender.page);
  assert.equal(actions.at(-1).type, type);
  assert.ok(observedAt >= actions.at(-1).committedAt, 'Receiver must reflect an authoritative server write');
  await expectBoard(sender.page);
  await expectBoard(receiver.page);
  const sample = { round, action: type, from: sender.name, to: receiver.name, latencyMs: observedAt - startedAt, revision };
  samples.push(sample);
  console.log(JSON.stringify(sample));
}

try {
  const desktop = await device('desktop', { viewport: { width: 1366, height: 900 } });
  const mobile = await device('mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (let round = 0; round < 4; round++) {
    const [sender, receiver] = round % 2 ? [mobile, desktop] : [desktop, mobile];
    const index = [40, 30, 50, 60][round];
    await measure(sender, receiver, 'play', index, round + 1);
    await measure(sender, receiver, 'undo', index, round + 1);
    assert.equal(game.moves.length, 0, 'Each round must return the shared fixture to an empty game');
  }
  assert.equal(actions.length, 8);
  assert.equal(revision, 8);
  assert.deepEqual(errors, []);
  const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode: baseline ? 'baseline' : 'target', base, networkRttMs, samples: samples.length,
    minMs: latencies[0], medianMs: (latencies[3] + latencies[4]) / 2, maxMs: latencies.at(-1),
    mobileWithoutAbortSignalStatics: true, realCloudWrites: 0,
  }));
  if (!baseline) assert.ok(latencies.at(-1) < 800, `Cross-device propagation must stay below 800 ms; measured ${latencies.at(-1)} ms`);
} finally {
  closing = true;
  await browser.close();
}
