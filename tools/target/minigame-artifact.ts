import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  constants as fsConstants,
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
  readonly forbiddenGameBundleGlobals?: readonly string[];
}

export interface NamedMiniGameProtectedOutput {
  readonly name: string;
  readonly path: string;
}

interface MiniGameAstAncestor {
  readonly node: Record<string, unknown>;
  readonly childKey: string;
}

interface MiniGameLexicalBinding {
  readonly name: string;
  readonly scope: MiniGameLexicalScope;
}

interface MiniGameLexicalScope {
  readonly kind: 'program' | 'function' | 'block';
  readonly parent?: MiniGameLexicalScope;
  readonly bindings: Map<string, MiniGameLexicalBinding>;
}

type MiniGameGlobalIntrinsic = 'Object' | 'Reflect';
type MiniGameReflectiveGlobalReadKind = 'property' | 'descriptors';

interface MiniGameScopeAnalysis {
  readonly programScope: MiniGameLexicalScope;
  readonly scopeByNode: WeakMap<Record<string, unknown>, MiniGameLexicalScope>;
  readonly globalObjectAliases: ReadonlySet<MiniGameLexicalBinding>;
  readonly globalIntrinsicAliases: ReadonlyMap<
    MiniGameLexicalBinding,
    ReadonlySet<MiniGameGlobalIntrinsic>
  >;
  readonly reflectiveGlobalReadAliases: ReadonlyMap<
    MiniGameLexicalBinding,
    ReadonlySet<MiniGameReflectiveGlobalReadKind>
  >;
  readonly dynamicCodeConstructorAliases: ReadonlySet<MiniGameLexicalBinding>;
  readonly dynamicCodeConstructorContainers: ReadonlySet<MiniGameLexicalBinding>;
  readonly dynamicCodeConstructorFactories: ReadonlySet<MiniGameLexicalBinding>;
  readonly dynamicCodeConstructorContainerFactories: ReadonlySet<MiniGameLexicalBinding>;
}

