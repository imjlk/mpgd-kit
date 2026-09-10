import assert from 'node:assert/strict';
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
  '  Cache-Control: public, max-age=0, must-revalidate',
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
  const deploymentRoot = buildDeployment(sourceRoot, join(fixtureRoot, 'deployment'), {
    profile: 'api-only',
  });

  // 1. A faithful source and deployment pair passes for both reviewed profiles.
  const verified = verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot,
    host: 'cloudflare-pages',
    profile: 'api-only',
  });

  assert.equal(verified.host, 'cloudflare-pages');
  assert.equal(verified.appVersion, '1.2.3');
  assert.equal(verified.buildId, 'build-42');
  assert.equal(verified.workerRoutes.include.join('|'), '/api/*');
  assert.ok(verified.verifiedGameFileCount >= 6, 'game files counted');
  assert.ok(verified.hostFileCount >= 6, 'host files counted');

  const canonicalDeployment = buildDeployment(
    sourceRoot,
    join(fixtureRoot, 'deployment-canonical'),
    { profile: 'api-canonical-index' },
  );
  const canonicalVerified = verifyHostedPwaDeployment({
    sourceArtifactRoot: sourceRoot,
    deploymentRoot: canonicalDeployment,
    host: 'cloudflare-pages',
    profile: 'api-canonical-index',
  });
  assert.equal(canonicalVerified.workerRoutes.include.join('|'), '/api/*|/index.html');

  // 2. Matching release metadata with different JavaScript fails on the digest.
  const tamperedDeployment = fixtureCopy(deploymentRoot, 'tampered-js');
  const hashedAsset = findFile(tamperedDeployment, 'assets/');
  writeFileSync(
    join(tamperedDeployment, hashedAsset),
    `${readFileSync(join(tamperedDeployment, hashedAsset), 'utf8')}\n// different build`,
  );
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: tamperedDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /does not match the source artifact/u,
  );

  // 3. Missing service worker, manifest, icon, and referenced assets fail.
  for (const missing of ['service-worker.js', 'manifest.webmanifest', 'icons/icon-512.png']) {
    const incompleteDeployment = fixtureCopy(deploymentRoot, `missing-${missing}`);
    rmSync(join(incompleteDeployment, missing));
    assert.throws(
      () => verifyHostedPwaDeployment({
        sourceArtifactRoot: sourceRoot,
        deploymentRoot: incompleteDeployment,
        host: 'cloudflare-pages',
        profile: 'api-only',
      }),
      /missing game file/u,
      missing,
    );
  }

  const danglingReferenceSource = buildSourceArtifact(
    join(fixtureRoot, 'source-dangling-reference'),
    { extraIndexReferences: ['./missing-asset.png'] },
  );
  const danglingReferenceDeployment = buildDeployment(
    danglingReferenceSource,
    join(fixtureRoot, 'deployment-dangling-reference'),
    { profile: 'api-only' },
  );
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: danglingReferenceSource,
      deploymentRoot: danglingReferenceDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /references a missing file/u,
  );

  // 4. A required cache directive on an unrelated path block does not satisfy the policy.
  const wrongBlockHeaders = validHeaders.replace(
    '/service-worker.js\n  Cache-Control: no-store, must-revalidate',
    '/unrelated/*\n  Cache-Control: no-store, must-revalidate',
  );
  const wrongBlockDeployment = fixtureCopy(deploymentRoot, 'wrong-block');
  writeFileSync(join(wrongBlockDeployment, '_headers'), wrongBlockHeaders);
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: wrongBlockDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /cache policy for service-worker\.js is missing/u,
  );

  // 5. Conflicting duplicate adds and removal-after-add combinations are detected.
  const conflictingHeaders = `${validHeaders}/*\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  const conflictingDeployment = fixtureCopy(deploymentRoot, 'conflicting');
  writeFileSync(join(conflictingDeployment, '_headers'), conflictingHeaders);
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: conflictingDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /comma-joined Cache-Control values/u,
  );

  const removalAfterAddHeaders = `${validHeaders}/service-worker.js\n  ! Cache-Control\n`;
  const removalDeployment = fixtureCopy(deploymentRoot, 'removal-after-add');
  writeFileSync(join(removalDeployment, '_headers'), removalAfterAddHeaders);
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: removalDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /removal directive/u,
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
  for (const [routes, label] of [
    ['{"version":1,"include":["/*"],"exclude":[]}', 'broad include'],
    [
      '{"version":1,"include":["/api/*","/index.html"],"exclude":[]}',
      'canonical include on api-only',
    ],
    ['{"version":1,"include":["/api/*"],"exclude":["/assets/*"]}', 'non-empty exclude'],
    ['{"version":2,"include":["/api/*"],"exclude":[]}', 'wrong version'],
  ] as const) {
    const mismatchedDeployment = fixtureCopy(deploymentRoot, `routes-${label}`);
    writeFileSync(join(mismatchedDeployment, '_routes.json'), routes);
    assert.throws(
      () => verifyHostedPwaDeployment({
        sourceArtifactRoot: sourceRoot,
        deploymentRoot: mismatchedDeployment,
        host: 'cloudflare-pages',
        profile: 'api-only',
      }),
      /does not match the reviewed api-only profile/u,
      label,
    );
  }

  // 8. Unsupported hosts, profiles, targets, and missing options are rejected.
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot,
      host: 'vercel',
      profile: 'api-only',
    } as unknown as Parameters<typeof verifyHostedPwaDeployment>[0]),
    /Unsupported hosted PWA deployment host/u,
  );
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot,
      host: 'cloudflare-pages',
      profile: 'edge-everything',
    } as unknown as Parameters<typeof verifyHostedPwaDeployment>[0]),
    /Unsupported Cloudflare Pages host profile/u,
  );
  await assert.rejects(
    runMpgdCli([
      'target',
      'verify-deployment',
      'android',
      '--source-artifact-root',
      sourceRoot,
      '--deployment-root',
      deploymentRoot,
    ]),
    /not available for target: android/u,
  );
  await assert.rejects(
    runMpgdCli([
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
    /Unsupported cloudflare-pages deployment profile/u,
  );
  await assert.rejects(
    runMpgdCli([
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
    /Unsupported hosted PWA deployment host/u,
  );
  await assert.rejects(
    runMpgdCli([
      'target',
      'verify-deployment',
      'microsoft-store',
      '--source-artifact-root',
      sourceRoot,
    ]),
    (error: unknown) => {
      const aggregate = error as AggregateError;
      return String(aggregate.errors?.[0] ?? error).includes('deployment-root');
    },
  );

  // 9. Path escapes and symlink escapes are rejected.
  const symlinkDeployment = fixtureCopy(deploymentRoot, 'symlink');
  symlinkSync(
    join(fixtureRoot, 'outside-asset.txt'),
    join(symlinkDeployment, 'assets', 'linked.js'),
  );
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: sourceRoot,
      deploymentRoot: symlinkDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /must not contain symbolic links/u,
  );

  const escapingSource = buildSourceArtifact(join(fixtureRoot, 'source-escape'), {
    extraIndexReferences: ['../outside-asset.png'],
  });
  const escapingDeployment = buildDeployment(
    escapingSource,
    join(fixtureRoot, 'deployment-escape'),
    { profile: 'api-only' },
  );
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: escapingSource,
      deploymentRoot: escapingDeployment,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /outside the artifact root/u,
  );

  // 10. The legal-only Pages layout is not forced to carry PWA files: verifying
  // one against a PWA profile fails on the missing source evidence with a
  // precise diagnostic instead of touching anything.
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
  assert.throws(
    () => verifyHostedPwaDeployment({
      sourceArtifactRoot: legalOnlyRoot,
      deploymentRoot: deploymentRoot,
      host: 'cloudflare-pages',
      profile: 'api-only',
    }),
    /missing pwa-release\.json/u,
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
  assert.deepEqual(snapshotTree(sourceRoot, deploymentRoot), before);

  // CLI happy path writes structured evidence files.
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
  assert.ok(report.verifiedGameFileCount >= 6);
  assert.ok(
    readFileSync(join(reportDir, 'hosted-pwa-verification.md'), 'utf8')
      .includes('Hosted PWA Deployment Verification'),
  );

  console.log('Hosted PWA deployment verification tests passed.');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function buildSourceArtifact(
  root: string,
  options: { readonly extraIndexReferences?: readonly string[] } = {},
): string {
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'icons'), { recursive: true });
  const extraReferences = (options.extraIndexReferences ?? [])
    .map((reference) => `<img src="${reference}">`)
    .join('');
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head>'
      + '<link rel="manifest" href="./manifest.webmanifest">'
      + '</head><body>'
      + '<script type="module" src="./assets/app.a1b2c3d4.js"></script>'
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

function buildDeployment(
  sourceRoot: string,
  root: string,
  options: { readonly profile: 'api-only' | 'api-canonical-index' },
): string {
  cpSync(sourceRoot, root, { recursive: true });
  mkdirSync(join(root, 'privacy'), { recursive: true });
  writeFileSync(join(root, 'privacy', 'index.html'), '<!doctype html><p>privacy</p>');
  writeFileSync(join(root, '_worker.js'), 'export default { fetch() {} };\n');
  writeFileSync(join(root, '_headers'), validHeaders);
  writeFileSync(join(root, '_redirects'), validRedirects);
  writeFileSync(join(root, 'legal-site.json'), JSON.stringify(legalSiteManifest, null, 2));
  writeFileSync(
    join(root, '_routes.json'),
    JSON.stringify(
      {
        version: 1,
        include: options.profile === 'api-canonical-index'
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
        const relative = absolute.slice(root.length + 1);
        if (relative.startsWith(prefix)) {
          files.push(relative);
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

function snapshotTree(
  ...roots: readonly string[]
): Map<string, FileSnapshot> {
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
    const relative = url.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(url.pathname.slice(1));
    const file = safeJoin(deploymentRoot, relative);

    if (file === undefined || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    const bytes = readFileSync(file);
    response.statusCode = 200;
    response.end(bytes);
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
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
      assert.equal(response.status, 200, path);
      const body = Buffer.from(await response.arrayBuffer());
      assert.ok(
        body.equals(readFileSync(join(deploymentRoot, file))),
        `${path} serves the verified bytes`,
      );
    }

    const missing = await fetch(`http://127.0.0.1:${String(port)}/assets/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await close(server);
  }

}

function safeJoin(root: string, relative: string): string | undefined {
  const resolved = resolve(root, relative);
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
