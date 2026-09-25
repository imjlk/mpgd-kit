import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { compare, intersects, minVersion, satisfies, valid, validRange } from 'semver';

const execFile = promisify(execFileCallback);
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
type JsonObject = Record<string, unknown>;
type DependencySection = (typeof dependencySections)[number];

export interface PublishedKitPackage {
  readonly version: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalPeerDependencies?: readonly string[];
}
export type LatestKitPackageLookup = (name: string, gameRoot: string) => Promise<PublishedKitPackage>;
export interface KitUpgradeUpdate {
  readonly manifest: string;
  readonly section: DependencySection;
  readonly packageName: string;
  readonly current: string;
  readonly next: string;
  readonly latestVersion: string;
}
export interface KitUpgradePlan {
  readonly gameRoot: string;
  readonly updates: readonly KitUpgradeUpdate[];
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
  readonly manifestDigests: Readonly<Record<string, string>>;
  readonly targetConfigDigest: { readonly file: string; readonly sha256: string | null };
  readonly lockfileDigests: Readonly<Record<string, string>>;
  readonly workspaceRoots: readonly string[];
}
export interface KitUpgradeApplyResult {
  readonly manifests: readonly string[];
  readonly lockfiles: readonly string[];
}
export type KitUpgradeLockfileRunner = (workspaceRoot: string) => void;

export async function planKitUpgrade(
  gameDirectory: string,
  lookup: LatestKitPackageLookup = lookupPublishedKitPackage,
  targetsFileName?: string,
): Promise<KitUpgradePlan> {
  const gameRoot = realpathSync(path.resolve(gameDirectory));
  const gameManifest = path.join(gameRoot, 'package.json');
  if (!existsSync(gameManifest)) {
    throw new Error('Game package.json is missing: ' + gameManifest);
  }
  if (lstatSync(gameManifest).isSymbolicLink() || !inside(gameRoot, realpathSync(gameManifest))) {
    throw new Error('Refusing to update a linked game package.json: ' + gameManifest);
  }
  const notes: string[] = [];
  const blockers: string[] = [];
  const { manifests, targetConfigDigest } = discoverGameManifests(
    gameRoot,
    notes,
    blockers,
    targetsFileName,
  );
  const manifestDigests: Record<string, string> = {};
  const requested = new Set<string>();
  const parsedManifests = new Map<string, JsonObject>();
  for (const manifest of manifests) {
    const source = readFileSync(manifest, 'utf8');
    manifestDigests[manifest] = digest(source);
    const parsed = parseJsonObject(source, manifest);
    parsedManifests.set(manifest, parsed);
    for (const section of dependencySections) {
      for (const [name, value] of Object.entries(asObject(parsed[section]))) {
        if (!name.startsWith('@mpgd/') || typeof value !== 'string') {
          continue;
        }
        if (!isKitPackageName(name)) {
          blockers.push('Invalid Kit package name in ' + manifest + ': ' + name);
          continue;
        }
        if (parseVersionSpecifier(value) === undefined) {
          if (validRange(value) !== null) {
            blockers.push('Unsupported Kit version range for ' + name + ' in ' + manifest
              + ': ' + value + '. Pin an exact version, ^version, or ~version before upgrading.');
          } else {
            notes.push('Skipped non-SemVer dependency ' + name + ' in ' + manifest + ': ' + value);
          }
        } else {
          requested.add(name);
        }
      }
    }
  }

  const packages = new Map<string, PublishedKitPackage>();
  const names = [...requested].sort();
  for (let index = 0; index < names.length; index += 4) {
    await Promise.all(
      names.slice(index, index + 4).map(async (name) => {
        try {
          const published = await lookup(name, gameRoot);
          if (valid(published.version) === null) {
            throw new Error('registry returned a non-SemVer latest version');
          }
          packages.set(name, published);
        } catch (error) {
          blockers.push('Cannot resolve npm latest for ' + name + ': ' + formatError(error));
        }
      }),
    );
  }

  const updates: KitUpgradeUpdate[] = [];
  const peerSubjects: KitUpgradeUpdate[] = [];
  for (const manifest of manifests) {
    const parsed = parsedManifests.get(manifest);
    if (parsed === undefined) {
      continue;
    }
    for (const section of dependencySections) {
      for (const [name, value] of Object.entries(asObject(parsed[section]))) {
        if (!name.startsWith('@mpgd/') || typeof value !== 'string') {
          continue;
        }
        const current = parseVersionSpecifier(value);
        const published = packages.get(name);
        if (current === undefined || published === undefined) {
          continue;
        }
        if (compare(published.version, current.version) < 0) {
          notes.push(
            'Kept ' + name + ' in ' + manifest + ': current version is newer than npm latest.',
          );
        } else {
          const next = compare(published.version, current.version) > 0
            ? current.prefix + published.version
            : value;
          const subject: KitUpgradeUpdate = {
            manifest,
            section,
            packageName: name,
            current: value,
            next,
            latestVersion: published.version,
          };
          peerSubjects.push(subject);
          if (next !== value) {
            updates.push(subject);
          }
        }
      }
    }
  }
  validatePeers(peerSubjects, updates, packages, parsedManifests, gameManifest, blockers, notes);
  const { lockfileDigests, workspaceRoots } = discoverLockfiles(
    gameRoot,
    manifests,
    blockers,
    notes,
  );
  const cliUpdate = updates.find((update) => update.packageName === '@mpgd/cli');
  if (process.env.MPGD_KIT_PATH !== undefined && cliUpdate !== undefined) {
    const kitPackageFile = path.resolve(process.env.MPGD_KIT_PATH, 'packages/cli/package.json');
    if (existsSync(kitPackageFile)) {
      const kitPackage = parseJsonObject(readFileSync(kitPackageFile, 'utf8'), kitPackageFile);
      if (kitPackage.version !== cliUpdate.latestVersion) {
        notes.push('MPGD_KIT_PATH still has CLI ' + String(kitPackage.version)
          + '; select the published ' + cliUpdate.latestVersion + ' Kit tag before a release.');
      }
    }
  }
  return {
    gameRoot,
    updates,
    blockers,
    notes: [...new Set(notes)],
    manifestDigests,
    targetConfigDigest,
    lockfileDigests,
    workspaceRoots,
  };
}

