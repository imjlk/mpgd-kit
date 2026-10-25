import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

for (const relativePath of [
  '../../packages/cli/templates/lite-overlay/src/runtime/createGame.ts',
  '../../examples/lite-starter/src/runtime/createGame.ts',
]) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gmu, '')
    .replace('export function createStarterGame', 'function createStarterGame');
  for (const mode of ['pagehide', 'direct']) {
    const handlers = new Map();
    let disposals = 0;
    let restoreDisposals = 0;
    let deleteAccountDisposals = 0;
    const dispose = () => { disposals += 1; };
    const context = {
      document: { getElementById: () => ({ style: {} }) },
      bindGameAudio: () => ({ dispose }),
      createTapGame: () => shell,
      mountRestorePurchasesButton: () => () => { restoreDisposals += 1; },
      mountDeleteAccountButton: () => () => { deleteAccountDisposals += 1; },
      addEventListener: (type, handler) => handlers.set(type, handler),
      removeEventListener: (type, handler) => {
        if (handlers.get(type) === handler) handlers.delete(type);
      },
      input: { mountId: 'game', context: { gameRuntime: { execution: {}, dispose } } },
    };
    const shell = { size: { width: 300, height: 200, dpr: 1 }, dispose };
    const game = runInNewContext(`${stripTypeScriptTypes(source)}\ncreateStarterGame(input);`, context);
    handlers.get('pagehide')({ persisted: true });
    handlers.get('pagehide')({ persisted: true });
    assert.equal(disposals, 0, `${relativePath}: history caching must keep all owners alive`);
    const onPageHide = handlers.get('pagehide');
    shell.size = { width: 400, height: 250, dpr: 2 };
    assert.equal(game.size, shell.size, 'the owner wrapper must preserve the live size getter');
    if (mode === 'direct') game.dispose();
    else onPageHide({ persisted: false });
    assert.equal(disposals, 3, `${relativePath}: permanent unload disposes audio, runtime, and shell`);
    if (source.includes('mountRestorePurchasesButton')) {
      assert.equal(restoreDisposals, 1, `${relativePath}: unload removes the Restore Purchases button`);
    }
    if (source.includes('mountDeleteAccountButton')) {
      assert.equal(deleteAccountDisposals, 1, `${relativePath}: unload removes the Delete account button`);
    }
    assert.equal(handlers.has('pagehide'), false);
    game.dispose();
    onPageHide({ persisted: false });
    assert.equal(disposals, 3, `${relativePath}: disposal must be idempotent`);
    assert.ok(restoreDisposals <= 1, `${relativePath}: the button disposer runs once`);
    assert.ok(deleteAccountDisposals <= 1, `${relativePath}: the delete button disposer runs once`);
  }
}
for (const relativePath of [
  '../../packages/cli/templates/lite-overlay/src/lite/tapGame.ts',
  '../../examples/lite-starter/src/lite/tapGame.ts',
]) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gmu, '')
    .replace('export function createTapGame', 'function createTapGame');
  const handlers = new Map();
  let disposals = 0;
  let invalidations = 0;
  const shell = {
    size: { width: 300, height: 200, dpr: 1 },
    invalidate() { invalidations += 1; },
    dispose() { disposals += 1; },
  };
  const context = {
    document: {
      addEventListener: (type, handler) => handlers.set(type, handler),
      removeEventListener: (type, handler) => {
        if (handlers.get(type) === handler) handlers.delete(type);
      },
    },
    createStarterRunState: () => ({}),
    createCanvasRenderer: () => ({}),
    createLiteShell: () => shell,
    options: { mount: {}, title: 'test' },
  };
  const game = runInNewContext(`${stripTypeScriptTypes(source)}\ncreateTapGame(options);`, context);
  handlers.get('visibilitychange')();
  assert.equal(invalidations, 1);
  shell.size = { width: 400, height: 250, dpr: 2 };
  assert.equal(game.size, shell.size, 'the wrapper must preserve the live size getter');
  game.dispose();
  assert.equal(disposals, 1);
  assert.equal(handlers.has('visibilitychange'), false);
}
console.info('lite template history and visibility lifecycle checks passed');
