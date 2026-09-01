import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'acorn';

import type { ReleaseManifest } from '@mpgd/release-manifest';

import {
  assertMiniGameJavaScriptSafety,
  miniGameArtifactEvidenceFileName,
  miniGameEffectiveTargetConfigFileName,
  miniGameIconManifestFileName,
  verifyMiniGameArtifactEvidence,
} from '../target/minigame-artifact';
import { wechatStagingAppId } from '../target/minigame-project-files';
import type { MiniGamePackageBudget, MiniGameTargetConfig } from '../target/schemas';

const runtimeAssetOriginsProperty = '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__';

interface SmokeAstAncestor {
  readonly node: Record<string, unknown>;
  readonly childKey: string;
}

export interface SmokeMiniGameTargetConfig {
  readonly kind: MiniGameTargetConfig['kind'];
  readonly renderer: 'canvas';
  readonly orientation: MiniGameTargetConfig['orientation'];
  readonly experimental: true;
  readonly remoteAssetOrigins?: readonly string[];
  readonly packageBudget: MiniGamePackageBudget;
}

export function verifyMiniGameTargetArtifact(input: Readonly<{
  readonly target: string;
  readonly targetConfig: SmokeMiniGameTargetConfig;
  readonly artifactPath: string;
  readonly releaseManifest: ReleaseManifest;
  readonly releaseEntry: ReleaseManifest['targets'][string];
}>): void {
  const expectedRuntime = input.targetConfig.kind;
  const evidence = verifyMiniGameArtifactEvidence({
    artifactRoot: input.artifactPath,
    target: input.target,
    runtime: expectedRuntime,
    renderer: 'canvas',
    experimental: true,
    appVersion: input.releaseManifest.gameVersion,
    buildId: input.releaseManifest.buildId,
    sourceGitSha: input.releaseManifest.gitSha,
    kitGitSha: input.releaseManifest.kitGitSha,
    budget: input.targetConfig.packageBudget,
  });

  if (evidence.effectiveTargetConfig.sha256 !== input.releaseEntry.effectiveConfig.digest) {
    throw new Error('Mini-game effective target config digest differs from release evidence.');
  }
  if (evidence.iconManifest.sha256 !== input.releaseEntry.iconManifest.digest) {
    throw new Error('Mini-game icon manifest digest differs from release evidence.');
  }

  const gameEntry = readFileSync(join(input.artifactPath, 'game.js'), 'utf8');

  if (gameEntry !== "require('./runtime.js');\nrequire('./game.bundle.js');\n") {
    throw new Error('Mini-game game.js must synchronously load runtime.js before game.bundle.js.');
  }
  const runtimeSource = readFileSync(join(input.artifactPath, 'runtime.js'), 'utf8');
  assertMiniGameRuntimeAssetOrigins(runtimeSource, input.targetConfig.remoteAssetOrigins ?? []);

  const gameConfig = readJson(join(input.artifactPath, 'game.json'), 'Mini-game game.json');
  assertRecord(gameConfig, 'Mini-game game.json');

  if (gameConfig.deviceOrientation !== input.targetConfig.orientation) {
    throw new Error('Mini-game game.json orientation differs from target configuration.');
  }

  const projectConfig = readJson(
    join(input.artifactPath, 'project.config.json'),
    'Mini-game project.config.json',
  );
  assertRecord(projectConfig, 'Mini-game project.config.json');

  if (input.targetConfig.kind === 'wechat-minigame') {
    verifyWechatProjectConfig(projectConfig, input.releaseEntry.profile === 'production');
    assertMiniGameJavaScriptSafety(input.artifactPath, [
      { marker: 'TTMinis.game', owner: 'TikTok' },
      { marker: 'createTikTokPlatformGateway', owner: 'TikTok' },
    ]);
  }

  if (existsSync(join(input.artifactPath, 'index.html'))) {
    throw new Error('Native mini-game artifacts must not contain index.html.');
  }
}

export function assertMiniGameRuntimeAssetOrigins(
  runtimeSource: string,
  expectedOrigins: readonly string[],
): void {
  let ast: unknown;

  try {
    ast = parse(runtimeSource, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new Error(`Mini-game runtime.js is not valid JavaScript: ${formatError(error)}`);
  }

  const declarations = readTopLevelRuntimeAssetOriginDeclarations(ast);
  const candidateCount = countRuntimeAssetOriginCandidates(ast);

  if (candidateCount !== 1 || declarations.length !== 1) {
    throw new Error(
      'Mini-game runtime.js must contain exactly one executable asset-origin declaration.',
    );
  }
  if (JSON.stringify(declarations[0]) !== JSON.stringify(expectedOrigins)) {
    throw new Error('Mini-game runtime.js asset origins differ from target configuration.');
  }
}

function countRuntimeAssetOriginCandidates(ast: unknown): number {
  let count = 0;

  visitAst(ast, [], (node) => {
    if (isRuntimeAssetOriginCandidate(node)) {
      count += 1;
    }
  });
  return count;
}

function isRuntimeAssetOriginCandidate(node: Record<string, unknown>): boolean {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments)) {
    return false;
  }
  const [target, property] = node.arguments;

  return isIdentifier(target, 'globalThis')
    && readStaticString(property) === runtimeAssetOriginsProperty;
}

function readTopLevelRuntimeAssetOriginDeclarations(ast: unknown): string[][] {
  if (!isAstRecord(ast) || ast.type !== 'Program' || !Array.isArray(ast.body)) {
    return [];
  }

  return ast.body.flatMap((statement) => {
    if (
      !isAstRecord(statement)
      || statement.type !== 'ExpressionStatement'
      || !isAstRecord(statement.expression)
    ) {
      return [];
    }
    const origins = readRuntimeAssetOriginsDeclaration(statement.expression);

    return origins === undefined ? [] : [origins];
  });
}

