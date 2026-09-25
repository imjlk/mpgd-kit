import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  doctorNativeDeployment,
  initializeDeployConfig,
  parseDeployTargets,
  planNativeDeployment,
  writeNativeDeploymentPlan,
} from './deploy-planning.js';
import { runMpgdCli } from './index.js';

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
        gameApp: '.',
        shellApp: 'apps/mobile',
        webDir: 'apps/mobile/www',
        metadata: { packageId: 'dev.mpgd.game' },
      },
      ios: {
        kind: 'capacitor-ios',
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
  const plan = planNativeDeployment({ game, profile: 'beta' });
  assert.deepEqual(
    plan.targets.map((target) => target.target),
    ['android', 'ios'],
  );
  assert.equal(plan.targets[1]?.testGroup, 'Internal QA');
  assert.equal(JSON.stringify(plan).includes('MPGD_ASC_API_KEY'), false);
  const output = join(game, 'release-plan.json');
  writeNativeDeploymentPlan(output, plan);
  assert.throws(() => writeNativeDeploymentPlan(output, plan), /EEXIST/u);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), plan);
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
  assert.ok(doctor.checks.some((check) => check.name === 'android signing credential'
    && check.status === 'missing'));
  assert.equal(
    doctor.checks.some((check) => check.detail.includes('secret-value')),
    false,
  );

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
