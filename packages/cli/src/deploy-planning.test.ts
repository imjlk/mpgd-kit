import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  doctorNativeDeployment,
  initializeDeployConfig,
  parseDeployTargets,
  planNativeDeployment,
  readNativeDeploymentPlan,
  readNativeDeployTargetProfile,
  writeNativeDeploymentPlan,
} from './deploy-planning.js';
import { runMpgdCli } from './index.js';
import { runNativeDeployment, withoutStoreSubmissionCredentials } from './native-deploy-run.js';

const fixture = mkdtempSync(join(tmpdir(), 'mpgd-deploy-planning-'));
const game = join(fixture, 'game');

try {
  mkdirSync(join(game, 'apps/mobile'), { recursive: true });
  writeFileSync(join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
  const targetsFile = join(game, 'mpgd.targets.json');
  const targets = {
    targets: {
      android: {
        kind: 'capacitor-android',
        adapter: 'capacitor',
        artifact: 'aab',
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.game' },
      },
      ios: {
        kind: 'capacitor-ios',
        adapter: 'capacitor',
        artifact: 'ipa',
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { bundleId: 'dev.mpgd.game' },
      },
    },
  };
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  const configFile = initializeDeployConfig(game);
  assert.equal(existsSync(configFile), true);
  assert.throws(() => initializeDeployConfig(game), /EEXIST/u);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(Object.keys(config.profiles.beta.targets), ['android', 'ios']);
  assert.equal(config.profiles.beta.buildProfile, 'production');
  assert.equal(config.profiles.beta.approval, 'manual');
  assert.equal(JSON.stringify(config).includes('dev.mpgd.game'), false);

  const before = readdirSync(game).sort();
  const androidPlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  assert.equal(androidPlan.targets[0]?.appId, 'dev.mpgd.game');
  assert.equal(androidPlan.targets[0]?.destination, 'play-internal');
  assert.equal(
    androidPlan.targetConfigSha256,
    createHash('sha256').update(readFileSync(targetsFile)).digest('hex'),
  );
  assert.deepEqual(readdirSync(game).sort(), before, 'planning must not modify game files');
  assert.throws(() => planNativeDeployment({ game, profile: 'beta' }), /testGroup/u);
  config.profiles.beta.targets.ios.testGroup = 'Internal QA';
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  assert.throws(() => planNativeDeployment({ game, profile: 'beta' }), /group ID/u);
  config.profiles.beta.targets.ios.testGroup = 'group-1';
  config.profiles.alternate = {
    buildProfile: 'production',
    approval: 'manual',
    targets: {
      ios: {
        ...config.profiles.beta.targets.ios,
        submissionCredential: { env: 'CUSTOM_ALT_STORE_KEY' },
      },
    },
  };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const plan = planNativeDeployment({ game, profile: 'beta' });
  const buildEnvironment = withoutStoreSubmissionCredentials(
    {
      MPGD_ASC_API_KEY: 'secret-asc-key',
      MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT: '/private/service-account.json',
      MPGD_ASC_KEY_ID: 'secret-key-id',
      MPGD_ANDROID_UPLOAD_STORE_PASSWORD: 'secret-signing-password',
      MPGD_IOS_SIGNING_P12_PASSWORD: 'secret-p12-password',
      APP_VERSION: '1.0.0',
    },
    plan,
  );
  assert.equal(buildEnvironment.MPGD_ASC_API_KEY, undefined);
  assert.equal(buildEnvironment.MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT, undefined);
  assert.equal(buildEnvironment.MPGD_ASC_KEY_ID, undefined);
  assert.equal(buildEnvironment.MPGD_ANDROID_UPLOAD_STORE_PASSWORD, undefined);
  assert.equal(buildEnvironment.MPGD_IOS_SIGNING_P12_PASSWORD, undefined);
  assert.equal(buildEnvironment.APP_VERSION, '1.0.0');
  const androidOnlyPlan = planNativeDeployment({ game, profile: 'beta', targets: ['android'] });
  const unselectedCredential = withoutStoreSubmissionCredentials(
    {
      MPGD_ASC_API_KEY: 'unselected-ios-secret',
      MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT: 'selected-android-secret',
      CUSTOM_ALT_STORE_KEY: 'unselected-profile-secret',
    },
    androidOnlyPlan,
  );
  assert.equal(unselectedCredential.MPGD_ASC_API_KEY, undefined);
  assert.equal(unselectedCredential.MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT, undefined);
  assert.equal(unselectedCredential.CUSTOM_ALT_STORE_KEY, undefined);
  assert.deepEqual(
    plan.targets.map((target) => target.target),
    ['android', 'ios'],
  );
  assert.equal(plan.targets[1]?.testGroup, 'group-1');
  assert.equal(JSON.stringify(plan).includes('MPGD_ASC_API_KEY'), false);
  const output = join(game, 'release-plan.json');
  writeNativeDeploymentPlan(output, plan);
  assert.throws(() => writeNativeDeploymentPlan(output, plan), /EEXIST/u);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), plan);
  assert.deepEqual(readNativeDeploymentPlan(output), plan);
  const movedGame = join(fixture, 'moved-game');
  cpSync(game, movedGame, { recursive: true });
  assert.deepEqual(
    readNativeDeploymentPlan(output, movedGame),
    { ...plan, gameRoot: realpathSync(movedGame) },
    'an unchanged saved plan can move with a game checkout',
  );
  assert.equal(
    readNativeDeployTargetProfile(plan, 'ios').submissionCredential.env,
    'MPGD_ASC_API_KEY',
  );
  const tamperedPlan = join(game, 'tampered-release-plan.json');
  writeFileSync(
    tamperedPlan,
    `${JSON.stringify({ ...plan, approval: 'preapproved-internal-test' })}\n`,
  );
  assert.throws(() => readNativeDeploymentPlan(tamperedPlan), /differs from current/u);
  const cliOutput = join(game, 'cli-release-plan.json');
  await runMpgdCli([
    'deploy',
    'plan',
    '--game',
    game,
    '--profile',
    'beta',
    '--targets',
    'android',
    '--out',
    cliOutput,
  ]);
  assert.equal(JSON.parse(readFileSync(cliOutput, 'utf8')).targets[0].target, 'android');

  const doctor = doctorNativeDeployment({
    game,
    profile: 'beta',
    targets: ['android'],
    environment: {},
  });
  assert.equal(doctor.healthy, false);
  await assert.rejects(
    runNativeDeployment({
      plan,
      gameId: 'test',
      gameVersion: '1.0.0',
      releaseKey: 'beta-001',
      kit: { packageVersion: '0.35.0', gitSha: 'a'.repeat(40) },
      approved: true,
      environment: {},
    }),
    /not a git repository/u,
  );
  assert.ok(doctor.checks.some((check) => check.name === 'JDK'));
  assert.ok(doctor.checks.some((check) => check.name === 'Android SDK'
    && check.status === 'missing'));
  assert.ok(doctor.checks.some((check) => check.name === 'android signing credential'
    && check.status === 'missing'));
  assert.equal(
    doctor.checks.some((check) => check.detail.includes('secret-value')),
    false,
  );
  const conflictingSdk = doctorNativeDeployment({
    game,
    profile: 'beta',
    targets: ['android'],
    environment: { ANDROID_HOME: '/tmp/android-a', ANDROID_SDK_ROOT: '/tmp/android-b' },
  });
  assert.ok(conflictingSdk.checks.some((check) => check.name === 'Android SDK'
    && check.detail.includes('different directories')));
  const invalidJavaHome = doctorNativeDeployment({
    game,
    profile: 'beta',
    targets: ['android'],
    environment: { JAVA_HOME: join(fixture, 'missing-jdk') },
  });
  assert.ok(invalidJavaHome.checks.some((check) => check.name === 'JDK'
    && check.status === 'missing'));
  if (process.platform !== 'win32') {
    const sdk = join(fixture, 'android-sdk');
    const sdkAlias = join(fixture, 'android-sdk-link');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    mkdirSync(join(sdk, 'platforms'), { recursive: true });
    mkdirSync(join(sdk, 'build-tools'), { recursive: true });
    writeFileSync(join(sdk, 'platforms', 'installed'), 'yes');
    writeFileSync(join(sdk, 'build-tools', 'installed'), 'yes');
    symlinkSync(sdk, sdkAlias, 'dir');
    const aliasedSdk = doctorNativeDeployment({
      game,
      profile: 'beta',
      targets: ['android'],
      environment: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdkAlias },
    });
    assert.ok(aliasedSdk.checks.some((check) => check.name === 'Android SDK'
      && check.status === 'ok'));
  }

  assert.deepEqual(parseDeployTargets('android,ios'), ['android', 'ios']);
  assert.throws(() => parseDeployTargets('android,android'), /duplicates/u);
  assert.throws(() => parseDeployTargets('web'), /--targets/u);
  assert.throws(() => planNativeDeployment({ game, profile: 'unknown' }), /Unknown/u);
  assert.throws(() => planNativeDeployment({ game, profile: '__proto__' }), /Unknown/u);
  config.profiles.beta.targets.android.submissionCredential.token = 'secret-value';
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /Invalid deployment target/u,
  );
  delete config.profiles.beta.targets.android.submissionCredential.token;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  targets.targets.android.webDir = 'apps/other/www';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /webDir must be inside its shellApp/u,
  );
  targets.targets.android.webDir = 'apps/mobile/www';
  targets.targets.android.adapter = '';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /Invalid android target/u,
  );
  targets.targets.android.adapter = 'capacitor';
  targets.targets.android.artifact = 'apk';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /Invalid android target/u,
  );
  targets.targets.android.artifact = 'aab';
  targets.targets.android.metadata.packageId = ' dev.mpgd.game ';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /lowercase reverse-domain/u,
  );
  targets.targets.android.metadata.packageId = 'dev.mpgd.game';
  targets.targets.android.shellApp = '../outside';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /must stay inside/u,
  );
  targets.targets.android.shellApp = '${MPGD_KIT_PATH}/apps/mobile';
  writeFileSync(targetsFile, `${JSON.stringify(targets, null, 2)}\n`);
  assert.throws(
    () => planNativeDeployment({ game, profile: 'beta', targets: ['android'] }),
    /Kit checkout/u,
  );
  console.info('Game-owned native deploy planning passed.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
