import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const microsoftStoreBlockStart = '<!-- mpgd:microsoft-store:start -->';
export const microsoftStoreBlockEnd = '<!-- mpgd:microsoft-store:end -->';
export const defaultMpgdKitPath = '../mpgd-kit';
export const microsoftStoreDocumentationAnchors = {
  'README.md': '- Verse8 is a game-owned iframe web target',
  'agent/acceptance.md': '## Verse8 Agent8 Structured Server',
  'agent/brief.md': undefined,
} as const;
const microsoftStoreBootstrap = {
  importAnchor: "import { installPlatform } from './platform/installPlatform';",
  importLine: "import { installMicrosoftStorePwa } from './platform/microsoftStorePwa';",
  localAnchor: "  let locale: Locale = 'en';",
  localLine: '  let disposeMicrosoftStorePwa: (() => void) | undefined;',
  runtimeAnchor: '    const runtimeConfig = detectRuntime();',
  runtimeLine: '    disposeMicrosoftStorePwa = installMicrosoftStorePwa(runtimeConfig);',
  catchAnchor: '    renderBootstrapError(error, locale);',
  catchLine: '    disposeMicrosoftStorePwa?.();',
} as const;
const microsoftStoreOnlyTemplateFiles = new Set([
  '.agents/skills/release-microsoft-store/SKILL.md',
  '.agents/skills/release-microsoft-store/agents/openai.yaml',
  'mpgd.microsoft-store.json',
  'src/platform/microsoftStorePwa.ts',
]);
const microsoftStoreManagedTemplateFiles = new Set([
  '.agents/skills/release-microsoft-store/SKILL.md',
  '.agents/skills/release-microsoft-store/agents/openai.yaml',
  'src/platform/microsoftStorePwa.ts',
]);
const microsoftStoreTarget = {
  kind: 'web',
  gameApp: '.',
  adapter: 'browser',
  icon: { profile: 'microsoft-pwa' },
  output: 'artifacts/microsoft-store',
} as const;

interface JsonObject {
  [key: string]: unknown;
}

interface PlannedWrite {
  readonly file: string;
  readonly relativePath: string;
  readonly previous: string | undefined;
  readonly content: string;
  readonly mode: number;
}

interface AppliedWrite {
  readonly planned: PlannedWrite;
  readonly backupFile: string | undefined;
  readonly temporaryFile: string;
  readonly createdDirectories: readonly string[];
}

export interface InitializeMicrosoftStoreStarterInput {
  readonly gameRoot: string;
  readonly templateRoot: string;
  readonly defaultKitPath: string;
  readonly dryRun: boolean;
}

export interface InitializeMicrosoftStoreStarterResult {
  readonly changedFiles: readonly string[];
}

interface MicrosoftStoreStarterApplyRuntime {
  readonly beforeCommit?: (relativePath: string) => void;
  readonly beforeRollbackEntry?: (relativePath: string) => void;
}

export function prepareBaseGameTemplateFile(input: {
  readonly relativePath: string;
  readonly content: string;
}): string | undefined {
  const relativePath = toTemplatePath(input.relativePath);

  if (microsoftStoreOnlyTemplateFiles.has(relativePath)) {
    return undefined;
  }

  const withoutBlocks = removeMicrosoftStoreBlocks(input.content);

  switch (relativePath) {
    case 'package.json':
      return updateJson(withoutBlocks, (value) => {
        const scripts = requireJsonObject(value.scripts, 'template package.json scripts');

        for (const script of Object.keys(microsoftStoreScripts(defaultMpgdKitPath))) {
          delete scripts[script];
        }
      });
    case 'mpgd.targets.json':
      return updateJson(withoutBlocks, (value) => {
        const targets = requireJsonObject(value.targets, 'template mpgd.targets.json targets');
        delete targets['microsoft-store'];
      });
    case 'agent/game-manifest.json':
      return updateJson(withoutBlocks, (value) => {
        if (!Array.isArray(value.targets)) {
          throw new Error('Template agent/game-manifest.json targets must be an array.');
        }

        value.targets = value.targets.filter((target) => target !== 'microsoft-store');
        const workflow = requireJsonObject(
          value.agentWorkflow,
          'template agent/game-manifest.json agentWorkflow',
        );
        const targetSkills = requireJsonObject(
          workflow.targetSkills,
          'template agent/game-manifest.json agentWorkflow.targetSkills',
        );
        delete targetSkills['microsoft-store'];
      });
    case 'src/main.ts':
      return removeMicrosoftStoreBootstrap(withoutBlocks);
    default:
      return withoutBlocks;
  }
}

