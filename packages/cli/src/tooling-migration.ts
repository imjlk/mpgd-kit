import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'acorn';
import { gte, minVersion, valid } from 'semver';

import { resolveNativeCommandLaunch } from './command-launcher.js';

type JsonObject = Record<string, unknown>;
const managedPaths = [
  'package.json',
  'tsconfig.tools.json',
  'tools/run-game-acceptance.mjs',
  'tools/run-game-acceptance.ts',
  'pnpm-lock.yaml',
] as const;
type ManagedPath = typeof managedPaths[number];
const snapshotPaths = [...managedPaths, 'pnpm-workspace.yaml', 'tsconfig.json'] as const;
type SnapshotPath = typeof snapshotPaths[number];
export interface ToolingMigrationEdit {
  readonly file: ManagedPath;
  readonly before: string | null;
  readonly after: string | null;
}
export interface ToolingMigrationPlan {
  readonly gameRoot: string;
  readonly edits: readonly ToolingMigrationEdit[];
  readonly snapshots: Readonly<Record<SnapshotPath, string | null>>;
  readonly childManifests: Readonly<Record<string, string>>;
  readonly updateLockfile: boolean;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}
const defaultTemplateRoot = fileURLToPath(new URL('../templates/phaser-game/', import.meta.url));

/** Plans only known generated-tool changes; custom scripts and source stay untouched. */
export function planToolingMigration(gameDirectory: string, templateRoot = defaultTemplateRoot): ToolingMigrationPlan {
  const gameRoot = realpathSync(path.resolve(gameDirectory));
  const snapshots = Object.fromEntries(
    snapshotPaths.map((file) => [file, readOwnedFile(gameRoot, file)]),
  ) as Record<SnapshotPath, string | null>;
  const blockers: string[] = [];
  const childManifests = readChildManifests(gameRoot);
  const notes: string[] = [];
  const edits: ToolingMigrationEdit[] = [];
  const add = (file: ManagedPath, after: string | null): void => {
    if (snapshots[file] !== after) {
      edits.push({ file, before: snapshots[file], after });
    }
  };
  const manifest = parseObject(snapshots['package.json'], 'package.json');
  const template = parseObject(
    readFileSync(path.join(templateRoot, 'package.json'), 'utf8'),
    'template package.json',
  );
  if (manifest.type !== 'module') {
    blockers.push(
      'Only generated ESM games (package.json type: module) can be migrated automatically.',
    );
  }
  const scripts = objectField(manifest, 'scripts');
  const templateScripts = objectField(template, 'scripts');
  const oldCommands: Record<string, readonly string[]> = {
    accept: ['node ./tools/run-game-acceptance.mjs', 'node tools/run-game-acceptance.mjs'],
    check: ['ttsc --noEmit -p tsconfig.json'],
    lint: ['ttsc --noEmit -p tsconfig.json'],
    format: ['ttsc format'],
    fix: ['ttsc fix'],
  };
  for (const [name, old] of Object.entries(oldCommands)) {
    const desired = templateScripts[name];
    if (typeof desired !== 'string') {
      throw new Error(`Template script ${name} is missing.`);
    }
    if (scripts[name] === undefined || scripts[name] === desired || old.includes(String(scripts[name]))) {
      scripts[name] = desired;
    } else {
      blockers.push(`Custom scripts.${name}: preserve it and migrate that command manually.`);
    }
  }
  manifest.scripts = scripts;
  const oldRunner = snapshots['tools/run-game-acceptance.mjs'];
  const newRunner = snapshots['tools/run-game-acceptance.ts'];
  if (oldRunner !== null && newRunner !== null) {
    blockers.push('Both acceptance runners exist; resolve their contents before migrating.');
  } else if (oldRunner !== null) {
    const templateRunner = readFileSync(
      path.join(templateRoot, 'tools/run-game-acceptance.ts'),
      'utf8',
    );
    const rendered = migrateKnownRunner(oldRunner, templateRunner);
    if (rendered === undefined) {
      blockers.push(
        'The JavaScript acceptance runner is customized; preserve it and migrate it manually.',
      );
    } else {
      add('tools/run-game-acceptance.ts', rendered);
      add('tools/run-game-acceptance.mjs', null);
    }
  } else if (newRunner === null) {
    blockers.push('No generated acceptance runner was found.');
  } else if (migrateKnownRunner(newRunner, readFileSync(
    path.join(templateRoot, 'tools/run-game-acceptance.ts'),
    'utf8',
  )) === undefined) {
    blockers.push(
      'The TypeScript acceptance runner is customized; preserve it and migrate it manually.',
    );
  }

  const toolsTemplate = parseObject(
    readFileSync(path.join(templateRoot, 'tsconfig.tools.json'), 'utf8'),
    'template tools project',
  );
  const desiredTools = {
    ...toolsTemplate,
    compilerOptions: { ...objectField(toolsTemplate, 'compilerOptions'), strict: true },
  };
  const currentTools = snapshots['tsconfig.tools.json'];
  if (currentTools === null) {
    add('tsconfig.tools.json', stringify(desiredTools));
  } else {
    const current = parseObject(currentTools, 'tsconfig.tools.json');
    if (stable(current) === stable(toolsTemplate)) {
      add('tsconfig.tools.json', stringify(desiredTools, currentTools));
    } else if (stable(current) !== stable(desiredTools)) {
      blockers.push('Custom tsconfig.tools.json: preserve its options and migrate it manually.');
    }
  }

  const dev = objectField(manifest, 'devDependencies');
  const templateDev = objectField(template, 'devDependencies');
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of ['ttsc', 'typescript', '@types/node']) {
      if (objectField(manifest, section)[name] !== undefined) {
        blockers.push(
          `Custom ${section}.${name}: keep toolchain declarations in devDependencies before migrating.`,
        );
      }
    }
  }
  const compilerFloor = templateDev.ttsc;
  if (typeof compilerFloor !== 'string' || !valid(compilerFloor)) {
    throw new Error('Template ttsc must have an exact version.');
  }
  const currentCompiler = dev.ttsc;
  if (!existsSync(path.join(gameRoot, 'tsconfig.json'))) {
    blockers.push('Missing game tsconfig.json.');
  }
  let compilerVersion = compilerFloor;
  if (typeof currentCompiler === 'string' && valid(currentCompiler)) {
    if (gte(currentCompiler, compilerFloor)) {
      compilerVersion = currentCompiler;
    }
  } else if (currentCompiler !== undefined) {
    blockers.push('Custom ttsc version specifier: align the shared toolchain manually first.');
  }
  let updateLockfile = false;
  for (const name of ['ttsc', 'typescript', '@types/node']) {
    const desired = name === 'ttsc' ? compilerVersion : templateDev[name];
    if (typeof desired !== 'string') {
      throw new Error(`Template dependency ${name} is missing.`);
    }
    const existing = versionFloor(dev[name]);
    const minimum = minVersion(desired);
    if (dev[name] !== undefined && existing === null) {
      blockers.push(`Custom ${name} declaration: update it manually first.`);
    }
    if ((name === 'ttsc' || existing === null || (minimum !== null && !gte(existing, minimum))) && dev[name] !== desired) {
      dev[name] = desired;
      updateLockfile = true;
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = section === 'devDependencies' ? dev : objectField(manifest, section);
    for (const name of Object.keys(dependencies)) {
      if (!name.startsWith('@ttsc/')) {
        continue;
      }
      if (dependencies[name] !== compilerVersion) {
        if (typeof dependencies[name] !== 'string' || !valid(dependencies[name]) || gte(dependencies[name], compilerVersion)) {
          blockers.push(`Custom or newer ${section}.${name}: align it with ttsc manually first.`);
        } else {
          dependencies[name] = compilerVersion;
          updateLockfile = true;
        }
      }
    }
    if (section === 'devDependencies' || manifest[section] !== undefined) {
      manifest[section] = dependencies;
    }
  }
  for (const [name, version] of Object.entries(objectField(manifest, 'peerDependencies'))) {
    if (name.startsWith('@ttsc/') && version !== compilerVersion) {
      blockers.push(`Custom peerDependencies.${name}: align the peer toolchain manually first.`);
    }
  }
  for (const [file, source] of Object.entries(childManifests)) {
    const child = parseObject(source, file);
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, version] of Object.entries(objectField(child, section))) {
        if (name === 'ttsc' || name.startsWith('@ttsc/')) {
          if (version !== compilerVersion) {
            blockers.push(
              `${file}: align ${section}.${name} with ttsc ${compilerVersion} manually first.`,
            );
          }
        } else if (name === 'typescript' || name === '@types/node') {
          const minimum = versionFloor(templateDev[name]);
          const current = versionFloor(version);
          if (minimum === null || current === null || !gte(current, minimum)) {
            blockers.push(
              `${file}: align ${section}.${name} with the template toolchain manually first.`,
            );
          }
        }
      }
    }
  }
  if (hasAncestorWorkspace(gameRoot)) {
    blockers.push(
      'This game belongs to a parent pnpm workspace. Automatic migration cannot verify its shared toolchain and lockfile; migrate the tools manually after aligning the owning workspace.',
    );
  }
  if (updateLockfile) {
    notes.push(
      'Applying updates the game lockfile with pnpm install --lockfile-only --ignore-scripts.',
    );
  }
  notes.push('Requires Node 24.11 or newer. Run pnpm check and pnpm accept --help after applying.');
  if (stable(manifest) !== stable(parseObject(snapshots['package.json'], 'package.json'))) {
    add('package.json', stringify(manifest, snapshots['package.json'] ?? undefined));
  }
  return { gameRoot, edits, snapshots, childManifests, updateLockfile, blockers, notes };
}

