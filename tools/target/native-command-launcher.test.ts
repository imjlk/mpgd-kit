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
assert.deepEqual(
  resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['--dir', 'C:\\game with spaces', 'build'],
    environment: { npm_execpath: 'C:\\tool chain\\pnpm.exe' },
    platform: 'win32',
  }),
  {
    command: 'C:\\tool chain\\pnpm.exe',
    args: ['--dir', 'C:\\game with spaces', 'build'],
  },
);
const pnpmShim = () => resolveNativeCommandLaunch({
  command: 'pnpm',
  args: [],
  environment: { npm_execpath: 'C:\\tools\\pnpm.cmd' },
  platform: 'win32',
});
assert.throws(pnpmShim, /pnpm exec mpgd/u);
for (const entry of ['npm-cli.js', 'npx-cli.js', 'yarn.js', 'other.exe']) {
  const wrongManager = () => resolveNativeCommandLaunch({
    command: 'pnpm',
    args: [],
    platform: 'win32',
    environment: { npm_execpath: `C:\\tools\\${entry}` },
  });
  assert.throws(wrongManager, /pnpm exec mpgd/u);
}
console.info('Native command launch selection passed.');
