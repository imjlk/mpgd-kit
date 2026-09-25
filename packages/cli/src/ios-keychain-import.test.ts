import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-keychain-test-'));
const swiftFile = path.resolve('packages/cli/src/ios-keychain-import.swift');
const keychain = path.join(fixture, 'upload-signing.keychain-db');
const certificate = path.join(fixture, 'certificate.pem');
const privateKey = path.join(fixture, 'private-key.pem');
const pkcs12 = path.join(fixture, 'signing.p12');
const pkcs12Password = randomBytes(24).toString('hex');
const keychainPassword = randomBytes(24).toString('hex');

function run(command: string, args: readonly string[], environment = process.env): string {
  const result = spawnSync(command, [...args], {
    cwd: fixture,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

try {
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=mpgd-throwaway-signing',
    '-keyout',
    privateKey,
    '-out',
    certificate,
  ]);
  run(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-in',
      certificate,
      '-inkey',
      privateKey,
      '-out',
      pkcs12,
      '-passout',
      'env:MPGD_TEST_P12_PASSWORD',
    ],
    { ...process.env, MPGD_TEST_P12_PASSWORD: pkcs12Password },
  );
  const searchListBefore = run('security', ['list-keychains', '-d', 'user']);
  const environment = {
    ...process.env,
    MPGD_IOS_SESSION_KEYCHAIN: keychain,
    MPGD_IOS_SESSION_KEYCHAIN_PASSWORD: keychainPassword,
    MPGD_IOS_SIGNING_P12: pkcs12,
    MPGD_IOS_SIGNING_P12_PASSWORD: pkcs12Password,
  };
  const response = JSON.parse(run('swift', [swiftFile], environment)) as {
    readonly certificateSha256: string;
  };
  assert.match(response.certificateSha256, /^[0-9A-F]{64}$/u);
  assert.equal(existsSync(keychain), true);
  assert.equal(run('security', ['list-keychains', '-d', 'user']), searchListBefore);
  console.info('Isolated iOS keychain import passed with a throwaway P12.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
