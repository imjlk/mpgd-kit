import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  prepareAndroidUploadSigningSession,
  withAndroidUploadSigningSession,
} from './android-signing-session.js';

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-android-signing-test-'));
const sessions = path.join(fixture, 'sessions');
const keystore = path.join(fixture, 'upload.jks');
const storePassword = 'throwaway-store-password';
const keyPassword = 'throwaway-key-password';
const keyAlias = 'mpgd-upload';

function keytool(args: readonly string[]): string {
  const result = spawnSync('keytool', [...args], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  mkdirSync(sessions);
  keytool([
    '-genkeypair',
    '-noprompt',
    '-alias',
    keyAlias,
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '30',
    '-dname',
    'CN=mpgd-test,O=mpgd,C=US',
    '-keystore',
    keystore,
    '-storetype',
    'JKS',
    '-storepass',
    storePassword,
    '-keypass',
    keyPassword,
  ]);
  const description = keytool([
    '-J-Duser.language=en',
    '-list',
    '-v',
    '-keystore',
    keystore,
    '-alias',
    keyAlias,
    '-storepass',
    storePassword,
  ]);
  const fingerprint = /\bSHA256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/u
    .exec(description)?.[1]?.replace(/:/gu, '').toUpperCase();
  assert.match(fingerprint ?? '', /^[0-9A-F]{64}$/u);
  const input = {
    keystoreFile: keystore,
    storePassword,
    keyPassword,
    keyAlias,
    expectedCertSha256: fingerprint ?? '',
    temporaryParent: sessions,
  };
  const prepared = await prepareAndroidUploadSigningSession(input);
  assert.equal(existsSync(prepared.temporaryKeystore), true);
  assert.equal(prepared.environment.MPGD_ANDROID_UPLOAD_CERT_SHA256, fingerprint);
  assert.equal(prepared.environment.MPGD_ANDROID_SIGNING_INIT_SCRIPT, prepared.gradleInitScript);
  const script = readFileSync(prepared.gradleInitScript, 'utf8');
  assert.match(script, /mpgdUpload/u);
  assert.doesNotMatch(script, /throwaway-/u);
  if (process.platform !== 'win32') {
    assert.equal(statSync(prepared.temporaryKeystore).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(prepared.temporaryKeystore)).mode & 0o777, 0o700);
  }
  if (process.env.MPGD_TEST_ANDROID_GRADLE_SIGNING === '1'
    || process.env.MPGD_TEST_ANDROID_GRADLE_SIGNING === 'bundle') {
    const androidProject = path.resolve('apps/mobile-capacitor/android');
    const buildBundle = process.env.MPGD_TEST_ANDROID_GRADLE_SIGNING === 'bundle';
    const gradle = spawnSync(
      process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
      [
        buildBundle ? ':app:bundleRelease' : 'help',
        '--no-daemon',
        '--init-script',
        prepared.gradleInitScript,
      ],
      {
        cwd: androidProject,
        env: prepared.environment,
        encoding: 'utf8',
        timeout: 180_000,
      },
    );
    assert.equal(gradle.status, 0, `${gradle.stdout}\n${gradle.stderr}`);
    if (buildBundle) {
      const bundle = path.join(androidProject, 'app/build/outputs/bundle/release/app-release.aab');
      assert.equal(existsSync(bundle), true);
      const signed = spawnSync('jarsigner', ['-verify', '-verbose', bundle], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
      assert.match(signed.stdout, /jar verified\./u);
      const certificate = keytool(['-J-Duser.language=en', '-printcert', '-jarfile', bundle]);
      const signer = /\bSHA256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/u
        .exec(certificate)?.[1]?.replace(/:/gu, '').toUpperCase();
      assert.equal(signer, fingerprint);
    }
  }
  prepared.dispose();
  assert.deepEqual(readdirSync(sessions), []);

  await assert.rejects(
    prepareAndroidUploadSigningSession({ ...input, storePassword: 'wrong-store-password' }),
  );
  assert.deepEqual(readdirSync(sessions), []);
  await assert.rejects(
    prepareAndroidUploadSigningSession({ ...input, keyPassword: 'wrong-key-password' }),
  );
  assert.deepEqual(readdirSync(sessions), []);
  await assert.rejects(
    prepareAndroidUploadSigningSession({
      ...input,
      expectedCertSha256: 'F'.repeat(64),
    }),
    /certificate does not match/u,
  );
  assert.deepEqual(readdirSync(sessions), []);
  await assert.rejects(prepareAndroidUploadSigningSession({ ...input, keyAlias: 'wrong-alias' }));
  assert.deepEqual(readdirSync(sessions), []);
  await assert.rejects(
    withAndroidUploadSigningSession(input, async (session) => {
      assert.equal(existsSync(session.temporaryKeystore), true);
      throw new Error('cancelled build');
    }),
    /cancelled build/u,
  );
  assert.deepEqual(readdirSync(sessions), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareAndroidUploadSigningSession({ ...input, signal: controller.signal }),
    /aborted/u,
  );
  assert.deepEqual(readdirSync(sessions), []);
  console.info('Android upload signing session passed with a throwaway JKS key.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
