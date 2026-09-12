import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = fileURLToPath(new URL('../artifacts/browser/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await page.goto(`http://127.0.0.1:${address.port}/?inactive=1`);
  await page.waitForFunction(() => window.fixture?.state().ready);
  const step = (frames = 6) => page.evaluate((count) => window.advanceTime(count * 1000 / 60), frames);
  const state = () => page.evaluate(() => window.fixture.state());
  const screenshot = (name) => page.screenshot({ path: `${artifacts}/${name}.png` });
  const click = async (x, y) => {
    const canvas = await page.locator('canvas').boundingBox();
    assert.ok(canvas);
    await page.mouse.click(canvas.x + x * canvas.width / 1000, canvas.y + y * canvas.height / 620);
    await step(4);
  };
  await step();
  let current = await state();
  assert.equal(current.gameplayUpdates, 0, 'initial inactive scene must not run before first block application');
  assert.equal(current.gameplayActive, false);
  assert.equal(current.gameplayVisible, false);
  assert.equal(current.muted, true);
  assert.ok(current.uiUpdates > 0);
  await screenshot('initial-inactive');

  await click(795, 280); // Foreground.
  current = await state();
  assert.equal(current.gameplayActive, true);
  assert.equal(current.gameplayVisible, true);
  await page.keyboard.down('ArrowRight');
  await step();
  const moving = await state();
  assert.ok(moving.keyMoves > 0);
  await click(795, 156); // Settings.
  await page.keyboard.up('ArrowRight'); // Delivered while gameplay input is disabled.
  await step();
  const paused = await state();
  assert.equal(paused.gameplayActive, false);
  assert.equal(paused.gameplayCanInput, false);
  assert.ok(paused.gameplayRenders > current.gameplayRenders, 'paused gameplay still renders');
  await click(795, 218); // Background while settings remains open.
  current = await state();
  assert.equal(current.gameplayVisible, false);
  assert.equal(current.muted, true);
  assert.equal(current.gameplayUpdates, paused.gameplayUpdates);
  await screenshot('settings-background');
  await click(795, 280); // Foreground must leave settings blocked.
  current = await state();
  assert.equal(current.settingsOpen, true);
  assert.equal(current.gameplayActive, false);
  assert.equal(current.gameplayVisible, true);
  assert.equal(current.gameplayUpdates, paused.gameplayUpdates);
  assert.ok(current.uiUpdates > paused.uiUpdates);
  await screenshot('settings-foreground');
  await click(795, 156); // Close settings using the still-interactive UI scene.
  current = await state();
  assert.equal(current.gameplayActive, true);
  assert.ok(current.gameplayUpdates > paused.gameplayUpdates);
  assert.equal(current.keyMoves, paused.keyMoves, 'stale pressed input must not replay after resume');

  await click(180, 370);
  const tapped = await state();
  assert.equal(tapped.gameplayClicks, 1);
  await click(795, 404); // Input-only block leaves simulation running.
  await click(180, 370);
  current = await state();
  assert.equal(current.gameplayClicks, 1);
  assert.ok(current.gameplayUpdates > tapped.gameplayUpdates);
  await click(795, 404);
  await click(180, 370);
  assert.equal((await state()).gameplayClicks, 2);

  await click(795, 342); // Rendering-only block leaves simulation running.
  const hidden = await state();
  await step();
  current = await state();
  assert.equal(current.gameplayVisible, false);
  assert.equal(current.gameplayRenders, hidden.gameplayRenders);
  assert.ok(current.gameplayUpdates > hidden.gameplayUpdates);
  await screenshot('rendering-suppressed');
  await click(795, 342);
  assert.ok((await state()).gameplayRenders > hidden.gameplayRenders);

  const beforeRestart = await state();
  await click(795, 156);
  const beforePausedRestart = await state();
  for (let index = 0; index < 3; index += 1) await click(795, 466);
  current = await state();
  assert.equal(current.generations, beforeRestart.generations + 3);
  assert.equal(current.scopeCleanups, beforeRestart.scopeCleanups + 3);
  assert.equal(current.runtimeCreateListeners, beforeRestart.runtimeCreateListeners);
  assert.equal(current.gameplayUpdates, beforePausedRestart.gameplayUpdates);
  assert.equal(current.gameplayActive, false);
  await click(795, 156);

  await page.evaluate(() => window.fixture.sleepGameplay());
  await step();
  await click(795, 218);
  await click(795, 280);
  assert.equal((await state()).gameplayActive, false, 'foreground must not wake an externally sleeping scene');
  await page.evaluate(() => window.fixture.wakeGameplay());
  await step();
  assert.equal((await state()).gameplayActive, true);
  await page.evaluate(() => window.fixture.stopGameplay());
  await step();
  await click(795, 218);
  await click(795, 280);
  assert.equal((await state()).gameplayActive, false, 'foreground must not restart a stopped scene');
  await click(795, 466);
  current = await state();
  assert.equal(current.gameplayActive, true);
  assert.equal(current.runtimeCreateListeners, beforeRestart.runtimeCreateListeners);
  assert.deepEqual(current.errors, []);
  assert.deepEqual(errors, []);
  await screenshot('final-resumed');
  await writeFile(`${artifacts}/state.json`, JSON.stringify(current, null, 2));
  await click(795, 218);
  const beforeDestroy = await state();
  const afterDestroy = await page.evaluate(() => {
    window.fixture.destroy();
    window.fixture.destroy();
    return window.fixture.state();
  });
  await page.waitForFunction(() => document.querySelector('canvas') === null);
  assert.equal(afterDestroy.controllerStatus, 'destroyed');
  assert.equal(afterDestroy.gameplayResumes, beforeDestroy.gameplayResumes);
  assert.equal(afterDestroy.gameplayUpdates, beforeDestroy.gameplayUpdates);
  assert.deepEqual(errors, [], 'Application teardown must not introduce browser errors');
  console.log('Real Phaser browser fixture passed: initial inactive, overlap, UI input, stale-key reset, rendering, shutdown/restart, external sleep/stop.');
} finally {
  await browser?.close();
  await server.close();
}
