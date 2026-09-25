import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type NativeDeployTarget = 'android' | 'ios';

export interface CredentialReference {
  readonly env: string;
}

export interface DeployTargetProfile {
  readonly destination: 'play-internal' | 'testflight';
  readonly signingCredential: CredentialReference;
  readonly submissionCredential: CredentialReference;
  readonly testGroup?: string;
}

export interface DeployProfile {
  readonly buildProfile: 'production';
  readonly approval: 'manual' | 'preapproved-internal-test';
  readonly targets: Partial<Record<NativeDeployTarget, DeployTargetProfile>>;
}

export interface DeployConfig {
  readonly schemaVersion: 1;
  readonly profiles: Record<string, DeployProfile>;
}

interface NativeTargetConfig {
  readonly kind: 'capacitor-android' | 'capacitor-ios';
  readonly shellApp: string;
  readonly webDir: string;
  readonly gameApp: string;
  readonly metadata?: {
    readonly packageId?: string;
    readonly bundleId?: string;
  };
}

export interface PlannedDeployTarget {
  readonly target: NativeDeployTarget;
  readonly destination: 'play-internal' | 'testflight';
  readonly appId: string;
  readonly testGroup?: string;
}

export interface NativeDeploymentPlan {
  readonly schemaVersion: 1;
  readonly gameRoot: string;
  readonly profile: string;
  readonly buildProfile: 'production';
  readonly approval: DeployProfile['approval'];
  readonly targetConfigSha256: string;
  readonly deployConfigSha256: string;
  readonly targets: readonly PlannedDeployTarget[];
}

export interface DeployDoctorCheck {
  readonly name: string;
  readonly status: 'ok' | 'missing' | 'warning';
  readonly detail: string;
}

export interface DeployDoctorResult {
  readonly checks: readonly DeployDoctorCheck[];
  readonly healthy: boolean;
}

const deploymentConfigName = 'mpgd.deploy.json';
const targetsConfigName = 'mpgd.targets.json';
const environmentName = /^[A-Z_][A-Z0-9_]*$/u;

export function initializeDeployConfig(game: string): string {
  const gameRoot = resolve(game);
  const targets = readNativeTargets(gameRoot);
  const profiles: DeployConfig['profiles'] = {
    beta: {
      buildProfile: 'production',
      approval: 'manual',
      targets: {
        ...(targets.android === undefined ? {} : {
          android: {
            destination: 'play-internal',
            signingCredential: { env: 'MPGD_ANDROID_UPLOAD_KEYSTORE' },
            submissionCredential: { env: 'MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT' },
          },
        }),
        ...(targets.ios === undefined ? {} : {
          ios: {
            destination: 'testflight',
            signingCredential: { env: 'MPGD_IOS_SIGNING_P12' },
            submissionCredential: { env: 'MPGD_ASC_API_KEY' },
          },
        }),
      },
    },
  };
  if (targets.android === undefined && targets.ios === undefined) {
    throw new Error('Deploy init requires an Android or iOS target in mpgd.targets.json.');
  }
  const file = join(gameRoot, deploymentConfigName);
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, profiles }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return file;
}

export function planNativeDeployment(input: {
  readonly game: string;
  readonly profile: string;
  readonly targets?: readonly NativeDeployTarget[];
}): NativeDeploymentPlan {
  const gameRoot = resolve(input.game);
  const deployFile = join(gameRoot, deploymentConfigName);
  const targetFile = join(gameRoot, targetsConfigName);
  const deployBytes = readFileSync(deployFile);
  const targetBytes = readFileSync(targetFile);
  const config = readDeployConfig(deployFile, deployBytes.toString('utf8'));
  if (!Object.hasOwn(config.profiles, input.profile)) {
    throw new Error(`Unknown deployment profile: ${input.profile}`);
  }
  const profile = config.profiles[input.profile];
  if (profile === undefined) {
    throw new Error(`Unknown deployment profile: ${input.profile}`);
  }
  const nativeTargets = readNativeTargets(gameRoot, targetBytes.toString('utf8'));
  const selected = input.targets ?? (Object.keys(profile.targets) as NativeDeployTarget[]);
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error('Select at least one unique Android or iOS deployment target.');
  }
  const targets = selected.map((target) => {
    if (target !== 'android' && target !== 'ios') {
      throw new Error(`Unsupported deployment target: ${target}`);
    }
    const targetProfile = profile.targets[target];
    const targetConfig = nativeTargets[target];
    if (targetProfile === undefined || targetConfig === undefined) {
      throw new Error(`Deployment profile ${input.profile} does not configure ${target}.`);
    }
    assertGameOwnedNativePaths(gameRoot, target, targetConfig);
    const appId = target === 'android'
      ? targetConfig.metadata?.packageId
      : targetConfig.metadata?.bundleId;
    if (appId === undefined || appId.trim() === '') {
      throw new Error(`${target} must have its app ID in mpgd.targets.json metadata.`);
    }
    if (target === 'ios' && targetProfile.testGroup === undefined) {
      throw new Error('TestFlight deployment requires a testGroup in mpgd.deploy.json.');
    }
    return {
      target,
      destination: targetProfile.destination,
      appId,
      ...(targetProfile.testGroup === undefined ? {} : { testGroup: targetProfile.testGroup }),
    };
  });
  return {
    schemaVersion: 1,
    gameRoot: realpathSync(gameRoot),
    profile: input.profile,
    buildProfile: profile.buildProfile,
    approval: profile.approval,
    targetConfigSha256: createHash('sha256').update(targetBytes).digest('hex'),
    deployConfigSha256: createHash('sha256').update(deployBytes).digest('hex'),
    targets,
  };
}