/** Applies a fresh local plan, rolling back managed files and the game lockfile on failure. */
export function applyToolingMigration(plan: ToolingMigrationPlan, updateLockfile = refreshLockfile): readonly string[] {
  if (plan.blockers.length) {
    throw new Error(`Tooling migration blocked:\n${plan.blockers.join('\n')}`);
  }
  assertFreshPlan(plan);
  for (const edit of plan.edits) {
    if (!managedPaths.includes(edit.file) || edit.before !== plan.snapshots[edit.file]) {
      throw new Error('Invalid tooling migration edit.');
    }
  }

  if (!plan.edits.length) {
    return [];
  }
  const lockPath = path.join(plan.gameRoot, '.mpgd-tooling-migration.lock');
  const lock = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  try {
    writeFileSync(lockPath, lock, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (isObject(error) && error.code === 'EEXIST') {
      throw new Error(
        `Migration lock exists (EEXIST): ${lockPath}. If an earlier run was interrupted, verify its process and pnpm child have exited, inspect partial changes, then remove only this lock and run a fresh preview.`,
        { cause: error },
      );
    }
    throw error;
  }
  let writesStarted = false;
  let lockfileUpdateAttempted = false;
  const written: ToolingMigrationEdit[] = [];
  try {
    // Another migration may have completed between the initial check and lock acquisition.
    assertFreshPlan(plan);
    writesStarted = true;
    for (const edit of plan.edits) {
      if (readOwnedFile(plan.gameRoot, edit.file) !== edit.before) {
        throw new Error(`File changed during migration: ${edit.file}`);
      }
      writeOwnedFile(plan.gameRoot, edit.file, edit.after);
      written.push(edit);
    }
    if (plan.updateLockfile) {
      lockfileUpdateAttempted = true;
      updateLockfile(plan.gameRoot);
    }
  } catch (error) {
    if (!writesStarted) {
      throw error;
    }
    const failures: string[] = [];
    for (const edit of [...written].reverse()) {
      try {
        if (readOwnedFile(plan.gameRoot, edit.file) !== edit.after) {
          throw new Error('A concurrent writer changed the migration output.');
        }
        writeOwnedFile(plan.gameRoot, edit.file, edit.before);
      } catch {
        failures.push(edit.file);
      }
    }
    if (lockfileUpdateAttempted) {
      try {
        // pnpm does not honor our migration lock. A changed lockfile might be
        // another install's output; preserve it and require manual inspection.
        if (readOwnedFile(plan.gameRoot, 'pnpm-lock.yaml') !== plan.snapshots['pnpm-lock.yaml']) {
          failures.push('pnpm-lock.yaml');
        }
      } catch {
        failures.push('pnpm-lock.yaml');
      }
    }
    let rollbackStatus = lockfileUpdateAttempted
      ? 'Managed files restored; lockfile unchanged.'
      : 'Managed files restored; lockfile untouched.';
    if (failures.length) {
      rollbackStatus = `Rollback incomplete: ${failures.join(', ')}`;
    }
    throw new Error(`Tooling migration failed. ${rollbackStatus}`, { cause: error });
  } finally {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === lock) {
      rmSync(lockPath);
    }
  }
  return plan.edits.map((edit) => edit.file);
}

