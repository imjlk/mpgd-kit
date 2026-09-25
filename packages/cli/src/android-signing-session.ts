import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runReleaseProcess } from './deploy-process.js';

export interface AndroidUploadSigningInput {
  readonly keystoreFile: string;
  readonly storePassword: string;
  readonly keyAlias: string;
  readonly keyPassword: string;
  readonly expectedCertSha256: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly temporaryParent?: string;
}

export interface AndroidUploadSigningSession {
  readonly environment: NodeJS.ProcessEnv;
  readonly expectedCertSha256: string;
  readonly temporaryKeystore: string;
  readonly gradleInitScript: string;
  readonly secretValues: readonly string[];
  dispose(): void;
}

const fingerprintPattern = /^[0-9A-F]{64}$/u;
const maximumKeystoreBytes = 64 * 1024 * 1024;
const initScript = `gradle.beforeProject { project ->
  if (project.path != ':app') return
  project.pluginManager.withPlugin('com.android.application') {
    def android = project.extensions.getByName('android')
    def signing = android.signingConfigs.findByName('mpgdUpload')
      ?: android.signingConfigs.create('mpgdUpload')
    signing.storeFile = project.file(System.getenv('MPGD_ANDROID_SIGNING_KEYSTORE'))
    signing.storePassword = System.getenv('MPGD_ANDROID_SIGNING_STORE_PASSWORD')
    signing.keyAlias = System.getenv('MPGD_ANDROID_SIGNING_KEY_ALIAS')
    signing.keyPassword = System.getenv('MPGD_ANDROID_SIGNING_KEY_PASSWORD')
    android.buildTypes.getByName('release').signingConfig = signing
  }
}
gradle.projectsEvaluated {
  def app = gradle.rootProject.findProject(':app')
  if (app == null || app.extensions.findByName('android') == null
      || app.extensions.getByName('android').buildTypes.getByName('release').signingConfig?.name
        != 'mpgdUpload') {
    throw new GradleException('The game shell did not accept mpgd upload signing.')
  }
}
`;

