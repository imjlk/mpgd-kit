import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { GeneratedTargetIcons } from '../icons/types';
import {
  assembleMiniGameArtifact,
  miniGameArtifactEvidenceFileName,
  miniGameEffectiveTargetConfigFileName,
  miniGameIconManifestFileName,
  verifyMiniGameArtifactEvidence,
  writeMiniGameArtifactEvidence,
} from './minigame-artifact';

const root = mkdtempSync(join(tmpdir(), 'mpgd-minigame-evidence-'));
const transactionRoot = mkdtempSync(join(tmpdir(), 'mpgd-minigame-transaction-'));
const budget = { mainBytes: 100_000, totalBytes: 100_000 } as const;
const expected = {
  artifactRoot: root,
  target: 'wechat',
  runtime: 'wechat-minigame',
  renderer: 'canvas',
  experimental: true,
  appVersion: '1.2.3',
  buildId: 'build-1',
  sourceGitSha: 'source-sha',
  kitGitSha: 'kit-sha',
  budget,
} as const;

try {
  write('game.js', "require('./runtime.js');\nrequire('./game.bundle.js');\n");
  write('game.json', '{"deviceOrientation":"landscape"}\n');
  write('project.config.json', '{"compileType":"game"}\n');
  write('runtime.js', 'globalThis.__MPGD_MINIGAME__ = true;\n');
  write('game.bundle.js', 'globalThis.__MPGD_GAME__ = true;\n');
  write(miniGameEffectiveTargetConfigFileName, '{"target":"wechat"}\n');
  write(miniGameIconManifestFileName, '{"schemaVersion":2}\n');
  write('assets/logo.png', Buffer.from([1, 2, 3]));

  const evidence = writeMiniGameArtifactEvidence(expected);
  assert.equal(
    evidence.files.some((file) => file.path === miniGameArtifactEvidenceFileName),
    false,
  );
  assert.equal(
    evidence.packageSize.totalBytes,
    sumArtifactBytes(),
    'evidence package size must include its own final bytes',
  );
  assert.deepEqual(verifyMiniGameArtifactEvidence(expected), evidence);

  write('assets/logo.png', Buffer.from([4, 5, 6]));
  assert.throws(() => verifyMiniGameArtifactEvidence(expected), /digest mismatch/u);
  write('assets/logo.png', Buffer.from([1, 2, 3]));
  assert.deepEqual(verifyMiniGameArtifactEvidence(expected), evidence);

  const parsed = JSON.parse(
    readFileSync(join(root, miniGameArtifactEvidenceFileName), 'utf8'),
  ) as Record<string, unknown>;
  parsed.target = 'tiktok';
  write(miniGameArtifactEvidenceFileName, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.throws(() => verifyMiniGameArtifactEvidence(expected), /target mismatch/u);

  const projectRoot = join(transactionRoot, 'game');
  const artifactRoot = join(projectRoot, 'artifacts', 'wechat');
  const runtimeBundleRoot = join(transactionRoot, 'runtime-bundle');
  const gameBundleRoot = join(transactionRoot, 'game-bundle');
  const iconOutputRoot = join(transactionRoot, 'icons');
  const iconManifestPath = join(transactionRoot, 'icon-manifest.json');
  const effectiveTargetConfigSource = join(transactionRoot, 'effective-target.json');
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(runtimeBundleRoot, { recursive: true });
  mkdirSync(gameBundleRoot, { recursive: true });
  mkdirSync(iconOutputRoot, { recursive: true });
  writeFileSync(join(artifactRoot, 'sentinel.txt'), 'prior verified artifact');
  writeFileSync(join(runtimeBundleRoot, 'runtime.js'), 'globalThis.runtime = true;\n');
  writeFileSync(join(gameBundleRoot, 'game.bundle.js'), 'globalThis.game = true;\n');
  writeFileSync(iconManifestPath, '{"outputs":[]}\n');
  writeFileSync(effectiveTargetConfigSource, '{"target":"wechat"}\n');
  assert.throws(
    () => assembleMiniGameArtifact({
      artifactRoot,
      projectRoot,
      runtimeBundleRoot,
      gameBundleRoot,
      effectiveTargetConfigSource,
      generatedIcons: {
        manifestPath: iconManifestPath,
        outputDir: iconOutputRoot,
        manifest: { outputs: [] },
      } as unknown as GeneratedTargetIcons,
      writeProjectFiles(stagingRoot) {
        writeFileSync(join(stagingRoot, 'game.js'), "require('./game.bundle.js');\n");
        writeFileSync(join(stagingRoot, 'game.json'), '{}\n');
        writeFileSync(join(stagingRoot, 'project.config.json'), '{}\n');
      },
      target: 'wechat',
      runtime: 'wechat-minigame',
      appVersion: '1.2.3',
      buildId: 'build-1',
      sourceGitSha: 'source-sha',
      kitGitSha: 'kit-sha',
      budget,
    }),
    /must load runtime\.js before game\.bundle\.js/u,
  );
  assert.equal(readFileSync(join(artifactRoot, 'sentinel.txt'), 'utf8'), 'prior verified artifact');
  assert.deepEqual(readdirSync(join(projectRoot, 'artifacts')), ['wechat']);
} finally {
  rmSync(root, { force: true, recursive: true });
  rmSync(transactionRoot, { force: true, recursive: true });
}

console.log('Mini-game artifact evidence tests passed.');

function write(path: string, contents: string | Buffer): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function sumArtifactBytes(): number {
  let total = 0;
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();

    if (directory === undefined) {
      throw new Error('Fixture traversal lost its directory.');
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        total += statSync(path).size;
      }
    }
  }

  return total;
}