export function applyKitUpgrade(
  plan: KitUpgradePlan,
  runLockfileUpdate: KitUpgradeLockfileRunner = updatePnpmLockfile,
): KitUpgradeApplyResult {
  if (plan.blockers.length > 0) {
    throw new Error('Kit upgrade is blocked:\n' + plan.blockers.join('\n'));
  }
  if (plan.updates.length === 0) {
    return { manifests: [], lockfiles: [] };
  }
  const { file: targetsFile, sha256: targetsDigest } = plan.targetConfigDigest;
  if (targetsDigest === null) {
    if (existsSync(targetsFile)) {
      throw new Error('File changed after upgrade planning: ' + targetsFile);
    }
  } else if (!existsSync(targetsFile) || digest(readFileSync(targetsFile, 'utf8')) !== targetsDigest) {
    throw new Error('File changed after upgrade planning: ' + targetsFile);
  }
  const snapshots = new Map<string, string>();
  for (const [file, expected] of Object.entries({
    ...plan.manifestDigests,
    ...plan.lockfileDigests,
  })) {
    const current = readFileSync(file, 'utf8');
    if (digest(current) !== expected) {
      throw new Error('File changed after upgrade planning: ' + file);
    }
    snapshots.set(file, current);
  }
  const changedManifests = [...new Set(plan.updates.map((update) => update.manifest))];
  try {
    for (const manifest of changedManifests) {
      const source = snapshots.get(manifest);
      if (source === undefined) {
        throw new Error('Missing manifest snapshot: ' + manifest);
      }
      const parsed = parseJsonObject(source, manifest);
      for (const update of plan.updates.filter((item) => item.manifest === manifest)) {
        const section = asObject(parsed[update.section]);
        if (section[update.packageName] !== update.current) {
          throw new Error('Dependency changed after planning: ' + update.packageName);
        }
        section[update.packageName] = update.next;
        parsed[update.section] = section;
      }
      writeFileSync(manifest, stringifyLike(source, parsed));
    }
    for (const root of plan.workspaceRoots) {
      runLockfileUpdate(root);
    }
  } catch (error) {
    const restoreFailures: string[] = [];
    for (const [file, original] of snapshots) {
      try {
        writeFileSync(file, original);
      } catch (restoreError) {
        restoreFailures.push(file + ': ' + formatError(restoreError));
      }
    }
    const restoration = restoreFailures.length === 0
      ? 'Original manifests and lockfiles were rolled back.'
      : 'Rollback incomplete:\n' + restoreFailures.join('\n');
    throw new Error('Kit upgrade failed during lockfile update: ' + formatError(error)
      + '\n' + restoration);
  }
  return { manifests: changedManifests, lockfiles: Object.keys(plan.lockfileDigests) };
}

