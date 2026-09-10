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
    /cache policy for content-hashed assets\/chunks\/game\.1a2b3c4d\.js is missing/u,
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
  assertThrows(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: stableAssetSource,
      deploymentRoot: buildDeployment(
        stableAssetSource,
        join(fixtureRoot, 'deployment-stable-immutable'),
        'api-only',
      ),
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for stable-name assets\/game\.js is wrong/u,
    'immutable cache on a stable asset name',
  );

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
    /placeholders must be separated/u,
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

  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head>'
      + '<link rel="manifest" href="./manifest.webmanifest">'
      + '</head><body>'
      + '<a href="/">home</a><a href="/privacy/">privacy</a>'
      + '<script>const ignored = \'src="not-a-real-attribute.png"\';</script>'
      + '<!-- <img src="commented-out.png"> -->'
      + '<script type="module" src="./assets/app.a1b2c3d4.js"></script>'
      + extraScript
      + '<img src="./icons/icon-512.png">'
      + extraReferences
      + '</body></html>\n',
  );
  writeFileSync(
    join(root, 'manifest.webmanifest'),
    JSON.stringify(
      {
        id: './index.html',
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