function assertFreshPlan(plan: ToolingMigrationPlan): void {
  if (realpathSync(plan.gameRoot) !== plan.gameRoot) {
    throw new Error('Game root changed after planning.');
  }
  for (const file of snapshotPaths) {
    if (readOwnedFile(plan.gameRoot, file) !== plan.snapshots[file]) {
      throw new Error(`File changed after planning: ${file}`);
    }
  }
  if (stable(readChildManifests(plan.gameRoot)) !== stable(plan.childManifests)) {
    throw new Error('Child package manifests changed after planning.');
  }
  if (hasAncestorWorkspace(plan.gameRoot)) {
    throw new Error('Parent workspace changed after planning.');
  }
}

// Conservatively inspect game-owned nested packages, including custom workspace
// layouts. Never traverse dependency installs, generated builds or linked trees.
function readChildManifests(root: string): Record<string, string> {
  const manifests: Record<string, string> = {};
  const ignored = new Set(['node_modules', 'dist', 'build', 'coverage']);
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ignored.has(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === 'package.json' || existsSync(path.join(full, 'package.json'))) {
          throw new Error(`Refusing linked child package: ${path.relative(root, full)}`);
        }
      } else if (entry.isDirectory()) {
        visit(full);
      } else if (directory !== root && entry.name === 'package.json') {
        manifests[path.relative(root, full)] = readFileSync(full, 'utf8');
      }
    }
  }
  visit(root);
  return manifests;
}

