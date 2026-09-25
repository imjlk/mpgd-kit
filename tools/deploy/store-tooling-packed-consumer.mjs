import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePackage = join(repoRoot, 'apps/target-deploy-tooling-compat');
const consumerRoot = mkdtempSync(join(tmpdir(), 'mpgd-deploy-tooling-consumer-'));

function run(command, args, cwd) {
  const pnpmScript = command === 'pnpm' && process.platform === 'win32'
    ? process.env.npm_execpath
    : undefined;
  if (command === 'pnpm' && process.platform === 'win32') {
    assert.match(pnpmScript ?? '', /\.[cm]?js$/u,
      'On Windows, run this smoke through pnpm so its JavaScript entry point is available.');
  }
  const executable = pnpmScript === undefined ? command : process.execPath;
  const commandArgs = pnpmScript === undefined ? args : [pnpmScript, ...args];
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout ?? '';
}

try {
  const compiled = readFileSync(join(fixturePackage, 'dist/index.d.ts'), 'utf8');
  const fixtureManifest = JSON.parse(readFileSync(join(fixturePackage, 'package.json'), 'utf8'));
  assert.match(compiled, /probeGooglePublisher/u);
  assert.match(compiled, /probeAppleSdk/u);
  run('pnpm', ['--dir', fixturePackage, 'pack', '--silent', '--pack-destination', consumerRoot], repoRoot);
  const tarball = readdirSync(consumerRoot).find((entry) => entry.endsWith('.tgz'));
  assert.ok(tarball, 'compatibility tarball missing');
  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'mpgd-store-tooling-external-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@mpgd/deploy-tooling-compat': `file:${join(consumerRoot, tarball)}`,
    },
    devDependencies: {
      ttsc: fixtureManifest.devDependencies.ttsc,
      typescript: fixtureManifest.devDependencies.typescript,
    },
  }, null, 2));
  writeFileSync(join(consumerRoot, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
  writeFileSync(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    files: ['consumer.ts'],
  }, null, 2));
  writeFileSync(join(consumerRoot, 'consumer.ts'), [
    "import { probeAppleSdk, probeGooglePublisher } from '@mpgd/deploy-tooling-compat';",
    'const google: Promise<string> = probeGooglePublisher("http://localhost");',
    'const apple: Promise<string> = probeAppleSdk("http://localhost");',
    'void [google, apple];',
    '',
  ].join('\n'));
  writeFileSync(join(consumerRoot, 'verify.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { createServer } from 'node:http';",
    "import { once } from 'node:events';",
    "import { probeAppleSdk, probeGooglePublisher } from '@mpgd/deploy-tooling-compat';",
    'const server = createServer((request, response) => {',
    "  response.writeHead(200, { 'content-type': 'application/json' });",
    "  response.end(request.url?.includes('/androidpublisher/')",
    "    ? JSON.stringify({ id: 'external-edit' })",
    "    : JSON.stringify({ data: [{ type: 'builds', id: 'external-build' }] }));",
    '});',
    "server.listen(0, '127.0.0.1');",
    "await once(server, 'listening');",
    'try {',
    '  const address = server.address();',
    "  assert.ok(address && typeof address !== 'string');",
    '  const baseUrl = `http://127.0.0.1:${address.port}`;',
    "  assert.equal(await probeGooglePublisher(baseUrl), 'external-edit');",
    "  assert.equal(await probeAppleSdk(baseUrl), 'external-build');",
    '} finally { server.close(); }',
    '',
  ].join('\n'));
  run('pnpm', ['install', '--ignore-scripts'], consumerRoot);
  run('pnpm', ['exec', 'ttsc', '--noEmit', '-p', 'tsconfig.json'], consumerRoot);
  run('node', ['verify.mjs'], consumerRoot);
  process.stdout.write('store tooling tarball consumer: passed\n');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