export async function lookupPublishedKitPackage(
  packageName: string,
  gameRoot: string,
): Promise<PublishedKitPackage> {
  if (!isKitPackageName(packageName)) {
    throw new Error('Invalid Kit package name: ' + packageName);
  }
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await execFile(
    executable,
    [
      'view',
      packageName + '@latest',
      'version',
      'peerDependencies',
      'peerDependenciesMeta',
      '--json',
    ],
    {
      cwd: gameRoot,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
      timeout: 20_000,
      shell: process.platform === 'win32',
    },
  );
  return parsePublishedKitPackageResponse(String(stdout), packageName);
}

export function parsePublishedKitPackageResponse(
  source: string,
  packageName: string,
): PublishedKitPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error('Invalid npm view JSON for ' + packageName + ': ' + formatError(error));
  }
  const response = typeof parsed === 'string' ? { version: parsed } : asObject(parsed);
  if (typeof response.version !== 'string') {
    throw new Error('Registry did not return a latest version for ' + packageName);
  }
  const peers = asObject(response.peerDependencies);
  const peerMetadata = asObject(response.peerDependenciesMeta);
  const declaredPeers = Object.entries(peers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  const optionalPeerDependencies = declaredPeers
    .filter(([name]) => asObject(peerMetadata[name]).optional === true)
    .map(([name]) => name);
  return {
    version: response.version,
    peerDependencies: Object.fromEntries(declaredPeers),
    ...(optionalPeerDependencies.length > 0 ? { optionalPeerDependencies } : {}),
  };
}