/** Restore one upload key to an owned temporary path and preflight its identity. */
export async function prepareAndroidUploadSigningSession(
  input: AndroidUploadSigningInput,
): Promise<AndroidUploadSigningSession> {
  const expectedCertSha256 = input.expectedCertSha256.replace(/:/gu, '').toUpperCase();
  const keyAlias = input.keyAlias.trim();
  if (!fingerprintPattern.test(expectedCertSha256) || keyAlias === ''
    || input.storePassword === '' || input.keyPassword === '') {
    throw new Error('Android upload signing requires an alias, passwords and SHA-256 certificate.');
  }
  const source = path.resolve(input.keystoreFile);
  let sourceStat: ReturnType<typeof statSync>;
  try {
    sourceStat = statSync(source);
  } catch {
    throw new Error(`Android upload keystore is missing or unreadable: ${source}`);
  }
  if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > maximumKeystoreBytes) {
    throw new Error('Android upload keystore must be a nonempty regular file under 64 MiB.');
  }
  const parent = input.temporaryParent ?? tmpdir();
  const ownedRoot = mkdtempSync(path.join(parent, 'mpgd-android-upload-'));
  const temporaryKeystore = path.join(ownedRoot, 'upload-keystore');
  const gradleInitScript = path.join(ownedRoot, 'upload-signing.init.gradle');
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
    MPGD_ANDROID_SIGNING_KEYSTORE: temporaryKeystore,
    MPGD_ANDROID_SIGNING_STORE_PASSWORD: input.storePassword,
    MPGD_ANDROID_SIGNING_KEY_ALIAS: keyAlias,
    MPGD_ANDROID_SIGNING_KEY_PASSWORD: input.keyPassword,
    MPGD_ANDROID_SIGNING_INIT_SCRIPT: gradleInitScript,
    MPGD_ANDROID_UPLOAD_CERT_SHA256: expectedCertSha256,
  };
  delete environment.MPGD_ANDROID_UPLOAD_KEYSTORE;
  const secretValues = [input.storePassword, input.keyPassword];
  try {
    if (process.platform !== 'win32') {
      chmodSync(ownedRoot, 0o700);
    }
    copyFileSync(source, temporaryKeystore);
    chmodSync(temporaryKeystore, 0o600);
    const javaHome = environment.JAVA_HOME?.trim();
    const keytoolExecutable = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
    const keytool = javaHome === undefined || javaHome === ''
      ? keytoolExecutable
      : path.join(javaHome, 'bin', keytoolExecutable);
    const listed = await runReleaseProcess({
      command: keytool,
      args: [
        '-J-Duser.language=en',
        '-list',
        '-v',
        '-keystore',
        temporaryKeystore,
        '-alias',
        keyAlias,
        '-storepass:env',
        'MPGD_ANDROID_SIGNING_STORE_PASSWORD',
      ],
      cwd: ownedRoot,
      environment,
      timeoutMs: 30_000,
      signal: input.signal,
      secretValues,
      captureMachineStdout: true,
    });
    if (listed.truncated || listed.machineStdout === undefined) {
      throw new Error('Android upload certificate inspection output was truncated.');
    }
    const observed = /\bSHA256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/u
      .exec(listed.machineStdout)?.[1]?.replace(/:/gu, '').toUpperCase();
    if (observed !== expectedCertSha256) {
      throw new Error('Android upload keystore certificate does not match the expected SHA-256.');
    }
    const typeListing = await runReleaseProcess({
      command: keytool,
      args: [
        '-J-Duser.language=en',
        '-list',
        '-keystore',
        temporaryKeystore,
        '-storepass:env',
        'MPGD_ANDROID_SIGNING_STORE_PASSWORD',
      ],
      cwd: ownedRoot,
      environment,
      timeoutMs: 30_000,
      signal: input.signal,
      secretValues,
      captureMachineStdout: true,
    });
    if (typeListing.truncated || typeListing.machineStdout === undefined) {
      throw new Error('Android upload keystore type inspection output was truncated.');
    }
    // -list -v with -alias omits the keystore type. PKCS12 ignores a distinct
    // key password during -certreq, so Gradle must receive the store password.
    if (/^Keystore type:\s*PKCS12\s*$/imu.test(typeListing.machineStdout)
      && input.keyPassword !== input.storePassword) {
      throw new Error(
        'PKCS12 upload signing requires the key password to equal the store password.',
      );
    }
    await runReleaseProcess({
      command: keytool,
      args: [
        '-J-Duser.language=en',
        '-certreq',
        '-keystore',
        temporaryKeystore,
        '-alias',
        keyAlias,
        '-file',
        path.join(ownedRoot, 'upload.csr'),
        '-storepass:env',
        'MPGD_ANDROID_SIGNING_STORE_PASSWORD',
        '-keypass:env',
        'MPGD_ANDROID_SIGNING_KEY_PASSWORD',
      ],
      cwd: ownedRoot,
      environment,
      timeoutMs: 30_000,
      signal: input.signal,
      secretValues,
    });
    writeFileSync(gradleInitScript, initScript, { flag: 'wx', mode: 0o600 });
    return {
      environment,
      expectedCertSha256,
      temporaryKeystore,
      gradleInitScript,
      secretValues,
      dispose() {
        removeOwnedSigningRoot(ownedRoot);
      },
    };
  } catch (error) {
    try {
      removeOwnedSigningRoot(ownedRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Android upload signing preparation and cleanup both failed.',
      );
    }
    throw error;
  }
}

/** Always remove the restored key after a build, failure, or cancellation. */
export async function withAndroidUploadSigningSession<T>(
  input: AndroidUploadSigningInput,
  action: (session: AndroidUploadSigningSession) => Promise<T>,
): Promise<T> {
  const session = await prepareAndroidUploadSigningSession(input);
  let outcome: { readonly ok: true; readonly value: T } | {
    readonly ok: false;
    readonly error: unknown;
  };
  try {
    outcome = { ok: true, value: await action(session) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    session.dispose();
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        'Android upload signing action and cleanup both failed.',
      );
    }
    throw cleanupError;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function removeOwnedSigningRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