export function assembleMiniGameArtifact(
  input: AssembleMiniGameArtifactInput,
): MiniGameArtifactEvidence {
  const artifactRoot = resolve(input.artifactRoot);
  assertMiniGameArtifactOutputDirectory(artifactRoot, input.projectRoot);
  const artifactParent = dirname(artifactRoot);
  mkdirSync(artifactParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(artifactParent, `.${basename(artifactRoot)}-staging-`));
  let projectFilesRoot: string | undefined;
  const stagingInput = { ...input, artifactRoot: stagingRoot };

  try {
    projectFilesRoot = mkdtempSync(
      join(artifactParent, `.${basename(artifactRoot)}-project-files-`),
    );
    copyMiniGameBundleOutput(input.runtimeBundleRoot, stagingRoot);
    copyMiniGameBundleOutput(input.gameBundleRoot, stagingRoot);
    copyMiniGameArtifactFile(
      input.effectiveTargetConfigSource,
      join(stagingRoot, miniGameEffectiveTargetConfigFileName),
      miniGameEffectiveTargetConfigFileName,
    );
    stageMiniGameIconEvidence(input.generatedIcons, stagingRoot);
    input.writeProjectFiles(projectFilesRoot);
    copyMiniGameBundleOutput(projectFilesRoot, stagingRoot);
    assertMiniGameRequiredFiles(stagingRoot);
    assertMiniGameJavaScriptSafety(
      stagingRoot,
      input.forbiddenJavaScriptMarkers ?? [],
      input.forbiddenGameBundleGlobals ?? [],
    );
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
    if (projectFilesRoot !== undefined) {
      rmSync(projectFilesRoot, { force: true, recursive: true });
    }
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
  const files = [
    {
      source: generated.manifestPath,
      destination: join(artifactRoot, miniGameIconManifestFileName),
      relativePath: miniGameIconManifestFileName,
    },
    ...generated.manifest.outputs.map((output) => {
      assertMiniGameArtifactRelativePath(output.path, 'Mini-game icon output');
      return {
        source: join(generated.outputDir, basename(output.path)),
        destination: join(artifactRoot, output.path),
        relativePath: output.path,
      };
    }),
  ];
  const plannedPaths = new Set<string>();

  for (const file of files) {
    const comparisonKey = portablePathComparisonKey(file.destination);

    if (plannedPaths.has(comparisonKey)) {
      throw new Error(`Mini-game icon outputs collide at ${file.relativePath}.`);
    }
    plannedPaths.add(comparisonKey);
    if (existsSync(file.destination)) {
      throw new Error(`Mini-game artifact files collide at ${file.relativePath}.`);
    }
  }

  for (const file of files) {
    copyMiniGameArtifactFile(file.source, file.destination, file.relativePath);
  }
}

function copyMiniGameArtifactFile(source: string, destination: string, relativePath: string): void {
  if (existsSync(destination)) {
    throw new Error(`Mini-game artifact files collide at ${relativePath}.`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
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
  forbiddenGameBundleGlobals: readonly string[] = [],
): void {
  const javascript = listMiniGameArtifactFiles(artifactRoot)
    .filter((file) => ['.cjs', '.js', '.mjs'].includes(extname(file.path).toLowerCase()));
  const gameBundleGlobals = new Set(forbiddenGameBundleGlobals);
  const noForbiddenGlobals = new Set<string>();

  for (const file of javascript) {
    const source = readFileSync(join(artifactRoot, file.path), 'utf8');
    assertMiniGameJavaScriptAstSafety(
      source,
      file.path,
      file.path === 'game.bundle.js' ? gameBundleGlobals : noForbiddenGlobals,
    );

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

function assertMiniGameJavaScriptAstSafety(
  source: string,
  path: string,
  forbiddenGlobals: ReadonlySet<string>,
): void {
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

  const scopeAnalysis = createMiniGameScopeAnalysis(ast);
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

    assertSafeNode(input, ancestors, path, scopeAnalysis, forbiddenGlobals);
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
  scopeAnalysis: MiniGameScopeAnalysis,
  forbiddenGlobals: ReadonlySet<string>,
): void {
  if (node.type === 'ImportExpression') {
    throw new Error(`Mini-game ${path} contains forbidden dynamic import.`);
  }
  const parent = ancestors.at(-1)?.node;

  if (
    isMiniGameFunctionNode(node)
    && (
      (parent?.type === 'MethodDefinition' && parent.value === node)
      || (parent?.type === 'PropertyDefinition' && parent.value === node)
      || (parent?.type === 'Property' && parent.value === node)
    )
    && readMiniGameFunctionReturnValues(node).some((value) => {
      return isReturnedDynamicCodeConstructorSource(value, ancestors, scopeAnalysis);
    })
  ) {
    throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
  }

  if (
    node.type === 'Identifier'
    && typeof node.name === 'string'
    && isExecutableIdentifierReference(ancestors)
  ) {
    const scope = scopeAnalysis.scopeByNode.get(node) ?? scopeAnalysis.programScope;
    const binding = resolveMiniGameBinding(node.name, scope);

    if (binding === undefined && forbiddenGlobals.has(node.name)) {
      throw new Error(`Mini-game ${path} contains forbidden platform global ${node.name}.`);
    }

    if (
      binding !== undefined
      && isInvocationArgument(node, ancestors)
      && (
        scopeAnalysis.dynamicCodeConstructorAliases.has(binding)
        || scopeAnalysis.dynamicCodeConstructorContainers.has(binding)
        || scopeAnalysis.dynamicCodeConstructorFactories.has(binding)
        || scopeAnalysis.dynamicCodeConstructorContainerFactories.has(binding)
      )
    ) {
      throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
    }
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
      && forbiddenGlobals.has(propertyName)
      && isGlobalObjectAliasSource(node.object, ancestors, scopeAnalysis)
    ) {
      throw new Error(`Mini-game ${path} contains forbidden platform global ${propertyName}.`);
    }

    if (
      propertyName !== undefined
      && ['eval', 'Function', 'importScripts'].includes(propertyName)
      && (
        node.computed === true
        || isGlobalObjectAliasSource(node.object, ancestors, scopeAnalysis)
      )
      && !isTypeofReference(node, ancestors)
    ) {
      throw new Error(`Mini-game ${path} contains forbidden ${propertyName}.`);
    }
    if (
      isInvocationArgument(node, ancestors)
      && isDynamicCodeConstructorSource(node, ancestors, scopeAnalysis)
    ) {
      throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
    }
  }

  if (
    node.type === 'Property'
    && isGlobalObjectDestructuring(ancestors, scopeAnalysis)
  ) {
    const propertyName = readStaticPropertyName(node);

    if (propertyName !== undefined && forbiddenGlobals.has(propertyName)) {
      throw new Error(`Mini-game ${path} contains forbidden platform global ${propertyName}.`);
    }

    if (node.computed === true) {
      throw new Error(`Mini-game ${path} contains forbidden computed destructuring.`);
    }
    if (
      propertyName !== undefined
      && ['eval', 'Function', 'importScripts'].includes(propertyName)
    ) {
      throw new Error(`Mini-game ${path} contains forbidden ${propertyName} destructuring.`);
    }
  }

  if (node.type === 'CallExpression' && isAstRecord(node.callee)) {
    const calleeName = readMemberName(node.callee);
    const arguments_ = Array.isArray(node.arguments) ? node.arguments : [];
    const firstArgument = arguments_[0];

    if (isDynamicCodeConstructorInvocation(node.callee, arguments_, ancestors, scopeAnalysis)) {
      throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
    }
    if (isUnknownComputedGlobalMember(node.callee, ancestors, scopeAnalysis)) {
      throw new Error(`Mini-game ${path} contains forbidden computed global call.`);
    }
    if (isReflectiveDynamicCodeGlobalRead(node, ancestors, scopeAnalysis)) {
      throw new Error(`Mini-game ${path} contains forbidden reflective global lookup.`);
    }

    if (calleeName === 'createElement' && evaluateStaticString(firstArgument) === 'script') {
      throw new Error(`Mini-game ${path} contains forbidden script element creation.`);
    }
  }

  if (node.type === 'NewExpression' && isAstRecord(node.callee)) {
    const calleeName = readMemberName(node.callee);

    if (isDynamicCodeConstructorSource(node.callee, ancestors, scopeAnalysis)) {
      throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
    }
    if (isUnknownComputedGlobalMember(node.callee, ancestors, scopeAnalysis)) {
      throw new Error(`Mini-game ${path} contains forbidden computed global construction.`);
    }

    if (calleeName === 'Worker' || calleeName === 'SharedWorker') {
      throw new Error(`Mini-game ${path} contains forbidden ${calleeName} construction.`);
    }
  }

  if (
    node.type === 'TaggedTemplateExpression'
    && isDynamicCodeConstructorSource(node.tag, ancestors, scopeAnalysis)
  ) {
    throw new Error(`Mini-game ${path} contains forbidden dynamic-code constructor.`);
  }
}

function isInvocationArgument(
  node: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
): boolean {
  let value = node;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index];

    if (parent === undefined) {
      return false;
    }
    if (
      isMiniGameFunctionNode(parent.node)
      || parent.node.type === 'ClassBody'
      || parent.node.type === 'StaticBlock'
    ) {
      return false;
    }
    if (
      parent.childKey === 'arguments'
      && (parent.node.type === 'CallExpression' || parent.node.type === 'NewExpression')
    ) {
      return true;
    }
    if (!parentPreservesDynamicCodeConstructorValue(parent.node, value)) {
      return false;
    }
    value = parent.node;
  }

  return false;
}

function parentPreservesDynamicCodeConstructorValue(
  parent: Record<string, unknown>,
  value: Record<string, unknown>,
): boolean {
  // Follow only value-preserving wrappers and containers. Metadata transforms such as
  // constructor.prototype and comparisons produce a different value and end the taint path.
  if (
    parent.type === 'ArrayExpression'
    || parent.type === 'ObjectExpression'
    || parent.type === 'SpreadElement'
    || parent.type === 'ChainExpression'
    || parent.type === 'AwaitExpression'
    || parent.type === 'YieldExpression'
    || parent.type === 'LogicalExpression'
  ) {
    return true;
  }
  if (parent.type === 'Property') {
    return parent.value === value;
  }
  if (parent.type === 'ConditionalExpression') {
    return parent.consequent === value || parent.alternate === value;
  }
  if (parent.type === 'SequenceExpression' && Array.isArray(parent.expressions)) {
    return parent.expressions.at(-1) === value;
  }
  if (parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern') {
    return parent.right === value;
  }
  if (parent.type === 'MemberExpression' && parent.object === value) {
    const memberName = readMemberName(parent);
    return memberName === 'call' || memberName === 'apply' || memberName === 'bind';
  }

  return false;
}

function isGlobalObjectDestructuring(
  ancestors: readonly MiniGameAstAncestor[],
  scopeAnalysis: MiniGameScopeAnalysis,
): boolean {
  const pattern = ancestors.at(-1)?.node;
  const container = ancestors.at(-2)?.node;

  if (!isAstRecord(pattern) || pattern.type !== 'ObjectPattern' || !isAstRecord(container)) {
    return false;
  }
  if (container.type === 'VariableDeclarator' && container.id === pattern) {
    return isGlobalObjectAliasSource(container.init, ancestors, scopeAnalysis);
  }
  if (container.type === 'AssignmentPattern' && container.left === pattern) {
    return isGlobalObjectAliasSource(container.right, ancestors, scopeAnalysis);
  }

  return container.type === 'AssignmentExpression'
    && container.left === pattern
    && isGlobalObjectAliasSource(container.right, ancestors, scopeAnalysis);
}

function isDynamicCodeGlobalObject(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  scopeAnalysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = scopeAnalysis.scopeByNode.get(input) ?? scopeAnalysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);

    return binding === undefined
      ? ['globalThis', 'self', 'window'].includes(input.name)
      : scopeAnalysis.globalObjectAliases.has(binding);
  }

  return input.type === 'ThisExpression' && isProgramThisReference(ancestors);
}

