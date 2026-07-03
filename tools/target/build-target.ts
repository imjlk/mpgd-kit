import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

import { readJsonFile } from '../io';

const [targetName = 'web-preview', profile = 'production'] = process.argv.slice(2);

interface BuildTargetConfig {
  readonly kind: 'web' | 'capacitor-android' | 'capacitor-ios' | 'apps-in-toss';
  readonly gameApp: string;
  readonly adapter: string;
  readonly output?: string;
  readonly shellApp?: string;
  readonly wrapperApp?: string;
  readonly webDir?: string;
  readonly artifact?: string;
}

interface BuildTargetsFile {
  readonly targets: Record<string, BuildTargetConfig>;
}

run('pnpm', ['validate:catalog'], process.env);
run('pnpm', ['validate:ads'], process.env);
run('pnpm', ['validate:policy'], process.env);
run('pnpm', ['validate:targets'], process.env);

const config = readJsonFile('platform.targets.json') as BuildTargetsFile;
const target = config.targets[targetName];

if (target === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

const appTarget = targetName === 'web-preview' ? 'browser' : targetName;
const env = {
  ...process.env,
  APP_TARGET: appTarget,
  APP_VERSION: process.env.APP_VERSION ?? '0.0.0',
  BUILD_ID: process.env.BUILD_ID ?? 'local',
};

run('pnpm', ['--dir', target.gameApp, 'exec', 'vite', 'build', '--mode', profile], env);

switch (target.kind) {
  case 'web': {
    const output = requireString(target.output, `${targetName}.output`);
    replaceDirectory(`${target.gameApp}/dist`, output);
    run('pnpm', ['manifest:release', targetName, profile, output], env);
    break;
  }

  case 'apps-in-toss': {
    const webDir = requireString(target.webDir, `${targetName}.webDir`);
    const wrapperApp = requireString(target.wrapperApp, `${targetName}.wrapperApp`);
    replaceDirectory(`${target.gameApp}/dist`, webDir);
    run('pnpm', ['--dir', wrapperApp, 'exec', 'vite', 'build', '--mode', profile], env);
    run('pnpm', ['manifest:release', targetName, profile, `${wrapperApp}/dist`], env);
    break;
  }

  case 'capacitor-android':
  case 'capacitor-ios': {
    const webDir = requireString(target.webDir, `${targetName}.webDir`);
    replaceDirectory(`${target.gameApp}/dist`, webDir);
    console.warn(
      `${targetName}: native project generation is not bootstrapped yet; copied web assets only.`,
    );
    run('pnpm', ['manifest:release', targetName, profile, webDir], env);
    break;
  }
}

function replaceDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function run(command: string, args: readonly string[], commandEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, [...args], {
    stdio: 'inherit',
    env: commandEnv,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing target config value: ${label}`);
  }

  return value;
}