function readRuntimeAssetOriginsDeclaration(
  node: Record<string, unknown>,
): string[] | undefined {
  if (
    node.type !== 'CallExpression'
    || !isAstRecord(node.callee)
    || !isGlobalObjectIntrinsicMember(node.callee, 'defineProperty')
    || !Array.isArray(node.arguments)
  ) {
    return undefined;
  }

  const [target, property, descriptor] = node.arguments;

  if (
    !isIdentifier(target, 'globalThis')
    || readStaticString(property) !== runtimeAssetOriginsProperty
    || !isAstRecord(descriptor)
    || descriptor.type !== 'ObjectExpression'
    || !Array.isArray(descriptor.properties)
  ) {
    return undefined;
  }

  const valueProperty = descriptor.properties.find((candidate) => {
    return isAstRecord(candidate)
      && candidate.type === 'Property'
      && readStaticPropertyName(candidate) === 'value';
  });

  return isAstRecord(valueProperty) ? readStaticStringArray(valueProperty.value) : undefined;
}

function readStaticStringArray(input: unknown): string[] | undefined {
  if (!isAstRecord(input)) {
    return undefined;
  }
  if (
    input.type === 'CallExpression'
    && isAstRecord(input.callee)
    && isGlobalObjectIntrinsicMember(input.callee, 'freeze')
    && Array.isArray(input.arguments)
    && input.arguments.length === 1
  ) {
    return readStaticStringArray(input.arguments[0]);
  }
  if (input.type !== 'ArrayExpression' || !Array.isArray(input.elements)) {
    return undefined;
  }

  const values = input.elements.map(readStaticString);

  return values.every((value): value is string => value !== undefined) ? values : undefined;
}

function readMemberName(node: Record<string, unknown>): string | undefined {
  if (node.type !== 'MemberExpression' || !isAstRecord(node.property)) {
    return undefined;
  }
  if (node.computed === true) {
    return readStaticString(node.property);
  }

  return node.property.type === 'Identifier' && typeof node.property.name === 'string'
    ? node.property.name
    : undefined;
}

function isGlobalObjectIntrinsicMember(
  node: Record<string, unknown>,
  memberName: string,
): boolean {
  return node.type === 'MemberExpression'
    && node.computed === false
    && isAstRecord(node.object)
    && node.object.type === 'MemberExpression'
    && node.object.computed === false
    && isIdentifier(node.object.object, 'globalThis')
    && isIdentifier(node.object.property, 'Object')
    && readMemberName(node) === memberName;
}

function readStaticPropertyName(node: Record<string, unknown>): string | undefined {
  if (!isAstRecord(node.key)) {
    return undefined;
  }
  if (node.computed === true) {
    return readStaticString(node.key);
  }
  if (node.key.type === 'Identifier' && typeof node.key.name === 'string') {
    return node.key.name;
  }

  return readStaticString(node.key);
}

function readStaticString(input: unknown): string | undefined {
  if (!isAstRecord(input)) {
    return undefined;
  }
  if (input.type === 'Literal' && typeof input.value === 'string') {
    return input.value;
  }
  if (
    input.type === 'TemplateLiteral'
    && Array.isArray(input.expressions)
    && input.expressions.length === 0
    && Array.isArray(input.quasis)
    && input.quasis.length === 1
    && isAstRecord(input.quasis[0])
    && isAstRecord(input.quasis[0].value)
    && typeof input.quasis[0].value.cooked === 'string'
  ) {
    return input.quasis[0].value.cooked;
  }

  return undefined;
}

function visitAst(
  input: unknown,
  ancestors: SmokeAstAncestor[],
  visitor: (
    node: Record<string, unknown>,
    ancestors: readonly SmokeAstAncestor[],
  ) => void,
): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      visitAst(item, ancestors, visitor);
    }
    return;
  }
  if (!isAstRecord(input)) {
    return;
  }

  visitor(input, ancestors);
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'start' && key !== 'end' && key !== 'loc' && key !== 'range') {
      ancestors.push({ node: input, childKey: key });
      visitAst(value, ancestors, visitor);
      ancestors.pop();
    }
  }
}

function isIdentifier(input: unknown, name: string): boolean {
  return isAstRecord(input) && input.type === 'Identifier' && input.name === name;
}

function isAstRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function requiredMiniGameArtifactFiles(artifactPath: string): readonly string[] {
  return [
    'game.js',
    'game.json',
    'project.config.json',
    'runtime.js',
    'game.bundle.js',
    miniGameEffectiveTargetConfigFileName,
    miniGameIconManifestFileName,
    miniGameArtifactEvidenceFileName,
  ].map((file) => join(artifactPath, file));
}

function verifyWechatProjectConfig(
  projectConfig: Record<string, unknown>,
  production: boolean,
): void {
  if (projectConfig.compileType !== 'game' || projectConfig.simulatorType !== 'wechat') {
    throw new Error('WeChat project.config.json must declare the game compile type and simulator.');
  }
  if (typeof projectConfig.appid !== 'string') {
    throw new Error('WeChat project.config.json must declare an appid.');
  }
  if (
    production
    && (
      projectConfig.appid === wechatStagingAppId
      || !/^wx[0-9a-f]{16}$/u.test(projectConfig.appid)
    )
  ) {
    throw new Error('Production WeChat project.config.json contains a placeholder appid.');
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is unreadable: ${formatError(error)}`);
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