function isProgramThisReference(ancestors: readonly MiniGameAstAncestor[]): boolean {
  return !ancestors.some(({ node }) => {
    return node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ClassBody'
      || node.type === 'StaticBlock';
  });
}

function isUnknownComputedGlobalMember(
  node: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
  scopeAnalysis: MiniGameScopeAnalysis,
): boolean {
  return node.type === 'MemberExpression'
    && node.computed === true
    && readMemberName(node) === undefined
    && isGlobalObjectAliasSource(node.object, ancestors, scopeAnalysis);
}

function isReflectiveDynamicCodeGlobalRead(
  node: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
  scopeAnalysis: MiniGameScopeAnalysis,
): boolean {
  if (
    node.type !== 'CallExpression'
    || !isAstRecord(node.callee)
    || !Array.isArray(node.arguments)
  ) {
    return false;
  }

  let kinds = getReflectiveGlobalReadKinds(node.callee, ancestors, scopeAnalysis);
  let target = node.arguments[0];
  let property = node.arguments[1];

  if (kinds.size === 0 && node.callee.type === 'MemberExpression') {
    const invocationMethod = readMemberName(node.callee);
    const receiverKinds = getReflectiveGlobalReadKinds(
      node.callee.object,
      ancestors,
      scopeAnalysis,
    );

    if (receiverKinds.size === 0) {
      return false;
    }
    if (invocationMethod === 'bind') {
      return true;
    }
    if (invocationMethod === 'call') {
      kinds = receiverKinds;
      target = node.arguments[1];
      property = node.arguments[2];
    } else if (invocationMethod === 'apply') {
      const appliedArguments = node.arguments[1];

      if (!isAstRecord(appliedArguments) || appliedArguments.type !== 'ArrayExpression') {
        return true;
      }
      const elements = Array.isArray(appliedArguments.elements) ? appliedArguments.elements : [];

      if (elements.some((element) => isAstRecord(element) && element.type === 'SpreadElement')) {
        return true;
      }
      kinds = receiverKinds;
      target = elements[0];
      property = elements[1];
    } else {
      return false;
    }
  }

  if (!isGlobalObjectAliasSource(target, ancestors, scopeAnalysis)) {
    return false;
  }
  if (kinds.has('descriptors')) {
    return true;
  }

  const propertyName = evaluateStaticString(property);
  return kinds.has('property')
    && (propertyName === undefined
      || ['eval', 'Function', 'importScripts'].includes(propertyName));
}

function createMiniGameScopeAnalysis(ast: unknown): MiniGameScopeAnalysis {
  const programScope = createMiniGameLexicalScope('program');
  const scopeByNode = new WeakMap<Record<string, unknown>, MiniGameLexicalScope>();
  buildMiniGameScopes(ast, programScope, scopeByNode);
  const globalObjectAliases = new Set<MiniGameLexicalBinding>();
  const globalIntrinsicAliases = new Map<
    MiniGameLexicalBinding,
    Set<MiniGameGlobalIntrinsic>
  >();
  const reflectiveGlobalReadAliases = new Map<
    MiniGameLexicalBinding,
    Set<MiniGameReflectiveGlobalReadKind>
  >();
  const dynamicCodeConstructorAliases = new Set<MiniGameLexicalBinding>();
  const dynamicCodeConstructorContainers = new Set<MiniGameLexicalBinding>();
  const dynamicCodeConstructorFactories = new Set<MiniGameLexicalBinding>();
  const dynamicCodeConstructorContainerFactories = new Set<MiniGameLexicalBinding>();
  const analysis: MiniGameScopeAnalysis = {
    programScope,
    scopeByNode,
    globalObjectAliases,
    globalIntrinsicAliases,
    reflectiveGlobalReadAliases,
    dynamicCodeConstructorAliases,
    dynamicCodeConstructorContainers,
    dynamicCodeConstructorFactories,
    dynamicCodeConstructorContainerFactories,
  };
  collectDynamicCodeGlobalObjectAliases(ast, analysis, globalObjectAliases);
  collectGlobalIntrinsicAliases(ast, analysis, globalIntrinsicAliases);
  collectReflectiveGlobalReadAliases(ast, analysis, reflectiveGlobalReadAliases);
  collectDynamicCodeConstructorFlow(
    ast,
    analysis,
    dynamicCodeConstructorAliases,
    dynamicCodeConstructorContainers,
    dynamicCodeConstructorFactories,
    dynamicCodeConstructorContainerFactories,
  );
  return analysis;
}

function buildMiniGameScopes(
  input: unknown,
  currentScope: MiniGameLexicalScope,
  scopeByNode: WeakMap<Record<string, unknown>, MiniGameLexicalScope>,
): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      buildMiniGameScopes(item, currentScope, scopeByNode);
    }
    return;
  }
  if (!isAstRecord(input)) {
    return;
  }

  let nodeScope = currentScope;

  if (isMiniGameFunctionNode(input)) {
    if (input.type === 'FunctionDeclaration') {
      declareMiniGamePattern(input.id, currentScope);
    }
    nodeScope = createMiniGameLexicalScope('function', currentScope);
    if (input.type === 'FunctionExpression') {
      declareMiniGamePattern(input.id, nodeScope);
    }
    if (Array.isArray(input.params)) {
      for (const parameter of input.params) {
        declareMiniGamePattern(parameter, nodeScope);
      }
    }
  } else if (input.type === 'ClassDeclaration') {
    declareMiniGamePattern(input.id, currentScope);
  } else if (input.type === 'ClassExpression') {
    nodeScope = createMiniGameLexicalScope('block', currentScope);
    declareMiniGamePattern(input.id, nodeScope);
  } else if (createsMiniGameBlockScope(input)) {
    nodeScope = createMiniGameLexicalScope('block', currentScope);
  }

  scopeByNode.set(input, nodeScope);

  if (input.type === 'VariableDeclaration' && Array.isArray(input.declarations)) {
    const declarationScope = input.kind === 'var' ? nearestMiniGameVarScope(nodeScope) : nodeScope;

    for (const declaration of input.declarations) {
      if (isAstRecord(declaration)) {
        declareMiniGamePattern(declaration.id, declarationScope);
      }
    }
  } else if (input.type === 'CatchClause') {
    declareMiniGamePattern(input.param, nodeScope);
  } else if (input.type === 'ImportDeclaration' && Array.isArray(input.specifiers)) {
    for (const specifier of input.specifiers) {
      if (isAstRecord(specifier)) {
        declareMiniGamePattern(specifier.local, nodeScope);
      }
    }
  }

  for (const [key, value] of Object.entries(input)) {
    if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
      buildMiniGameScopes(value, nodeScope, scopeByNode);
    }
  }
}

