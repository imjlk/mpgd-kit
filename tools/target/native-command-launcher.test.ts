import assert from 'node:assert/strict';

import { resolveNativeCommandLaunch } from './native-command-launcher';

assert.deepEqual(
  resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['--dir', 'shell', 'cap', 'sync', 'android'],
    environment: { npm_execpath: 'C:\\tools\\pnpm.cjs' },
    platform: 'win32',
    nodeExecutable: 'C:\\node.exe',
  }),
  {
    command: 'C:\\node.exe',
    args: ['C:\\tools\\pnpm.cjs', '--dir', 'shell', 'cap', 'sync', 'android'],
  },
);
assert.deepEqual(
  resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['install'],
    environment: {},
    platform: 'darwin',
  }),
  { command: 'pnpm', args: ['install'] },
);
assert.deepEqual(
  resolveNativeCommandLaunch({
    command: './gradlew',
    args: ['bundleRelease', '--no-daemon'],
    environment: {},
    platform: 'win32',
  }),
  { command: 'gradlew.bat', args: ['bundleRelease', '--no-daemon'], shell: true },
);
const missingPnpmScript = () => resolveNativeCommandLaunch({
  command: 'pnpm',
  args: [],
  environment: {},
  platform: 'win32',
});
assert.throws(missingPnpmScript, /pnpm exec mpgd/u);
console.info('Native command launch selection passed.');