function parseObject(source: string | null, label: string): JsonObject {
  if (source === null) {
    throw new Error(`Missing ${label}.`);
  }
  const parsed: unknown = JSON.parse(source);
  if (!isObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function objectField(value: JsonObject, key: string): JsonObject {
  if (value[key] === undefined) {
    return {};
  }
  if (!isObject(value[key])) {
    throw new Error(`${key} must be an object.`);
  }
  return value[key];
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isObject(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}
function stringify(value: unknown, original = ''): string {
  const indent = /^([\t ]+)"/m.exec(original)?.[1] ?? '  ';
  const text = JSON.stringify(value, null, indent) + '\n';
  return original.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}
function migrateKnownRunner(source: string, template: string): string | undefined {
  try {
    let comments = 0;
    const ast: unknown = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      onComment: () => {
        comments++;
      },
    });
    if (comments) {
      return undefined;
    } // Preserve user-authored comments rather than silently replacing them.
    const defaults: string[] = [];
    function walk(value: unknown): void {
      if (Array.isArray(value)) {
        for (const entry of value) {
          walk(entry);
        }
      } else if (isObject(value)) {
        if (value.type === 'ConditionalExpression' && isObject(value.consequent) && typeof value.consequent.value === 'string') {
          defaults.push(value.consequent.value);
        }
        for (const entry of Object.values(value)) {
          walk(entry);
        }
      }
    }
    walk(ast);
    if (defaults.length !== 1) {
      return undefined;
    }
    const rendered = template.replace("'__DEFAULT_KIT_PATH__'", () => JSON.stringify(defaults[0]));
    const canonical = (value: unknown): string => JSON.stringify(value, (key, item: unknown) =>
      ['start', 'end', 'raw'].includes(key) ? undefined : item,
    );
    return canonical(ast) === canonical(parse(rendered, { ecmaVersion: 'latest', sourceType: 'module' }))
      ? rendered
      : undefined;
  } catch {
    return undefined;
  }
}
function readOwnedFile(root: string, file: SnapshotPath): string | null {
  const full = ownedPath(root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}
function ownedPath(root: string, file: SnapshotPath): string {
  if (!snapshotPaths.includes(file)) {
    throw new Error('Path is not owned by tooling migration.');
  }
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing linked migration path: ${file}`);
      }
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return current;
}
function writeOwnedFile(root: string, file: ManagedPath, source: string | null): void {
  const full = ownedPath(root, file);
  if (source === null) {
    rmSync(full, { force: true });
    return;
  }
  const temporary = `${full}.mpgd-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source, {
      flag: 'wx',
      mode: existsSync(full) ? lstatSync(full).mode & 0o777 : 0o644,
    });
    renameSync(temporary, full);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function hasAncestorWorkspace(root: string): boolean {
  if (existsSync(path.join(root, 'pnpm-workspace.yaml'))) {
    return false;
  }
  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    if (existsSync(path.join(parent, 'pnpm-workspace.yaml'))) {
      return true;
    }
    if (path.dirname(parent) === parent) {
      return false;
    }
  }
}
function refreshLockfile(gameRoot: string): void {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_workspace_dir') {
      delete environment[key];
    }
  }
  const launch = resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['install', '--lockfile-only', '--ignore-scripts', '--lockfile-dir', gameRoot],
    environment,
  });
  const result = spawnSync(launch.command, [...launch.args], {
    cwd: gameRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not refresh game lockfile: ${result.error?.message ?? result.stderr}`);
  }
}

function versionFloor(value: unknown): ReturnType<typeof minVersion> {
  try {
    return typeof value === 'string' ? minVersion(value) : null;
  } catch {
    return null;
  }
}