function createMiniGameLexicalScope(
  kind: MiniGameLexicalScope['kind'],
  parent?: MiniGameLexicalScope,
): MiniGameLexicalScope {
  return {
    kind,
    ...(parent === undefined ? {} : { parent }),
    bindings: new Map(),
  };
}

function isMiniGameFunctionNode(node: Record<string, unknown>): boolean {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression';
}

function createsMiniGameBlockScope(node: Record<string, unknown>): boolean {
  return node.type === 'BlockStatement'
    || node.type === 'CatchClause'
    || node.type === 'ClassBody'
    || node.type === 'StaticBlock'
    || node.type === 'ForStatement'
    || node.type === 'ForInStatement'
    || node.type === 'ForOfStatement'
    || node.type === 'SwitchStatement';
}

function nearestMiniGameVarScope(scope: MiniGameLexicalScope): MiniGameLexicalScope {
  let candidate = scope;

  while (candidate.kind === 'block' && candidate.parent !== undefined) {
    candidate = candidate.parent;
  }

  return candidate;
}

function declareMiniGamePattern(input: unknown, scope: MiniGameLexicalScope): void {
  if (!isAstRecord(input)) {
    return;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    ensureMiniGameBinding(input.name, scope);
    return;
  }
  if (input.type === 'RestElement') {
    declareMiniGamePattern(input.argument, scope);
    return;
  }
  if (input.type === 'AssignmentPattern') {
    declareMiniGamePattern(input.left, scope);
    return;
  }
  if (input.type === 'ArrayPattern' && Array.isArray(input.elements)) {
    for (const element of input.elements) {
      declareMiniGamePattern(element, scope);
    }
    return;
  }
  if (input.type === 'ObjectPattern' && Array.isArray(input.properties)) {
    for (const property of input.properties) {
      if (!isAstRecord(property)) {
        continue;
      }
      declareMiniGamePattern(
        property.type === 'Property' ? property.value : property.argument,
        scope,
      );
    }
  }
}

function ensureMiniGameBinding(
  name: string,
  scope: MiniGameLexicalScope,
): MiniGameLexicalBinding {
  const existing = scope.bindings.get(name);

  if (existing !== undefined) {
    return existing;
  }
  const binding = { name, scope };
  scope.bindings.set(name, binding);
  return binding;
}

function resolveMiniGameBinding(
  name: string,
  scope: MiniGameLexicalScope,
): MiniGameLexicalBinding | undefined {
  let candidate: MiniGameLexicalScope | undefined = scope;

  while (candidate !== undefined) {
    const binding = candidate.bindings.get(name);

    if (binding !== undefined) {
      return binding;
    }
    candidate = candidate.parent;
  }

  return undefined;
}

function collectDynamicCodeGlobalObjectAliases(
  ast: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
): void {
  collectMiniGameAliases(ast, (pattern, source, ancestors) => {
    return addGlobalObjectAliasBindings(pattern, source, ancestors, analysis, aliases);
  });
}

function collectGlobalIntrinsicAliases(
  ast: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Map<MiniGameLexicalBinding, Set<MiniGameGlobalIntrinsic>>,
): void {
  collectMiniGameAliases(ast, (pattern, source, ancestors) => {
    return addGlobalIntrinsicAliasBindings(pattern, source, ancestors, analysis, aliases);
  });
}

function addGlobalIntrinsicAliasBindings(
  pattern: unknown,
  source: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
  aliases: Map<MiniGameLexicalBinding, Set<MiniGameGlobalIntrinsic>>,
): boolean {
  if (!isAstRecord(pattern)) {
    return false;
  }
  if (
    pattern.type === 'ObjectPattern'
    && Array.isArray(pattern.properties)
    && isGlobalObjectAliasSource(source, ancestors, analysis)
  ) {
    let changed = false;

    for (const property of pattern.properties) {
      if (!isAstRecord(property) || property.type !== 'Property') {
        continue;
      }
      const name = readStaticPropertyName(property);

      if (name === 'Object' || name === 'Reflect') {
        changed = addMiniGameBindingKinds(
          property.value,
          new Set([name]),
          analysis,
          aliases,
        ) || changed;
      }
    }

    return changed;
  }

  return addMiniGameBindingKinds(
    pattern,
    getGlobalIntrinsicKinds(source, ancestors, analysis),
    analysis,
    aliases,
  );
}

