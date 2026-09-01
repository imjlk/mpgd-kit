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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse } from 'acorn';

import type { GeneratedTargetIcons } from '../icons/types';
import {
  assertMiniGameArtifactRelativePath,
  assertMiniGamePackageBudget,
  listMiniGameArtifactFiles,
  type MiniGamePackageSizeResult,
} from './minigame-package-budget';
import type { MiniGamePackageBudget, MiniGameTargetConfig, PlatformTargetConfig } from './schemas';

export const miniGameArtifactEvidenceFileName = 'mpgd-minigame-artifact.json';
export const miniGameEffectiveTargetConfigFileName = 'mpgd-effective-target-config.json';
export const miniGameIconManifestFileName = 'mpgd-icon-manifest.json';
const forbiddenJavaScriptPatterns = [
  { pattern: /\bimport\s*\(/u, label: 'dynamic import' },
  {
    pattern: /https?:\/\/[^\s"'`]+\.[cm]?js(?:[?#][^\s"'`]*)?/iu,
    label: 'remote executable code reference',
  },
  { pattern: /\bindex\.html\b/u, label: 'HTML entry dependency' },
  { pattern: /["'`]\.?\/?[^"'`]*\.css(?:[?"'`])/u, label: 'CSS runtime dependency' },
];

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

export interface NamedMiniGameProtectedOutput {
  readonly name: string;
  readonly path: string;
}

interface MiniGameAstAncestor {
  readonly node: Record<string, unknown>;
  readonly childKey: string;
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
  const portableProjectRelativePath = projectRelativePath.replaceAll(sep, '/');
  const segments = portableProjectRelativePath.split('/');

  if (
    projectRelativePath.length === 0
    || projectRelativePath === '..'
    || projectRelativePath.startsWith(`..${sep}`)
    || (sep === '/' && projectRelativePath.includes('\\'))
    || isAbsolute(projectRelativePath)
    || segments[0] !== 'artifacts'
    || segments.length < 2
  ) {
    throw new Error(
      `Mini-game artifact output must be a dedicated artifacts/ child: ${artifactRoot}`,
    );
  }
  assertMiniGameArtifactRelativePath(portableProjectRelativePath, 'Mini-game artifact output');

  let candidate = artifact;

  while (candidate !== project) {
    if (existsSync(candidate)) {
      const status = lstatSync(candidate);

      if (status.isSymbolicLink()) {
        throw new Error(
          'Mini-game artifact output must not traverse a symbolic link: '
            + candidate,
        );
      }
      if (!status.isDirectory()) {
        throw new Error(
          'Mini-game artifact output must only traverse directories: '
            + candidate,
        );
      }
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      throw new Error(`Mini-game artifact output is outside its project root: ${artifactRoot}`);
    }
    candidate = parent;
  }
}

export function assertDisjointMiniGameTargetOutputs(
  targets: Readonly<Record<string, PlatformTargetConfig>>,
  resolvePath: (path: string) => string,
  protectedOutputs: readonly NamedMiniGameProtectedOutput[] = [],
): void {
  const outputs = Object.entries(targets).flatMap(([name, target]) => {
    if (target.kind !== 'wechat-minigame' && target.kind !== 'tiktok-minigame') {
      return [];
    }
    assertMiniGameArtifactRelativePath(target.output, `Mini-game artifact output ${name}`);

    return [{ name, path: resolvePath(target.output) }];
  });
  const projectRoot = resolvePath('.');

  for (const output of outputs) {
    assertMiniGameArtifactOutputDirectory(output.path, projectRoot);
  }

  const canonicalOutputs = outputs.map((output) => ({
    ...output,
    canonicalPath: portablePathComparisonKey(output.path),
  }));

  for (const [index, output] of canonicalOutputs.entries()) {
    for (const candidate of canonicalOutputs.slice(index + 1)) {
      if (pathsOverlap(output.canonicalPath, candidate.canonicalPath)) {
        throw new Error(
          `Mini-game artifact outputs must not overlap: ${output.name} (${output.path}) and ${candidate.name} (${candidate.path}).`,
        );
      }
    }
  }

  const generatedOutputs = [
    { name: 'generated icon cache', path: resolvePath('.mpgd/generated/icons') },
    { name: 'release output', path: resolvePath('release-output') },
    ...configuredNonMiniGameOutputs(targets, resolvePath),
    ...protectedOutputs,
  ].map((output) => ({
    ...output,
    canonicalPath: portablePathComparisonKey(output.path),
  }));

  for (const output of canonicalOutputs) {
    for (const generatedOutput of generatedOutputs) {
      if (pathsOverlap(output.canonicalPath, generatedOutput.canonicalPath)) {
        throw new Error(
          `Mini-game artifact output must not overlap generated output: ${output.name} (${output.path}) and ${generatedOutput.name} (${generatedOutput.path}).`,
        );
      }
    }
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

function configuredNonMiniGameOutputs(
  targets: Readonly<Record<string, PlatformTargetConfig>>,
  resolvePath: (path: string) => string,
): readonly NamedMiniGameProtectedOutput[] {
  return Object.entries(targets).flatMap(([name, target]) => {
    const viteOutput = {
      name: `${name} Vite output`,
      path: resolvePath(join(target.gameApp, 'dist')),
    };

    switch (target.kind) {
      case 'web':
        return [
          viteOutput,
          { name: `${name} web artifact output`, path: resolvePath(target.output) },
          ...(target.staticDir === undefined
            ? []
            : [{ name: `${name} web staticDir`, path: resolvePath(target.staticDir) }]),
        ];
      case 'capacitor-android':
      case 'capacitor-ios':
        return [
          viteOutput,
          { name: `${name} web staging output`, path: resolvePath(target.webDir) },
        ];
      case 'apps-in-toss':
      case 'devvit-web':
        return [
          viteOutput,
          { name: `${name} web staging output`, path: resolvePath(target.webDir) },
          {
            name: `${name} wrapper build output`,
            path: resolvePath(join(target.wrapperApp, 'dist')),
          },
        ];
      case 'wechat-minigame':
      case 'tiktok-minigame':
        return [viteOutput];
    }
  });
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function portablePathComparisonKey(path: string): string {
  const portablePath = path.replaceAll('\\', '/').split('/').map((segment) => {
    return segment === '.' || segment === '..'
      ? segment
      : segment.replace(/[. ]+$/u, '');
  }).join('/');

  return canonicalizeThroughExistingAncestor(portablePath)
    .normalize('NFC')
    .toLowerCase();
}

function canonicalizeThroughExistingAncestor(path: string): string {
  const normalizedPath = resolve(path);
  const suffix: string[] = [];
  let existingAncestor = normalizedPath;

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);

    if (parent === existingAncestor) {
      throw new Error(`Cannot resolve an existing ancestor for mini-game output: ${path}`);
    }

    suffix.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  return resolve(realpathSync(existingAncestor), ...suffix);
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
    cleanupMiniGameArtifactBackup(backupRoot);
  }
}

export function cleanupMiniGameArtifactBackup(
  backupRoot: string,
  removeDirectory: (path: string) => void = removeMiniGameArtifactBackupDirectory,
  reportWarning: (message: string) => void = console.warn,
): void {
  try {
    removeDirectory(backupRoot);
  } catch (error) {
    reportWarning(
      `The new mini-game artifact is active, but its prior backup could not be removed: `
        + `${backupRoot} (${formatError(error)}). Remove this backup manually.`,
    );
  }
}

function removeMiniGameArtifactBackupDirectory(path: string): void {
  rmSync(path, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
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
    .filter((file) => ['.cjs', '.js', '.mjs'].includes(extname(file.path).toLowerCase()));

  for (const file of javascript) {
    const source = readFileSync(join(artifactRoot, file.path), 'utf8');
    assertMiniGameJavaScriptAstSafety(source, file.path);

    for (const { pattern, label } of forbiddenJavaScriptPatterns) {
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

function assertMiniGameJavaScriptAstSafety(source: string, path: string): void {
  let ast: unknown;

  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: path.toLowerCase().endsWith('.mjs') ? 'module' : 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new Error(`Mini-game ${path} is not valid JavaScript: ${formatError(error)}`);
  }

  const ancestors: MiniGameAstAncestor[] = [];
  visit(ast);

  function visit(input: unknown): void {
    if (Array.isArray(input)) {
      for (const item of input) {
        visit(item);
      }
      return;
    }
    if (!isAstRecord(input)) {
      return;
    }

    assertSafeNode(input, ancestors, path);
    for (const [key, value] of Object.entries(input)) {
      if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
        ancestors.push({ node: input, childKey: key });
        visit(value);
        ancestors.pop();
      }
    }
  }
}

function assertSafeNode(
  node: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
  path: string,
): void {
  if (node.type === 'ImportExpression') {
    throw new Error(`Mini-game ${path} contains forbidden dynamic import.`);
  }

  if (
    node.type === 'Identifier'
    && typeof node.name === 'string'
    && isExecutableIdentifierReference(ancestors)
  ) {
    if (node.name === 'eval') {
      throw new Error(`Mini-game ${path} contains forbidden eval.`);
    }
    if (node.name === 'Function') {
      throw new Error(`Mini-game ${path} contains forbidden Function constructor.`);
    }
    if (node.name === 'importScripts' && !isTypeofReference(node, ancestors)) {
      throw new Error(`Mini-game ${path} contains forbidden importScripts.`);
    }
  }

  if (node.type === 'MemberExpression') {
    const propertyName = node.computed === true
      ? evaluateStaticString(node.property)
      : readMemberName(node);

    if (
      propertyName !== undefined
      && ['eval', 'Function', 'importScripts'].includes(propertyName)
      && (node.computed === true || isDynamicCodeGlobalObject(node.object))
      && !isTypeofReference(node, ancestors)
    ) {
      throw new Error(`Mini-game ${path} contains forbidden ${propertyName}.`);
    }
  }

  if (
    node.type === 'Property'
    && node.computed === true
    && isComputedGlobalDestructuring(ancestors)
  ) {
    throw new Error(`Mini-game ${path} contains forbidden computed destructuring.`);
  }

  if (node.type === 'CallExpression' && isAstRecord(node.callee)) {
    const calleeName = readMemberName(node.callee);
    const firstArgument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;

    if (isUnknownComputedGlobalMember(node.callee)) {
      throw new Error(`Mini-game ${path} contains forbidden computed global call.`);
    }

    if (calleeName === 'createElement' && evaluateStaticString(firstArgument) === 'script') {
      throw new Error(`Mini-game ${path} contains forbidden script element creation.`);
    }
  }

  if (node.type === 'NewExpression' && isAstRecord(node.callee)) {
    const calleeName = readMemberName(node.callee);

    if (isUnknownComputedGlobalMember(node.callee)) {
      throw new Error(`Mini-game ${path} contains forbidden computed global construction.`);
    }

    if (calleeName === 'Worker' || calleeName === 'SharedWorker') {
      throw new Error(`Mini-game ${path} contains forbidden ${calleeName} construction.`);
    }
  }
}

function isComputedGlobalDestructuring(
  ancestors: readonly MiniGameAstAncestor[],
): boolean {
  const pattern = ancestors.at(-1)?.node;
  const container = ancestors.at(-2)?.node;

  if (!isAstRecord(pattern) || pattern.type !== 'ObjectPattern' || !isAstRecord(container)) {
    return false;
  }
  if (container.type === 'VariableDeclarator' && container.id === pattern) {
    return isGlobalObjectIdentifier(container.init);
  }

  return container.type === 'AssignmentExpression'
    && container.left === pattern
    && isGlobalObjectIdentifier(container.right);
}

function isGlobalObjectIdentifier(input: unknown): boolean {
  return isAstRecord(input)
    && input.type === 'Identifier'
    && typeof input.name === 'string'
    && ['globalThis', 'self', 'window'].includes(input.name);
}

function isDynamicCodeGlobalObject(input: unknown): boolean {
  return isGlobalObjectIdentifier(input)
    || (isAstRecord(input) && input.type === 'ThisExpression');
}

function isUnknownComputedGlobalMember(node: Record<string, unknown>): boolean {
  return node.type === 'MemberExpression'
    && node.computed === true
    && readMemberName(node) === undefined
    && isAstRecord(node.object)
    && node.object.type === 'Identifier'
    && typeof node.object.name === 'string'
    && ['globalThis', 'self', 'window'].includes(node.object.name);
}

function isTypeofReference(
  node: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
): boolean {
  let expression: Record<string, unknown> = node;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index]?.node;

    if (parent === undefined) {
      return false;
    }
    if (
      (parent.type === 'MemberExpression' || parent.type === 'ChainExpression')
      && (parent.object === expression
        || parent.property === expression
        || parent.expression === expression)
    ) {
      expression = parent;
      continue;
    }

    return parent.type === 'UnaryExpression'
      && parent.operator === 'typeof'
      && parent.argument === expression;
  }

  return false;
}

function isExecutableIdentifierReference(
  ancestors: readonly MiniGameAstAncestor[],
): boolean {
  const immediate = ancestors.at(-1);

  if (immediate === undefined) {
    return true;
  }
  const parent = immediate.node;
  const childKey = immediate.childKey;

  if (
    parent.type === 'MemberExpression'
    && parent.computed === false
    && childKey === 'property'
  ) {
    return false;
  }
  if (
    ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(String(parent.type))
    && parent.computed === false
    && childKey === 'key'
  ) {
    return false;
  }
  if (
    (parent.type === 'LabeledStatement' && childKey === 'label')
    || ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')
      && childKey === 'label')
    || (parent.type === 'MetaProperty' && (childKey === 'meta' || childKey === 'property'))
  ) {
    return false;
  }

  return !isBindingIdentifier(ancestors);
}

function isBindingIdentifier(ancestors: readonly MiniGameAstAncestor[]): boolean {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];

    if (ancestor === undefined) {
      return false;
    }
    const { node: parent, childKey } = ancestor;

    if (
      (parent.type === 'RestElement' && childKey === 'argument')
      || (parent.type === 'AssignmentPattern' && childKey === 'left')
      || (parent.type === 'ArrayPattern' && childKey === 'elements')
      || (parent.type === 'ObjectPattern' && childKey === 'properties')
    ) {
      continue;
    }
    if (parent.type === 'Property' && childKey === 'value') {
      const container = ancestors[index - 1]?.node;

      if (container?.type === 'ObjectPattern') {
        continue;
      }
    }
    if (parent.type === 'VariableDeclarator') {
      return childKey === 'id';
    }
    if (
      parent.type === 'FunctionDeclaration'
      || parent.type === 'FunctionExpression'
      || parent.type === 'ArrowFunctionExpression'
    ) {
      return childKey === 'id' || childKey === 'params';
    }
    if (parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') {
      return childKey === 'id';
    }
    if (parent.type === 'CatchClause') {
      return childKey === 'param';
    }
    if (
      parent.type === 'ImportSpecifier'
      || parent.type === 'ImportDefaultSpecifier'
      || parent.type === 'ImportNamespaceSpecifier'
    ) {
      return childKey === 'local';
    }

    return false;
  }

  return false;
}

function evaluateStaticString(input: unknown): string | undefined {
  if (!isAstRecord(input)) {
    return undefined;
  }
  if (input.type === 'Literal' && typeof input.value === 'string') {
    return input.value;
  }
  if (input.type === 'BinaryExpression' && input.operator === '+') {
    const left = evaluateStaticString(input.left);
    const right = evaluateStaticString(input.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (
    input.type === 'TemplateLiteral'
    && Array.isArray(input.expressions)
    && Array.isArray(input.quasis)
    && input.quasis.length === input.expressions.length + 1
  ) {
    let result = '';

    for (const [index, quasi] of input.quasis.entries()) {
      if (
        !isAstRecord(quasi)
        || !isAstRecord(quasi.value)
        || typeof quasi.value.cooked !== 'string'
      ) {
        return undefined;
      }
      result += quasi.value.cooked;

      const expression = input.expressions[index];
      if (expression !== undefined) {
        const value = evaluateStaticString(expression);
        if (value === undefined) {
          return undefined;
        }
        result += value;
      }
    }

    return result;
  }

  return undefined;
}

function readMemberName(node: Record<string, unknown>): string | undefined {
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return node.name;
  }
  if (node.type !== 'MemberExpression' || !isAstRecord(node.property)) {
    return undefined;
  }
  if (node.computed === true) {
    return evaluateStaticString(node.property);
  }

  return node.property.type === 'Identifier' && typeof node.property.name === 'string'
    ? node.property.name
    : undefined;
}

function isAstRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
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