export function listMicrosoftStoreInitializerTemplateFiles(): readonly string[] {
  return [...microsoftStoreOnlyTemplateFiles].sort();
}

export function initializeMicrosoftStoreStarter(
  input: InitializeMicrosoftStoreStarterInput,
  runtime: MicrosoftStoreStarterApplyRuntime = {},
): InitializeMicrosoftStoreStarterResult {
  const gameRoot = resolveGameRoot(input.gameRoot);
  const templateRoot = realpathSync(input.templateRoot);
  const writes: PlannedWrite[] = [];
  const plan = (relativePath: string, content: string): void => {
    const file = resolveGameFile(gameRoot, relativePath);
    const previous = readOptionalRegularFile(gameRoot, file, relativePath);

    if (previous === content) {
      return;
    }

    writes.push({
      file,
      relativePath,
      previous,
      content,
      mode: previous === undefined ? 0o644 : readRegularFileMode(file, relativePath),
    });
  };

  const packageFile = resolveGameFile(gameRoot, 'package.json');
  const packageSource = readRequiredRegularFile(gameRoot, packageFile, 'package.json');
  const packageJson = parseJsonObject(packageSource, 'package.json');
  const scripts = requireJsonObject(packageJson.scripts, 'package.json scripts');
  const legacyScripts = legacyMicrosoftStoreScripts(input.defaultKitPath);

  for (const [name, command] of Object.entries(microsoftStoreScripts(input.defaultKitPath))) {
    const existing = scripts[name];
    const legacyCommand = legacyScripts[name];

    if (existing !== undefined && existing !== command && existing !== legacyCommand) {
      throw new Error(`package.json script ${name} already exists with a different command.`);
    }

    scripts[name] = command;
  }

  plan('package.json', formatJson(packageJson));

  const targetsFile = resolveGameFile(gameRoot, 'mpgd.targets.json');
  const targetsSource = readRequiredRegularFile(gameRoot, targetsFile, 'mpgd.targets.json');
  const targetsJson = parseJsonObject(targetsSource, 'mpgd.targets.json');
  const targets = requireJsonObject(targetsJson.targets, 'mpgd.targets.json targets');
  const existingTarget = targets['microsoft-store'];

  if (existingTarget === undefined) {
    targets['microsoft-store'] = microsoftStoreTarget;
  } else {
    assertCompatibleMicrosoftStoreTarget(existingTarget);
  }

  plan('mpgd.targets.json', formatJson(targetsJson));

  const mainFile = resolveGameFile(gameRoot, 'src/main.ts');
  const mainSource = readRequiredRegularFile(gameRoot, mainFile, 'src/main.ts');
  plan('src/main.ts', addMicrosoftStoreBootstrap(mainSource));

  planGitignore(gameRoot, plan);
  planAgentManifest(gameRoot, plan);
  planManagedDocumentation(gameRoot, templateRoot, plan);

  for (const relativePath of [
    'AGENTS.md',
    '.agents/skills/use-mpgd-kit/SKILL.md',
    '.agents/skills/use-mpgd-kit/agents/openai.yaml',
    '.agents/skills/release-microsoft-store/SKILL.md',
    '.agents/skills/release-microsoft-store/agents/openai.yaml',
    'docs/MPGD_KIT_WORKFLOWS.md',
    'mpgd.microsoft-store.json',
    'src/platform/microsoftStorePwa.ts',
  ] as const) {
    const destination = resolveGameFile(gameRoot, relativePath);

    if (existsSync(destination)) {
      readRequiredRegularFile(gameRoot, destination, relativePath);

      if (microsoftStoreManagedTemplateFiles.has(relativePath)) {
        plan(relativePath, readRequiredTemplateFile(templateRoot, relativePath));
      }

      continue;
    }

    plan(relativePath, readRequiredTemplateFile(templateRoot, relativePath));
  }

  if (!input.dryRun) {
    applyPlannedWrites(gameRoot, writes, runtime);
  }

  return { changedFiles: writes.map((write) => write.relativePath).sort() };
}

