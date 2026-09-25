import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Tiny genuinely signed JAR fixture; an AAB is a signed ZIP/JAR container. */
export function createSignedAabFixture(outputFile: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'mpgd-aab-sign-fixture-'));
  const password = 'fixture-only-password';
  try {
    const keystore = path.join(directory, 'fixture.p12');
    const unsigned = path.join(directory, 'unsigned.aab');
    writeFileSync(path.join(directory, 'payload.txt'), 'test bundle payload');
    run('keytool', [
      '-genkeypair',
      '-alias',
      'fixture',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '2',
      '-dname',
      'CN=mpgd test fixture',
      '-storetype',
      'PKCS12',
      '-keystore',
      keystore,
      '-storepass',
      password,
      '-keypass',
      password,
      '-noprompt',
    ]);
    run('jar', ['--create', '--file', unsigned, '-C', directory, 'payload.txt']);
    run('jarsigner', [
      '-keystore',
      keystore,
      '-storepass',
      password,
      '-keypass',
      password,
      '-signedjar',
      outputFile,
      unsigned,
      'fixture',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Signed AAB fixture ${command} failed: ${result.stderr}`);
  }
}
