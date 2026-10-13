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
  const handlers = new Map();
  let disposals = 0;
  const dispose = () => { disposals += 1; };
  const context = {
    document: { getElementById: () => ({ style: {} }) },
    bindGameAudio: () => ({ dispose }),
    createTapGame: () => ({ dispose }),
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type, handler) => {
      if (handlers.get(type) === handler) handlers.delete(type);
    },
    input: { mountId: 'game', context: { gameRuntime: { execution: {}, dispose } } },
  };
  runInNewContext(`${stripTypeScriptTypes(source)}\ncreateStarterGame(input);`, context);
  handlers.get('pagehide')({ persisted: true });
  handlers.get('pagehide')({ persisted: true });
  assert.equal(disposals, 0, `${relativePath}: history caching must keep all owners alive`);
  handlers.get('pagehide')({ persisted: false });
  assert.equal(disposals, 3, `${relativePath}: permanent unload disposes audio, runtime, and shell`);
  assert.equal(handlers.has('pagehide'), false);
}
console.info('lite template history lifecycle checks passed');
