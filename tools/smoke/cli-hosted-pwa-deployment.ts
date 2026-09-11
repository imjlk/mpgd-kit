import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, relative as toRelative } from 'node:path';

import { verifyHostedPwaDeployment } from '../../packages/cli/src/hosted-pwa-deployment';
import { runMpgdCli } from '../../packages/cli/src/index';
import { writeMicrosoftStorePwaArtifacts } from '../target/microsoft-store-pwa';

// Local throwing helpers: node:assert calls are stripped by @ttsc/strip, so
// smokes must validate by throwing plain errors (the repo-wide convention).
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)} but found ${String(actual)}.`);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson} but found ${actualJson}.`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`${label}: expected true.`);
  }
}

function assertThrows(run: () => void, pattern: RegExp, label: string): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!pattern.test(message)) {
      throw new Error(`${label} threw an unexpected error: ${message}`);
    }

    return;
  }

  throw new Error(`${label} did not throw.`);
}

async function assertRejects(
  run: () => Promise<unknown>,
  predicate: (error: unknown) => boolean,
  label: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!predicate(error)) {
      const aggregate = error as AggregateError;
      const description = String(aggregate.errors?.[0] ?? error);
      throw new Error(`${label} rejected with an unexpected error: ${description}`);
    }

    return;
  }

  throw new Error(`${label} did not reject.`);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-hosted-pwa-verification-'));

