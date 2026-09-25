import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';

const pin = JSON.parse(readFileSync(new URL('./asc-pin.json', import.meta.url), 'utf8'));
const host = `${platform()}-${arch()}`;
const asset = pin.assets[host];
assert.ok(asset, `asc ${pin.version} is not pinned for ${host}`);
const download = process.argv.includes('--download');
assert.ok(download || process.argv.length === 3, 'usage: node validate-asc.mjs --download | /path/to/asc');
const scratch = download ? mkdtempSync(join(tmpdir(), 'mpgd-asc-compat-')) : undefined;
const binary = scratch ? join(scratch, asset.name) : resolve(process.argv[2]);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...env, ASC_TELEMETRY_DISABLED: '1', ASC_BYPASS_KEYCHAIN: '1' },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout;
}

try {
  if (download) {
    const release = JSON.parse(run('gh', [
      'api', `repos/${pin.repository}/releases/tags/${pin.version}`,
    ]));
    const releaseAsset = release.assets?.find((entry) => entry.name === asset.name);
    assert.equal(releaseAsset?.digest, `sha256:${asset.sha256}`,
      `GitHub release metadata does not match pinned ${asset.name} hash`);
    run('gh', [
      'release', 'download', pin.version, '-R', pin.repository,
      '-p', asset.name, '-D', scratch,
    ]);
    chmodSync(binary, 0o755);
  }
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
  assert.equal(actual, asset.sha256, `asc ${pin.version} ${host} SHA-256 mismatch`);
  assert.match(run(binary, ['--version']), new RegExp(`^${pin.version.replaceAll('.', '\\.')}\\b`, 'u'));
  for (const command of [
    ['builds', 'upload'], ['builds', 'list'], ['builds', 'add-groups'],
  ]) {
    const help = run(binary, [...command, '--help']);
    assert.match(help, /--output\s+Output format: json/u);
  }
  const json = JSON.parse(run(binary, ['capabilities', '--output', 'json']));
  assert.ok(json.capabilities?.some((entry) =>
    entry.area === 'builds' && entry.status === 'cli-supported'
      && entry.commands?.includes('asc builds upload')));
  const usageError = spawnSync(binary, ['builds', 'list', '--not-a-flag', '--output', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, ASC_TELEMETRY_DISABLED: '1', ASC_BYPASS_KEYCHAIN: '1' },
    timeout: 30_000,
  });
  assert.equal(usageError.error, undefined, `${binary}: ${usageError.error?.message}`);
  assert.equal(usageError.status, 2, 'invalid asc flags should use exit code 2');
  process.stdout.write(`asc ${pin.version} ${host}: checksum, JSON capability, help, exit code passed\n`);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
