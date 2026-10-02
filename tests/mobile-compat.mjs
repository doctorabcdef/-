import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createGame, applyAction, publicState } from '../src/engine.js';

// All game requests are mocked, including when GO_TEST_BASE points at production.
// This exercises missing browser APIs in Chromium, not an actual iPhone/WebKit.
const base = process.env.GO_TEST_BASE || 'http://127.0.0.1:5187';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' };
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const matchesGame = url => url.pathname === '/api/game';
const payload = (game, revision = 0) => ({ revision, game: publicState(game), updatedAt: '2026-10-02T00:00:00.000Z' });
const fulfill = (route, data) => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });
const waitSynced = page => page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('云端已同步'), null, { timeout: 10000 });

async function prepare(context, suppressPolling = false) {
  await context.addInitScript(({ suppressPolling }) => {
    for (const method of ['any', 'timeout']) Object.defineProperty(AbortSignal, method, { configurable: true, writable: true, value: undefined });
    // Isolate the explicit retry from visibility-based automatic polling.
    if (suppressPolling) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  }, { suppressPolling });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  return { page, errors };
}

try {
  const context = await browser.newContext(mobile);
  try {
    let game = createGame({ size: 9 }), revision = 0, gets = 0;
    const actions = [];
    await context.route(matchesGame, async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.equal(body.revision, revision);
        game = applyAction(game, body.action, () => 0.5); revision++;
        actions.push(body.action.type);
      } else {
        assert.equal(request.method(), 'GET'); gets++;
      }
      await fulfill(route, payload(game, revision));
    });
    const { page, errors } = await prepare(context);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitSynced(page);
    assert.deepEqual(await page.evaluate(() => [typeof AbortSignal.any, typeof AbortSignal.timeout]), ['undefined', 'undefined']);
    assert.ok(gets > 0, 'Loading must actually reach the mocked API without static AbortSignal helpers');
    assert.equal(await page.locator('#board-overlay').isVisible(), false);

    await page.locator('[data-index="40"]').tap();
    await waitSynced(page);
    assert.equal(await page.locator('[data-index="40"] .stone.black').count(), 1);
    assert.equal(game.board[40], 1);
    assert.equal(revision, 1);
    await page.locator('#undo-button').tap();
    await waitSynced(page);
    assert.equal(await page.locator('[data-index="40"] .stone').count(), 0);
    assert.equal(game.board[40], 0);
    assert.equal(revision, 2);
    assert.deepEqual(actions, ['play', 'undo']);
    assert.deepEqual(errors, []);
    console.log('Mobile API compatibility passed: missing AbortSignal.any/timeout, initial load, saved move and saved undo.');
  } finally { await context.close(); }

  const recovery = await browser.newContext(mobile);
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  try {
    let healthy = false, failedRequests = 0, healthyRequests = 0;
    const game = createGame({ size: 9 });
    await recovery.route(matchesGame, async route => {
      if (!healthy) { failedRequests++; await route.abort('failed'); return; }
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(route.request().method(), 'GET');
      healthyRequests++;
      await Promise.all([new Promise(resolve => setTimeout(resolve, 300)), recoveryGate]);
      await fulfill(route, payload(game));
    });
    const { page, errors } = await prepare(recovery, true);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('连接失败'), null, { timeout: 10000 });
    assert.ok(failedRequests > 0);
    assert.equal(await page.locator('#board-overlay').isVisible(), true);
    assert.equal(await page.locator('#retry-button').isVisible(), true);
    assert.equal(await page.locator('#board-overlay .spinner').isVisible(), false);

    healthy = true;
    await page.locator('#retry-button').tap();
    await page.waitForFunction(() => !document.querySelector('#board-overlay .spinner').classList.contains('hidden'));
    assert.equal(await page.locator('#board-overlay .spinner').isVisible(), true);
    assert.equal((await page.locator('#sync-status').textContent()).includes('连接失败'), false, 'Manual retry must clear the previous connection error');
    assert.equal(await page.locator('#board-overlay').isVisible(), true);
    releaseRecovery();
    await waitSynced(page);
    assert.equal(healthyRequests, 1);
    assert.equal(await page.locator('#board-overlay').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Mobile recovery passed: failed request, connection-failed status, retry loading spinner, delayed successful recovery.');
  } finally { releaseRecovery(); await recovery.close(); }
} finally { await browser.close(); }