function discoverGameManifests(
  gameRoot: string,
  notes: string[],
  blockers: string[],
  targetsFileName?: string,
): {
  readonly manifests: readonly string[];
  readonly targetConfigDigest: { readonly file: string; readonly sha256: string | null };
} {
  const manifests = new Set([path.join(gameRoot, 'package.json')]);
  const targetsFile = path.resolve(gameRoot, targetsFileName ?? 'mpgd.targets.json');
  if (!inside(gameRoot, targetsFile)) {
    throw new Error('Targets file must be inside the game directory: ' + targetsFile);
  }
  if (!existsSync(targetsFile)) {
    if (targetsFileName === undefined) {
      notes.push('No mpgd.targets.json found; only the game manifest will be updated.');
    } else {
      blockers.push('Requested targets file is missing: ' + targetsFile);
    }
    return { manifests: [...manifests], targetConfigDigest: { file: targetsFile, sha256: null } };
  }
  if (lstatSync(targetsFile).isSymbolicLink() || !inside(gameRoot, realpathSync(targetsFile))) {
    throw new Error('Refusing to read a linked targets file: ' + targetsFile);
  }
  const targetsSource = readFileSync(targetsFile, 'utf8');
  const config = parseJsonObject(targetsSource, targetsFile);
  const targetsDirectory = path.dirname(targetsFile);
  for (const value of Object.values(asObject(config.targets))) {
    const target = asObject(value);
    for (const key of ['wrapperApp', 'shellApp'] as const) {
      const location = target[key];
      if (typeof location !== 'string') {
        continue;
      }
      if (location.includes('${MPGD_KIT_PATH}')) {
        notes.push('Skipped external target ' + key + ': ' + location);
        continue;
      }
      const resolvedLocation = location
        .replaceAll('${MPGD_GAME_ROOT}', targetsDirectory)
        .replaceAll('${MPGD_GAME_APP_ROOT}', targetsDirectory);
      if (resolvedLocation.includes('$' + '{')) {
        notes.push('Skipped target with unresolved path token: ' + location);
        continue;
      }
      const directory = path.resolve(targetsDirectory, resolvedLocation);
      if (!inside(gameRoot, directory)) {
        notes.push('Skipped target outside the game directory: ' + location);
        continue;
      }
      const manifest = path.join(directory, 'package.json');
      if (!existsSync(manifest)) {
        notes.push('Skipped target without package.json: ' + location);
        continue;
      }
      if (lstatSync(manifest).isSymbolicLink() || !inside(gameRoot, realpathSync(manifest))) {
        notes.push('Skipped linked target manifest: ' + location);
        continue;
      }
      manifests.add(manifest);
    }
  }
  return {
    manifests: [...manifests].sort(),
    targetConfigDigest: { file: targetsFile, sha256: digest(targetsSource) },
  };
}

function discoverLockfiles(
  gameRoot: string,
  manifests: readonly string[],
  blockers: string[],
  notes: string[],
): {
  readonly lockfileDigests: Readonly<Record<string, string>>;
  readonly workspaceRoots: readonly string[];
} {
  const roots = new Set<string>();
  let boundary = gameRoot;
  for (;;) {
    if (existsSync(path.join(boundary, '.git'))) {
      break;
    }
    const parent = path.dirname(boundary);
    if (parent === boundary) {
      boundary = gameRoot;
      notes.push('No git boundary found; lockfile discovery is limited to the game directory.');
      break;
    }
    boundary = parent;
  }
  for (const manifest of manifests) {
    let directory = path.dirname(manifest);
    while (inside(boundary, directory)) {
      const lockfile = path.join(directory, 'pnpm-lock.yaml');
      if (existsSync(lockfile)) {
        if (lstatSync(lockfile).isSymbolicLink()) {
          blockers.push('Refusing to rewrite a linked pnpm lockfile: ' + lockfile);
        } else {
          roots.add(directory);
        }
      }
      if (directory === boundary) {
        break;
      }
      directory = path.dirname(directory);
    }
  }
  if (roots.size === 0) {
    blockers.push('No pnpm-lock.yaml found for the game and its target manifests.');
  }
  const workspaceRoots = [...roots].sort((left, right) => left.length - right.length);
  return {
    workspaceRoots,
    lockfileDigests: Object.fromEntries(
      workspaceRoots.map((root) => {
        const file = path.join(root, 'pnpm-lock.yaml');
        return [file, digest(readFileSync(file, 'utf8'))];
      }),
    ),
  };
}

