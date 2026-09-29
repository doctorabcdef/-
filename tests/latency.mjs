import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createGame, applyAction, publicState } from '../src/engine.js';

// Intercept only game API traffic. This can also check a deployed frontend
// without modifying its real shared game or touching another visitor's moves.
const base = process.env.GO_TEST_BASE || 'http://127.0.0.1:5187';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  for (const mode of ['local', 'ai']) {
    const context = await browser.newContext(mode === 'local' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
    let server = createGame({ size: 9, mode }), revision = 0, completed = 0;
    const posted = [], errors = [];
    await context.route(url => url.pathname === '/api/game', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); posted.push(body);
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(body.revision, revision, 'Requests must be serialized with the confirmed revision');
        server = applyAction(server, body.action, () => 0.5); revision++; completed++;
      }
      await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ revision, game: publicState(server), updatedAt: new Date().toISOString() }) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('云端已同步'));
    const move = await page.evaluate(async () => {
      const start = performance.now(); document.querySelector('[data-index="40"]').click();
      const immediate = !!document.querySelector('[data-index="40"] .stone.black');
      await new Promise(requestAnimationFrame);
      return { immediate, frameMs: performance.now() - start, undoEnabled: !document.getElementById('undo-button').disabled };
    });
    assert.equal(move.immediate, true); assert.equal(move.undoEnabled, true); assert.ok(move.frameMs < 250);
    const undo = await page.evaluate(async () => {
      const start = performance.now(); document.getElementById('undo-button').click();
      const immediate = !document.querySelector('[data-index="40"] .stone');
      await new Promise(requestAnimationFrame);
      return { immediate, frameMs: performance.now() - start };
    });
    assert.equal(undo.immediate, true); assert.ok(undo.frameMs < 250); assert.equal(completed, 0);
    await page.evaluate(() => {
      window.oldStoneReappeared = false;
      new MutationObserver(() => { if (document.querySelector('[data-index="40"] .stone.black')) window.oldStoneReappeared = true; }).observe(document.getElementById('board'), { childList: true, subtree: true });
      document.querySelector('[data-index="41"]').click();
    });
    assert.equal(await page.locator('[data-index="41"] .stone.black').count(), 1);
    await page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('云端已同步'), { timeout: 10000 });
    assert.equal(posted.length, 3); assert.equal(server.board[40], 0); assert.equal(server.board[41], 1);
    assert.equal(server.moves.length, mode === 'ai' ? 2 : 1);
    assert.equal(await page.evaluate(() => window.oldStoneReappeared), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, serverDelayMs: 1500, moveFrameMs: Math.round(move.frameMs), undoFrameMs: Math.round(undo.frameMs), immediateBeforeAnyResponse: true, queuedActions: posted.length }));
    await context.close();
  }
} finally { await browser.close(); }
