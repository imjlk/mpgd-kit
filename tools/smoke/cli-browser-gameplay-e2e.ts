import assert from 'node:assert/strict';

import {
  createBrowserGameplayE2EDriver,
  type BrowserGameplayE2EPage,
  type BrowserGameplayE2EViewport,
  type GameplayE2EState,
} from '../../packages/cli/src/index';

interface FakeBrowserPage extends BrowserGameplayE2EPage {
  readonly marker: 'fake-browser-page';
}

let viewport: BrowserGameplayE2EViewport | null = { width: 200, height: 100 };
const clicks: Array<readonly [number, number]> = [];
const keys: string[] = [];
const waits: number[] = [];
const screenshots: Array<{ readonly path: string; readonly type: 'png' }> = [];
const lifecycle: string[] = [];
const inspections: Array<{
  readonly marker: FakeBrowserPage['marker'];
  readonly stateId: string;
  readonly phase: 'after' | 'before' | 'resumed';
}> = [];
const page: FakeBrowserPage = {
  marker: 'fake-browser-page',
  viewportSize: () => viewport,
  mouse: {
    click: async (x, y) => {
      clicks.push([x, y]);
    },
  },
  keyboard: {
    press: async (key) => {
      keys.push(key);
    },
  },
  waitForTimeout: async (durationMs) => {
    waits.push(durationMs);
  },
  screenshot: async (options) => {
    screenshots.push(options);
  },
};
const driver = createBrowserGameplayE2EDriver({
  page,
  pause: async (currentPage) => {
    lifecycle.push(`pause:${currentPage.marker}`);
  },
  resume: async (currentPage) => {
    lifecycle.push(`resume:${currentPage.marker}`);
  },
  inspect: async ({ page: currentPage, state, phase }) => {
    inspections.push({ marker: currentPage.marker, stateId: state.id, phase });
    return {
      passed: true,
      sessionId: 'browser-session',
      metadata: { marker: currentPage.marker },
    };
  },
});
const state = {
  id: 'browser-ready',
  label: 'Browser ready',
  actions: [],
} as const satisfies GameplayE2EState;

await driver.perform({ type: 'tap', x: 0, y: 0 });
await driver.perform({ type: 'tap', x: 0.5, y: 0.75 });
await driver.perform({ type: 'tap', x: 1, y: 1 });
viewport = { width: 40, height: 20 };
await driver.perform({ type: 'tap', x: 0.5, y: 0.5 });
await driver.perform({ type: 'key', key: 'Enter' });
await driver.perform({ type: 'wait', durationMs: 125 });
await driver.pause();
await driver.resume();

assert.deepEqual(clicks, [
  [0, 0],
  [100, 75],
  [199, 99],
  [20, 10],
]);
assert.deepEqual(keys, ['Enter']);
assert.deepEqual(waits, [125]);
assert.deepEqual(lifecycle, ['pause:fake-browser-page', 'resume:fake-browser-page']);
assert.deepEqual(await driver.inspect({ state, phase: 'after' }), {
  passed: true,
  sessionId: 'browser-session',
  metadata: { marker: 'fake-browser-page' },
});
assert.deepEqual(inspections, [
  {
    marker: 'fake-browser-page',
    stateId: 'browser-ready',
    phase: 'after',
  },
]);

await driver.captureScreenshot({ state, file: '/tmp/browser-ready.png' });
assert.deepEqual(screenshots, [{ path: '/tmp/browser-ready.png', type: 'png' }]);

viewport = null;
await assert.rejects(
  () => driver.perform({ type: 'tap', x: 0.5, y: 0.5 }),
  /require a configured page viewport/u,
);

viewport = { width: 0, height: 100 };
await assert.rejects(
  () => driver.perform({ type: 'tap', x: 0.5, y: 0.5 }),
  /positive safe integers/u,
);

viewport = { width: 100, height: 100 };
await assert.rejects(
  () => driver.perform({ type: 'tap', x: Number.NaN, y: 0.5 }),
  /x tap coordinates must be between 0 and 1/u,
);

console.log('Browser Gameplay E2E driver smoke passed.');
