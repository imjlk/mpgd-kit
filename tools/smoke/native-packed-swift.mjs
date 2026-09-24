import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginRoot = join(repoRoot, 'native-plugins/capacitor-game-services');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-packed-swift-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout ?? '';
}

try {
  run('pnpm', ['--dir', pluginRoot, 'pack', '--silent', '--pack-destination', fixtureRoot], repoRoot);
  const tarballs = readdirSync(fixtureRoot).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'The native plugin must produce one tarball.');
  run('tar', ['-xzf', join(fixtureRoot, tarballs[0]), '-C', fixtureRoot], repoRoot);
  const extracted = join(fixtureRoot, 'package');
  const privacy = join(extracted, 'ios/Sources/CapacitorGameServices/PrivacyInfo.xcprivacy');
  assert.ok(existsSync(privacy), 'Packed Swift target is missing its privacy manifest.');
  run('plutil', ['-lint', privacy], extracted);
  const description = JSON.parse(run('swift', ['package', 'dump-package', '--package-path', extracted], extracted));
  const target = description.targets.find((item) => item.name === 'MpgdCapacitorGameServices');
  assert.ok(target, 'Packed Swift package target is missing.');
  assert.ok(target.resources?.some((resource) =>
    resource.path === 'PrivacyInfo.xcprivacy' && resource.rule?.process !== undefined),
  'Packed Swift target does not process the privacy resource.');
  console.log('Packed Swift Package and privacy resource passed.');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
