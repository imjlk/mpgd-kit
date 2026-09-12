import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = fileURLToPath(new URL('../artifacts/actions/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const open = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.fixture?.state().ready);
    await page.evaluate(() => window.advanceTime(100));
  };
  const state = () => page.evaluate(() => window.fixture.state());
  const step = () => page.evaluate(() => window.advanceTime(200));
  const clickCanvas = async (y) => {
    const bounds = await page.locator('canvas').boundingBox();
    assert.ok(bounds, 'gameplay canvas must be rendered');
    await page.mouse.click(bounds.x + 795 * bounds.width / 1000, bounds.y + y * bounds.height / 620);
    await step();
  };
  const waitServer = () => page.waitForFunction(() => window.fixture.state().monetization.serverWaiting);
  const waitOwner = (kind, status) => page.waitForFunction(({ kind, status }) => window.fixture.state().monetization[kind].status === status, { kind, status });

  await open();
  await clickCanvas(156); // Settings.
  await page.locator('#rewarded-ad').click();
  await page.locator('#rewarded-ad').click();
  await waitServer();
  let current = await state();
  assert.equal(current.monetization.ad, 1);
  assert.equal(current.monetization.claim, 1);
  assert.equal(current.monetization.adOwner.status, 'running');
  assert.equal(current.monetization.ui.status, 'server-requested');
  await page.locator('#settle').click();
  await waitOwner('adOwner', 'granted');
  const settingsUpdates = (await state()).gameplayUpdates;
  await step();
  current = await state();
  assert.equal(current.gameplayUpdates, settingsUpdates);
  assert.equal(current.blocked.simulation, true);
  assert.equal(current.settingsOpen, true);
  await page.screenshot({ path: `${artifacts}/ad-complete-settings-open.png` });
  await clickCanvas(156); // Close settings.

  await page.locator('#purchase').click();
  await page.locator('#purchase').click();
  await waitServer();
  await clickCanvas(218); // Background.
  await clickCanvas(280); // Foreground.
  current = await state();
  assert.equal(current.blocked.simulation, true);
  assert.equal(current.monetization.purchase, 1);
  assert.equal(current.monetization.verify, 1);
  const oldEvents = current.monetization.events;
  await page.locator('#close-action-ui').click();
  current = await state();
  assert.equal(current.monetization.ui.status, 'idle');
  assert.equal(current.monetization.ui.screen, 2);
  assert.equal(current.blocked.simulation, true);
  await page.locator('#settle').click();
  await waitOwner('purchaseOwner', 'granted');
  await step();
  current = await state();
  assert.equal(current.monetization.ui.status, 'idle');
  assert.equal(current.monetization.events, oldEvents);
  assert.equal(current.monetization.purchaseOwner.status, 'granted');
  assert.equal(current.monetization.ownerResults, 2);
  assert.equal(current.blocked.simulation, false);
  await page.screenshot({ path: `${artifacts}/new-screen-old-operation-complete.png` });

  await open();
  await page.locator('#action-mode').selectOption('pending');
  await page.locator('#purchase').click();
  await waitOwner('purchaseOwner', 'pending');
  await page.locator('#purchase').click();
  await page.locator('#close-action-ui').click();
  await page.locator('#next-action').click();
  await page.locator('#purchase').click();
  current = await state();
  assert.equal(current.monetization.purchase, 1);
  assert.equal(current.monetization.verify, 0);
  assert.equal(current.monetization.availability, 'reconciliation-required');
  assert.equal(current.blocked.simulation, false);
  await page.screenshot({ path: `${artifacts}/pending-no-repurchase.png` });

  for (const [button, owner, counter] of [
    ['purchase', 'purchaseOwner', 'verify'], ['rewarded-ad', 'adOwner', 'claim'],
  ]) {
    for (const outcome of ['rejected', 'exception']) {
      await open();
      await page.locator('#action-mode').selectOption(outcome);
      await page.locator(`#${button}`).click();
      await waitServer();
      await page.locator('#settle').click();
      await waitOwner(owner, outcome);
      current = await state();
      assert.equal(current.blocked.simulation, false);
      assert.equal(current.monetization[counter], 1);
      assert.equal(current.monetization.ownerResults, 1);
      assert.equal(current.monetization.ui.status, outcome);
      assert.equal(current.monetization.availability, outcome === 'exception' ? 'reconciliation-required' : 'ready');
    }
  }
  assert.deepEqual(errors, []);
  console.log('Real browser action fixture passed: shared calls, settings/background overlap, stale UI isolation, owner completion, pending, rejection and exception.');
} finally {
  await browser?.close();
  await server.close();
}
