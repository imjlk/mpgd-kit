import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertLatestDevvitSdk, checkDevvitSdk } from './devvit-sdk-check.js';
const entries = ['devvit', '@devvit/web', '@devvit/start'].map((name) => ({
  name,
  declared: '0.15.0',
  installed: '0.15.0',
  latest: '0.15.0',
}));
assert.doesNotThrow(() => assertLatestDevvitSdk(entries));
assert.throws(() => assertLatestDevvitSdk([]), /both/);
for (const changed of [
  { declared: '^0.15.0' },
  { installed: '0.14.1' },
  { latest: '0.16.0' },
  { latest: '0.16.0-next.1' },
  { declared: 'latest' },
]) {
  assert.throws(() =>
    assertLatestDevvitSdk(
      entries.map((entry, index) => index === 1 ? { ...entry, ...changed } : entry),
    ),
  );
}
assert.throws(
  () => assertLatestDevvitSdk(entries.filter((entry) => entry.name !== 'devvit')),
  /both/,
);
console.info('Devvit latest SDK gate tests passed.');

assert.doesNotThrow(() =>
  assertLatestDevvitSdk([
    ...entries,
    {
      name: '@devvit/web',
      declared: '0.14.1',
      installed: '0.15.0',
      latest: '0.15.0',
      source: 'adapter',
    },
  ]),
);
assert.throws(() =>
  assertLatestDevvitSdk([
    ...entries,
    {
      name: '@devvit/web',
      declared: '0.14.1',
      installed: '0.14.1',
      latest: '0.15.0',
      source: 'adapter',
    },
  ]),
);

const playtestRoots = [
  'apps/target-devvit/package.json',
  'packages/cli/templates/phaser-game/apps/target-devvit/package.json',
  'examples/lite-starter/apps/target-devvit/package.json',
];
for (const file of playtestRoots) {
  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  const scripts = (manifest as { scripts?: unknown }).scripts;
  assert.ok(scripts && typeof scripts === 'object' && !Array.isArray(scripts));
  const dev = (scripts as { dev?: unknown }).dev;
  assert.equal(typeof dev, 'string', file);
  assert.match(
    String(dev),
    /^pnpm run check:sdk && pnpm run prepare:icon && devvit playtest/,
    `${file} must gate playtest uploads`,
  );
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function installPackage(root: string, name: string, version: string, extra: Record<string, unknown> = {}): void {
  writeJson(path.join(root, 'node_modules', name, 'package.json'), { name, version, ...extra });
}

function mockedRegistry(versions: Readonly<Record<string, string>>) {
  const calls: string[] = [];
  return {
    calls,
    lookupLatest: async (name: string) => {
      calls.push(name);
      const version = versions[name];
      if (version === undefined) {
        throw new Error('unexpected registry lookup: ' + name);
      }
      return version;
    },
  };
}

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-devvit-sdk-'));
try {
  const current = '9.8.7';
  const stale = '1.0.0';
  const paymentsLatest = '9.9.9';
  writeJson(path.join(fixture, 'package.json'), {
    dependencies: {
      devvit: current,
      '@devvit/web': current,
      '@devvit/payments': stale,
      '@other/devvit': stale,
    },
  });
  installPackage(fixture, 'devvit', current);
  installPackage(fixture, '@devvit/web', current);
  installPackage(fixture, '@devvit/payments', stale);
  installPackage(fixture, '@other/devvit', stale);
  const stalePayments = mockedRegistry({
    devvit: current,
    '@devvit/web': current,
    '@devvit/payments': paymentsLatest,
  });
  await assert.rejects(
    () => checkDevvitSdk(fixture, { lookupLatest: stalePayments.lookupLatest }),
    /@devvit\/payments: declared=1\.0\.0, installed=1\.0\.0, latest=9\.9\.9/,
  );
  assert.ok(stalePayments.calls.includes('@devvit/payments'));
  assert.ok(!stalePayments.calls.includes('@other/devvit'));

  writeJson(path.join(fixture, 'package.json'), {
    dependencies: {
      devvit: current,
      '@devvit/web': current,
      '@devvit/redis': current,
    },
  });
  installPackage(fixture, '@devvit/redis', current);
  const currentRedis = mockedRegistry({
    devvit: current,
    '@devvit/web': current,
    '@devvit/redis': current,
  });
  const checked = await checkDevvitSdk(fixture, { lookupLatest: currentRedis.lookupLatest });
  assert.ok(checked.some((entry) => entry.name === '@devvit/redis' && entry.latest === current));
  assert.ok(currentRedis.calls.includes('@devvit/redis'));

  const adapterRoot = path.join(fixture, 'adapter-consumer');
  writeJson(path.join(adapterRoot, 'package.json'), {
    dependencies: {
      devvit: current,
      '@devvit/web': current,
      '@mpgd/adapter-devvit': 'workspace:*',
    },
  });
  installPackage(adapterRoot, 'devvit', current);
  installPackage(adapterRoot, '@devvit/web', current);
  installPackage(adapterRoot, '@mpgd/adapter-devvit', '0.13.3', {
    dependencies: { '@devvit/redis': stale },
  });
  installPackage(adapterRoot, '@devvit/redis', stale);
  const adapterRedis = mockedRegistry({
    devvit: current,
    '@devvit/web': current,
    '@devvit/redis': paymentsLatest,
  });
  await assert.rejects(
    () => checkDevvitSdk(adapterRoot, { lookupLatest: adapterRedis.lookupLatest }),
    /@devvit\/redis: declared=1\.0\.0, installed=1\.0\.0, latest=9\.9\.9/,
  );
  assert.ok(adapterRedis.calls.includes('@devvit/redis'));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