function microsoftStoreScripts(defaultKitPath: string): Readonly<Record<string, string>> {
  const safeKitPath = requireSafeShellParameterDefaultPath(defaultKitPath);
  const kitPath = `"\${MPGD_KIT_PATH:-${safeKitPath}}"`;

  return createMicrosoftStoreScripts(kitPath);
}

function legacyMicrosoftStoreScripts(defaultKitPath: string): Readonly<Record<string, string>> {
  const safeKitPath = requireSafeShellParameterDefaultPath(defaultKitPath);
  const kitPath = `\${MPGD_KIT_PATH:-${safeKitPath}}`;

  return createMicrosoftStoreScripts(kitPath);
}

function createMicrosoftStoreScripts(kitPath: string): Readonly<Record<string, string>> {
  return {
    'build:microsoft-store': `pnpm exec mpgd target build microsoft-store production --targets-file ./mpgd.targets.json --kit-path ${kitPath}`,
    'smoke:microsoft-store': `pnpm exec mpgd target smoke microsoft-store --targets-file ./mpgd.targets.json --kit-path ${kitPath}`,
    'preflight:microsoft-store': `pnpm exec mpgd target preflight microsoft-store --targets-file ./mpgd.targets.json --kit-path ${kitPath}`,
    'package:microsoft-store': 'pnpm exec mpgd target generate-package microsoft-store --targets-file ./mpgd.targets.json',
  };
}

function requireSafeShellParameterDefaultPath(value: string): string {
  const normalized = toTemplatePath(value.trim());

  if (!/^[\p{L}\p{N} ._/:@+(),-]+$/u.test(normalized)) {
    throw new Error(
      'The default kit path contains characters that are unsafe in a shell parameter default.',
    );
  }

  return normalized;
}

function assertCompatibleMicrosoftStoreTarget(value: unknown): void {
  const target = requireJsonObject(value, 'microsoft-store target');
  const icon = isJsonObject(target.icon) ? target.icon : undefined;

  if (
    target.kind !== 'web'
    || target.adapter !== 'browser'
    || target.gameApp !== microsoftStoreTarget.gameApp
    || target.output !== microsoftStoreTarget.output
    || icon?.profile !== microsoftStoreTarget.icon.profile
  ) {
    throw new Error(
      'Existing microsoft-store target must use the game root, Store artifact directory, browser adapter, and microsoft-pwa icon profile.',
    );
  }
}

function addMicrosoftStoreBootstrap(source: string): string {
  let output = source;

  if (!output.includes(microsoftStoreBootstrap.importLine)) {
    output = insertAfter(
      output,
      microsoftStoreBootstrap.importAnchor,
      microsoftStoreBootstrap.importLine,
      'src/main.ts platform import',
    );
  }

  if (!output.includes(microsoftStoreBootstrap.localLine.trim())) {
    output = insertAfter(
      output,
      microsoftStoreBootstrap.localAnchor,
      microsoftStoreBootstrap.localLine,
      'src/main.ts bootstrap locals',
    );
  }

  if (!output.includes(microsoftStoreBootstrap.runtimeLine.trim())) {
    output = insertAfter(
      output,
      microsoftStoreBootstrap.runtimeAnchor,
      microsoftStoreBootstrap.runtimeLine,
      'src/main.ts runtime config',
    );
  }

  if (!output.includes(microsoftStoreBootstrap.catchLine)) {
    output = insertBefore(
      output,
      microsoftStoreBootstrap.catchAnchor,
      microsoftStoreBootstrap.catchLine,
      'src/main.ts bootstrap catch',
    );
  }

  return output;
}