function validatePeers(
  subjects: readonly KitUpgradeUpdate[],
  updates: readonly KitUpgradeUpdate[],
  packages: ReadonlyMap<string, PublishedKitPackage>,
  manifests: ReadonlyMap<string, JsonObject>,
  gameManifest: string,
  blockers: string[],
  notes: string[],
): void {
  const replacements = new Map(
    updates.map((update) => [update.manifest + '\0' + update.packageName, update.next]),
  );
  for (const subject of subjects) {
    const published = packages.get(subject.packageName);
    const peers = published?.peerDependencies ?? {};
    const optionalPeers = new Set(published?.optionalPeerDependencies ?? []);
    for (const [peerName, range] of Object.entries(peers)) {
      if (validRange(range) === null) {
        blockers.push('Invalid published peer range for ' + subject.packageName + ': '
          + peerName + ' ' + range);
        continue;
      }
      const owner = findPeerOwner(manifests, subject.manifest, gameManifest, peerName);
      if (owner === undefined) {
        if (!optionalPeers.has(peerName)) {
          notes.push(subject.packageName + ' requires peer ' + peerName + ' ' + range
            + '; no direct version was declared. Check the resolved lockfile.');
        }
        continue;
      }
      const specifier = replacements.get(owner.manifest + '\0' + peerName) ?? owner.specifier;
      const parsed = parseVersionSpecifier(specifier);
      if (parsed !== undefined) {
        if (!intersects(specifier, range)) {
          blockers.push(subject.packageName + '@' + subject.latestVersion + ' requires '
            + peerName + ' ' + range + ', incompatible with ' + specifier + '.');
        } else if (!satisfies(parsed.version, range)) {
          notes.push(subject.packageName + ' peer ' + peerName + ' requires ' + range
            + '; confirm the installed version selected by ' + specifier + '.');
        }
      } else if (validRange(specifier) !== null && !intersects(specifier, range)) {
        blockers.push(subject.packageName + '@' + subject.latestVersion + ' requires '
          + peerName + ' ' + range + ', incompatible with ' + specifier + '.');
      } else if (validRange(specifier) !== null) {
        const minimum = minVersion(specifier);
        if (minimum !== null && !satisfies(minimum, range)) {
          notes.push(subject.packageName + ' peer ' + peerName + ' requires ' + range
            + '; verify the resolved version inside ' + specifier + '.');
        }
      } else {
        notes.push('Could not verify peer ' + peerName + ' for ' + subject.packageName
          + ' from specifier ' + specifier + '.');
      }
    }
  }
}

function findPeerOwner(
  manifests: ReadonlyMap<string, JsonObject>,
  packageManifest: string,
  gameManifest: string,
  peerName: string,
): { readonly manifest: string; readonly specifier: string } | undefined {
  for (const manifest of [packageManifest, gameManifest]) {
    const specifier = dependencySpecifier(manifests.get(manifest), peerName);
    if (specifier !== undefined) {
      return { manifest, specifier };
    }
  }
  const candidates = [...manifests].flatMap(([manifest, content]) => {
    const specifier = dependencySpecifier(content, peerName);
    return specifier === undefined ? [] : [{ manifest, specifier }];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function dependencySpecifier(manifest: JsonObject | undefined, name: string): string | undefined {
  if (manifest === undefined) {
    return undefined;
  }
  for (const section of dependencySections) {
    const value = asObject(manifest[section])[name];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function parseVersionSpecifier(value: string): { readonly prefix: string; readonly version: string } | undefined {
  if (valid(value) !== null) {
    return { prefix: '', version: value };
  }
  const prefix = value[0];
  if ((prefix === '^' || prefix === '~') && valid(value.slice(1)) !== null) {
    return { prefix, version: value.slice(1) };
  }
  return undefined;
}

function updatePnpmLockfile(workspaceRoot: string): void {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['install', '--lockfile-only', '--ignore-scripts'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('pnpm lockfile update failed in ' + workspaceRoot + ': '
      + formatError(result.error ?? (result.stderr || result.stdout)));
  }
}

function parseJsonObject(source: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error('Invalid JSON in ' + label + ': ' + formatError(error));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object in ' + label);
  }
  return parsed as JsonObject;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringifyLike(original: string, value: JsonObject): string {
  const indent = original.match(/\r?\n([ \t]+)"/u)?.[1] ?? '  ';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, indent).replaceAll('\n', newline)
    + (original.endsWith('\n') ? newline : '');
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..'
    && !path.isAbsolute(relative));
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function isKitPackageName(name: string): boolean {
  return /^@mpgd\/[a-z0-9][a-z0-9._-]*$/u.test(name);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
