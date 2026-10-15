import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
export interface ToolingMigrationEdit {
  readonly file: ManagedPath;
  readonly before: string | null;
  readonly after: string | null;
}
export interface ToolingMigrationPlan {
  readonly gameRoot: string;
  readonly edits: readonly ToolingMigrationEdit[];
  readonly snapshots: Readonly<Record<ManagedPath, string | null>>;
  readonly updateLockfile: boolean;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}
const defaultTemplateRoot = fileURLToPath(new URL('../templates/phaser-game/', import.meta.url));

/** Plans only known generated-tool changes; custom scripts and source stay untouched. */
export function planToolingMigration(gameDirectory: string, templateRoot = defaultTemplateRoot): ToolingMigrationPlan {
  const gameRoot = realpathSync(path.resolve(gameDirectory));
  const snapshots = Object.fromEntries(
    managedPaths.map((file) => [file, readOwnedFile(gameRoot, file)]),
  ) as Record<ManagedPath, string | null>;
  const blockers: string[] = [];
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
  for (const section of ['dependencies', 'optionalDependencies']) {
    if (objectField(manifest, section).ttsc !== undefined) {
      blockers.push(
      `Custom ${section}.ttsc: keep one compiler declaration in devDependencies before migrating.`,
    );
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
  if (updateLockfile && hasAncestorWorkspace(gameRoot)) {
    blockers.push(
      'This game belongs to a parent pnpm workspace. Upgrade its shared toolchain first; this migration will not change the parent lockfile.',
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
  return { gameRoot, edits, snapshots, updateLockfile, blockers, notes };
}

/** Applies a fresh local plan, rolling back managed files and the game lockfile on failure. */
export function applyToolingMigration(plan: ToolingMigrationPlan, updateLockfile = refreshLockfile): readonly string[] {
  if (plan.blockers.length) {
    throw new Error(`Tooling migration blocked:\n${plan.blockers.join('\n')}`);
  }
  if (realpathSync(plan.gameRoot) !== plan.gameRoot) {
    throw new Error('Game root changed after planning.');
  }
  for (const file of managedPaths) {
    if (readOwnedFile(plan.gameRoot, file) !== plan.snapshots[file]) {
      throw new Error(`File changed after planning: ${file}`);
    }
  }
  for (const edit of plan.edits) {
    if (!managedPaths.includes(edit.file) || edit.before !== plan.snapshots[edit.file]) {
      throw new Error('Invalid tooling migration edit.');
    }
  }
  if (plan.updateLockfile && hasAncestorWorkspace(plan.gameRoot)) {
    throw new Error('Parent workspace changed after planning.');
  }
  if (!plan.edits.length) {
    return [];
  }
  const lockPath = path.join(plan.gameRoot, '.mpgd-tooling-migration.lock');
  const lock = randomUUID();
  writeFileSync(lockPath, lock, { flag: 'wx', mode: 0o600 });
  try {
    for (const edit of plan.edits) {
      writeOwnedFile(plan.gameRoot, edit.file, edit.after);
    }
    if (plan.updateLockfile) {
      updateLockfile(plan.gameRoot);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const file of [
      ...new Set([...plan.edits.map((edit) => edit.file), 'pnpm-lock.yaml' as const]),
    ]) {
      try {
        writeOwnedFile(plan.gameRoot, file, plan.snapshots[file]);
      } catch {
        failures.push(file);
      }
    }
    throw new Error(
      `Tooling migration failed. ${failures.length ? `Rollback incomplete: ${failures.join(', ')}` : 'Managed files and lockfile restored.'}`,
      { cause: error },
    );
  } finally {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === lock) {
      rmSync(lockPath);
    }
  }
  return plan.edits.map((edit) => edit.file);
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
    const rendered = template.replace("'__DEFAULT_KIT_PATH__'", JSON.stringify(defaults[0]));
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
function readOwnedFile(root: string, file: ManagedPath): string | null {
  const full = ownedPath(root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}
function ownedPath(root: string, file: ManagedPath): string {
  if (!managedPaths.includes(file)) {
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
  const launch = resolveNativeCommandLaunch({
    command: 'pnpm',
    args: ['install', '--lockfile-only', '--ignore-scripts', '--lockfile-dir', gameRoot],
    environment: process.env,
  });
  const result = spawnSync(launch.command, [...launch.args], {
    cwd: gameRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
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
