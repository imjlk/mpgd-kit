import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReleaseManifest } from '@mpgd/release-manifest';

import {
  assertMiniGameJavaScriptSafety,
  miniGameArtifactEvidenceFileName,
  miniGameEffectiveTargetConfigFileName,
  miniGameIconManifestFileName,
  verifyMiniGameArtifactEvidence,
} from '../target/minigame-artifact';
import type { MiniGamePackageBudget, MiniGameTargetConfig } from '../target/schemas';

export interface SmokeMiniGameTargetConfig {
  readonly kind: MiniGameTargetConfig['kind'];
  readonly renderer: 'canvas';
  readonly orientation: MiniGameTargetConfig['orientation'];
  readonly experimental: true;
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
  if (production && !/^wx[0-9a-f]{16}$/iu.test(projectConfig.appid)) {
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