function getGlobalIntrinsicKinds(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): Set<MiniGameGlobalIntrinsic> {
  const kinds = new Set<MiniGameGlobalIntrinsic>();

  if (!isAstRecord(input)) {
    return kinds;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);

    if (binding === undefined) {
      if (input.name === 'Object' || input.name === 'Reflect') {
        kinds.add(input.name);
      }
    } else {
      addSetValues(kinds, analysis.globalIntrinsicAliases.get(binding));
    }
    return kinds;
  }
  if (input.type === 'ChainExpression') {
    return getGlobalIntrinsicKinds(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return getGlobalIntrinsicKinds(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    addSetValues(kinds, getGlobalIntrinsicKinds(input.consequent, ancestors, analysis));
    addSetValues(kinds, getGlobalIntrinsicKinds(input.alternate, ancestors, analysis));
    return kinds;
  }
  if (input.type === 'LogicalExpression') {
    addSetValues(kinds, getGlobalIntrinsicKinds(input.left, ancestors, analysis));
    addSetValues(kinds, getGlobalIntrinsicKinds(input.right, ancestors, analysis));
    return kinds;
  }
  if (
    input.type === 'MemberExpression'
    && isGlobalObjectAliasSource(input.object, ancestors, analysis)
  ) {
    const name = readMemberName(input);

    if (name === 'Object' || name === 'Reflect') {
      kinds.add(name);
    }
  }

  return kinds;
}

function collectReflectiveGlobalReadAliases(
  ast: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Map<MiniGameLexicalBinding, Set<MiniGameReflectiveGlobalReadKind>>,
): void {
  collectMiniGameAliases(ast, (pattern, source, ancestors) => {
    return addReflectiveGlobalReadAliasBindings(pattern, source, ancestors, analysis, aliases);
  });
}

function addReflectiveGlobalReadAliasBindings(
  pattern: unknown,
  source: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
  aliases: Map<MiniGameLexicalBinding, Set<MiniGameReflectiveGlobalReadKind>>,
): boolean {
  if (!isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
    const intrinsicKinds = getGlobalIntrinsicKinds(source, ancestors, analysis);
    let changed = false;

    for (const property of pattern.properties) {
      if (!isAstRecord(property) || property.type !== 'Property') {
        continue;
      }
      const methodName = readStaticPropertyName(property);
      const readKinds = getReflectiveMethodKinds(intrinsicKinds, methodName);

      const added = addMiniGameBindingKinds(property.value, readKinds, analysis, aliases);
      changed = added || changed;
    }

    return changed;
  }

  return addMiniGameBindingKinds(
    pattern,
    getReflectiveGlobalReadKinds(source, ancestors, analysis),
    analysis,
    aliases,
  );
}

function getReflectiveGlobalReadKinds(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): Set<MiniGameReflectiveGlobalReadKind> {
  const kinds = new Set<MiniGameReflectiveGlobalReadKind>();

  if (!isAstRecord(input)) {
    return kinds;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);

    if (binding !== undefined) {
      addSetValues(kinds, analysis.reflectiveGlobalReadAliases.get(binding));
    }
    return kinds;
  }
  if (input.type === 'ChainExpression') {
    return getReflectiveGlobalReadKinds(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return getReflectiveGlobalReadKinds(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    addSetValues(kinds, getReflectiveGlobalReadKinds(input.consequent, ancestors, analysis));
    addSetValues(kinds, getReflectiveGlobalReadKinds(input.alternate, ancestors, analysis));
    return kinds;
  }
  if (input.type === 'LogicalExpression') {
    addSetValues(kinds, getReflectiveGlobalReadKinds(input.left, ancestors, analysis));
    addSetValues(kinds, getReflectiveGlobalReadKinds(input.right, ancestors, analysis));
    return kinds;
  }
  if (input.type === 'MemberExpression') {
    addSetValues(
      kinds,
      getReflectiveMethodKinds(
        getGlobalIntrinsicKinds(input.object, ancestors, analysis),
        readMemberName(input),
      ),
    );
  }

  return kinds;
}

function getReflectiveMethodKinds(
  intrinsics: ReadonlySet<MiniGameGlobalIntrinsic>,
  methodName: string | undefined,
): Set<MiniGameReflectiveGlobalReadKind> {
  const kinds = new Set<MiniGameReflectiveGlobalReadKind>();

  if (
    (
      intrinsics.has('Reflect')
      && (methodName === 'get' || methodName === 'getOwnPropertyDescriptor')
    )
    || (intrinsics.has('Object') && methodName === 'getOwnPropertyDescriptor')
  ) {
    kinds.add('property');
  }
  if (intrinsics.has('Object') && methodName === 'getOwnPropertyDescriptors') {
    kinds.add('descriptors');
  }

  return kinds;
}

// Constructor values can cross aliases, containers, and helper return values. Iterate to a fixed
// point because a factory discovered in one pass can taint a later alias or container assignment.
function collectDynamicCodeConstructorFlow(
  ast: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
  containers: Set<MiniGameLexicalBinding>,
  factories: Set<MiniGameLexicalBinding>,
  containerFactories: Set<MiniGameLexicalBinding>,
): void {
  let changed = true;

  while (changed) {
    const sizes = [aliases.size, containers.size, factories.size, containerFactories.size] as const;

    collectMiniGameAliases(ast, (pattern, source, ancestors) => {
      if (!isAstRecord(pattern)) {
        return false;
      }
      const sourceIsConstructor = isPotentialDynamicCodeConstructorSource(
        source,
        ancestors,
        analysis,
      );
      const sourceIsContainer = isDynamicCodeConstructorContainerSource(
        source,
        ancestors,
        analysis,
      );
      const sourceIsFactory = isDynamicCodeConstructorFactoryReference(
        source,
        ancestors,
        analysis,
      );
      const sourceIsContainerFactory = isDynamicCodeConstructorContainerFactoryReference(
        source,
        ancestors,
        analysis,
      );

      if (pattern.type === 'MemberExpression') {
        return (
          sourceIsConstructor
          || sourceIsContainer
          || sourceIsFactory
          || sourceIsContainerFactory
        )
          && addDynamicCodeConstructorContainerReference(pattern.object, analysis, containers);
      }
      if (
        (pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern')
        && sourceIsContainer
      ) {
        return addDynamicCodeConstructorPattern(pattern, analysis, aliases);
      }
      if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
        let patternChanged = false;

        for (const property of pattern.properties) {
          if (
            isAstRecord(property)
            && property.type === 'Property'
            && readStaticPropertyName(property) === 'constructor'
          ) {
            patternChanged = addDynamicCodeConstructorAlias(
              property.value,
              analysis,
              aliases,
            ) || patternChanged;
          }
        }

        return patternChanged;
      }

      const constructorChanged = sourceIsConstructor
        && addDynamicCodeConstructorAlias(pattern, analysis, aliases);
      const containerChanged = sourceIsContainer
        && addDynamicCodeConstructorContainerReference(pattern, analysis, containers);
      const factoryChanged = sourceIsFactory
        && addDynamicCodeConstructorAlias(pattern, analysis, factories);
      const containerFactoryChanged = sourceIsContainerFactory
        && addDynamicCodeConstructorAlias(pattern, analysis, containerFactories);
      return constructorChanged
        || containerChanged
        || factoryChanged
        || containerFactoryChanged;
    });
    const discoveredFactory = collectDynamicCodeConstructorFactories(
      ast,
      analysis,
      factories,
      containerFactories,
    );
    changed = discoveredFactory
      || aliases.size !== sizes[0]
      || containers.size !== sizes[1]
      || factories.size !== sizes[2]
      || containerFactories.size !== sizes[3];
  }
}

function collectDynamicCodeConstructorFactories(
  ast: unknown,
  analysis: MiniGameScopeAnalysis,
  factories: Set<MiniGameLexicalBinding>,
  containerFactories: Set<MiniGameLexicalBinding>,
): boolean {
  let changed = false;
  const ancestors: MiniGameAstAncestor[] = [];
  visit(ast);
  return changed;

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

    if (isMiniGameFunctionNode(input)) {
      const returnValues = readMiniGameFunctionReturnValues(input);

      if (
        returnValues.some((value) => {
          return isReturnedDynamicCodeConstructorSource(value, ancestors, analysis);
        })
      ) {
        changed = addDynamicCodeConstructorFactoryBinding(
          input,
          ancestors,
          analysis,
          factories,
        ) || changed;
      }
      if (
        returnValues.some((value) => {
          return isDynamicCodeConstructorContainerSource(value, ancestors, analysis);
        })
      ) {
        changed = addDynamicCodeConstructorFactoryBinding(
          input,
          ancestors,
          analysis,
          containerFactories,
        ) || changed;
      }
    }

    for (const [key, value] of Object.entries(input)) {
      if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
        ancestors.push({ node: input, childKey: key });
        visit(value);
        ancestors.pop();
      }
    }
  }
}

