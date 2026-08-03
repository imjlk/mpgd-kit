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
  assertDisjointWebArtifactOutputs,
  assertInstallableWebArtifact,
  assertNonInstallableWebArtifact,
  assertWebArtifactOutputDirectory,
  assertWebStaticDirectory,
  copyWebStaticDirectoryContents,
  ensureInstallableWebManifestLink,
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
  assert.doesNotThrow(() => assertInstallableWebArtifact(artifact));

  sanitizeNonInstallableWebArtifact(artifact);
  assert.equal(existsSync(join(artifact, 'manifest.webmanifest')), false);
  assert.doesNotMatch(readFileSync(join(artifact, 'index.html'), 'utf8'), /rel="manifest"/u);
  assert.match(readFileSync(join(artifact, 'index.html'), 'utf8'), /rel="icon"/u);
  assert.doesNotThrow(() => assertNonInstallableWebArtifact(artifact));
  assert.throws(() => assertInstallableWebArtifact(artifact), /has no web app manifest/u);

  const misleadingAttributesArtifact = join(root, 'misleading-attributes-artifact');
  mkdirSync(misleadingAttributesArtifact);
  writeFileSync(join(misleadingAttributesArtifact, 'manifest.webmanifest'), '{}\n');
  writeFileSync(
    join(misleadingAttributesArtifact, 'index.html'),
    '<html><head>'
      + '<link data-rel="manifest" href="./manifest.webmanifest">'
      + '<link title="rel=manifest" href="./manifest.webmanifest">'
      + '</head></html>',
  );
  assert.throws(
    () => assertInstallableWebArtifact(misleadingAttributesArtifact),
    /does not link an existing root web app manifest/u,
  );
  ensureInstallableWebManifestLink(misleadingAttributesArtifact);
  const correctedAttributesHtml = readFileSync(
    join(misleadingAttributesArtifact, 'index.html'),
    'utf8',
  );
  assert.match(correctedAttributesHtml, /data-rel="manifest"/u);
  assert.match(correctedAttributesHtml, /title="rel=manifest"/u);
  assert.doesNotThrow(() => assertInstallableWebArtifact(misleadingAttributesArtifact));

  const mismatchedManifestArtifact = join(root, 'mismatched-manifest-artifact');
  mkdirSync(mismatchedManifestArtifact);
  writeFileSync(join(mismatchedManifestArtifact, 'manifest.json'), '{}\n');
  writeFileSync(
    join(mismatchedManifestArtifact, 'index.html'),
    '<html><head><link rel="manifest" href="./manifest.webmanifest"></head></html>',
  );
  assert.throws(
    () => assertInstallableWebArtifact(mismatchedManifestArtifact),
    /does not link an existing root web app manifest/u,
  );

  const scriptedArtifact = join(root, 'scripted-artifact');
  const embeddedManifestMarkup = '<link rel="manifest" href="./embedded.webmanifest">';
  mkdirSync(scriptedArtifact);
  writeFileSync(join(scriptedArtifact, 'manifest.webmanifest'), '{}\n');
  writeFileSync(
    join(scriptedArtifact, 'index.html'),
    '<html><head>'
      + `<script>const markup = ${JSON.stringify(embeddedManifestMarkup)};</script>`
      + `<!-- ${embeddedManifestMarkup} -->`
      + `<template>${embeddedManifestMarkup}</template>`
      + '</head><body></body></html>',
  );
  ensureInstallableWebManifestLink(scriptedArtifact);
  const installableHtml = readFileSync(join(scriptedArtifact, 'index.html'), 'utf8');
  assert.ok(installableHtml.includes(`<script>const markup = ${JSON.stringify(
    embeddedManifestMarkup,
  )};</script>`));
  assert.ok(installableHtml.includes(`<!-- ${embeddedManifestMarkup} -->`));
  assert.ok(installableHtml.includes(`<template>${embeddedManifestMarkup}</template>`));
  assert.doesNotThrow(() => assertInstallableWebArtifact(scriptedArtifact));

  sanitizeNonInstallableWebArtifact(scriptedArtifact);
  const nonInstallableHtml = readFileSync(join(scriptedArtifact, 'index.html'), 'utf8');
  assert.ok(nonInstallableHtml.includes(`<script>const markup = ${JSON.stringify(
    embeddedManifestMarkup,
  )};</script>`));
  assert.ok(nonInstallableHtml.includes(`<!-- ${embeddedManifestMarkup} -->`));
  assert.ok(nonInstallableHtml.includes(`<template>${embeddedManifestMarkup}</template>`));
  assert.doesNotThrow(() => assertNonInstallableWebArtifact(scriptedArtifact));

  writeFileSync(join(staticDir, 'manifest.webmanifest'), '{}\n');
  assertWebStaticDirectory(staticDir, artifact, root);
  copyWebStaticDirectoryContents(staticDir, artifact);
  assert.throws(() => assertNonInstallableWebArtifact(artifact), /contains a web app manifest/u);

  const newlyCreatedArtifact = join(root, 'new-artifact');
  copyWebStaticDirectoryContents(staticDir, newlyCreatedArtifact);
  assert.equal(existsSync(join(newlyCreatedArtifact, 'manifest.webmanifest')), true);

  assert.throws(
    () => assertWebStaticDirectory(artifact, join(artifact, 'nested'), root),
    /must not overlap/u,
  );
  assert.throws(
    () => assertWebArtifactOutputDirectory(artifact, join(artifact, 'nested')),
    /artifact output and Vite output must not overlap/u,
  );
  assert.throws(
    () => assertDisjointWebArtifactOutputs([
      { name: 'storefront', path: artifact },
      { name: 'archive', path: join(artifact, 'nested') },
    ]),
    /artifact outputs must not overlap: storefront .* and archive /u,
  );

  const realStaticDir = join(root, 'real-static');
  const linkedStaticDir = join(root, 'linked-static');
  mkdirSync(realStaticDir);
  symlinkSync(realStaticDir, linkedStaticDir);
  assert.throws(
    () => assertWebStaticDirectory(linkedStaticDir, artifact, root),
    /symbolic-link web staticDir/u,
  );

  const outputLink = join(root, 'output-link');
  symlinkSync(staticDir, outputLink);
  assert.throws(
    () => assertWebStaticDirectory(staticDir, join(outputLink, 'nested'), root),
    /staticDir and output must not overlap/u,
  );

  const externalOutput = join(root, 'external-output');
  const linkedOutputInsideStatic = join(staticDir, 'linked-output');
  mkdirSync(externalOutput);
  symlinkSync(externalOutput, linkedOutputInsideStatic);
  assert.throws(
    () => assertWebStaticDirectory(staticDir, linkedOutputInsideStatic, root),
    /artifact output must not be a symbolic link/u,
  );

  const danglingOutput = join(root, 'dangling-output');
  symlinkSync(join(root, 'missing-output-target'), danglingOutput);
  assert.throws(
    () => assertWebArtifactOutputDirectory(danglingOutput, join(root, 'vite-output')),
    /artifact output must not be a symbolic link/u,
  );

  const reservedStaticDir = join(root, 'reserved-static');
  mkdirSync(reservedStaticDir);
  writeFileSync(join(reservedStaticDir, 'mpgd-effective-target.json'), '{}\n');
  assert.throws(
    () => copyWebStaticDirectoryContents(reservedStaticDir, artifact),
    /reserved generated evidence: mpgd-effective-target\.json/u,
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

  const gameApp = join(root, 'game-app');
  const viteOutputStaticDir = join(gameApp, 'dist/static');
  mkdirSync(viteOutputStaticDir, { recursive: true });

  for (const output of ['.', '..', join(root, '..', 'absolute-external-output')]) {
    writeWebTargetConfig(configPath, {
      gameApp: 'game-app',
      output,
      staticDir: 'static',
    });
    assert.throws(
      () => validatePlatformTargetsFile(configPath),
      /artifact output must stay inside its game root/u,
    );
  }

  for (const output of [
    'game-app/dist',
    'game-app/dist/release',
    'game-app',
    'game-app/../game-app/dist',
  ]) {
    writeWebTargetConfig(configPath, {
      gameApp: 'game-app',
      output,
      staticDir: 'static',
    });
    assert.throws(
      () => validatePlatformTargetsFile(configPath),
      /artifact output and Vite output must not overlap/u,
    );
  }

  const linkedGameApp = join(root, 'linked-game-app');
  symlinkSync(gameApp, linkedGameApp);
  writeWebTargetConfig(configPath, {
    gameApp: 'game-app',
    output: 'linked-game-app/dist',
    staticDir: 'static',
  });
  assert.throws(
    () => validatePlatformTargetsFile(configPath),
    /artifact output and Vite output must not overlap/u,
  );

  const artifactRoot = join(root, 'artifact-root');
  const linkedArtifactRoot = join(root, 'linked-artifact-root');
  mkdirSync(artifactRoot);
  symlinkSync(artifactRoot, linkedArtifactRoot);

  for (const [output, additionalOutput] of [
    ['artifact-root/storefront', 'artifact-root/storefront'],
    ['artifact-root/storefront', 'artifact-root/storefront/archive'],
    ['artifact-root/storefront', 'artifact-root/other/../storefront'],
    ['artifact-root/storefront', 'linked-artifact-root/storefront'],
  ] as const) {
    writeWebTargetConfig(configPath, {
      additionalOutput,
      gameApp: 'game-app',
      output,
      staticDir: 'static',
    });
    assert.throws(
      () => validatePlatformTargetsFile(configPath),
      /artifact outputs must not overlap: storefront .* and archive /u,
    );
  }

  for (const output of [
    'release-output',
    'release-output/android',
    'artifacts',
    'artifacts/target-config',
    'artifacts/release-manifest.json',
  ]) {
    writeWebTargetConfig(configPath, {
      gameApp: 'game-app',
      output,
      staticDir: 'static',
    });
    assert.throws(
      () => validatePlatformTargetsFile(configPath),
      /artifact output must not overlap generated output/u,
    );
  }

  writeWebTargetConfig(configPath, {
    output: 'validated-artifact',
    staticDir: 'static',
  });
  assert.doesNotThrow(() => validatePlatformTargetsFile(configPath));

  writeWebTargetConfig(configPath, {
    gameApp: 'game-app',
    output: 'validated-artifact',
    staticDir: 'game-app/dist/static',
  });
  assert.throws(
    () => validatePlatformTargetsFile(configPath),
    /staticDir and output must not overlap/u,
  );

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
  assert.throws(
    () => assertPlatformTargetsConfigShape({
      targets: {
        index: {
          kind: 'web',
          gameApp: '.',
          adapter: 'browser',
          output: 'artifact',
        },
      },
    }),
    /Invalid deployment target name: index/u,
  );
  assert.throws(
    () => assertPlatformTargetsConfigShape({
      targets: {
        'microsoft-store': {
          kind: 'web',
          gameApp: '.',
          adapter: 'browser',
          output: 'artifact',
          installable: false,
        },
      },
    }),
    /microsoft-store\.installable must not be false/u,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}

console.log('Web artifact policy smoke passed.');

function writeWebTargetConfig(
  path: string,
  input: {
    readonly additionalOutput?: string;
    readonly gameApp?: string;
    readonly output: string;
    readonly staticDir: string;
  },
): void {
  const target = {
    kind: 'web',
    gameApp: input.gameApp ?? '.',
    adapter: 'browser',
    staticDir: input.staticDir,
  };

  writeFileSync(path, `${JSON.stringify({
    targets: {
      storefront: {
        ...target,
        output: input.output,
      },
      ...(input.additionalOutput === undefined
        ? {}
        : {
            archive: {
              ...target,
              output: input.additionalOutput,
            },
          }),
    },
  })}\n`);
}
