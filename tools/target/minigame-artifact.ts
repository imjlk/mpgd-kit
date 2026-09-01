import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { GeneratedTargetIcons } from '../icons/types';
import {
  assertMiniGameArtifactRelativePath,
  assertMiniGamePackageBudget,
  listMiniGameArtifactFiles,
  type MiniGamePackageSizeResult,
} from './minigame-package-budget';
import type { MiniGamePackageBudget, MiniGameTargetConfig } from './schemas';

export const miniGameArtifactEvidenceFileName = 'mpgd-minigame-artifact.json';
export const miniGameEffectiveTargetConfigFileName = 'mpgd-effective-target-config.json';
export const miniGameIconManifestFileName = 'mpgd-icon-manifest.json';

export interface MiniGameArtifactFileEvidence {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface MiniGameArtifactEvidence {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly runtime: MiniGameTargetConfig['kind'];
  readonly renderer: 'canvas';
  readonly experimental: true;
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly effectiveTargetConfig: Readonly<{
    readonly path: typeof miniGameEffectiveTargetConfigFileName;
    readonly sha256: string;
  }>;
  readonly iconManifest: Readonly<{
    readonly path: typeof miniGameIconManifestFileName;
    readonly sha256: string;
  }>;
  readonly packageSize: MiniGamePackageSizeResult;
  /** Every regular payload file except this self-referential evidence document. */
  readonly files: readonly MiniGameArtifactFileEvidence[];
}

export interface WriteMiniGameArtifactEvidenceInput {
  readonly artifactRoot: string;
  readonly target: string;
  readonly runtime: MiniGameTargetConfig['kind'];
  readonly appVersion: string;
  readonly buildId: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly budget: MiniGamePackageBudget;
}

export interface AssembleMiniGameArtifactInput extends WriteMiniGameArtifactEvidenceInput {
  readonly projectRoot: string;
  readonly runtimeBundleRoot: string;
  readonly gameBundleRoot: string;
  readonly effectiveTargetConfigSource: string;
  readonly generatedIcons: GeneratedTargetIcons;
  readonly writeProjectFiles: (artifactRoot: string) => void;
  readonly forbiddenJavaScriptMarkers?: readonly Readonly<{
    readonly marker: string;
    readonly owner: string;
  }>[];
}

export function assembleMiniGameArtifact(
  input: AssembleMiniGameArtifactInput,
): MiniGameArtifactEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  assertMiniGameArtifactOutputDirectory(artifactRoot, input.projectRoot);
  const artifactParent = dirname(artifactRoot);
  mkdirSync(artifactParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(artifactParent, `.${basename(artifactRoot)}-staging-`));
  const stagingInput = { ...input, artifactRoot: stagingRoot };

  try {
    copyMiniGameBundleOutput(input.runtimeBundleRoot, stagingRoot);
    copyMiniGameBundleOutput(input.gameBundleRoot, stagingRoot);
    copyFileSync(
      input.effectiveTargetConfigSource,
      join(stagingRoot, miniGameEffectiveTargetConfigFileName),
    );
    stageMiniGameIconEvidence(input.generatedIcons, stagingRoot);
    input.writeProjectFiles(stagingRoot);
    assertMiniGameRequiredFiles(stagingRoot);
    assertMiniGameJavaScriptSafety(stagingRoot, input.forbiddenJavaScriptMarkers ?? []);
    const evidence = writeMiniGameArtifactEvidence(stagingInput);

    verifyMiniGameArtifactEvidence({
      ...stagingInput,
      renderer: 'canvas',
      experimental: true,
    });
    replaceMiniGameArtifact(stagingRoot, artifactRoot);
    return evidence;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export function assertMiniGameArtifactOutputDirectory(
  artifactRoot: string,
  projectRoot: string,
): void {
  const project = resolve(projectRoot);
  const artifact = resolve(artifactRoot);
  const projectRelativePath = relative(project, artifact);
  const segments = projectRelativePath.split(/[\\/]+/u);

  if (
    projectRelativePath.length === 0
    || projectRelativePath === '..'
    || projectRelativePath.startsWith('../')
    || isAbsolute(projectRelativePath)
    || segments[0] !== 'artifacts'
    || segments.length < 2
  ) {
    throw new Error(
      `Mini-game artifact output must be a dedicated artifacts/ child: ${artifactRoot}`,
    );
  }

  let candidate = artifact;

  while (candidate !== project) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`Mini-game artifact output must not traverse a symbolic link: ${candidate}`);
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      throw new Error(`Mini-game artifact output is outside its project root: ${artifactRoot}`);
    }
    candidate = parent;
  }
}