function isReturnedDynamicCodeConstructorSource(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'ChainExpression') {
    return isReturnedDynamicCodeConstructorSource(input.expression, ancestors, analysis);
  }
  if (
    (input.type === 'AwaitExpression' || input.type === 'YieldExpression')
    && input.argument !== null
  ) {
    return isReturnedDynamicCodeConstructorSource(input.argument, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isReturnedDynamicCodeConstructorSource(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isReturnedDynamicCodeConstructorSource(input.consequent, ancestors, analysis)
      || isReturnedDynamicCodeConstructorSource(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isReturnedDynamicCodeConstructorSource(input.left, ancestors, analysis)
      || isReturnedDynamicCodeConstructorSource(input.right, ancestors, analysis);
  }
  // Libraries may return an arbitrary value's constructor for identity checks. Treat a constructor
  // return as executable only when its receiver is already tainted or is syntactically callable.
  if (input.type === 'MemberExpression' && readMemberName(input) === 'constructor') {
    return isDynamicCodeConstructorSource(input.object, ancestors, analysis)
      || isDynamicCodeConstructorContainerSource(input.object, ancestors, analysis)
      || isSyntacticallyCallableValue(input.object, ancestors, analysis);
  }

  return isDynamicCodeConstructorSource(input, ancestors, analysis)
    || isUnknownComputedGlobalMember(input, ancestors, analysis);
}

function isSyntacticallyCallableValue(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (
    input.type === 'FunctionDeclaration'
    || input.type === 'FunctionExpression'
    || input.type === 'ArrowFunctionExpression'
    || input.type === 'ClassDeclaration'
    || input.type === 'ClassExpression'
  ) {
    return true;
  }
  if (input.type === 'ChainExpression') {
    return isSyntacticallyCallableValue(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isSyntacticallyCallableValue(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isSyntacticallyCallableValue(input.consequent, ancestors, analysis)
      || isSyntacticallyCallableValue(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isSyntacticallyCallableValue(input.left, ancestors, analysis)
      || isSyntacticallyCallableValue(input.right, ancestors, analysis);
  }
  if (
    input.type === 'CallExpression'
    && isAstRecord(input.callee)
    && readMemberName(input.callee) === 'getPrototypeOf'
    && getGlobalIntrinsicKinds(input.callee.object, ancestors, analysis).has('Object')
    && Array.isArray(input.arguments)
  ) {
    return isSyntacticallyCallableValue(input.arguments[0], ancestors, analysis);
  }

  return false;
}

function readMiniGameFunctionReturnValues(
  functionNode: Record<string, unknown>,
): readonly unknown[] {
  if (
    functionNode.type === 'ArrowFunctionExpression'
    && isAstRecord(functionNode.body)
    && functionNode.body.type !== 'BlockStatement'
  ) {
    return [functionNode.body];
  }

  const values: unknown[] = [];
  visit(functionNode.body);
  return values;

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
    if (
      isMiniGameFunctionNode(input)
      || input.type === 'ClassDeclaration'
      || input.type === 'ClassExpression'
      || input.type === 'StaticBlock'
    ) {
      return;
    }
    if (input.type === 'ReturnStatement') {
      if (input.argument !== null && input.argument !== undefined) {
        values.push(input.argument);
      }
      return;
    }

    for (const [key, value] of Object.entries(input)) {
      if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
        visit(value);
      }
    }
  }
}

function addDynamicCodeConstructorFactoryBinding(
  functionNode: Record<string, unknown>,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
  factories: Set<MiniGameLexicalBinding>,
): boolean {
  let changed = false;

  if (
    (functionNode.type === 'FunctionDeclaration' || functionNode.type === 'FunctionExpression')
    && functionNode.id !== null
    && functionNode.id !== undefined
  ) {
    changed = addDynamicCodeConstructorAlias(functionNode.id, analysis, factories) || changed;
  }

  const parent = ancestors.at(-1)?.node;

  if (parent?.type === 'VariableDeclarator' && parent.init === functionNode) {
    changed = addDynamicCodeConstructorAlias(parent.id, analysis, factories) || changed;
  } else if (
    (parent?.type === 'AssignmentExpression' || parent?.type === 'AssignmentPattern')
    && parent.right === functionNode
  ) {
    changed = addDynamicCodeConstructorAlias(parent.left, analysis, factories) || changed;
  }

  return changed;
}

function addDynamicCodeConstructorPattern(
  pattern: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
): boolean {
  if (!isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'Identifier' || pattern.type === 'AssignmentPattern') {
    return addDynamicCodeConstructorAlias(pattern, analysis, aliases);
  }
  if (pattern.type === 'RestElement') {
    return addDynamicCodeConstructorPattern(pattern.argument, analysis, aliases);
  }
  if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
    return pattern.elements.reduce((changed, element) => {
      return addDynamicCodeConstructorPattern(element, analysis, aliases) || changed;
    }, false);
  }
  if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
    return pattern.properties.reduce((changed, property) => {
      if (!isAstRecord(property)) {
        return changed;
      }
      const value = property.type === 'Property' ? property.value : property.argument;
      return addDynamicCodeConstructorPattern(value, analysis, aliases) || changed;
    }, false);
  }

  return false;
}

function addDynamicCodeConstructorContainerReference(
  input: unknown,
  analysis: MiniGameScopeAnalysis,
  containers: Set<MiniGameLexicalBinding>,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'AssignmentPattern') {
    return addDynamicCodeConstructorContainerReference(input.left, analysis, containers);
  }
  if (input.type === 'ChainExpression') {
    return addDynamicCodeConstructorContainerReference(input.expression, analysis, containers);
  }
  if (input.type === 'MemberExpression') {
    return addDynamicCodeConstructorContainerReference(input.object, analysis, containers);
  }
  if (input.type !== 'Identifier' || typeof input.name !== 'string') {
    return false;
  }

  const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
  const binding = resolveMiniGameBinding(input.name, scope)
    ?? ensureMiniGameBinding(input.name, analysis.programScope);
  const size = containers.size;
  containers.add(binding);
  return containers.size !== size;
}

