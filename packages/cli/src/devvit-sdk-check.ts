import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
const execFile = promisify(execFileCallback);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
function isFirstPartyDevvitPackage(name: string): boolean {
  return name === 'devvit' || name.startsWith('@devvit/');
}
function devvitPackageNames(dependencies: Record<string, unknown>): string[] {
  return Object.keys(dependencies).filter(isFirstPartyDevvitPackage);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid package metadata.');
  }
  return value as Record<string, unknown>;
}
export interface DevvitSdkVersion {
  readonly name: string;
  readonly declared: string;
  readonly installed: string;
  readonly latest: string;
  readonly source?: 'adapter';
}
export interface CheckDevvitSdkOptions {
  /** Test seam. Production looks up the npm `latest` dist-tag. */
  readonly lookupLatest?: (name: string) => Promise<string>;
}
async function npmLatestStable(name: string, cwd: string): Promise<string> {
  const { stdout } = await execFile(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', `${name}@latest`, 'version', '--json', '--registry=https://registry.npmjs.org'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 16_384,
      shell: process.platform === 'win32',
    },
  );
  return requireStableVersion(name, JSON.parse(stdout) as unknown);
}
function requireStableVersion(name: string, latest: unknown): string {
  if (typeof latest !== 'string' || !stable.test(latest)) {
    throw new Error('Registry did not return a stable Devvit version: ' + name);
  }
  return latest;
}
export function assertLatestDevvitSdk(entries: readonly DevvitSdkVersion[]): void {
  if (!entries.some((e) => e.name === 'devvit' || e.name === '@devvit/cli') || !entries.some((e) => e.name === '@devvit/web' || e.name === '@devvit/public-api')) {
    throw new Error('Devvit upload needs both an installed CLI and SDK in this project.');
  }
  for (const entry of entries) {
    if (!stable.test(entry.latest) || (entry.source !== 'adapter' && entry.declared !== entry.latest) || entry.installed !== entry.latest) {
      throw new Error(
        `${entry.name}: declared=${entry.declared}, installed=${entry.installed}, latest=${entry.latest}. Update exact SDK/CLI pins and lockfile, rebuild and test, then retry upload.`,
      );
    }
  }
}
/** Read-only pre-upload gate. Never install a new SDK between verified build and upload. */
export async function checkDevvitSdk(
  project: string,
  options: CheckDevvitSdkOptions = {},
): Promise<readonly DevvitSdkVersion[]> {
  const manifestPath = path.resolve(project, 'package.json');
  const manifest = record(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  const dependencies = {
    ...(manifest.dependencies === undefined ? {} : record(manifest.dependencies)),
    ...(manifest.devDependencies === undefined ? {} : record(manifest.devDependencies)),
  };
  async function installedPackage(from: string, name: string) {
    let directory = from;
    for (;;) {
      const file = path.join(directory, 'node_modules', name, 'package.json');
      try {
        const metadata = record(JSON.parse(await readFile(file, 'utf8')) as unknown);
        if (metadata.name !== name || typeof metadata.version !== 'string') {
          throw new Error('Invalid installed package: ' + name);
        }
        return { metadata, directory: path.dirname(await realpath(file)) };
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error('Cannot resolve installed Devvit package: ' + name);
      }
      directory = parent;
    }
  }
  const targetDirectory = path.dirname(manifestPath);
  const subjects = devvitPackageNames(dependencies).map((name) => ({
    name,
    declared: dependencies[name],
    directory: targetDirectory,
    transitive: false,
  }));
  if (Object.hasOwn(dependencies, '@mpgd/adapter-devvit')) {
    const adapter = await installedPackage(targetDirectory, '@mpgd/adapter-devvit');
    const adapterDependencies = record(adapter.metadata.dependencies);
    for (const name of devvitPackageNames(adapterDependencies)) {
      subjects.push({
        name,
        declared: adapterDependencies[name],
        directory: adapter.directory,
        transitive: true,
      });
    }
  }
  const entries = await Promise.all(subjects.map(async ({ name, declared, directory, transitive }) => {
    if (typeof declared !== 'string') { throw new Error('Invalid Devvit dependency: ' + name); }
    const resolved = await installedPackage(directory, name);
    const installed = resolved.metadata.version;
    if (typeof installed !== 'string') { throw new Error('Missing installed Devvit version: ' + name); }
    const latest = options.lookupLatest
      ? requireStableVersion(name, await options.lookupLatest(name))
      : await npmLatestStable(name, path.dirname(manifestPath));
    // A consumer may use a reviewed exact override until the adapter release catches up.
    return { name, declared, installed, latest, ...(transitive ? { source: 'adapter' as const } : {}) };
  }));
  assertLatestDevvitSdk(entries);
  return entries;
}