const validHeaders = [
  '/*',
  '  ! Cache-Control',
  '  X-Content-Type-Options: nosniff',
  '',
  '/',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/index.html',
  '  Cache-Control: must-revalidate, public, max-age=0',
  '',
  '/manifest.webmanifest',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/service-worker.js',
  '  Cache-Control: no-store, must-revalidate',
  '',
  '/pwa-release.json',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/mpgd-effective-target.json',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/icons/*',
  '  Cache-Control: no-store, must-revalidate',
  '',
  '/legal-site.json',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/privacy/*',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
].join('\n');

const validRedirects = [
  '/privacy /privacy/ 301',
  '/support /support/ 301',
  '/terms /terms/ 301',
  '',
].join('\n');

const legalSiteManifest = {
  version: 1,
  pages: [
    { slug: 'privacy', path: '/privacy/', source: 'legal/privacy.html' },
  ],
};

try {
  const sourceRoot = buildSourceArtifact(join(fixtureRoot, 'source-pwa'));
  const deploymentRoot = buildDeployment(sourceRoot, join(fixtureRoot, 'deployment'), 'api-only');

  // 1. A faithful source and deployment pair passes for both reviewed profiles.
  const verified = verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  assertEqual(verified.host, 'cloudflare-pages', 'verification host');
  assertEqual(verified.appVersion, '1.2.3', 'app version');
  assertEqual(verified.buildId, 'build-42', 'build id');
  assertEqual(verified.workerRoutes.include.join('|'), '/api/*', 'api-only routes');
  assertTrue(verified.verifiedGameFileCount >= 6, 'game files counted');
  assertTrue(verified.hostFileCount >= 6, 'host files counted');

  const canonicalDeployment = buildDeployment(
    sourceRoot,
    join(fixtureRoot, 'deployment-canonical'),
    'api-canonical-index',
  );
  const canonicalVerified = verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot: canonicalDeployment,
    host: 'cloudflare-pages',
    profile: 'api-canonical-index',
  });
  assertEqual(
    canonicalVerified.workerRoutes.include.join('|'),
    '/api/*|/index.html',
    'canonical routes',
  );

  // 2. Matching release metadata with different JavaScript fails on the digest.
  const tamperedDeployment = fixtureCopy(deploymentRoot, 'tampered-js');
  const hashedAsset = findFile(tamperedDeployment, 'assets/');
  writeFileSync(
    join(tamperedDeployment, hashedAsset),
    `${readFileSync(join(tamperedDeployment, hashedAsset), 'utf8')}\n// different build`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: tamperedDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /does not match the source artifact/u,
    'tampered deployment JavaScript',
  );

  // 2b. A recorded precache list that disagrees with the artifact files fails.
  const staleContractSource = fixtureCopy(sourceRoot, 'stale-precache-contract');
  const evidencePath = join(staleContractSource, 'pwa-release.json');
  const staleEvidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    precacheUrls: readonly string[];
  };
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        ...staleEvidence,
        precacheUrls: staleEvidence.precacheUrls.filter((url) => url !== './index.html'),
      },
      null,
      2,
    ),
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: staleContractSource,
      deploymentRoot: fixtureCopy(deploymentRoot, 'stale-precache-deployment'),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /precache contract is inconsistent/u,
    'stale precache contract',
  );

  // 3. Missing service worker, manifest, icon, and referenced assets fail.
  for (const missing of ['service-worker.js', 'manifest.webmanifest', 'icons/icon-512.png']) {
    const incompleteDeployment = fixtureCopy(deploymentRoot, `missing-${missing}`);
    rmSync(join(incompleteDeployment, missing));
    assertThrows(
      () => verifyHostedPwaDeployment({
        sourceArtifactRoot: sourceRoot,
        deploymentRoot: incompleteDeployment,
        host: 'cloudflare-pages',
        profile: 'api-only',
      }),
      /missing game file/u,
      `missing ${missing}`,
    );
  }

  const danglingReferenceSource = buildSourceArtifact(
    join(fixtureRoot, 'source-dangling-reference'),
    { extraIndexReferences: ['./missing-asset.png'] },
  );
  const danglingReferenceDeployment = buildDeployment(
    danglingReferenceSource,
    join(fixtureRoot, 'deployment-dangling-reference'),
    'api-only',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: danglingReferenceSource,
      deploymentRoot: danglingReferenceDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'dangling index reference',
  );

  // 3b. A deployment without the Pages worker fails for routed profiles.
  const workerlessDeployment = fixtureCopy(deploymentRoot, 'workerless');
  rmSync(join(workerlessDeployment, '_worker.js'));
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: workerlessDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /missing _worker\.js/u,
    'workerless deployment',
  );

  // 4. A required cache directive on an unrelated path block fails.
  const wrongBlockHeaders = validHeaders.replace(
    '/service-worker.js\n  Cache-Control: no-store, must-revalidate',
    '/unrelated/*\n  Cache-Control: no-store, must-revalidate',
  );
  const wrongBlockDeployment = fixtureCopy(deploymentRoot, 'wrong-block');
  writeFileSync(join(wrongBlockDeployment, '_headers'), wrongBlockHeaders);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: wrongBlockDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for service-worker\.js is missing/u,
    'wrong cache block',
  );

  // 4b. A placeholder-only block cannot cover nested asset URLs.
  const placeholderSource = buildSourceArtifact(join(fixtureRoot, 'source-placeholder'), {
    nestedAsset: 'assets/chunks/game.1a2b3c4d.js',
  });
  const placeholderHeaders = validHeaders.replace(
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable',
    '/assets/:file\n  Cache-Control: public, max-age=31536000, immutable',
  );
  const placeholderDeployment = buildDeployment(
    placeholderSource,
    join(fixtureRoot, 'deployment-placeholder'),
    'api-only',
    { headersOverride: placeholderHeaders },
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: placeholderSource,
      deploymentRoot: placeholderDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for asset assets\/chunks\/game\.1a2b3c4d\.js is missing/u,
    'placeholder-only asset block',
  );

  // 5. Conflicting duplicate adds and removal-after-add combinations are detected.
  const conflictingHeaders = `${validHeaders}/*\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  const conflictingDeployment = fixtureCopy(deploymentRoot, 'conflicting');
  writeFileSync(join(conflictingDeployment, '_headers'), conflictingHeaders);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: conflictingDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /comma-joined Cache-Control values/u,
    'conflicting duplicate headers',
  );

  const removalAfterAddHeaders = `${validHeaders}/service-worker.js\n  ! Cache-Control\n`;
  const removalDeployment = fixtureCopy(deploymentRoot, 'removal-after-add');
  writeFileSync(join(removalDeployment, '_headers'), removalAfterAddHeaders);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: removalDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /removal directive/u,
    'removal after add',
  );

  // 6. CRLF endings, comments, and whitespace-only differences behave identically.
  const crlfDeployment = fixtureCopy(deploymentRoot, 'crlf');
  writeFileSync(
    join(crlfDeployment, '_headers'),
    `# managed header policy\r\n\r\n${validHeaders.replaceAll('\n', '\r\n').replaceAll('  ', '\t')}`,
  );
  writeFileSync(
    join(crlfDeployment, '_redirects'),
    `# legal redirects\r\n${validRedirects.replaceAll('\n', '\r\n')}`,
  );
  verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot: crlfDeployment,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 7. Worker routes that disagree with the profile are rejected.
  const routeCases = [
    ['{"version":1,"include":["/*"],"exclude":[]}', 'broad-include', /reviewed api-only profile/u],
    [
      '{"version":1,"include":["/api/*","/index.html"],"exclude":[]}',
      'canonical-on-api-only',
      /reviewed api-only profile/u,
    ],
    [
      '{"version":1,"include":["/api/*"],"exclude":["/assets/*"]}',
      'non-empty-exclude',
      /reviewed api-only profile/u,
    ],
    ['{"version":2,"include":["/api/*"],"exclude":[]}', 'wrong-version', /version 1/u],
  ] as const;

  for (const [routes, label, pattern] of routeCases) {
    const mismatchedDeployment = fixtureCopy(deploymentRoot, `routes-${label}`);
    writeFileSync(join(mismatchedDeployment, '_routes.json'), routes);
    assertThrows(
      () => verifyHostedPwaDeployment({
        sourceArtifactRoot: sourceRoot,
        deploymentRoot: mismatchedDeployment,
        host: 'cloudflare-pages',
        profile: 'api-only',
      }),
      pattern,
      `route mismatch: ${label}`,
    );
  }

  // 8. Unsupported hosts, profiles, targets, and missing options are rejected.
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot,
      host: 'vercel',
      profile: 'api-only',
    } as unknown as Parameters<typeof verifyHostedPwaDeployment>[0]),
    /Unsupported hosted PWA deployment host/u,
    'unsupported host',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot,
      host: 'cloudflare-pages',
      profile: 'edge-everything',
    } as unknown as Parameters<typeof verifyHostedPwaDeployment>[0]),
    /Unsupported Cloudflare Pages host profile/u,
    'unsupported profile',
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'android',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
    ]),
    (error) => String(error).includes('not available for target: android'),
    'wrong target',
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
      '--profile',
      'bogus',
    ]),
    (error) => String(error).includes('Unsupported cloudflare-pages deployment profile'),
    'CLI unsupported profile',
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
      '--host',
      'vercel',
    ]),
    (error) => String(error).includes('Unsupported hosted PWA deployment host'),
    'CLI unsupported host',
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
    ]),
    (error) => {
      const aggregate = error as AggregateError;
      return String(aggregate.errors?.[0] ?? error).includes('deployment-root');
    },
    'missing deployment option',
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
      '--report-dir',
      join(deploymentRoot, 'reports'),
    ]),
    (error) => String(error).includes('must stay outside'),
    'report dir inside deployment',
  );

  // 9. Path escapes and symlink escapes are rejected.
  const symlinkDeployment = fixtureCopy(deploymentRoot, 'symlink');
  symlinkSync(
    join(fixtureRoot, 'outside-asset.txt'),
    join(symlinkDeployment, 'assets', 'linked.js'),
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: symlinkDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /must not contain symbolic links/u,
    'symlink escape',
  );

  const escapingSource = buildSourceArtifact(join(fixtureRoot, 'source-escape'), {
    extraIndexReferences: ['../outside-asset.png'],
  });
  const escapingDeployment = buildDeployment(
    escapingSource,
    join(fixtureRoot, 'deployment-escape'),
    'api-only',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: escapingSource,
      deploymentRoot: escapingDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /outside the artifact root/u,
    'index path escape',
  );

  // 10. The legal-only Pages layout is not forced to carry PWA files:
  // verifying one as a PWA source fails on the missing release evidence with
  // a precise diagnostic instead of touching anything.
  const legalOnlyRoot = join(fixtureRoot, 'legal-only');
  mkdirSync(join(legalOnlyRoot, 'privacy'), { recursive: true });
  writeFileSync(join(legalOnlyRoot, 'privacy', 'index.html'), '<!doctype html>');
  writeFileSync(join(legalOnlyRoot, '_worker.js'), 'export default {};\n');
  writeFileSync(join(legalOnlyRoot, '_headers'), validHeaders);
  writeFileSync(join(legalOnlyRoot, '_redirects'), validRedirects);
  writeFileSync(
    join(legalOnlyRoot, '_routes.json'),
    '{"version":1,"include":["/api/*"],"exclude":[]}',
  );
  writeFileSync(join(legalOnlyRoot, 'legal-site.json'), JSON.stringify(legalSiteManifest));
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: legalOnlyRoot,
      deploymentRoot,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /missing pwa-release\.json/u,
    'legal-only source',
  );

  // 10b. A broad wildcard redirect covering protected PWA paths is rejected.
  const broadRedirectDeployment = fixtureCopy(deploymentRoot, 'broad-redirect');
  writeFileSync(join(broadRedirectDeployment, '_redirects'), '/* /maintenance 302\n');
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: broadRedirectDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path/u,
    'broad wildcard redirect',
  );

  // 10c. A script src that survives body stripping must still resolve.
  const danglingScriptSource = buildSourceArtifact(join(fixtureRoot, 'source-dangling-script'), {
    extraScriptSrc: './missing-module.js',
  });
  const danglingScriptDeployment = buildDeployment(
    danglingScriptSource,
    join(fixtureRoot, 'deployment-dangling-script'),
    'api-only',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: danglingScriptSource,
      deploymentRoot: danglingScriptDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'dangling script src',
  );

  // 10d. A service worker that is not the evidence-matching build fails.
  const staleWorkerSource = fixtureCopy(sourceRoot, 'stale-worker');
  writeFileSync(
    join(staleWorkerSource, 'service-worker.js'),
    `${readFileSync(join(staleWorkerSource, 'service-worker.js'), 'utf8')}\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: staleWorkerSource,
      deploymentRoot: fixtureCopy(deploymentRoot, 'stale-worker-deployment'),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /service worker does not match the release evidence/u,
    'stale service worker',
  );

  // 10e. Stable-named assets require revalidation, hashed names require immutable.
  const stableAssetSource = buildSourceArtifact(join(fixtureRoot, 'source-stable-asset'));
  writeFileSync(join(stableAssetSource, 'assets', 'game.js'), 'export const stable = true;\n');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: stableAssetSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  const stableHeaders = `${validHeaders.replace(
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n',
    '',
  )}/assets/app.a1b2c3d4.js\n  Cache-Control: public, max-age=31536000, immutable\n\n/assets/game.js\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  const stableDeployment = buildDeployment(
    stableAssetSource,
    join(fixtureRoot, 'deployment-stable-asset'),
    'api-only',
    { headersOverride: stableHeaders },
  );
  verifyHostedPwaDeployment({
    sourceArtifactRoot: stableAssetSource,
    deploymentRoot: stableDeployment,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: stableAssetSource,
      deploymentRoot: buildDeployment(
        stableAssetSource,
        join(fixtureRoot, 'deployment-stable-immutable'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10f. A declared legal page that is missing from the deployment fails.
  const missingLegalDeployment = fixtureCopy(deploymentRoot, 'missing-legal-page');
  rmSync(join(missingLegalDeployment, 'privacy', 'index.html'));
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: missingLegalDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /declares a page that is not present/u,
    'missing legal page',
  );

  // 10g. Adjacent placeholders in a header pattern are rejected.
  const adjacentHeaders = validHeaders.replace(
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable',
    '/assets/:a:b\n  Cache-Control: public, max-age=31536000, immutable',
  );
  const adjacentDeployment = fixtureCopy(deploymentRoot, 'adjacent-placeholders');
  writeFileSync(join(adjacentDeployment, '_headers'), adjacentHeaders);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: adjacentDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /at most one placeholder/u,
    'adjacent placeholders',
  );

  // 10h. A symlinked report directory pointing into a verified tree is rejected.
  const internalReports = join(deploymentRoot, '.reports');
  mkdirSync(internalReports, { recursive: true });
  const externalReports = join(fixtureRoot, 'external-reports-link');
  symlinkSync(internalReports, externalReports);
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
      '--report-dir',
      externalReports,
    ]),
    (error) => String(error).includes('must stay outside'),
    'symlinked report directory',
  );

  // 10i. A wildcard redirect covering any source artifact URL is rejected.
  const assetRedirectDeployment = fixtureCopy(deploymentRoot, 'asset-redirect');
  writeFileSync(
    join(assetRedirectDeployment, '_redirects'),
    `${validRedirects}/assets/* /moved/:splat 302\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: assetRedirectDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path \/assets\//u,
    'wildcard asset redirect',
  );

  // 10j. Script attributes containing quoted angle brackets keep their src.
  const quotedAngleSource = buildSourceArtifact(join(fixtureRoot, 'source-quoted-angle'), {
    quotedAngleScript: './missing-quoted.js',
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: quotedAngleSource,
      deploymentRoot: buildDeployment(
        quotedAngleSource,
        join(fixtureRoot, 'deployment-quoted-angle'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'quoted-angle script src',
  );

  // 10k. srcset URL candidates must resolve.
  const srcsetSource = buildSourceArtifact(join(fixtureRoot, 'source-srcset'), {
    extraSrcset: './missing-1x.png 1x, ./missing-2x.png 2x',
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: srcsetSource,
      deploymentRoot: buildDeployment(
        srcsetSource,
        join(fixtureRoot, 'deployment-srcset'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'dangling srcset candidate',
  );

  // 10l. A manifest id that disagrees with the release evidence fails.
  const mismatchedManifestSource = fixtureCopy(sourceRoot, 'source-manifest-mismatch');
  const mismatchedManifestDeployment = fixtureCopy(deploymentRoot, 'deployment-manifest-mismatch');
  for (const tree of [mismatchedManifestSource, mismatchedManifestDeployment]) {
    writeFileSync(
      join(tree, 'manifest.webmanifest'),
      readFileSync(join(tree, 'manifest.webmanifest'), 'utf8').replace(
        '"./index.html"',
        '"./other-app/index.html"',
      ),
    );
  }
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: mismatchedManifestSource,
      deploymentRoot: mismatchedManifestDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /manifest application id does not match/u,
    'manifest id mismatch',
  );

  // 10n. data-srcset is not srcset: lazy-load candidates stay invisible.
  const lazySource = buildSourceArtifact(join(fixtureRoot, 'source-lazy'), {
    extraDataSrcset: './missing-lazy.png 1x',
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: lazySource,
    deploymentRoot: buildDeployment(
      lazySource,
      join(fixtureRoot, 'deployment-lazy'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10o. Uppercase attribute names are scanned case-insensitively.
  const upperSource = buildSourceArtifact(join(fixtureRoot, 'source-upper'), {
    extraUpperSrc: './missing-upper.js',
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: upperSource,
      deploymentRoot: buildDeployment(
        upperSource,
        join(fixtureRoot, 'deployment-upper'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'uppercase SRC attribute',
  );

  // 10p. HTML character references in URLs decode before resolution.
  const entitySource = buildSourceArtifact(join(fixtureRoot, 'source-entity'), {
    extraEntityRef: './icons/decoded&amp;icon.png',
  });
  mkdirSync(join(entitySource, 'icons'), { recursive: true });
  writeFileSync(join(entitySource, 'icons', 'decoded&icon.png'), 'entity-icon');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: entitySource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: entitySource,
    deploymentRoot: buildDeployment(
      entitySource,
      join(fixtureRoot, 'deployment-entity'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10q. Commas inside srcset data URLs do not create bogus local candidates.
  const dataUrlSource = buildSourceArtifact(join(fixtureRoot, 'source-data-url'), {
    extraSrcset: 'data:image/png;base64,AAAA 1x, ./icons/icon-512.png 2x',
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: dataUrlSource,
    deploymentRoot: buildDeployment(
      dataUrlSource,
      join(fixtureRoot, 'deployment-data-url'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10r. Base64-style segments take the fail-safe revalidation policy.
  const base64HashSource = buildSourceArtifact(join(fixtureRoot, 'source-b64hash'), {
    nestedAsset: 'assets/index-BhYHK6AL.js',
  });
  const base64FreshHeaders = validHeaders.replace(
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable',
    '/assets/app.a1b2c3d4.js\n  Cache-Control: public, max-age=31536000, immutable\n\n/assets/index-BhYHK6AL.js\n  Cache-Control: public, max-age=0, must-revalidate',
  );
  verifyHostedPwaDeployment({
    sourceArtifactRoot: base64HashSource,
    deploymentRoot: buildDeployment(
      base64HashSource,
      join(fixtureRoot, 'deployment-b64hash'),
      'api-only',
      { headersOverride: base64FreshHeaders },
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: base64HashSource,
      deploymentRoot: buildDeployment(
        base64HashSource,
        join(fixtureRoot, 'deployment-b64hash-immutable'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10s. A trailing-slash header path does not satisfy the exact policy.
  const trailingSlashDeployment = fixtureCopy(deploymentRoot, 'trailing-slash');
  writeFileSync(
    join(trailingSlashDeployment, '_headers'),
    validHeaders.replace('/service-worker.js\n', '/service-worker.js/\n'),
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: trailingSlashDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for service-worker\.js is missing/u,
    'trailing slash header path',
  );

  // 10t. Backslash file names are rejected as non-portable.
  const backslashDeployment = fixtureCopy(deploymentRoot, 'backslash-name');
  writeFileSync(join(backslashDeployment, 'assets\\game.js'), 'shadow');
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: backslashDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /backslash/u,
    'backslash file name',
  );

  // 10u. Unsupported placeholder shapes are rejected at parse time.
  const unrelatedPlaceholderDeployment = fixtureCopy(deploymentRoot, 'unrelated-placeholder');
  writeFileSync(
    join(unrelatedPlaceholderDeployment, '_headers'),
    `${validHeaders}/unrelated/:first:second\n  X-Test: 1\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: unrelatedPlaceholderDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /at most one placeholder/u,
    'unrelated adjacent placeholders',
  );

  // 10v. Special file entries are rejected during traversal.
  const fifoDeployment = fixtureCopy(deploymentRoot, 'fifo-entry');
  const fifoPath = join(fifoDeployment, 'assets', 'channel.pipe');
  if (!existsSync(fifoPath)) {
    spawnSync('mkfifo', [fifoPath]);
  }
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: fifoDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /neither a directory nor a regular file/u,
    'fifo entry',
  );

  // 10w. Source files under a worker route are rejected as shadowed.
  const shadowedSource = buildSourceArtifact(join(fixtureRoot, 'source-shadowed'));
  mkdirSync(join(shadowedSource, 'api', 'mpgd'), { recursive: true });
  writeFileSync(join(shadowedSource, 'api', 'mpgd', 'bridge'), '{}');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: shadowedSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: shadowedSource,
      deploymentRoot: buildDeployment(
        shadowedSource,
        join(fixtureRoot, 'deployment-shadowed'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /intercepts/u,
    'worker route shadowing',
  );

  // 10x. A symlinked report destination file is rejected before writing.
  const linkedReportDir = join(fixtureRoot, 'linked-report');
  mkdirSync(linkedReportDir, { recursive: true });
  symlinkSync(
    join(deploymentRoot, 'pwa-release.json'),
    join(linkedReportDir, 'hosted-pwa-verification.json'),
  );
  await assertRejects(
    () => runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
      '--report-dir',
      linkedReportDir,
    ]),
    (error) => String(error).includes('symbolic link'),
    'symlinked report file',
  );

  // 10y. Stable eight-character basenames stay revalidating.
  const controlsSource = buildSourceArtifact(join(fixtureRoot, 'source-controls'));
  writeFileSync(join(controlsSource, 'assets', 'controls.png'), 'stable-eight');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: controlsSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  const controlsHeaders = `${validHeaders.replace(
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n',
    '',
  )}/assets/app.a1b2c3d4.js\n  Cache-Control: public, max-age=31536000, immutable\n\n/assets/controls.png\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  const controlsDeployment = buildDeployment(
    controlsSource,
    join(fixtureRoot, 'deployment-controls'),
    'api-only',
    { headersOverride: controlsHeaders },
  );
  verifyHostedPwaDeployment({
    sourceArtifactRoot: controlsSource,
    deploymentRoot: controlsDeployment,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: controlsSource,
      deploymentRoot: buildDeployment(
        controlsSource,
        join(fixtureRoot, 'deployment-controls-immutable'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10z. srcset values are scanned only as candidate lists.
  const srcsetOnlySource = buildSourceArtifact(join(fixtureRoot, 'source-srcset-only'), {
    extraSrcset: './icons/icon-512.png 1x, ./icons/icon-512.png 2x',
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: srcsetOnlySource,
    deploymentRoot: buildDeployment(
      srcsetOnlySource,
      join(fixtureRoot, 'deployment-srcset-only'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10aa. Base elements are rejected as unsupported.
  const baseSource = buildSourceArtifact(join(fixtureRoot, 'source-base'), {
    withBaseTag: true,
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: baseSource,
      deploymentRoot: buildDeployment(
        baseSource,
        join(fixtureRoot, 'deployment-base'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /base element/u,
    'base element unsupported',
  );

  // 10ab. Percent-encoded references decode to real files.
  const encodedSource = buildSourceArtifact(join(fixtureRoot, 'source-encoded'));
  mkdirSync(join(encodedSource, 'icons'), { recursive: true });
  writeFileSync(join(encodedSource, 'icons', 'my icon.png'), 'spacey');
  writeFileSync(
    join(encodedSource, 'index.html'),
    readFileSync(join(encodedSource, 'index.html'), 'utf8').replace(
      '<img src="./icons/icon-512.png">',
      '<img src="./icons/my%20icon.png">',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: encodedSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: encodedSource,
    deploymentRoot: buildDeployment(
      encodedSource,
      join(fixtureRoot, 'deployment-encoded'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10ac. Pages control files inside the source artifact are rejected.
  const controlSource = fixtureCopy(sourceRoot, 'source-control-file');
  writeFileSync(join(controlSource, '_redirects'), '/x /y 301\n');
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: controlSource,
      deploymentRoot: fixtureCopy(deploymentRoot, 'deployment-control-file'),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /Pages control file _redirects/u,
    'control file in source',
  );

  // 10ad. Legal URLs are protected from redirects and require fresh policy.
  const legalRedirectDeployment = fixtureCopy(deploymentRoot, 'legal-redirect');
  writeFileSync(
    join(legalRedirectDeployment, '_redirects'),
    `${validRedirects}/privacy/* /moved/:splat 302\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: legalRedirectDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path \/privacy\//u,
    'legal page redirect',
  );

  // 10ae. Poster attributes are local references.
  const posterSource = buildSourceArtifact(join(fixtureRoot, 'source-poster'), {
    withPosterRef: true,
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: posterSource,
      deploymentRoot: buildDeployment(
        posterSource,
        join(fixtureRoot, 'deployment-poster'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'poster attribute',
  );

  // 10af. Ordinary hyphenated words stay stable despite eight characters.
  const wordySource = buildSourceArtifact(join(fixtureRoot, 'source-wordy'));
  mkdirSync(join(wordySource, 'assets'), { recursive: true });
  writeFileSync(join(wordySource, 'assets', 'game-controls.png'), 'words');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: wordySource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: wordySource,
      deploymentRoot: buildDeployment(
        wordySource,
        join(fixtureRoot, 'deployment-wordy'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10ag. The full named-entity set decodes (&sol; becomes a slash).
  const solSource = buildSourceArtifact(join(fixtureRoot, 'source-sol'));
  writeFileSync(
    join(solSource, 'index.html'),
    readFileSync(join(solSource, 'index.html'), 'utf8').replace(
      '<img src="./icons/icon-512.png">',
      '<img src="./icons/foo&sol;bar.png">',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: solSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: solSource,
      deploymentRoot: buildDeployment(
        solSource,
        join(fixtureRoot, 'deployment-sol'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'named entity decodes to a path separator',
  );

  // 10ah. srcset separators without following whitespace still split.
  const tightSrcsetSource = buildSourceArtifact(join(fixtureRoot, 'source-tight'), {
    extraSrcset: './icons/icon-512.png 1x,./icons/icon-512.png 2x',
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: tightSrcsetSource,
    deploymentRoot: buildDeployment(
      tightSrcsetSource,
      join(fixtureRoot, 'deployment-tight'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10ai. The legal manifest URL is redirect-protected.
  const legalManifestRedirect = fixtureCopy(deploymentRoot, 'legal-manifest-redirect');
  writeFileSync(
    join(legalManifestRedirect, '_redirects'),
    `${validRedirects}/legal-site.json /stale.json 302\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: legalManifestRedirect,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path \/legal-site\.json/u,
    'legal manifest redirect',
  );

  // 10aj. Mixed-case digit words without an uppercase signal stay stable.
  const playerSource = buildSourceArtifact(join(fixtureRoot, 'source-player'));
  mkdirSync(join(playerSource, 'assets'), { recursive: true });
  writeFileSync(join(playerSource, 'assets', 'game-player2d.png'), 'player');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: playerSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: playerSource,
      deploymentRoot: buildDeployment(
        playerSource,
        join(fixtureRoot, 'deployment-player'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10ak. Legal pages under a worker route are rejected.
  const apiLegalDeployment = fixtureCopy(deploymentRoot, 'api-legal');
  mkdirSync(join(apiLegalDeployment, 'api', 'game-services'), { recursive: true });
  writeFileSync(join(apiLegalDeployment, 'api', 'game-services', 'index.html'), '<!doctype html>');
  writeFileSync(
    join(apiLegalDeployment, 'legal-site.json'),
    JSON.stringify({
      version: 1,
      pages: [
        { slug: 'privacy', path: '/privacy/', source: 'legal/privacy.html' },
        { slug: 'api', path: '/api/game-services/', source: 'legal/api.html' },
      ],
    }),
  );
  writeFileSync(
    join(apiLegalDeployment, '_headers'),
    `${validHeaders}/api/game-services/*\n  Cache-Control: public, max-age=0, must-revalidate\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: apiLegalDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /legal page api\/game-services\/index\.html is served at \/api\/game-services\//u,
    'legal page under worker route',
  );

  // 10al. References to Pages control files are rejected.
  const workerRefSource = buildSourceArtifact(join(fixtureRoot, 'source-worker-ref'), {
    withWorkerRef: true,
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: workerRefSource,
      deploymentRoot: buildDeployment(
        workerRefSource,
        join(fixtureRoot, 'deployment-worker-ref'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /Pages control file _worker\.js/u,
    'control file reference',
  );

  // 10am. Object data URLs are browser-loaded references.
  const objectDataSource = buildSourceArtifact(join(fixtureRoot, 'source-object'), {
    withObjectData: './missing-widget.html',
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: objectDataSource,
      deploymentRoot: buildDeployment(
        objectDataSource,
        join(fixtureRoot, 'deployment-object'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'object data URL',
  );

  // 10an. Prose text mentioning href is not a reference.
  const textHrefSource = buildSourceArtifact(join(fixtureRoot, 'source-text-href'), {
    withTextHref: true,
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: textHrefSource,
    deploymentRoot: buildDeployment(
      textHrefSource,
      join(fixtureRoot, 'deployment-text-href'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10ao. Redirect sources with adjacent placeholders fail at parse time.
  const adjacentRedirectDeployment = fixtureCopy(deploymentRoot, 'adjacent-redirect');
  writeFileSync(
    join(adjacentRedirectDeployment, '_redirects'),
    `${validRedirects}/unrelated/:first:second /target 302\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: adjacentRedirectDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /at most one placeholder/u,
    'adjacent redirect placeholders',
  );

  // 10ap. Directory-form references are redirect-protected.
  const docsSource = buildSourceArtifact(join(fixtureRoot, 'source-docs'), {
    withDirectoryRef: '/docs/',
  });
  mkdirSync(join(docsSource, 'docs'), { recursive: true });
  writeFileSync(join(docsSource, 'docs', 'index.html'), '<!doctype html><p>docs</p>');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: docsSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  const docsDeployment = buildDeployment(
    docsSource,
    join(fixtureRoot, 'deployment-docs'),
    'api-only',
  );
  verifyHostedPwaDeployment({
    sourceArtifactRoot: docsSource,
    deploymentRoot: docsDeployment,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });
  const docsRedirectDeployment = fixtureCopy(docsDeployment, 'docs-redirect');
  writeFileSync(
    join(docsRedirectDeployment, '_redirects'),
    `${validRedirects}/docs/ /missing 302\n`,
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: docsSource,
      deploymentRoot: docsRedirectDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path \/docs\//u,
    'directory reference redirect',
  );

  // 10aq. Non-canonical legal manifest paths are rejected.
  const queryManifestDeployment = fixtureCopy(deploymentRoot, 'query-manifest');
  writeFileSync(
    join(queryManifestDeployment, 'legal-site.json'),
    JSON.stringify({
      version: 1,
      pages: [{ slug: 'privacy', path: '/privacy?version=1/', source: 'x' }],
    }),
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: queryManifestDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /canonical slash-delimited/u,
    'non-canonical legal path',
  );

  // 10ar. Splats inside path segments match like the Pages router.
  const segmentSplatHeaders = validHeaders.replace(
    '/icons/*\n  Cache-Control: no-store, must-revalidate',
    '/icons/*.png\n  Cache-Control: no-store, must-revalidate',
  );
  const segmentSplatDeployment = fixtureCopy(deploymentRoot, 'segment-splat');
  writeFileSync(join(segmentSplatDeployment, '_headers'), segmentSplatHeaders);
  verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot: segmentSplatDeployment,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10as. Mixed-case digit stems with lowercase stay stable.
  const playerCaseSource = buildSourceArtifact(join(fixtureRoot, 'source-player-case'));
  mkdirSync(join(playerCaseSource, 'assets'), { recursive: true });
  writeFileSync(join(playerCaseSource, 'assets', 'game-Player2D.png'), 'mixedcase');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: playerCaseSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
      sourceArtifactRoot: playerCaseSource,
      deploymentRoot: buildDeployment(
        playerCaseSource,
        join(fixtureRoot, 'deployment-player-case'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
  });

  // 10at. A standalone splat does not cover the slashless exact path.
  const zeroSplatHeaders = validHeaders.replace(
    '/service-worker.js\n  Cache-Control: no-store, must-revalidate',
    '/service-worker.js/*\n  Cache-Control: no-store, must-revalidate',
  );
  const zeroSplatDeployment = fixtureCopy(deploymentRoot, 'zero-splat');
  writeFileSync(join(zeroSplatDeployment, '_headers'), zeroSplatHeaders);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: zeroSplatDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for service-worker\.js is missing/u,
    'zero-length splat does not match the exact path',
  );

  // 10au. Relative and queried directory references are redirect-protected.
  const relativeDocsSource = buildSourceArtifact(join(fixtureRoot, 'source-relative-docs'), {
    withDirectoryRef: './docs/',
  });
  mkdirSync(join(relativeDocsSource, 'docs'), { recursive: true });
  writeFileSync(join(relativeDocsSource, 'docs', 'index.html'), '<!doctype html>');
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: relativeDocsSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  const relativeDocsDeployment = buildDeployment(
    relativeDocsSource,
    join(fixtureRoot, 'deployment-relative-docs'),
    'api-only',
  );
  const relativeDocsRedirect = fixtureCopy(relativeDocsDeployment, 'relative-docs-redirect');
  writeFileSync(join(relativeDocsRedirect, '_redirects'), `${validRedirects}/docs/ /missing 302\n`);
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: relativeDocsSource,
      deploymentRoot: relativeDocsRedirect,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /covers the protected PWA path \/docs\//u,
    'relative directory reference redirect',
  );

  // 10av. Entity-encoded schemes decode before external classification.
  const entitySchemeSource = buildSourceArtifact(join(fixtureRoot, 'source-entity-scheme'));
  writeFileSync(
    join(entitySchemeSource, 'index.html'),
    readFileSync(join(entitySchemeSource, 'index.html'), 'utf8').replace(
      '<script type="module" src="./assets/app.a1b2c3d4.js"></script>',
      '<script type="module" src="&#104;ttps://cdn.example/app.js"></script>',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: entitySchemeSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: entitySchemeSource,
    deploymentRoot: buildDeployment(
      entitySchemeSource,
      join(fixtureRoot, 'deployment-entity-scheme'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10aw. legal-site.json links remain valid browser references.
  const legalLinkSource = buildSourceArtifact(join(fixtureRoot, 'source-legal-link'));
  writeFileSync(
    join(legalLinkSource, 'index.html'),
    readFileSync(join(legalLinkSource, 'index.html'), 'utf8').replace(
      '</body>',
      '<a href="./legal-site.json">manifest</a></body>',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: legalLinkSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: legalLinkSource,
    deploymentRoot: buildDeployment(
      legalLinkSource,
      join(fixtureRoot, 'deployment-legal-link'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10ax. End tags with whitespace strip their bodies.
  const looseEndTagSource = buildSourceArtifact(join(fixtureRoot, 'source-loose-end'));
  writeFileSync(
    join(looseEndTagSource, 'index.html'),
    readFileSync(join(looseEndTagSource, 'index.html'), 'utf8').replace(
      '<script>const ignored',
      '<script>const template = \'<img src="./missing.png">\'; const ignored',
    ).replace(
      ';</script>',
      ';</script >',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: looseEndTagSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  verifyHostedPwaDeployment({
    sourceArtifactRoot: looseEndTagSource,
    deploymentRoot: buildDeployment(
      looseEndTagSource,
      join(fixtureRoot, 'deployment-loose-end'),
      'api-only',
    ),
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  // 10ay. Tokenized style-attribute URLs join the validated references.
  const styleAttrSource = buildSourceArtifact(join(fixtureRoot, 'source-style-attr'));
  writeFileSync(
    join(styleAttrSource, 'index.html'),
    readFileSync(join(styleAttrSource, 'index.html'), 'utf8').replace(
      '</body>',
      `<div style='background:url("./missing-style.png")'></div></body>`,
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: styleAttrSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: styleAttrSource,
      deploymentRoot: buildDeployment(
        styleAttrSource,
        join(fixtureRoot, 'deployment-style-attr'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'style-attribute URL validated',
  );

  // 10az. srcdoc srcset candidates are scanned by the full tokenizer.
  const srcsetDocSource = buildSourceArtifact(join(fixtureRoot, 'source-srcset-doc'));
  writeFileSync(
    join(srcsetDocSource, 'index.html'),
    readFileSync(join(srcsetDocSource, 'index.html'), 'utf8').replace(
      '</body>',
      `<iframe srcdoc="<img srcset='./missing-doc.png 1x'>"></iframe></body>`,
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: srcsetDocSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: srcsetDocSource,
      deploymentRoot: buildDeployment(
        srcsetDocSource,
        join(fixtureRoot, 'deployment-srcset-doc'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'srcdoc srcset candidate',
  );

  // 10ba. Entity-encoded meta-refresh separators decode before parsing.
  const entityRefreshSource = buildSourceArtifact(join(fixtureRoot, 'source-entity-refresh'));
  writeFileSync(
    join(entityRefreshSource, 'index.html'),
    readFileSync(join(entityRefreshSource, 'index.html'), 'utf8').replace(
      '</head>',
      '<meta http-equiv="refresh" content="0&#59; url=./missing-entity.html"></head>',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: entityRefreshSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: entityRefreshSource,
      deploymentRoot: buildDeployment(
        entityRefreshSource,
        join(fixtureRoot, 'deployment-entity-refresh'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'entity-encoded meta refresh',
  );

  // 10bb. Declared legal pages carry validated local references.
  const brokenLegalDeployment = fixtureCopy(deploymentRoot, 'broken-legal-ref');
  writeFileSync(
    join(brokenLegalDeployment, 'privacy', 'index.html'),
    '<!doctype html><img src="/missing-legal.png">',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: brokenLegalDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /legal page privacy\/index\.html references a missing file/u,
    'legal page broken reference',
  );

  // 10bc. Nested srcdoc documents recurse through the full tokenizer.
  const nestedDocSource = buildSourceArtifact(join(fixtureRoot, 'source-nested-doc'));
  writeFileSync(
    join(nestedDocSource, 'index.html'),
    readFileSync(join(nestedDocSource, 'index.html'), 'utf8').replace(
      '</body>',
      '<iframe srcdoc="<iframe srcdoc=\"<img src=./missing-nested.png>\"></iframe>"></iframe></body>',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: nestedDocSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: nestedDocSource,
      deploymentRoot: buildDeployment(
        nestedDocSource,
        join(fixtureRoot, 'deployment-nested-doc'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'nested srcdoc reference',
  );

  // 10bd. Legal-page srcset candidates are validated.
  const legalSrcsetDeployment = fixtureCopy(deploymentRoot, 'legal-srcset');
  writeFileSync(
    join(legalSrcsetDeployment, 'privacy', 'index.html'),
    '<!doctype html><img srcset="./missing-legal-srcset.png 1x">',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: legalSrcsetDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /legal page privacy\/index\.html references a missing file/u,
    'legal page srcset candidate',
  );

  // 10be. Entity-encoded srcdoc markup decodes before scanning.
  const entityDocSource = buildSourceArtifact(join(fixtureRoot, 'source-entity-doc'));
  writeFileSync(
    join(entityDocSource, 'index.html'),
    readFileSync(join(entityDocSource, 'index.html'), 'utf8').replace(
      '</body>',
      '<iframe srcdoc="&lt;img src=./missing-entity-doc.png&gt;"></iframe></body>',
    ),
  );
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: entityDocSource,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: entityDocSource,
      deploymentRoot: buildDeployment(
        entityDocSource,
        join(fixtureRoot, 'deployment-entity-doc'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
    'entity-encoded srcdoc markup',
  );

  // 10bf. Legal-page style attributes are validated.
  const legalStyleDeployment = fixtureCopy(deploymentRoot, 'legal-style');
  writeFileSync(
    join(legalStyleDeployment, 'privacy', 'index.html'),
    '<!doctype html><div style="background:url(./missing-legal-style.png)"></div>',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: legalStyleDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /legal page privacy\/index\.html references a missing file/u,
    'legal page style reference',
  );

  // 10bg. Legal pages cannot reference Pages control artifacts.
  const legalControlDeployment = fixtureCopy(deploymentRoot, 'legal-control');
  writeFileSync(
    join(legalControlDeployment, 'privacy', 'index.html'),
    '<!doctype html><img src="/_headers">',
  );
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: legalControlDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /legal page privacy\/index\.html references the Pages control file/u,
    'legal page control artifact reference',
  );

  // 11. A local static server serves the verified deployment paths and bytes.
  await verifyServedDeployment(deploymentRoot);

  // 12. Verification never modifies the source artifact or the deployment.
  const before = snapshotTree(sourceRoot, deploymentRoot);
  verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });
  assertJsonEqual([...snapshotTree(sourceRoot, deploymentRoot)], [...before], 'read-only snapshot');

  // 10m. Hostile metadata cannot inject Markdown into the evidence report.
  const hostileSource = buildSourceArtifact(join(fixtureRoot, 'source-hostile'));
  writeMicrosoftStorePwaArtifacts({
    artifactRoot: hostileSource,
    provenance: {
      appVersion: '1.0.0',
      buildId: 'build`\n# injected heading',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });
  const hostileDeployment = buildDeployment(
    hostileSource,
    join(fixtureRoot, 'deployment-hostile'),
    'api-only',
  );
  const hostileReportDir = join(fixtureRoot, 'hostile-report');
  await runMpgdCli([
    'target',
    'verify-deployment',
    'microsoft-store',
    '--source-artifact-root',
    hostileSource,
    '--deployment-root',
    hostileDeployment,
    '--report-dir',
    hostileReportDir,
  ]);
  const hostileMarkdown = readFileSync(
    join(hostileReportDir, 'hosted-pwa-verification.md'),
    'utf8',
  );
  assertTrue(
    !hostileMarkdown.split('\n').some((line) => line.startsWith('# injected')),
    'markdown injection cannot forge a heading line',
  );
  assertTrue(
    hostileMarkdown.split('\n').some(
      (line) => line.includes('build') && line.includes('injected heading'),
    ),
    'escaped build id stays readable',
  );

  // CLI happy path writes structured evidence files outside the verified trees.
  const beforeCli = snapshotTree(sourceRoot, canonicalDeployment);
  const reportDir = join(fixtureRoot, 'report');
  await runMpgdCli([
    'target',
    'verify-deployment',
    'microsoft-store',
    '--source-artifact-root',
    sourceRoot,
    '--deployment-root',
    canonicalDeployment,
    '--profile',
    'api-canonical-index',
    '--report-dir',
    reportDir,
  ]);
  const report = JSON.parse(
    readFileSync(
      join(reportDir, 'hosted-pwa-verification.json'),
      'utf8',
    ),
  ) as { readonly verifiedGameFileCount: number };
  assertTrue(report.verifiedGameFileCount >= 6, 'report game file count');
  assertTrue(
    readFileSync(join(reportDir, 'hosted-pwa-verification.md'), 'utf8')
      .includes('Hosted PWA Deployment Verification'),
    'report markdown title',
  );
  assertJsonEqual(
    [...snapshotTree(sourceRoot, canonicalDeployment)],
    [...beforeCli],
    'CLI read-only snapshot',
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

interface BuildSourceOptions {
  readonly extraIndexReferences?: readonly string[];
  readonly nestedAsset?: string;
  readonly extraScriptSrc?: string;
  readonly quotedAngleScript?: string;
  readonly extraSrcset?: string;
  readonly manifestIdOverride?: string;
  readonly extraUpperSrc?: string;
  readonly withBaseTag?: boolean;
  readonly withPosterRef?: boolean;
  readonly withObjectData?: string;
  readonly withTextHref?: boolean;
  readonly withWorkerRef?: boolean;
  readonly withDirectoryRef?: string;
  readonly extraDataSrcset?: string;
  readonly extraEntityRef?: string;
}

function buildSourceArtifact(root: string, options: BuildSourceOptions = {}): string {
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'icons'), { recursive: true });
  const extraReferences = (options.extraIndexReferences ?? [])
    .map((reference) => `<img src="${reference}">`)
    .join('');

  if (options.nestedAsset !== undefined) {
    mkdirSync(join(root, dirnameOf(options.nestedAsset)), { recursive: true });
    writeFileSync(join(root, options.nestedAsset), 'export const nested = true;\n');
  }

  const extraScript = options.extraScriptSrc === undefined
    ? ''
    : `<script type="module" src="${options.extraScriptSrc}"></script>`;

  const quotedScript = options.quotedAngleScript === undefined
    ? ''
    : `<script data-note=">" src="${options.quotedAngleScript}"></script>`;
  const extraUpperSrc = options.extraUpperSrc === undefined
    ? ''
    : `<script SRC="${options.extraUpperSrc}"></script>`;
  const extraDataSrcset = options.extraDataSrcset === undefined
    ? ''
    : `<img data-srcset="${options.extraDataSrcset}">`;
  const extraEntityRef = options.extraEntityRef === undefined
    ? ''
    : `<img src="${options.extraEntityRef}">`;

  const extraSrcset = options.extraSrcset === undefined
    ? ''
    : `<img srcset="${options.extraSrcset}">`;

  const objectData = options.withObjectData === undefined
    ? ''
    : `<object data="${options.withObjectData}"></object>`;
  const textHref = options.withTextHref === true
    ? '<p>Set href="./missing.js" '
      + "and <div title='See href=&quot;./missing.png&quot;'>note</div> "
      + 'and url(./missing-css.png) in prose</p>'
    : '';
  const workerRef = options.withWorkerRef === true
    ? '<script type="module" src="./_worker.js"></script>'
    : '';
  const directoryRef = options.withDirectoryRef === undefined
    ? ''
    : `<a href="${options.withDirectoryRef}">docs</a>`;

  const baseTag = options.withBaseTag === true ? '<base href="/sub/">' : '';

  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head>'
      + baseTag
      + '<link rel="manifest" href="./manifest.webmanifest">'
      + '</head><body>'
      + '<a href="/">home</a><a href="/privacy/">privacy</a>'
      + '<script>const css decoy = "url(./missing-script-css.png)"; const ignored = \'src="not-a-real-attribute.png"\';</script>'
      + '<!-- <img src="commented-out.png"> -->'
      + (options.withPosterRef === true
        ? '<video poster="./missing-poster.png"></video>'
        : '')
      + '<script type="module" src="./assets/app.a1b2c3d4.js"></script>'
      + extraScript
      + extraUpperSrc
      + extraDataSrcset
      + extraEntityRef
      + objectData
      + textHref
      + workerRef
      + directoryRef
      + quotedScript
      + extraSrcset
      + '<img src="./icons/icon-512.png">'
      + extraReferences
      + '</body></html>\n',
  );
  writeFileSync(
    join(root, 'manifest.webmanifest'),
    JSON.stringify(
      {
        id: options.manifestIdOverride ?? './index.html',
        name: 'Fixture Game',
        start_url: './index.html',
        icons: [
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, 'icons', 'icon-512.png'), 'fixture-png-bytes');
  writeFileSync(join(root, 'assets', 'app.a1b2c3d4.js'), 'export const game = "fixture";\n');
  writeFileSync(join(root, 'mpgd-effective-target.json'), '{"target":"microsoft-store"}\n');

  writeMicrosoftStorePwaArtifacts({
    artifactRoot: root,
    provenance: {
      appVersion: '1.2.3',
      buildId: 'build-42',
      sourceGitSha: 'a'.repeat(40),
      kitGitSha: 'b'.repeat(40),
    },
  });

  return root;
}

interface BuildDeploymentOptions {
  readonly headersOverride?: string;
}

function buildDeployment(
  sourceRoot: string,
  root: string,
  profile: 'api-only' | 'api-canonical-index',
  options: BuildDeploymentOptions = {},
): string {
  cpSync(sourceRoot, root, { recursive: true });
  mkdirSync(join(root, 'privacy'), { recursive: true });
  writeFileSync(join(root, 'privacy', 'index.html'), '<!doctype html><p>privacy</p>');
  writeFileSync(join(root, '_worker.js'), 'export default { fetch() {} };\n');
  writeFileSync(join(root, '_headers'), options.headersOverride ?? validHeaders);
  writeFileSync(join(root, '_redirects'), validRedirects);
  writeFileSync(join(root, 'legal-site.json'), JSON.stringify(legalSiteManifest, null, 2));
  writeFileSync(
    join(root, '_routes.json'),
    JSON.stringify(
      {
        version: 1,
        include: profile === 'api-canonical-index'
          ? ['/api/*', '/index.html']
          : ['/api/*'],
        exclude: [],
      },
      null,
      2,
    ),
  );

  return root;
}

function dirnameOf(portablePath: string): string {
  const separator = portablePath.lastIndexOf('/');

  return separator === -1 ? '.' : portablePath.slice(0, separator);
}

function fixtureCopy(source: string, name: string): string {
  const destination = join(fixtureRoot, name);
  cpSync(source, destination, { recursive: true });
  return destination;
}

function findFile(root: string, prefix: string): string {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        const relativePath = absolute.slice(root.length + 1);
        if (relativePath.startsWith(prefix)) {
          files.push(relativePath);
        }
      }
    }
  };

  walk(root);
  const found = files[0];

  if (found === undefined) {
    throw new Error(`No file under ${prefix} in ${root}`);
  }

  return found;
}

interface FileSnapshot {
  readonly sha256: string;
  readonly mtimeMs: number;
}

function snapshotTree(...roots: readonly string[]): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>();

  for (const root of roots) {
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
        } else {
          const bytes = readFileSync(absolute);
          snapshot.set(absolute, {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            mtimeMs: statSync(absolute).mtimeMs,
          });
        }
      }
    };

    walk(root);
  }

  return snapshot;
}

async function verifyServedDeployment(deploymentRoot: string): Promise<void> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relativePath = url.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(url.pathname.slice(1));
    const resolved = safeJoin(deploymentRoot, relativePath);
    const file = resolved !== undefined
      && existsSync(resolved)
      && statSync(resolved).isDirectory()
      ? join(resolved, 'index.html')
      : resolved;

    if (file === undefined || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    response.statusCode = 200;
    response.end(readFileSync(file));
  });

  try {
    await listen(server);
    const port = addressPort(server);
    const hashedAsset = findFile(deploymentRoot, 'assets/');

    for (const [path, file] of [
      ['/', 'index.html'],
      ['/index.html', 'index.html'],
      ['/manifest.webmanifest', 'manifest.webmanifest'],
      ['/service-worker.js', 'service-worker.js'],
      ['/pwa-release.json', 'pwa-release.json'],
      [`/${hashedAsset}`, hashedAsset],
      ['/icons/icon-512.png', 'icons/icon-512.png'],
      ['/privacy/', 'privacy/index.html'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
      assertEqual(response.status, 200, `served status for ${path}`);
      const body = Buffer.from(await response.arrayBuffer());
      assertTrue(
        body.equals(readFileSync(join(deploymentRoot, file))),
        `${path} serves the verified bytes`,
      );
    }

    const missing = await fetch(`http://127.0.0.1:${String(port)}/assets/missing.js`);
    assertEqual(missing.status, 404, 'missing asset status');
  } finally {
    await close(server);
  }
}

function safeJoin(root: string, relativePath: string): string | undefined {
  const resolved = resolve(root, relativePath);
  const distance = toRelative(root, resolved);

  return distance.startsWith('..') || distance.length === 0 ? undefined : resolved;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise();
    });
  });
}

function addressPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The verification server lost its port.');
  }

  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
  });
}