function addDynamicCodeConstructorAlias(
  pattern: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
): boolean {
  if (!isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'AssignmentPattern') {
    return addDynamicCodeConstructorAlias(pattern.left, analysis, aliases);
  }
  if (pattern.type !== 'Identifier' || typeof pattern.name !== 'string') {
    return false;
  }

  const scope = analysis.scopeByNode.get(pattern) ?? analysis.programScope;
  const binding = resolveMiniGameBinding(pattern.name, scope)
    ?? ensureMiniGameBinding(pattern.name, analysis.programScope);
  const size = aliases.size;
  aliases.add(binding);
  return aliases.size !== size;
}

function isDynamicCodeConstructorInvocation(
  callee: Record<string, unknown>,
  arguments_: readonly unknown[],
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (isDynamicCodeConstructorSource(callee, ancestors, analysis)) {
    return true;
  }
  if (callee.type !== 'MemberExpression') {
    return false;
  }

  const method = readMemberName(callee);

  return (method === 'apply' || method === 'construct')
    && getGlobalIntrinsicKinds(callee.object, ancestors, analysis).has('Reflect')
    && isDynamicCodeConstructorSource(arguments_[0], ancestors, analysis);
}

function isDynamicCodeConstructorSource(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);
    return binding !== undefined && analysis.dynamicCodeConstructorAliases.has(binding);
  }
  if (input.type === 'ChainExpression') {
    return isDynamicCodeConstructorSource(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isDynamicCodeConstructorSource(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isDynamicCodeConstructorSource(input.consequent, ancestors, analysis)
      || isDynamicCodeConstructorSource(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isDynamicCodeConstructorSource(input.left, ancestors, analysis)
      || isDynamicCodeConstructorSource(input.right, ancestors, analysis);
  }
  if (input.type === 'MemberExpression') {
    const memberName = readMemberName(input);

    if (isDynamicCodeConstructorContainerSource(input.object, ancestors, analysis)) {
      return true;
    }
    if (memberName === 'constructor') {
      return true;
    }
    if (
      (memberName === 'call' || memberName === 'apply' || memberName === 'bind')
      && isDynamicCodeConstructorSource(input.object, ancestors, analysis)
    ) {
      return true;
    }
    return memberName === 'value'
      && isReflectiveConstructorDescriptorRead(input.object, ancestors, analysis);
  }
  if (
    input.type === 'CallExpression'
    && isAstRecord(input.callee)
    && Array.isArray(input.arguments)
  ) {
    if (isDynamicCodeConstructorFactoryReference(input.callee, ancestors, analysis)) {
      return true;
    }
    const kinds = getReflectiveGlobalReadKinds(input.callee, ancestors, analysis);
    return kinds.has('property') && evaluateStaticString(input.arguments[1]) === 'constructor';
  }

  return false;
}

function isPotentialDynamicCodeConstructorSource(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'ChainExpression') {
    return isPotentialDynamicCodeConstructorSource(input.expression, ancestors, analysis);
  }
  if (
    (input.type === 'AwaitExpression' || input.type === 'YieldExpression')
    && input.argument !== null
  ) {
    return isPotentialDynamicCodeConstructorSource(input.argument, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isPotentialDynamicCodeConstructorSource(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isPotentialDynamicCodeConstructorSource(input.consequent, ancestors, analysis)
      || isPotentialDynamicCodeConstructorSource(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isPotentialDynamicCodeConstructorSource(input.left, ancestors, analysis)
      || isPotentialDynamicCodeConstructorSource(input.right, ancestors, analysis);
  }

  return isDynamicCodeConstructorSource(input, ancestors, analysis)
    || isUnknownComputedGlobalMember(input, ancestors, analysis);
}

function isDynamicCodeConstructorFactoryReference(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  return isMiniGameFactoryReference(
    input,
    ancestors,
    analysis,
    analysis.dynamicCodeConstructorFactories,
    (value) => isReturnedDynamicCodeConstructorSource(value, ancestors, analysis),
  );
}

function isDynamicCodeConstructorContainerFactoryReference(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  return isMiniGameFactoryReference(
    input,
    ancestors,
    analysis,
    analysis.dynamicCodeConstructorContainerFactories,
    (value) => isDynamicCodeConstructorContainerSource(value, ancestors, analysis),
  );
}

function isMiniGameFactoryReference(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
  factories: ReadonlySet<MiniGameLexicalBinding>,
  returnsFactoryValue: (value: unknown) => boolean,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);
    return binding !== undefined && factories.has(binding);
  }
  if (isMiniGameFunctionNode(input)) {
    return readMiniGameFunctionReturnValues(input).some(returnsFactoryValue);
  }
  if (input.type === 'ChainExpression') {
    return isMiniGameFactoryReference(
      input.expression,
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    );
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isMiniGameFactoryReference(
      input.expressions.at(-1),
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    );
  }
  if (input.type === 'ConditionalExpression') {
    return isMiniGameFactoryReference(
      input.consequent,
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    ) || isMiniGameFactoryReference(
      input.alternate,
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    );
  }
  if (input.type === 'LogicalExpression') {
    return isMiniGameFactoryReference(
      input.left,
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    ) || isMiniGameFactoryReference(
      input.right,
      ancestors,
      analysis,
      factories,
      returnsFactoryValue,
    );
  }

  return false;
}

function isDynamicCodeConstructorContainerSource(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'Identifier' && typeof input.name === 'string') {
    const scope = analysis.scopeByNode.get(input) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(input.name, scope);
    return binding !== undefined && analysis.dynamicCodeConstructorContainers.has(binding);
  }
  if (input.type === 'ChainExpression') {
    return isDynamicCodeConstructorContainerSource(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isDynamicCodeConstructorContainerSource(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isDynamicCodeConstructorContainerSource(input.consequent, ancestors, analysis)
      || isDynamicCodeConstructorContainerSource(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isDynamicCodeConstructorContainerSource(input.left, ancestors, analysis)
      || isDynamicCodeConstructorContainerSource(input.right, ancestors, analysis);
  }
  if (
    input.type === 'CallExpression'
    && isAstRecord(input.callee)
    && isDynamicCodeConstructorContainerFactoryReference(input.callee, ancestors, analysis)
  ) {
    return true;
  }
  if (input.type === 'MemberExpression') {
    return isDynamicCodeConstructorContainerSource(input.object, ancestors, analysis);
  }
  if (input.type === 'ObjectExpression' && Array.isArray(input.properties)) {
    return input.properties.some((property) => {
      if (!isAstRecord(property)) {
        return false;
      }
      const value = property.type === 'Property' ? property.value : property.argument;
      return isPotentialDynamicCodeConstructorSource(value, ancestors, analysis)
        || isDynamicCodeConstructorContainerSource(value, ancestors, analysis)
        || isDynamicCodeConstructorFactoryReference(value, ancestors, analysis)
        || isDynamicCodeConstructorContainerFactoryReference(value, ancestors, analysis);
    });
  }
  if (input.type === 'ArrayExpression' && Array.isArray(input.elements)) {
    return input.elements.some((element) => {
      return isPotentialDynamicCodeConstructorSource(element, ancestors, analysis)
        || isDynamicCodeConstructorContainerSource(element, ancestors, analysis)
        || isDynamicCodeConstructorFactoryReference(element, ancestors, analysis)
        || isDynamicCodeConstructorContainerFactoryReference(element, ancestors, analysis);
    });
  }

  return false;
}

function isReflectiveConstructorDescriptorRead(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (
    !isAstRecord(input)
    || input.type !== 'CallExpression'
    || !isAstRecord(input.callee)
    || !Array.isArray(input.arguments)
  ) {
    return false;
  }

  const kinds = getReflectiveGlobalReadKinds(input.callee, ancestors, analysis);
  return kinds.has('property') && evaluateStaticString(input.arguments[1]) === 'constructor';
}

function collectMiniGameAliases(
  ast: unknown,
  addAliases: (
    pattern: unknown,
    source: unknown,
    ancestors: readonly MiniGameAstAncestor[],
  ) => boolean,
): void {
  let changed = true;

  while (changed) {
    changed = false;
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

      if (input.type === 'VariableDeclarator') {
        changed = addAliases(input.id, input.init, ancestors) || changed;
      } else if (input.type === 'AssignmentPattern') {
        changed = addAliases(input.left, input.right, ancestors) || changed;
      } else if (
        input.type === 'AssignmentExpression'
        && typeof input.operator === 'string'
        && ['=', '&&=', '||=', '??='].includes(input.operator)
      ) {
        changed = addAliases(input.left, input.right, ancestors) || changed;
      }

      for (const [key, value] of Object.entries(input)) {
        if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
          ancestors.push({ node: input, childKey: key });
          visit(value);
          ancestors.pop();
        }
      }
    }
  }
}

function addMiniGameBindingKinds<T>(
  pattern: unknown,
  kinds: ReadonlySet<T>,
  analysis: MiniGameScopeAnalysis,
  aliases: Map<MiniGameLexicalBinding, Set<T>>,
): boolean {
  if (kinds.size === 0 || !isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'AssignmentPattern') {
    return addMiniGameBindingKinds(pattern.left, kinds, analysis, aliases);
  }
  if (pattern.type !== 'Identifier' || typeof pattern.name !== 'string') {
    return false;
  }

  const scope = analysis.scopeByNode.get(pattern) ?? analysis.programScope;
  const binding = resolveMiniGameBinding(pattern.name, scope)
    ?? ensureMiniGameBinding(pattern.name, analysis.programScope);
  const existing = aliases.get(binding) ?? new Set<T>();
  const size = existing.size;
  addSetValues(existing, kinds);
  aliases.set(binding, existing);
  return existing.size !== size;
}

function addSetValues<T>(target: Set<T>, source: ReadonlySet<T> | undefined): void {
  if (source === undefined) {
    return;
  }
  for (const value of source) {
    target.add(value);
  }
}

function addGlobalObjectAliasBindings(
  pattern: unknown,
  source: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
): boolean {
  if (!isGlobalObjectAliasSource(source, ancestors, analysis) || !isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    const scope = analysis.scopeByNode.get(pattern) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(pattern.name, scope)
      ?? ensureMiniGameBinding(pattern.name, analysis.programScope);
    const size = aliases.size;
    aliases.add(binding);
    return aliases.size !== size;
  }
  if (pattern.type === 'AssignmentPattern') {
    return addGlobalObjectAliasBindings(pattern.left, source, ancestors, analysis, aliases);
  }
  if (pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) {
    return false;
  }

  let changed = false;

  for (const property of pattern.properties) {
    if (!isAstRecord(property) || property.type !== 'Property') {
      continue;
    }
    const name = readStaticPropertyName(property);

    if (
      name !== undefined
      && ['globalThis', 'self', 'window', 'top', 'parent'].includes(name)
    ) {
      changed = addKnownGlobalObjectAlias(property.value, analysis, aliases) || changed;
    }
  }

  return changed;
}

function addKnownGlobalObjectAlias(
  pattern: unknown,
  analysis: MiniGameScopeAnalysis,
  aliases: Set<MiniGameLexicalBinding>,
): boolean {
  if (!isAstRecord(pattern)) {
    return false;
  }
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    const scope = analysis.scopeByNode.get(pattern) ?? analysis.programScope;
    const binding = resolveMiniGameBinding(pattern.name, scope)
      ?? ensureMiniGameBinding(pattern.name, analysis.programScope);
    const size = aliases.size;
    aliases.add(binding);
    return aliases.size !== size;
  }
  if (pattern.type === 'AssignmentPattern') {
    return addKnownGlobalObjectAlias(pattern.left, analysis, aliases);
  }

  return false;
}

function isGlobalObjectAliasSource(
  input: unknown,
  ancestors: readonly MiniGameAstAncestor[],
  analysis: MiniGameScopeAnalysis,
): boolean {
  if (isDynamicCodeGlobalObject(input, ancestors, analysis)) {
    return true;
  }
  if (!isAstRecord(input)) {
    return false;
  }
  if (input.type === 'ChainExpression') {
    return isGlobalObjectAliasSource(input.expression, ancestors, analysis);
  }
  if (input.type === 'SequenceExpression' && Array.isArray(input.expressions)) {
    return isGlobalObjectAliasSource(input.expressions.at(-1), ancestors, analysis);
  }
  if (input.type === 'ConditionalExpression') {
    return isGlobalObjectAliasSource(input.consequent, ancestors, analysis)
      || isGlobalObjectAliasSource(input.alternate, ancestors, analysis);
  }
  if (input.type === 'LogicalExpression') {
    return isGlobalObjectAliasSource(input.left, ancestors, analysis)
      || isGlobalObjectAliasSource(input.right, ancestors, analysis);
  }
  if (input.type === 'MemberExpression') {
    const name = readMemberName(input);

    return name !== undefined
      && ['globalThis', 'self', 'window', 'top', 'parent'].includes(name)
      && isGlobalObjectAliasSource(input.object, ancestors, analysis);
  }

  return false;
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

function readStaticPropertyName(node: Record<string, unknown>): string | undefined {
  if (!isAstRecord(node.key)) {
    return undefined;
  }
  if (node.computed === false && node.key.type === 'Identifier') {
    return typeof node.key.name === 'string' ? node.key.name : undefined;
  }

  return evaluateStaticString(node.key);
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