function removeMicrosoftStoreBootstrap(source: string): string {
  const lines = [
    microsoftStoreBootstrap.importLine,
    microsoftStoreBootstrap.localLine,
    microsoftStoreBootstrap.runtimeLine,
    microsoftStoreBootstrap.catchLine,
  ];
  let output = source;

  for (const line of lines) {
    const occurrences = output.split(`${line}\n`).length - 1;

    if (occurrences !== 1) {
      throw new Error(`Template src/main.ts must contain exactly one line: ${line}`);
    }

    output = output.replace(`${line}\n`, '');
  }

  return output;
}

function insertAfter(source: string, anchor: string, line: string, label: string): string {
  const occurrences = source.split(anchor).length - 1;

  if (occurrences !== 1) {
    throw new Error(`${label} must contain exactly one canonical insertion anchor.`);
  }

  return source.replace(anchor, `${anchor}\n${line}`);
}

function insertBefore(source: string, anchor: string, line: string, label: string): string {
  const occurrences = source.split(anchor).length - 1;

  if (occurrences !== 1) {
    throw new Error(`${label} must contain exactly one canonical insertion anchor.`);
  }

  return source.replace(anchor, `${line}\n${anchor}`);
}

function planGitignore(
  gameRoot: string,
  plan: (relativePath: string, content: string) => void,
): void {
  const relativePath = '.gitignore';
  const file = resolveGameFile(gameRoot, relativePath);
  const source = existsSync(file) ? readRequiredRegularFile(gameRoot, file, relativePath) : '';
  const lines = source
    .split(/\r?\n/u)
    .filter((line, index, entries) => line.length > 0 || index < entries.length - 1);

  for (const required of ['release-input/', 'release-output/']) {
    if (!lines.includes(required)) {
      lines.push(required);
    }
  }

  plan(relativePath, `${lines.join('\n')}\n`);
}

function planAgentManifest(
  gameRoot: string,
  plan: (relativePath: string, content: string) => void,
): void {
  const relativePath = 'agent/game-manifest.json';
  const file = resolveGameFile(gameRoot, relativePath);

  if (!existsSync(file)) {
    console.warn(
      `Warning: ${relativePath} was not found; the Microsoft Store agent workflow was not registered.`,
    );
    return;
  }

  const manifest = parseJsonObject(
    readRequiredRegularFile(gameRoot, file, relativePath),
    relativePath,
  );

  if (!Array.isArray(manifest.targets)) {
    throw new Error(`${relativePath} targets must be an array.`);
  }

  if (!manifest.targets.includes('microsoft-store')) {
    const webIndex = manifest.targets.indexOf('web-preview');
    const insertAt = webIndex < 0 ? manifest.targets.length : webIndex + 1;
    manifest.targets.splice(insertAt, 0, 'microsoft-store');
  }

  const workflow = manifest.agentWorkflow === undefined
    ? {}
    : requireJsonObject(manifest.agentWorkflow, `${relativePath} agentWorkflow`);
  manifest.agentWorkflow = workflow;
  workflow.guide ??= 'docs/MPGD_KIT_WORKFLOWS.md';
  workflow.routerSkill ??= '.agents/skills/use-mpgd-kit/SKILL.md';
  const targetSkills = workflow.targetSkills === undefined
    ? {}
    : requireJsonObject(workflow.targetSkills, `${relativePath} agentWorkflow.targetSkills`);
  workflow.targetSkills = targetSkills;
  const skillPath = '.agents/skills/release-microsoft-store/SKILL.md';
  const existingSkill = targetSkills['microsoft-store'];

  if (existingSkill !== undefined && existingSkill !== skillPath) {
    throw new Error(`${relativePath} already assigns a different Microsoft Store skill.`);
  }

  targetSkills['microsoft-store'] = skillPath;

  plan(relativePath, formatJson(manifest));
}