export function writeMiniGameArtifactEvidence(
  input: WriteMiniGameArtifactEvidenceInput,
): MiniGameArtifactEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  const evidencePath = join(artifactRoot, miniGameArtifactEvidenceFileName);
  rmSync(evidencePath, { force: true });
  const files = listMiniGameArtifactFiles(artifactRoot).map((file) => ({
    path: file.path,
    size: file.bytes,
    sha256: sha256(readFileSync(join(artifactRoot, file.path))),
  }));
  const effectiveTargetConfig = requireEvidenceFile(
    artifactRoot,
    files,
    miniGameEffectiveTargetConfigFileName,
  );
  const iconManifest = requireEvidenceFile(artifactRoot, files, miniGameIconManifestFileName);
  const gameConfig = readJson(join(artifactRoot, 'game.json'), 'Mini-game game.json');
  let packageSize = assertMiniGamePackageBudget({
    artifactRoot,
    gameConfig,
    budget: input.budget,
  });
  let evidence = createEvidence(input, files, effectiveTargetConfig, iconManifest, packageSize);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(evidencePath, serialized);
    packageSize = assertMiniGamePackageBudget({
      artifactRoot,
      gameConfig,
      budget: input.budget,
    });
    const next = createEvidence(input, files, effectiveTargetConfig, iconManifest, packageSize);
    const nextSerialized = `${JSON.stringify(next, null, 2)}\n`;

    if (nextSerialized === serialized) {
      return next;
    }

    evidence = next;
  }

  throw new Error('Mini-game artifact evidence size did not converge.');
}

export interface VerifyMiniGameArtifactEvidenceInput extends WriteMiniGameArtifactEvidenceInput {
  readonly renderer: 'canvas';
  readonly experimental: true;
}

export function verifyMiniGameArtifactEvidence(
  input: VerifyMiniGameArtifactEvidenceInput,
): MiniGameArtifactEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  const evidencePath = join(artifactRoot, miniGameArtifactEvidenceFileName);
  const parsed = readJson(evidencePath, 'Mini-game artifact evidence');
  const evidence = assertMiniGameArtifactEvidenceShape(parsed);

  for (const [field, expected] of [
    ['target', input.target],
    ['runtime', input.runtime],
    ['renderer', input.renderer],
    ['experimental', input.experimental],
    ['appVersion', input.appVersion],
    ['buildId', input.buildId],
    ['sourceGitSha', input.sourceGitSha],
    ['kitGitSha', input.kitGitSha],
  ] as const) {
    if (evidence[field] !== expected) {
      throw new Error(`Mini-game artifact evidence ${field} mismatch.`);
    }
  }

  const actualFiles = listMiniGameArtifactFiles(artifactRoot)
    .filter((file) => file.path !== miniGameArtifactEvidenceFileName);
  const expectedPaths = evidence.files.map((file) => file.path);
  const actualPaths = actualFiles.map((file) => file.path);

  if (new Set(expectedPaths).size !== expectedPaths.length) {
    throw new Error('Mini-game artifact evidence contains duplicate file paths.');
  }
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error('Mini-game artifact evidence file list does not match the artifact payload.');
  }

  for (const [index, file] of evidence.files.entries()) {
    const actual = actualFiles[index];

    if (actual === undefined || actual.bytes !== file.size) {
      throw new Error(`Mini-game artifact evidence size mismatch: ${file.path}`);
    }
    if (sha256(readFileSync(join(artifactRoot, file.path))) !== file.sha256) {
      throw new Error(`Mini-game artifact evidence digest mismatch: ${file.path}`);
    }
  }

  verifyNamedDigest(
    artifactRoot,
    evidence.effectiveTargetConfig,
    miniGameEffectiveTargetConfigFileName,
    'effective target config',
  );
  verifyNamedDigest(
    artifactRoot,
    evidence.iconManifest,
    miniGameIconManifestFileName,
    'icon manifest',
  );
  const packageSize = assertMiniGamePackageBudget({
    artifactRoot,
    gameConfig: readJson(join(artifactRoot, 'game.json'), 'Mini-game game.json'),
    budget: input.budget,
  });

  if (JSON.stringify(packageSize) !== JSON.stringify(evidence.packageSize)) {
    throw new Error('Mini-game artifact evidence package size mismatch.');
  }

  return evidence;
}