export function writeNativeDeploymentPlan(file: string, plan: NativeDeploymentPlan): void {
  writeFileSync(resolve(file), `${JSON.stringify(plan, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

export function doctorNativeDeployment(input: {
  readonly game: string;
  readonly profile: string;
  readonly targets?: readonly NativeDeployTarget[];
  readonly environment?: NodeJS.ProcessEnv;
}): DeployDoctorResult {
  const environment = input.environment ?? process.env;
  const checks: DeployDoctorCheck[] = [];
  let plan: NativeDeploymentPlan;
  try {
    plan = planNativeDeployment(input);
    checks.push({ name: 'deployment plan', status: 'ok', detail: 'Configuration is valid.' });
  } catch (error) {
    checks.push({
      name: 'deployment plan',
      status: 'missing',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { checks, healthy: false };
  }
  const config = readDeployConfig(join(resolve(input.game), deploymentConfigName));
  const profile = config.profiles[input.profile];
  if (profile === undefined) {
    throw new Error(`Unknown deployment profile: ${input.profile}`);
  }
  checks.push({
    name: 'Node.js',
    status: Number(process.versions.node.split('.')[0]) >= 24 ? 'ok' : 'missing',
    detail: `Running Node.js ${process.versions.node}; version 24 or later is required.`,
  });
  for (const target of plan.targets) {
    const entry = profile.targets[target.target];
    if (entry === undefined) {
      throw new Error(`Missing deployment profile target: ${target.target}`);
    }
    if (target.target === 'android') {
      checks.push(commandCheck('Java', 'java', ['-version']));
      const sdk = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
      checks.push({
        name: 'Android SDK',
        status: sdk !== undefined && existsSync(join(sdk, 'platform-tools')) ? 'ok' : 'missing',
        detail: sdk === undefined ? 'Set ANDROID_HOME or ANDROID_SDK_ROOT.' : `SDK path: ${sdk}`,
      });
    } else {
      checks.push(
        process.platform === 'darwin'
          ? commandCheck('Xcode', 'xcodebuild', ['-version'])
          : { name: 'Xcode', status: 'missing', detail: 'iOS builds require macOS and Xcode.' },
      );
    }
    for (const [purpose, credential] of [
      ['signing', entry.signingCredential],
      ['submission', entry.submissionCredential],
    ] as const) {
      checks.push({
        name: `${target.target} ${purpose} credential`,
        status: environment[credential.env] ? 'ok' : 'missing',
        detail: environment[credential.env]
          ? `Environment reference ${credential.env} is present; content is not validated.`
          : `Set the ${credential.env} environment reference.`,
      });
    }
  }
  return { checks, healthy: checks.every((check) => check.status !== 'missing') };
}

export function parseDeployTargets(value: string | undefined): readonly NativeDeployTarget[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const targets = value.split(',').map((target) => target.trim());
  if (targets.length === 0 || targets.some((target) => target !== 'android' && target !== 'ios')) {
    throw new Error('--targets must be android, ios, or android,ios.');
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error('--targets must not contain duplicates.');
  }
  return targets as NativeDeployTarget[];
}

function readDeployConfig(file: string, text?: string): DeployConfig {
  const raw = text === undefined ? readObject(file) : parseObject(text, file);
  if (raw.schemaVersion !== 1 || !isObject(raw.profiles)
    || !hasOnlyKeys(raw, ['schemaVersion', 'profiles'])) {
    throw new Error('mpgd.deploy.json must use schemaVersion 1 and contain profiles.');
  }
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || !isObject(value)
      || value.buildProfile !== 'production'
      || (value.approval !== 'manual' && value.approval !== 'preapproved-internal-test')
      || !isObject(value.targets)
      || !hasOnlyKeys(value, ['buildProfile', 'approval', 'targets'])) {
      throw new Error(`Invalid deployment profile: ${name}`);
    }
    for (const [target, entry] of Object.entries(value.targets)) {
      const destination = target === 'android' ? 'play-internal' : 'testflight';
      if ((target !== 'android' && target !== 'ios') || !isObject(entry)
        || entry.destination !== destination
        || !isCredentialReference(entry.signingCredential)
        || !isCredentialReference(entry.submissionCredential)
        || !hasOnlyKeys(entry, [
          'destination', 'signingCredential', 'submissionCredential', 'testGroup',
        ])
        || (entry.testGroup !== undefined
          && (target !== 'ios' || typeof entry.testGroup !== 'string'
            || entry.testGroup.trim() === ''))) {
        throw new Error(`Invalid deployment target ${target} in profile ${name}.`);
      }
    }
  }
  return raw as unknown as DeployConfig;
}

function readNativeTargets(
  gameRoot: string,
  text?: string,
): Partial<Record<NativeDeployTarget, NativeTargetConfig>> {
  const file = join(gameRoot, targetsConfigName);
  const raw = text === undefined ? readObject(file) : parseObject(text, file);
  if (!isObject(raw.targets)) {
    throw new Error('mpgd.targets.json must contain a targets object.');
  }
  const result: Partial<Record<NativeDeployTarget, NativeTargetConfig>> = {};
  for (const [target, kind] of [
    ['android', 'capacitor-android'],
    ['ios', 'capacitor-ios'],
  ] as const) {
    const value = raw.targets[target];
    if (value === undefined) {
      continue;
    }
    if (!isObject(value) || value.kind !== kind
      || typeof value.gameApp !== 'string'
      || typeof value.shellApp !== 'string'
      || typeof value.webDir !== 'string'
      || (value.metadata !== undefined && !isObject(value.metadata))) {
      throw new Error(`Invalid ${target} target in mpgd.targets.json.`);
    }
    if (isObject(value.metadata)) {
      const appId = target === 'android' ? value.metadata.packageId : value.metadata.bundleId;
      if (appId !== undefined && typeof appId !== 'string') {
        throw new Error(`Invalid ${target} app ID in mpgd.targets.json metadata.`);
      }
    }
    result[target] = value as unknown as NativeTargetConfig;
  }
  return result;
}

function assertGameOwnedNativePaths(
  gameRoot: string,
  target: NativeDeployTarget,
  config: NativeTargetConfig,
): void {
  const root = realpathSync(gameRoot);
  for (const field of ['gameApp', 'shellApp', 'webDir'] as const) {
    const value = config[field];
    if (value.includes('${MPGD_KIT_PATH}')) {
      throw new Error(
        `${target} ${field} still points to a Kit checkout; initialize a game-owned shell.`,
      );
    }
    const expanded = value
      .replaceAll('${MPGD_GAME_ROOT}', root)
      .replaceAll('${MPGD_GAME_APP_ROOT}', root);
    const candidate = resolve(root, expanded);
    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new Error(`Cannot resolve ${target} ${field}: ${value}`);
      }
      ancestor = parent;
    }
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, candidate));
    const fromRoot = relative(root, canonical);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`${target} ${field} must stay inside the game project.`);
    }
    if (field === 'shellApp' && !existsSync(join(candidate, 'package.json'))) {
      throw new Error(
        `${target} shellApp is missing its package.json; run mpgd target init capacitor.`,
      );
    }
  }
}

function readObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseObject(text, file);
}

function parseObject(text: string, file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(value)) {
    throw new Error(`Expected a JSON object in ${file}.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCredentialReference(value: unknown): value is CredentialReference {
  return isObject(value) && typeof value.env === 'string'
    && environmentName.test(value.env) && hasOnlyKeys(value, ['env']);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function commandCheck(name: string, command: string, args: readonly string[]): DeployDoctorCheck {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    name,
    status: result.status === 0 ? 'ok' : 'missing',
    detail: result.status === 0 ? `${command} is available.` : `${command} is unavailable.`,
  };
}