function planManagedDocumentation(
  gameRoot: string,
  templateRoot: string,
  plan: (relativePath: string, content: string) => void,
): void {
  for (const relativePath of ['README.md', 'agent/brief.md', 'agent/acceptance.md'] as const) {
    const file = resolveGameFile(gameRoot, relativePath);

    if (!existsSync(file)) {
      continue;
    }

    const source = readRequiredRegularFile(gameRoot, file, relativePath);
    const template = readRequiredTemplateFile(templateRoot, relativePath);
    const managedBlock = extractMicrosoftStoreBlock(template).trim();
    plan(relativePath, upsertManagedDocumentationBlock(source, managedBlock, relativePath));
  }
}

function upsertManagedDocumentationBlock(
  source: string,
  managedBlock: string,
  relativePath: 'README.md' | 'agent/brief.md' | 'agent/acceptance.md',
): string {
  const startCount = source.split(microsoftStoreBlockStart).length - 1;
  const endCount = source.split(microsoftStoreBlockEnd).length - 1;
  const start = source.indexOf(microsoftStoreBlockStart);
  const end = source.indexOf(microsoftStoreBlockEnd);

  if (startCount > 0 || endCount > 0) {
    if (startCount !== 1 || endCount !== 1 || end < start) {
      throw new Error(`${relativePath} has malformed Microsoft Store managed block markers.`);
    }

    return `${source.slice(0, start)}${managedBlock}${source.slice(end + microsoftStoreBlockEnd.length)}`;
  }

  const legacyBlock = removeMicrosoftStoreBlockMarkers(managedBlock).trim();

  if (legacyBlock.length === 0) {
    throw new Error(`${relativePath} Microsoft Store managed block must not be empty.`);
  }

  if (source.includes(legacyBlock)) {
    return source.replace(legacyBlock, managedBlock);
  }

  const anchor = managedDocumentationAnchor(relativePath);

  if (anchor === undefined) {
    return `${source.trimEnd()}\n\n${managedBlock}\n`;
  }

  const anchorCount = source.split(anchor).length - 1;

  if (anchorCount > 1) {
    throw new Error(`${relativePath} has more than one Microsoft Store insertion anchor.`);
  }

  return anchorCount === 0
    ? `${source.trimEnd()}\n\n${managedBlock}\n`
    : source.replace(anchor, `${managedBlock}\n${anchor}`);
}

function managedDocumentationAnchor(
  relativePath: 'README.md' | 'agent/brief.md' | 'agent/acceptance.md',
): string | undefined {
  return microsoftStoreDocumentationAnchors[relativePath];
}

function extractMicrosoftStoreBlock(source: string): string {
  const start = source.indexOf(microsoftStoreBlockStart);
  const end = source.indexOf(microsoftStoreBlockEnd);

  if (start < 0 || end < start) {
    throw new Error('Microsoft Store documentation block markers are missing or out of order.');
  }

  return source.slice(start, end + microsoftStoreBlockEnd.length);
}

function removeMicrosoftStoreBlocks(source: string): string {
  let output = source;

  while (output.includes(microsoftStoreBlockStart)) {
    const start = output.indexOf(microsoftStoreBlockStart);
    const end = output.indexOf(microsoftStoreBlockEnd, start);

    if (end < 0) {
      throw new Error('Microsoft Store template block is missing its closing marker.');
    }

    output = `${output.slice(0, start)}${output.slice(end + microsoftStoreBlockEnd.length)}`;
  }

  return output.replace(/\n{3,}/gu, '\n\n');
}

function removeMicrosoftStoreBlockMarkers(source: string): string {
  return source
    .replaceAll(microsoftStoreBlockStart, '')
    .replaceAll(microsoftStoreBlockEnd, '');
}

function updateJson(source: string, update: (value: JsonObject) => void): string {
  const value = parseJsonObject(source, 'template JSON');
  update(value);
  return formatJson(value);
}