export function stageMiniGameIconEvidence(
  generated: GeneratedTargetIcons,
  artifactRoot: string,
): void {
  mkdirSync(artifactRoot, { recursive: true });
  copyFileSync(generated.manifestPath, join(artifactRoot, miniGameIconManifestFileName));

  for (const output of generated.manifest.outputs) {
    const source = join(generated.outputDir, basename(output.path));
    const destination = join(artifactRoot, output.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function copyMiniGameBundleOutput(sourceRoot: string, artifactRoot: string): void {
  const source = resolve(sourceRoot);

  if (!existsSync(source)) {
    throw new Error(`Mini-game bundle output does not exist: ${source}`);
  }

  for (const entry of readdirSync(source)) {
    const destination = join(artifactRoot, entry);

    if (existsSync(destination)) {
      throw new Error(`Mini-game bundle outputs collide at ${entry}.`);
    }
    cpSync(join(source, entry), destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
}

function replaceMiniGameArtifact(stagingRoot: string, artifactRoot: string): void {
  let backupRoot: string | undefined;

  if (existsSync(artifactRoot)) {
    backupRoot = mkdtempSync(join(dirname(artifactRoot), `.${basename(artifactRoot)}-backup-`));
    rmSync(backupRoot, { force: true, recursive: true });
    renameSync(artifactRoot, backupRoot);
  }

  try {
    renameSync(stagingRoot, artifactRoot);
  } catch (error) {
    if (backupRoot !== undefined) {
      try {
        renameSync(backupRoot, artifactRoot);
      } catch (restoreError) {
        throw new Error(
          `Failed to activate the new mini-game artifact and restore the prior artifact: `
            + `${formatError(error)}; restore failed: ${formatError(restoreError)}. `
            + `The prior artifact remains at ${backupRoot}.`,
        );
      }
    }
    throw error;
  }

  if (backupRoot !== undefined) {
    rmSync(backupRoot, { force: true, recursive: true });
  }
}

function assertMiniGameRequiredFiles(artifactRoot: string): void {
  for (const file of [
    'game.js',
    'game.json',
    'project.config.json',
    'runtime.js',
    'game.bundle.js',
    miniGameEffectiveTargetConfigFileName,
    miniGameIconManifestFileName,
  ]) {
    if (!existsSync(join(artifactRoot, file))) {
      throw new Error(`Mini-game artifact is missing required file: ${file}`);
    }
  }

  const entry = readFileSync(join(artifactRoot, 'game.js'), 'utf8');

  if (entry !== "require('./runtime.js');\nrequire('./game.bundle.js');\n") {
    throw new Error('Mini-game game.js must load runtime.js before game.bundle.js.');
  }
}

export function assertMiniGameJavaScriptSafety(
  artifactRoot: string,
  forbiddenMarkers: readonly Readonly<{ readonly marker: string; readonly owner: string }>[],
): void {
  const javascript = listMiniGameArtifactFiles(artifactRoot)
    .filter((file) => file.path.endsWith('.js'));

  for (const file of javascript) {
    const source = readFileSync(join(artifactRoot, file.path), 'utf8');

    for (const [pattern, label] of [
      [/\bimport\s*\(/u, 'dynamic import'],
      [/\beval\s*\(/u, 'eval'],
      [/\bnew\s+Function\b/u, 'new Function'],
      [
        /(?:\bimportScripts\s*\(\s*["'`]https?:\/\/|https?:\/\/[^\s"'`]+\.m?js(?:[?#][^\s"'`]*)?)/iu,
        'remote executable code reference',
      ],
      [/\bindex\.html\b/u, 'HTML entry dependency'],
      [/["'`]\.?\/?[^"'`]*\.css(?:[?"'`])/u, 'CSS runtime dependency'],
    ] as const) {
      if (pattern.test(source)) {
        throw new Error(`Mini-game ${file.path} contains forbidden ${label}.`);
      }
    }

    for (const forbidden of forbiddenMarkers) {
      if (source.includes(forbidden.marker)) {
        throw new Error(`Mini-game ${file.path} contains ${forbidden.owner} adapter code.`);
      }
    }
  }
}

function createEvidence(
  input: WriteMiniGameArtifactEvidenceInput,
  files: readonly MiniGameArtifactFileEvidence[],
  effectiveTargetConfig: MiniGameArtifactFileEvidence,
  iconManifest: MiniGameArtifactFileEvidence,
  packageSize: MiniGamePackageSizeResult,
): MiniGameArtifactEvidence {
  return {
    schemaVersion: 1,
    target: input.target,
    runtime: input.runtime,
    renderer: 'canvas',
    experimental: true,
    appVersion: input.appVersion,
    buildId: input.buildId,
    sourceGitSha: input.sourceGitSha,
    kitGitSha: input.kitGitSha,
    effectiveTargetConfig: {
      path: miniGameEffectiveTargetConfigFileName,
      sha256: effectiveTargetConfig.sha256,
    },
    iconManifest: {
      path: miniGameIconManifestFileName,
      sha256: iconManifest.sha256,
    },
    packageSize,
    files,
  };
}

function requireEvidenceFile(
  artifactRoot: string,
  files: readonly MiniGameArtifactFileEvidence[],
  path: string,
): MiniGameArtifactFileEvidence {
  const file = files.find((candidate) => candidate.path === path);

  if (file === undefined || !existsSync(join(artifactRoot, path))) {
    throw new Error(`Mini-game artifact is missing required evidence file: ${path}`);
  }

  return file;
}

function assertMiniGameArtifactEvidenceShape(input: unknown): MiniGameArtifactEvidence {
  assertRecord(input, 'Mini-game artifact evidence');

  if (input.schemaVersion !== 1) {
    throw new Error('Mini-game artifact evidence schemaVersion must be 1.');
  }
  for (const field of [
    'target',
    'runtime',
    'renderer',
    'appVersion',
    'buildId',
    'sourceGitSha',
    'kitGitSha',
  ] as const) {
    assertNonEmptyString(input[field], `Mini-game artifact evidence ${field}`);
  }
  if (input.runtime !== 'wechat-minigame' && input.runtime !== 'tiktok-minigame') {
    throw new Error('Mini-game artifact evidence runtime is invalid.');
  }
  if (input.renderer !== 'canvas' || input.experimental !== true) {
    throw new Error('Mini-game artifact evidence must remain experimental and Canvas-only.');
  }
  assertDigestReference(input.effectiveTargetConfig, miniGameEffectiveTargetConfigFileName);
  assertDigestReference(input.iconManifest, miniGameIconManifestFileName);
  assertPackageSize(input.packageSize);

  if (!Array.isArray(input.files)) {
    throw new Error('Mini-game artifact evidence files must be an array.');
  }
  for (const [index, file] of input.files.entries()) {
    assertRecord(file, `Mini-game artifact evidence file ${String(index)}`);
    assertNonEmptyString(file.path, `Mini-game artifact evidence file ${String(index)} path`);
    assertMiniGameArtifactRelativePath(file.path, 'Mini-game artifact evidence file path');
    assertNonNegativeSafeInteger(file.size, `Mini-game artifact evidence file ${file.path} size`);
    assertSha256(file.sha256, `Mini-game artifact evidence file ${file.path} sha256`);
  }

  return input as unknown as MiniGameArtifactEvidence;
}

function assertDigestReference(input: unknown, expectedPath: string): void {
  assertRecord(input, `Mini-game artifact ${expectedPath} digest reference`);

  if (input.path !== expectedPath) {
    throw new Error(`Mini-game artifact digest reference path must be ${expectedPath}.`);
  }
  assertSha256(input.sha256, `Mini-game artifact ${expectedPath} sha256`);
}

function assertPackageSize(input: unknown): void {
  assertRecord(input, 'Mini-game artifact package size');
  assertNonNegativeSafeInteger(input.mainBytes, 'Mini-game artifact main package size');
  assertNonNegativeSafeInteger(input.totalBytes, 'Mini-game artifact total package size');

  if (!Array.isArray(input.subpackages)) {
    throw new Error('Mini-game artifact package subpackages must be an array.');
  }
  for (const [index, subpackage] of input.subpackages.entries()) {
    assertRecord(subpackage, `Mini-game artifact subpackage ${String(index)}`);
    assertNonEmptyString(subpackage.root, `Mini-game artifact subpackage ${String(index)} root`);
    assertMiniGameArtifactRelativePath(subpackage.root, 'Mini-game artifact subpackage root');
    if (typeof subpackage.independent !== 'boolean') {
      throw new Error('Mini-game artifact subpackage independent must be a boolean.');
    }
    assertNonNegativeSafeInteger(
      subpackage.bytes,
      `Mini-game artifact subpackage ${subpackage.root} bytes`,
    );
  }
}

function verifyNamedDigest(
  artifactRoot: string,
  reference: Readonly<{ readonly path: string; readonly sha256: string }>,
  expectedPath: string,
  label: string,
): void {
  if (reference.path !== expectedPath) {
    throw new Error(`Mini-game artifact ${label} path mismatch.`);
  }
  const digest = sha256(readFileSync(join(artifactRoot, reference.path)));

  if (digest !== reference.sha256) {
    throw new Error(`Mini-game artifact ${label} digest mismatch.`);
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is unreadable: ${formatError(error)}`);
  }
}

function sha256(input: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
}

function assertNonNegativeSafeInteger(input: unknown, label: string): asserts input is number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertSha256(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/u.test(input)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
