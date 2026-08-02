import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertPlatformTargetsConfigShape } from './platform-targets';
import { validatePlatformTargetsFile } from './validate-platform-targets';
import {
  assertNonInstallableWebArtifact,
  assertWebStaticDirectory,
  copyWebStaticDirectoryContents,
  sanitizeNonInstallableWebArtifact,
} from './web-artifact';

const root = mkdtempSync(join(tmpdir(), 'mpgd-web-artifact-'));

try {
  const artifact = join(root, 'artifact');
  const staticDir = join(root, 'static');
  mkdirSync(artifact);
  mkdirSync(staticDir);
  writeFileSync(join(artifact, 'manifest.webmanifest'), '{}\n');
  writeFileSync(
    join(artifact, 'index.html'),
    '<html><head><link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon.png"></head></html>',
  );

  sanitizeNonInstallableWebArtifact(artifact);
  assert.equal(existsSync(join(artifact, 'manifest.webmanifest')), false);
  assert.doesNotMatch(readFileSync(join(artifact, 'index.html'), 'utf8'), /rel="manifest"/u);
  assert.match(readFileSync(join(artifact, 'index.html'), 'utf8'), /rel="icon"/u);
  assert.doesNotThrow(() => assertNonInstallableWebArtifact(artifact));

  writeFileSync(join(staticDir, 'manifest.webmanifest'), '{}\n');
  assertWebStaticDirectory(staticDir, artifact, root);
  copyWebStaticDirectoryContents(staticDir, artifact);
  assert.throws(() => assertNonInstallableWebArtifact(artifact), /contains a web app manifest/u);

  assert.throws(
    () => assertWebStaticDirectory(artifact, join(artifact, 'nested'), root),
    /must not overlap/u,
  );

  const realStaticDir = join(root, 'real-static');
  const linkedStaticDir = join(root, 'linked-static');
  mkdirSync(realStaticDir);
  symlinkSync(realStaticDir, linkedStaticDir);
  assert.throws(
    () => assertWebStaticDirectory(linkedStaticDir, artifact, root),
    /symbolic-link web staticDir/u,
  );

  const configPath = join(root, 'mpgd.targets.json');
  const staticFile = join(root, 'static-file');
  writeFileSync(staticFile, 'not a directory\n');
  writeWebTargetConfig(configPath, {
    output: 'validated-artifact',
    staticDir: 'static-file',
  });
  assert.throws(() => validatePlatformTargetsFile(configPath), /staticDir must be a directory/u);

  writeWebTargetConfig(configPath, {
    output: 'static/nested-output',
    staticDir: 'static',
  });
  assert.throws(
    () => validatePlatformTargetsFile(configPath),
    /staticDir and output must not overlap/u,
  );

  writeWebTargetConfig(configPath, {
    output: 'validated-artifact',
    staticDir: 'static',
  });
  assert.doesNotThrow(() => validatePlatformTargetsFile(configPath));

  assert.throws(
    () => assertPlatformTargetsConfigShape({
      targets: {
        storefront: {
          kind: 'web',
          gameApp: '.',
          adapter: 'browser',
          output: 'artifact',
          staticDir: '   ',
        },
      },
    }),
    /storefront\.staticDir must be a non-empty string/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('Web artifact policy smoke passed.');

function writeWebTargetConfig(
  path: string,
  input: { readonly output: string; readonly staticDir: string },
): void {
  writeFileSync(path, `${JSON.stringify({
    targets: {
      storefront: {
        kind: 'web',
        gameApp: '.',
        adapter: 'browser',
        output: input.output,
        staticDir: input.staticDir,
      },
    },
  })}\n`);
}
