import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-native-cli-consumer-'));
const packRoot = join(fixtureRoot, 'packs');
const gameRoot = join(fixtureRoot, 'game');
const syncIos = process.argv.includes('--sync-ios');
const releaseSimulation = process.argv.includes('--release-simulation');

function run(command, args, cwd, env = process.env, timeout = 300_000) {
  const pnpmScript = command === 'pnpm' && process.platform === 'win32'
    ? process.env.npm_execpath
    : undefined;
  if (command === 'pnpm' && process.platform === 'win32') {
    assert.match(pnpmScript ?? '', /\.[cm]?js$/u,
      'On Windows, launch this smoke through pnpm.');
  }
  const executable = pnpmScript === undefined ? command : process.execPath;
  const commandArgs = pnpmScript === undefined ? args : [pnpmScript, ...args];
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  return result;
}

function mustRun(command, args, cwd, env = process.env, timeout = 300_000) {
  const result = run(command, args, cwd, env, timeout);
  assert.equal(result.status, 0, [
    `${command} ${args.join(' ')} failed in ${cwd}`,
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n'));
  return result.stdout ?? '';
}

try {
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(gameRoot, { recursive: true });
  mustRun('pnpm', [
    '--dir', join(repoRoot, 'packages/cli'), 'pack', '--silent', '--pack-destination', packRoot,
  ], repoRoot);
  const tarballs = readdirSync(packRoot).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'expected one @mpgd/cli tarball');
  const tarball = join(packRoot, tarballs[0]);
  const adapterVersion = JSON.parse(readFileSync(
    join(repoRoot, 'adapters/capacitor/package.json'), 'utf8',
  )).version;
  writeFileSync(join(gameRoot, 'package.json'), `${JSON.stringify({
    name: 'mpgd-external-native-consumer',
    private: true,
    version: '1.2.3',
    packageManager: 'pnpm@11.7.0',
    type: 'module',
    dependencies: {
      '@capacitor/app': '8.1.1',
      '@capacitor/core': '8.5.2',
      '@mpgd/adapter-capacitor': adapterVersion,
    },
    devDependencies: {
      '@capacitor/cli': '8.5.2',
      '@mpgd/cli': `file:${tarball}`,
      vite: '8.1.3',
    },
  }, null, 2)}\n`);
  writeFileSync(join(gameRoot, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    "  - 'apps/*'",
    'allowBuilds:',
    '  esbuild: true',
    '  sharp: true',
    '',
  ].join('\n'));
  writeFileSync(join(gameRoot, '.gitignore'), [
    'node_modules/', 'dist/', 'artifacts/', 'release-output/',
    '.mpgd.targets.generated.json', 'apps/*/node_modules/', '',
  ].join('\n'));
  writeFileSync(join(gameRoot, 'index.html'), [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"></head>',
    '<body><div id="game">external native consumer</div></body></html>',
    '',
  ].join('\n'));
  mkdirSync(join(gameRoot, 'public'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/cli/templates/phaser-game/public/icon.svg'),
    join(gameRoot, 'public/icon.svg'),
  );
  copyFileSync(
    join(repoRoot, 'packages/cli/templates/phaser-game/mpgd.game.json'),
    join(gameRoot, 'mpgd.game.json'),
  );
  copyFileSync(join(repoRoot, 'packages/catalog/catalog.json'), join(gameRoot, 'mpgd.catalog.json'));
  copyFileSync(
    join(repoRoot, 'packages/catalog/placements.json'),
    join(gameRoot, 'mpgd.ad-placements.json'),
  );
  writeFileSync(join(gameRoot, 'mpgd.targets.json'), `${JSON.stringify({
    targets: {
      android: {
        kind: 'capacitor-android',
        gameApp: '.',
        shellApp: 'apps/mobile-capacitor',
        webDir: 'apps/mobile-capacitor/www',
        adapter: 'capacitor',
        artifact: 'aab',
        icon: { profile: 'android' },
        metadata: { appName: 'External Game', packageId: 'dev.mpgd.externalgame' },
      },
      ios: {
        kind: 'capacitor-ios',
        gameApp: '.',
        shellApp: 'apps/mobile-capacitor',
        webDir: 'apps/mobile-capacitor/www',
        adapter: 'capacitor',
        artifact: 'ipa',
        icon: { profile: 'ios' },
        metadata: { appName: 'External Game', bundleId: 'dev.mpgd.externalgame' },
      },
    },
  }, null, 2)}\n`);
  mustRun('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
  const cliDist = join(gameRoot, 'node_modules/@mpgd/cli/dist');
  const ascPin = JSON.parse(readFileSync(join(cliDist, 'asc-pin.json'), 'utf8'));
  assert.equal(ascPin.version, '5.5.0');
  assert.equal(existsSync(join(cliDist, 'ios-ipa-inspection.js')), true);
  const installedCli = await import(pathToFileURL(join(cliDist, 'index.js')).href);
  assert.equal(typeof installedCli.submitVerifiedIosBuild, 'function');
  assert.equal(typeof installedCli.runNativeDeployment, 'function');
  assert.equal(typeof installedCli.submitRecordedNativeTarget, 'function');
  assert.equal(typeof installedCli.readNativeReleaseStatus, 'function');
  mustRun('git', ['init', '--object-format=sha1', '-q'], gameRoot);
  mustRun('git', ['add', '.'], gameRoot);
  mustRun('git', [
    '-c', 'user.name=mpgd-test', '-c', 'user.email=mpgd-test@example.invalid',
    'commit', '-qm', 'external game fixture',
  ], gameRoot);
  const env = { ...process.env };
  delete env.MPGD_KIT_PATH;
  delete env.MPGD_NATIVE_BUILD_MODE;
  const result = run('pnpm', [
    'exec', 'mpgd', 'target', 'build', 'ios', 'production',
    '--targets-file', join(gameRoot, 'mpgd.targets.json'),
  ], gameRoot, env);
  assert.notEqual(result.status, 0, 'production build without an explicit mode must fail');
  assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    /Production native builds require an explicit MPGD_NATIVE_BUILD_MODE/u);
  assert.doesNotMatch(`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    /Could not detect an mpgd-kit checkout|Expected an mpgd-kit checkout/u);
  const installedInfo = JSON.parse(readFileSync(join(
    gameRoot, 'node_modules/@mpgd/cli/dist/native-build-info.json',
  ), 'utf8'));
  assert.match(installedInfo.kitGitSha, /^[0-9a-f]{40}$/u);
  assert.equal(installedInfo.kitDirty, false, 'packed native builds require a clean Kit commit');
  assert.equal(existsSync(join(gameRoot, '.mpgd.targets.generated.json')), true);

  const invalidTargets = JSON.parse(readFileSync(join(gameRoot, 'mpgd.targets.json'), 'utf8'));
  invalidTargets.targets.ios.shellApp = '${MPGD_GAME_ROOT}/../outside-shell';
  const invalidTargetsFile = join(gameRoot, 'mpgd.invalid.targets.json');
  writeFileSync(invalidTargetsFile, `${JSON.stringify(invalidTargets, null, 2)}\n`);
  const escapedShell = run('pnpm', [
    'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
    '--targets-file', invalidTargetsFile,
  ], gameRoot, env);
  assert.notEqual(escapedShell.status, 0, 'a shell outside the game must be rejected');
  assert.match(`${escapedShell.stdout ?? ''}\n${escapedShell.stderr ?? ''}`,
    /shellApp must stay inside its game project/u);
  if (process.platform !== 'win32') {
    const linkedShell = join(gameRoot, 'linked-shell');
    symlinkSync(fixtureRoot, linkedShell, 'dir');
    invalidTargets.targets.ios.shellApp = 'linked-shell/not-created-yet';
    writeFileSync(invalidTargetsFile, `${JSON.stringify(invalidTargets, null, 2)}\n`);
    const symlinkEscape = run('pnpm', [
      'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
      '--targets-file', invalidTargetsFile,
    ], gameRoot, env);
    assert.notEqual(symlinkEscape.status, 0, 'a symlink ancestor outside the game must be rejected');
    assert.match(`${symlinkEscape.stdout ?? ''}\n${symlinkEscape.stderr ?? ''}`,
      /shellApp must stay inside its game project/u);
    unlinkSync(linkedShell);
  }

  mustRun('pnpm', [
    'exec', 'mpgd', 'target', 'init', 'capacitor',
    '--game', gameRoot,
    '--app-id', 'dev.mpgd.externalgame',
    '--display-name', 'External Game',
  ], gameRoot);
  mustRun('pnpm', ['install', '--no-frozen-lockfile'], gameRoot);
  mustRun('git', ['add', '.'], gameRoot);
  mustRun('git', [
    '-c', 'user.name=mpgd-test', '-c', 'user.email=mpgd-test@example.invalid',
    'commit', '-qm', 'game-owned shell',
  ], gameRoot);
  if (syncIos) {
    if (process.platform !== 'darwin') {
      throw new Error('--sync-ios requires a macOS host.');
    }
    mustRun('pnpm', [
      'exec', 'mpgd', 'target', 'build', 'ios', 'staging',
      '--targets-file', join(gameRoot, 'mpgd.targets.json'),
    ], gameRoot, { ...env, MPGD_NATIVE_BUILD_MODE: 'sync' }, 600_000);
    const manifest = JSON.parse(readFileSync(
      join(gameRoot, 'artifacts/release-manifest.json'), 'utf8',
    ));
    assert.equal(manifest.kitGitSha, installedInfo.kitGitSha);
    assert.ok(manifest.targets?.ios);
    assert.ok(existsSync(join(gameRoot, manifest.targets.ios.artifact)));
  }
  mustRun('pnpm', ['exec', 'mpgd', 'deploy', 'init', '--game', gameRoot], gameRoot);
  const deployPlanFile = join(gameRoot, 'release-plan.json');
  mustRun('pnpm', [
    'exec', 'mpgd', 'deploy', 'plan', '--game', gameRoot,
    '--profile', 'beta', '--targets', 'android', '--out', deployPlanFile,
  ], gameRoot);
  const deployPlan = JSON.parse(readFileSync(deployPlanFile, 'utf8'));
  assert.equal(deployPlan.targets[0]?.target, 'android');
  assert.equal(deployPlan.targets[0]?.appId, 'dev.mpgd.externalgame');
  assert.equal(JSON.stringify(deployPlan).includes('MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT'), false);
  mustRun('pnpm', [
    'exec', 'mpgd', 'deploy', 'workflow', 'init', '--game', gameRoot,
    '--profile', 'beta', '--targets', 'android', '--release-branch', 'main',
  ], gameRoot);
  const workflows = readdirSync(join(gameRoot, '.github/workflows'));
  assert.equal(workflows.length, 1);
  const workflow = readFileSync(join(gameRoot, '.github/workflows', workflows[0]), 'utf8');
  assert.match(workflow, /deploy_android:/u);
  assert.doesNotMatch(workflow, /deploy_ios:/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: 'native-beta'/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  if (releaseSimulation) {
    await verifyPackedReleaseSimulation(installedCli, cliDist, gameRoot, fixtureRoot, env);
  }
  const nestedRoot = join(fixtureRoot, 'nested-workspace');
  const nestedGame = join(nestedRoot, 'games', 'alpha');
  mkdirSync(nestedGame, { recursive: true });
  writeFileSync(join(nestedRoot, 'package.json'), JSON.stringify({
    name: 'game-monorepo', private: true, packageManager: 'pnpm@11.7.0',
  }));
  writeFileSync(join(nestedRoot, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - 'games/*'",
    'allowBuilds:',
    '  esbuild: true',
    '',
  ].join('\n'));
  writeFileSync(join(nestedGame, 'package.json'), JSON.stringify({
    name: 'nested-game',
    private: true,
    devDependencies: { '@mpgd/cli': `file:${tarball}` },
  }));
  mustRun('pnpm', ['install', '--no-frozen-lockfile'], nestedRoot);
  mustRun('pnpm', ['--dir', nestedGame, 'exec', 'mpgd', '--help'], nestedRoot);
  let modeLabel = 'validation';
  if (syncIos) {
    modeLabel = 'iOS sync';
  }
  if (releaseSimulation) {
    modeLabel = 'mock release';
  }
  console.info(`External @mpgd/cli native ${modeLabel} passed.`);
} finally {
  if (process.env.MPGD_KEEP_NATIVE_CONSUMER !== '1') {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } else {
    console.info(`Kept external native consumer at ${fixtureRoot}`);
  }
}

async function verifyPackedReleaseSimulation(cli, cliDist, game, fixture, env) {
  const remote = join(fixture, 'release-state.git');
  mustRun('git', ['init', '--bare', '--object-format=sha1', '-q', remote], fixture);
  mustRun('git', ['remote', 'add', 'origin', remote], game);
  const configFile = join(game, 'mpgd.deploy.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.profiles.beta.targets.ios.testGroup = 'group-1';
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  mustRun('git', ['add', '.'], game);
  mustRun('git', [
    '-c', 'user.name=mpgd-test', '-c', 'user.email=mpgd-test@example.invalid',
    'commit', '-qm', 'release profile',
  ], game);
  const gameSha = mustRun('git', ['rev-parse', 'HEAD'], game).trim();
  const planFile = join(fixture, 'packed-release-plan.json');
  mustRun('pnpm', [
    'exec', 'mpgd', 'deploy', 'plan', '--game', game, '--profile', 'beta',
    '--targets', 'android,ios', '--out', planFile,
  ], game, env);
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  assert.deepEqual(plan.targets.map((entry) => entry.target), ['android', 'ios']);
  assert.equal(plan.targets[1].testGroup, 'group-1');
  const kit = JSON.parse(readFileSync(join(cliDist, 'native-build-info.json'), 'utf8'));
  const releaseKey = 'packed-beta-001';
  const stateInput = { gameRoot: game, gameId: 'external-game', releaseKey, environment: env };
  const reservationInput = {
    ...stateInput,
    gameVersion: '1.2.3',
    sourceGitSha: gameSha,
    kitGitSha: kit.kitGitSha,
    targetConfigDigest: plan.targetConfigSha256,
    targets: [{ target: 'android' }, { target: 'ios' }],
    initialLedger: {
      schemaVersion: 2,
      platforms: { android: { versionCode: 40 }, ios: { buildNumber: 50 } },
      releaseRevision: { lastAllocated: 0 },
    },
  };
  const reserved = await cli.reserveNativeRelease(reservationInput);
  assert.equal(reserved.reused, false);
  assert.equal(reserved.plan.targets.android.versionCode, 41);
  assert.equal(reserved.plan.targets.ios.buildNumber, 51);
  assert.equal((await cli.reserveNativeRelease(reservationInput)).reused, true);
  const signer = await import(pathToFileURL(join(cliDist, 'android-bundle-signer.js')).href);
  const play = await import(pathToFileURL(join(cliDist, 'play-internal-submission.js')).href);
  const submit = await import(pathToFileURL(join(cliDist, 'native-deploy-submission.js')).href);
  const signing = join(fixture, 'fixture-signing');
  mkdirSync(signing);
  writeFileSync(join(signing, 'payload.txt'), 'mock Android bundle bytes');
  mustRun('keytool', [
    '-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '2', '-dname', 'CN=mpgd mock fixture', '-storetype', 'PKCS12',
    '-keystore', join(signing, 'fixture.p12'), '-storepass', 'fixture-only-password',
    '-keypass', 'fixture-only-password', '-noprompt',
  ], fixture, env);
  mustRun('jar', [
    '--create', '--file', join(signing, 'unsigned.aab'), '-C', signing, 'payload.txt',
  ], fixture, env);
  const androidSource = join(signing, 'signed.aab');
  mustRun('jarsigner', [
    '-keystore', join(signing, 'fixture.p12'), '-storepass', 'fixture-only-password',
    '-keypass', 'fixture-only-password', '-signedjar', androidSource,
    join(signing, 'unsigned.aab'), 'fixture',
  ], fixture, env);
  const outputDir = join(game, '.mpgd', 'releases', releaseKey);
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(androidSource, join(outputDir, 'android.aab'));
  writeFileSync(join(outputDir, 'ios.ipa'), 'mock IPA bytes; not an Apple-signed archive');
  const records = {};
  for (const target of ['android', 'ios']) {
    const artifactName = target === 'android' ? 'android.aab' : 'ios.ipa';
    const artifact = join(outputDir, artifactName);
    const planned = plan.targets.find((entry) => entry.target === target);
    const version = reserved.plan.targets[target];
    const digest = plan.targetConfigSha256;
    const manifest = {
      releaseId: `mpgd-${reserved.plan.releaseLabel}+${reserved.plan.buildId}`,
      gitSha: gameSha,
      kitGitSha: kit.kitGitSha,
      gameVersion: '1.2.3',
      buildId: reserved.plan.buildId,
      targetConfigVersion: '1',
      catalogVersion: '1',
      adPlacementVersion: '1',
      releaseIdentity: {
        gameVersion: '1.2.3',
        releaseRevision: reserved.plan.releaseRevision,
        label: reserved.plan.releaseLabel,
      },
      targets: {
        [target]: {
          artifact: artifactName,
          effectiveConfig: { path: 'effective.json', version: '1', digest },
          iconManifest: {
            path: 'icons.json', digest, sourceSha256: digest,
            sharedConfigSha256: digest, renderConfigSha256: digest,
            generatorVersion: '1', targetProfile: target, targetProfileVersion: '1',
          },
          profile: 'production',
          ...(target === 'android'
            ? { versionCode: version.versionCode, versionName: version.versionName }
            : { buildNumber: String(version.buildNumber),
                marketingVersion: version.marketingVersion }),
          nativeDelivery: {
            platform: target,
            mode: target === 'android' ? 'signed-archive' : 'store-export',
            signed: true,
            submissionCandidate: true,
          },
        },
      },
    };
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
    const manifestFile = join(outputDir, `${target}-manifest-${manifestHash}.json`);
    writeFileSync(manifestFile, manifestBytes);
    const recorded = await cli.recordNativeReleaseBuild({
      ...stateInput,
      target,
      buildRunId: `${target}-mock-build`,
      kitPackageVersion: kit.packageVersion,
      buildConfigDigest: digest,
      deployConfigSha256: plan.deployConfigSha256,
      deploymentProfile: plan.profile,
      deploymentDestination: planned.destination,
      ...(target === 'ios' ? { internalTestGroupId: planned.testGroup } : {}),
      artifactFile: artifact,
      expectedArtifactSha256: hashFile(artifact),
      artifactLocation: `.mpgd/releases/${releaseKey}/${artifactName}`,
      releaseManifestFile: manifestFile,
      expectedReleaseManifestSha256: manifestHash,
      inspectedAppId: planned.appId,
      ...(target === 'android'
        ? { inspectedSignerSha256: await signer.inspectAndroidBundleSigner(artifact) }
        : { inspectedTeamId: 'ABCDEFGHIJ' }),
    });
    records[target] = recorded.record;
  }
  const beforeSubmission = await cli.readNativeReleaseStatus(stateInput);
  assert.ok(beforeSubmission.builds.android && beforeSubmission.builds.ios);
  assert.deepEqual(beforeSubmission.submissions, {});
  let playApiCalls = 0;
  const fakePublisher = {
    async insertEdit() {
      playApiCalls += 1;
      return 'mock-play-edit';
    },
    async listBundles() {
      return [];
    },
    async uploadBundle() {
      return {
        versionCode: reserved.plan.targets.android.versionCode,
        sha256: records.android.artifactSha256,
      };
    },
    async getTrack() {
      return { track: 'internal', releases: [] };
    },
    async updateTrack() {},
    async validateEdit() {},
    async commitEdit() {},
  };
  let iosCalls = 0;
  const ports = {
    readStatus: cli.readNativeReleaseStatus,
    checkpoint: cli.checkpointNativeSubmission,
    reclaim: cli.reclaimNativeSubmission,
    releaseLease: cli.releaseNativeSubmissionLease,
    async submitAndroid(input) {
      return play.submitVerifiedAndroidBundleWithPublisher(input, fakePublisher);
    },
    async submitIos(input) {
      assert.equal(hashFile(input.ipaFile), input.record.artifactSha256);
      iosCalls += 1;
      if (iosCalls === 1) {
        await input.onUploadCommitted('mock-upload');
        throw new cli.IosSubmissionUncertainError('mock-upload');
      }
      assert.equal(input.resumeUploadId, 'mock-upload');
      return {
        status: iosCalls === 2 ? 'processing' : 'testflight-ready',
        appStoreAppId: '123456', bundleId: input.bundleId,
        marketingVersion: '1.2.3', buildNumber: '51',
        internalGroupId: input.internalGroupId,
        uploadId: 'mock-upload', buildId: 'mock-build',
      };
    },
  };
  const androidInput = {
    plan, gameId: stateInput.gameId, releaseKey,
    credential: { target: 'android', serviceAccountFile: '/mock-only.json' },
    approved: true, environment: { ...env, MPGD_VERIFY_RELEASE_MANIFEST: '1' },
  };
  const iosInput = {
    ...androidInput,
    credential: {
      target: 'ios', ascBinary: '/mock-only-asc', appStoreAppId: '123456',
      apiKeyId: 'ABCDEFGHIJ', apiIssuerId: 'mock-issuer',
      apiPrivateKeyBase64: 'mock-private-key',
    },
  };
  await assert.rejects(
    submit.submitRecordedNativeTargetWithPorts({ ...androidInput, approved: false }, ports),
    /explicit approval/u,
  );
  await assert.rejects(
    submit.submitRecordedNativeTargetWithPorts({
      ...iosInput,
      plan: { ...plan, targets: plan.targets.map((entry) => entry.target === 'ios'
        ? { ...entry, testGroup: 'wrong-group' } : entry) },
    }, ports),
    /matching immutable native build record/u,
  );
  const androidArtifact = join(outputDir, 'android.aab');
  writeFileSync(androidArtifact, 'changed bundle bytes');
  await assert.rejects(
    submit.submitRecordedNativeTargetWithPorts(androidInput, ports),
    /Google Play AAB bytes differ from the immutable build record/u,
  );
  assert.equal(playApiCalls, 0, 'invalid artifact must fail before a Play API call');
  copyFileSync(androidSource, androidArtifact);
  assert.equal((await submit.submitRecordedNativeTargetWithPorts(androidInput, ports)).status,
    'committed');
  await assert.rejects(
    submit.submitRecordedNativeTargetWithPorts(iosInput, ports),
    (error) => error instanceof cli.IosSubmissionUncertainError,
  );
  assert.equal((await cli.readNativeReleaseStatus(stateInput)).submissions.ios.status, 'unknown');
  assert.equal((await submit.submitRecordedNativeTargetWithPorts(iosInput, ports)).status,
    'processing');
  assert.equal((await submit.submitRecordedNativeTargetWithPorts(iosInput, ports)).status,
    'testflight-ready');
  const status = await cli.readNativeReleaseStatus(stateInput);
  assert.equal(status.submissions.android.status, 'committed');
  assert.equal(status.submissions.ios.status, 'testflight-ready');
  assert.equal((await cli.reserveNativeRelease(reservationInput)).reused, true);
  const printedStatus = mustRun('pnpm', [
    'exec', 'mpgd', 'deploy', 'status', '--game', game,
    '--game-id', stateInput.gameId, '--release', releaseKey,
  ], game, env);
  const statusJsonBoundary = printedStatus.lastIndexOf('\n{');
  assert.ok(statusJsonBoundary >= 0, 'deploy status must print a JSON object after its CLI banner');
  assert.equal(JSON.parse(printedStatus.slice(statusJsonBoundary + 1).trim())
    .submissions.ios.status, 'testflight-ready');
  assert.equal(records.android.artifactSha256, hashFile(androidArtifact));
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