function parseJsonObject(source: string, label: string): JsonObject {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${formatError(error)}`);
  }

  return requireJsonObject(value, label);
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveGameRoot(value: string): string {
  const resolved = path.resolve(value);

  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    throw new Error(`Game root must be an existing directory: ${resolved}`);
  }

  return realpathSync(resolved);
}

function resolveGameFile(gameRoot: string, relativePath: string): string {
  const file = path.resolve(gameRoot, relativePath);

  if (!isInside(gameRoot, file)) {
    throw new Error(`Starter path escapes the game root: ${relativePath}`);
  }

  return file;
}

function readOptionalRegularFile(
  gameRoot: string,
  file: string,
  relativePath: string,
): string | undefined {
  const stat = lstatIfExists(file);

  if (stat === undefined) {
    return undefined;
  }

  return readRequiredRegularFile(gameRoot, file, relativePath);
}

function lstatIfExists(file: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function readRequiredRegularFile(
  gameRoot: string,
  file: string,
  relativePath: string,
): string {
  const stat = lstatSync(file);

  if (!stat.isFile()) {
    throw new Error(`Starter path must be a regular file: ${relativePath}`);
  }

  if (!isInside(gameRoot, realpathSync(file))) {
    throw new Error(`Starter path resolves outside the game root: ${relativePath}`);
  }

  return readFileSync(file, 'utf8');
}

function readRegularFileMode(file: string, relativePath: string): number {
  const stat = lstatIfExists(file);

  if (stat === undefined) {
    throw new Error(`Starter file changed while initialization was being planned: ${relativePath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Starter path must remain a regular file: ${relativePath}`);
  }

  return Number(stat.mode) & 0o777;
}

function readRequiredTemplateFile(templateRoot: string, relativePath: string): string {
  const file = path.resolve(templateRoot, relativePath);

  if (!isInside(templateRoot, file)) {
    throw new Error(`Starter template path escapes the template root: ${relativePath}`);
  }

  try {
    const stat = lstatSync(file);

    if (!stat.isFile()) {
      throw new Error(`Starter template path must be a regular file: ${relativePath}`);
    }

    if (!isInside(templateRoot, realpathSync(file))) {
      throw new Error(`Starter template path resolves outside the template root: ${relativePath}`);
    }

    return readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Starter template file is missing: ${relativePath}`);
    }

    throw error;
  }
}

function applyPlannedWrites(
  gameRoot: string,
  writes: readonly PlannedWrite[],
  runtime: MicrosoftStoreStarterApplyRuntime,
): void {
  const applied: AppliedWrite[] = [];

  try {
    for (const planned of writes) {
      const current = readOptionalRegularFile(gameRoot, planned.file, planned.relativePath);

      if (current !== planned.previous) {
        throw new Error(
          `Starter file changed while initialization was running: ${planned.relativePath}`,
        );
      }

      const parent = path.dirname(planned.file);
      assertSafeWritableParent(gameRoot, parent, planned.relativePath);
      const createdDirectories: string[] = [];
      const suffix = `.mpgd-init-${randomUUID()}`;
      const temporaryFile = `${planned.file}${suffix}.tmp`;
      const backupFile = planned.previous === undefined
        ? undefined
        : `${planned.file}${suffix}.bak`;
      let backupMoved = false;

      try {
        createMissingDirectories(gameRoot, parent, planned.relativePath, createdDirectories);

        writeFileSync(temporaryFile, planned.content, {
          encoding: 'utf8',
          flag: 'wx',
          mode: planned.mode,
        });
        chmodSync(temporaryFile, planned.mode);
        runtime.beforeCommit?.(planned.relativePath);

        if (backupFile !== undefined) {
          renameSync(planned.file, backupFile);
          backupMoved = true;
        }

        renameSync(temporaryFile, planned.file);
      } catch (error) {
        const recoveryErrors: unknown[] = [];

        if (backupMoved && backupFile !== undefined && existsSync(backupFile)) {
          try {
            renameSync(backupFile, planned.file);
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }

        try {
          rmSync(temporaryFile, { force: true });
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }

        recoveryErrors.push(...removeCreatedDirectories(createdDirectories));

        if (recoveryErrors.length > 0) {
          throw new Error(
            `Starter write failed and recovery was incomplete for ${planned.relativePath}: ${recoveryErrors.map(formatError).join('; ')}`,
            { cause: error },
          );
        }

        throw error;
      }

      applied.push({ planned, backupFile, temporaryFile, createdDirectories });
    }
  } catch (error) {
    const rollbackErrors: { readonly relativePath: string; readonly error: unknown }[] = [];

    for (const entry of [...applied].reverse()) {
      try {
        runtime.beforeRollbackEntry?.(entry.planned.relativePath);
        rmSync(entry.planned.file, { force: true });

        if (entry.backupFile !== undefined && existsSync(entry.backupFile)) {
          renameSync(entry.backupFile, entry.planned.file);
        }
      } catch (rollbackError) {
        rollbackErrors.push({
          relativePath: entry.planned.relativePath,
          error: rollbackError,
        });
      }

      try {
        rmSync(entry.temporaryFile, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push({
          relativePath: entry.planned.relativePath,
          error: rollbackError,
        });
      }

      for (const cleanupError of removeCreatedDirectories(entry.createdDirectories)) {
        rollbackErrors.push({
          relativePath: entry.planned.relativePath,
          error: cleanupError,
        });
      }
    }

    if (rollbackErrors.length > 0) {
      throw new Error(
        `Starter initialization failed and rollback was incomplete: ${rollbackErrors.map((failure) => `${failure.relativePath}: ${formatError(failure.error)}`).join('; ')}`,
        { cause: error },
      );
    }

    throw error;
  }

  for (const entry of applied) {
    if (entry.backupFile !== undefined) {
      try {
        rmSync(entry.backupFile, { force: true });
      } catch (cleanupError) {
        // The committed file is authoritative; a backup cleanup failure must not roll it back.
        console.warn(
          `Warning: failed to clean up starter backup ${entry.backupFile}: ${formatError(cleanupError)}`,
        );
      }
    }
  }
}

function listMissingDirectories(parent: string): readonly string[] {
  const missing: string[] = [];
  let current = parent;

  while (lstatIfExists(current) === undefined) {
    missing.push(current);
    const next = path.dirname(current);

    if (next === current) {
      break;
    }

    current = next;
  }

  return missing;
}

function createMissingDirectories(
  gameRoot: string,
  parent: string,
  relativePath: string,
  createdDirectories: string[],
): void {
  for (const directory of [...listMissingDirectories(parent)].reverse()) {
    let created = false;

    try {
      mkdirSync(directory);
      created = true;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }

    const stat = lstatSync(directory);

    if (!stat.isDirectory() || !isInside(gameRoot, realpathSync(directory))) {
      throw new Error(`Starter directory resolves outside the game root: ${relativePath}`);
    }

    if (created) {
      createdDirectories.unshift(directory);
    }
  }
}

function removeCreatedDirectories(
  directories: readonly string[],
): readonly unknown[] {
  const errors: unknown[] = [];

  for (const directory of directories) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (isMissingPathError(error) || isNonEmptyDirectoryError(error)) {
        continue;
      }

      errors.push(error);
    }
  }

  return errors;
}

function isNonEmptyDirectoryError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeWritableParent(
  gameRoot: string,
  parent: string,
  relativePath: string,
): void {
  let existing = parent;

  while (lstatIfExists(existing) === undefined) {
    const next = path.dirname(existing);

    if (next === existing) {
      throw new Error(`Starter path has no existing parent: ${relativePath}`);
    }

    existing = next;
  }

  const stat = lstatSync(existing);

  if (!stat.isDirectory() || !isInside(gameRoot, realpathSync(existing))) {
    throw new Error(`Starter directory resolves outside the game root: ${relativePath}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === ''
    || (
      !relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative)
    )
  );
}

function toTemplatePath(value: string): string {
  return value.split(path.sep).join('/');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
