import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { MockAgent } from 'undici';

import {
  createMicrosoftStorePackageGenerationRuntime,
  microsoftStorePackageGeneratorEndpoint,
  microsoftStorePackageGeneratorSourceRevision,
  runMicrosoftStorePackageGeneration,
  type MicrosoftStorePackageGenerationRuntime,
  type RunMicrosoftStorePackageGenerationInput,
} from '../../packages/cli/src/index';
import {
  microsoftStoreEvidenceFileMatchesIdentity,
  removeMicrosoftStoreEvidenceLockIfOwned,
  writeMicrosoftStorePackageGenerationEvidenceFiles,
} from '../../packages/cli/src/microsoft-store-package-generation';
import {
  createMicrosoftStoreDispatcherFetch,
  removeMicrosoftStorePackageZipIfOwned,
  resolveMicrosoftStorePublicAddresses,
  withMicrosoftStorePackageArchive,
} from '../../packages/cli/src/microsoft-store-package-generation-download';
import { hashMicrosoftStoreFileSnapshot } from '../../packages/cli/src/microsoft-store-package-generation-integrity';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-microsoft-store-package-generation');
const pwaUrl = 'https://games.acme.dev/store/game/';
const manifestUrl = 'https://games.acme.dev/store/manifest.webmanifest';
const icon192Url = 'https://games.acme.dev/store/icon-192.png';
const icon512Url = 'https://games.acme.dev/store/icon-512.png';
const icon192Bytes = Buffer.from('fixture icon 192');
const icon512Bytes = Buffer.from('fixture icon 512');
const manifest = {
  id: 'com.acme.fixture',
  name: 'Fixture Game',
  scope: './game',
  start_url: './game/',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
const validArchive = createZipArchive(
  'packages/fixture.msixbundle',
  Buffer.from('fixture package'),
);
const packageId = '12345Acme.FixtureGame';
const publisherId = 'CN=01234567-89ab-cdef-0123-456789abcdef';

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  assert.deepEqual(
    await resolveMicrosoftStorePublicAddresses(
      'games.acme.dev',
      async () => [
        { address: '203.0.114.10', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
    ),
    [
      { address: '203.0.114.10', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  );
  const resolvePrivateAddress = async () => [{ address: '10.0.0.4', family: 4 }];
  const privateResolution = resolveMicrosoftStorePublicAddresses('intranet', resolvePrivateAddress);
  await assert.rejects(privateResolution, /must resolve only to public addresses/u);
  const resolveMixed = async () => [
    { address: '203.0.114.10', family: 4 },
    { address: 'fd00::4', family: 6 },
  ];
  const mixedResolution = resolveMicrosoftStorePublicAddresses('mixed.acme.dev', resolveMixed);
  await assert.rejects(mixedResolution, /fd00::4/u);
  const mappedPrivateResolution = resolveMicrosoftStorePublicAddresses(
    'mapped.acme.dev',
    async () => [{ address: '::ffff:10.0.0.1', family: 6 }],
  );
  await assert.rejects(mappedPrivateResolution, /::ffff:10\.0\.0\.1/u);
  const reservedIpv6Resolution = resolveMicrosoftStorePublicAddresses(
    'reserved.acme.dev',
    async () => [{ address: '6000::1', family: 6 }],
  );
  await assert.rejects(reservedIpv6Resolution, /6000::1/u);
  await assert.rejects(
    resolveMicrosoftStorePublicAddresses('empty.acme.dev', async () => []),
    /did not resolve/u,
  );
  const privateAddressRuntime = createMicrosoftStorePackageGenerationRuntime({
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  await assert.rejects(
    privateAddressRuntime.fetch('https://private.acme.dev/'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /must resolve only to public addresses/u);
      return true;
    },
  );
  const requestMockAgent = new MockAgent();
  let observedRequestBody = '';
  let observedRequestHeader = '';
  requestMockAgent.disableNetConnect();
  requestMockAgent
    .get('https://request.acme.dev')
    .intercept({
      path: '/package',
      method: 'POST',
      headers: (headers) => {
        observedRequestHeader = headers['x-mpgd-fixture'] ?? '';
        return true;
      },
      body: (body) => {
        observedRequestBody = body;
        return true;
      },
    })
    .reply(200, 'request preserved');

  try {
    const requestFetch = createMicrosoftStoreDispatcherFetch(requestMockAgent);
    const requestResponse = await requestFetch(
      new Request('https://request.acme.dev/package', {
        method: 'POST',
        headers: { 'x-mpgd-fixture': 'preserved' },
        body: 'request body',
      }),
    );
    assert.equal(await requestResponse.text(), 'request preserved');
    assert.equal(observedRequestHeader, 'preserved');
    assert.equal(observedRequestBody, 'request body');
  } finally {
    await requestMockAgent.close();
  }
  assert.throws(
    () => hashMicrosoftStoreFileSnapshot(
      join(fixtureRoot, 'missing-input'),
      'fixture integrity input',
    ),
    /Failed to open fixture integrity input/u,
  );
  const generatedStarter = join(fixtureRoot, 'generated-starter');
  const generatedStarterResult = runCli(['game', 'create', generatedStarter]);
  assert.equal(
    generatedStarterResult.status,
    0,
    generatedStarterResult.stderr || generatedStarterResult.stdout,
  );
  assert.ok(
    readFileSync(join(generatedStarter, '.gitignore'), 'utf8')
      .split(/\r?\n/u)
      .includes('release-input/'),
    'generated starter must ignore downloaded package inputs',
  );

  const cliGuardGameRoot = join(fixtureRoot, 'cli-output-guard');
  const outsideCliOutput = join(fixtureRoot, 'outside-cli-output');
  mkdirSync(cliGuardGameRoot, { recursive: true });
  mkdirSync(outsideCliOutput, { recursive: true });
  symlinkSync(outsideCliOutput, join(cliGuardGameRoot, 'linked-evidence'));
  const outputGuardResult = runCli([
    'target',
    'generate-package',
    'microsoft-store',
    '--targets-file',
    join(cliGuardGameRoot, 'mpgd.targets.json'),
    '--pwa-url',
    pwaUrl,
    '--manifest-url',
    manifestUrl,
    '--package-version',
    '1.2.3.0',
    '--classic-version',
    '1.2.2.0',
    '--output-dir',
    'linked-evidence',
  ]);
  assert.notEqual(outputGuardResult.status, 0);
  assert.match(
    `${outputGuardResult.stderr}${outputGuardResult.stdout}`,
    /output directory must stay inside the game root/u,
  );
  assert.deepEqual(readdirSync(outsideCliOutput), []);

  const success = createFixture('success');
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  const evidence = await runMicrosoftStorePackageGeneration(
    success.input,
    createRuntime({ calls }),
  );

  assert.equal(evidence.target, 'microsoft-store');
  assert.equal(evidence.pwaUrl, pwaUrl);
  assert.equal(evidence.modernVersion, '1.2.3.0');
  assert.equal(evidence.classicVersion, '1.2.2.0');
  assert.equal(evidence.productIdentity.packageId, packageId);
  assert.equal(evidence.productIdentity.publisherId, publisherId);
  assert.equal(evidence.generator.endpoint, microsoftStorePackageGeneratorEndpoint);
  assert.equal(evidence.generator.sourceRevision, microsoftStorePackageGeneratorSourceRevision);
  assert.equal(evidence.generator.contract, 'unversioned-best-effort');
  assert.equal(evidence.archive.sha256, sha256(validArchive));
  assert.equal(evidence.packageInspectionRequired, true);
  assert.deepEqual(readFileSync(success.input.outputFile), validArchive);
  const inodeFreeArchiveFile = join(success.gameRoot, 'inode-free-package.zip');
  writeFileSync(inodeFreeArchiveFile, validArchive);
  const inodeFreeArchiveMetadata = lstatSync(inodeFreeArchiveFile);
  const inodeFreeArchiveIdentity = {
    dev: inodeFreeArchiveMetadata.dev,
    ino: 0,
    sizeBytes: validArchive.length,
    sha256: sha256(validArchive),
  };
  const mismatchedArchiveIdentity = { ...inodeFreeArchiveIdentity, sha256: '0'.repeat(64) };
  removeMicrosoftStorePackageZipIfOwned(inodeFreeArchiveFile, mismatchedArchiveIdentity);
  assert.equal(existsSync(inodeFreeArchiveFile), true);
  removeMicrosoftStorePackageZipIfOwned(inodeFreeArchiveFile, inodeFreeArchiveIdentity);
  assert.equal(existsSync(inodeFreeArchiveFile), false);
  const inodeFreeEvidenceFile = join(success.gameRoot, 'inode-free-evidence.json');
  const inodeFreeEvidenceBytes = Buffer.from('{"owned":true}\n');
  writeFileSync(inodeFreeEvidenceFile, inodeFreeEvidenceBytes);
  const inodeFreeEvidenceMetadata = lstatSync(inodeFreeEvidenceFile);
  const inodeFreeEvidenceIdentity = {
    dev: inodeFreeEvidenceMetadata.dev,
    ino: 0,
    sizeBytes: inodeFreeEvidenceBytes.length,
    sha256: sha256(inodeFreeEvidenceBytes),
    mtimeMs: inodeFreeEvidenceMetadata.mtimeMs,
    ctimeMs: inodeFreeEvidenceMetadata.ctimeMs,
  };
  const evidenceIdentityMatches = microsoftStoreEvidenceFileMatchesIdentity(
    inodeFreeEvidenceFile,
    inodeFreeEvidenceIdentity,
  );
  const mismatchedEvidenceIdentity = {
    ...inodeFreeEvidenceIdentity,
    sha256: '0'.repeat(64),
  };
  const mismatchedEvidenceMatches = microsoftStoreEvidenceFileMatchesIdentity(
    inodeFreeEvidenceFile,
    mismatchedEvidenceIdentity,
  );
  assert.equal(evidenceIdentityMatches, true);
  assert.equal(mismatchedEvidenceMatches, false);
  rmSync(inodeFreeEvidenceFile);
  assert.equal(calls.length, 7);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      manifestUrl,
      icon192Url,
      icon512Url,
      microsoftStorePackageGeneratorEndpoint,
      manifestUrl,
      icon192Url,
      icon512Url,
    ],
  );
  assert.ok(calls.every((call) => call.init.redirect === 'manual'));
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('accept-encoding'), 'identity');
  }

  const request = JSON.parse(String(calls[3]?.init.body)) as Record<string, unknown>;
  assert.equal(request.name, 'Fixture Game');
  assert.equal(request.packageId, packageId);
  assert.equal(request.url, pwaUrl);
  assert.equal(request.version, '1.2.3.0');
  assert.equal(request.manifestUrl, manifestUrl);
  assert.deepEqual(request.manifest, {
    ...manifest,
    icons: [
      { ...manifest.icons[0], src: icon192Url },
      { ...manifest.icons[1], src: icon512Url },
    ],
  });
  assert.equal(request.resourceLanguage, 'en-US,ko-KR');
  assert.equal(request.usePwaBuilderWithCustomManifest, true);
  assert.deepEqual(request.classicPackage, {
    generate: true,
    version: '1.2.2.0',
    url: pwaUrl,
  });
  assert.equal(evidence.generator.requestSha256, sha256(Buffer.from(String(calls[3]?.init.body))));
  assert.equal(evidence.manifest.pinnedInGeneratorRequest, true);
  assert.equal(evidence.manifest.icons.count, 2);
  assert.equal(evidence.manifest.icons.verification, 'before-and-after-generator');
  assert.deepEqual(
    evidence.manifest.icons.entries.map(({ url, sha256, width, height }) => ({
      url,
      sha256,
      width,
      height,
    })),
    [
      { url: icon192Url, sha256: sha256(icon192Bytes), width: 192, height: 192 },
      { url: icon512Url, sha256: sha256(icon512Bytes), width: 512, height: 512 },
    ],
  );
  assert.equal(
    JSON.parse(readFileSync(success.input.jsonFile, 'utf8')).archive.sha256,
    sha256(validArchive),
  );
  assert.match(
    readFileSync(success.input.markdownFile, 'utf8'),
    /Generator contract: unversioned-best-effort[\s\S]*Package inspection: required/u,
  );

  const repeatedIcon = createFixture('repeated-icon');
  const repeatedIconManifest = {
    ...manifest,
    icons: [
      ...manifest.icons,
      { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  const repeatedIconManifestBytes = Buffer.from(`${JSON.stringify(repeatedIconManifest)}\n`);
  const repeatedIconManifestFile = join(
    repeatedIcon.gameRoot,
    'artifacts',
    'microsoft-store',
    'manifest.webmanifest',
  );
  writeFileSync(repeatedIconManifestFile, repeatedIconManifestBytes);
  const repeatedIconSubmission = JSON.parse(
    readFileSync(repeatedIcon.input.submissionEvidenceFile, 'utf8'),
  ) as {
    manifest: {
      sha256: string;
      iconCount: number;
      icons: Record<string, unknown>[];
    };
  };
  repeatedIconSubmission.manifest.sha256 = sha256(repeatedIconManifestBytes);
  repeatedIconSubmission.manifest.iconCount = 3;
  repeatedIconSubmission.manifest.icons.push({
    file: 'artifacts/microsoft-store/icon-512.png',
    sha256: sha256(icon512Bytes),
    width: 512,
    height: 512,
  });
  writeJson(repeatedIcon.input.submissionEvidenceFile, repeatedIconSubmission);
  const repeatedIconEvidence = await runMicrosoftStorePackageGeneration(
    repeatedIcon.input,
    createRuntime({
      manifestResponses: [repeatedIconManifestBytes, repeatedIconManifestBytes],
    }),
  );
  assert.equal(repeatedIconEvidence.manifest.icons.count, 3);
  assert.equal(
    repeatedIconEvidence.manifest.icons.entries[1]?.file,
    repeatedIconEvidence.manifest.icons.entries[2]?.file,
  );
  assert.deepEqual(readFileSync(repeatedIcon.input.outputFile), validArchive);

  const encodedSuccess = createFixture('encoded-success');
  const encodedEvidence = await runMicrosoftStorePackageGeneration(
    encodedSuccess.input,
    createRuntime({
      manifestResponses: [
        encodedResponse(manifestBytes, 'application/manifest+json'),
        encodedResponse(manifestBytes, 'application/manifest+json'),
      ],
      iconResponses: {
        [icon192Url]: [
          encodedResponse(icon192Bytes, 'image/png'),
          encodedResponse(icon192Bytes, 'image/png'),
        ],
        [icon512Url]: [
          encodedResponse(icon512Bytes, 'image/png'),
          encodedResponse(icon512Bytes, 'image/png'),
        ],
      },
      packageResponse: encodedResponse(validArchive, 'application/zip'),
    }),
  );
  assert.equal(encodedEvidence.archive.sha256, sha256(validArchive));
  assert.deepEqual(readFileSync(encodedSuccess.input.outputFile), validArchive);

  const remoteMismatch = createFixture('remote-mismatch');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      remoteMismatch.input,
      createRuntime({ manifestResponses: [Buffer.from('different')] }),
    ),
    /Deployed Microsoft Store manifest SHA-256 must match/u,
  );
  assertNoGenerationOutputs(remoteMismatch.input);

  const invalidUtf8Manifest = createFixture('invalid-utf8-manifest');
  const invalidManifestBytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
  const invalidManifestFile = join(
    invalidUtf8Manifest.gameRoot,
    'artifacts',
    'microsoft-store',
    'manifest.webmanifest',
  );
  writeFileSync(invalidManifestFile, invalidManifestBytes);
  const invalidManifestEvidence = JSON.parse(
    readFileSync(invalidUtf8Manifest.input.submissionEvidenceFile, 'utf8'),
  ) as { manifest: { sha256: string } };
  invalidManifestEvidence.manifest.sha256 = sha256(invalidManifestBytes);
  writeJson(invalidUtf8Manifest.input.submissionEvidenceFile, invalidManifestEvidence);
  const invalidUtf8ManifestCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      invalidUtf8Manifest.input,
      createRuntime({ calls: invalidUtf8ManifestCalls }),
    ),
    /web app manifest must use valid UTF-8/u,
  );
  assert.equal(invalidUtf8ManifestCalls.length, 0);
  assertNoGenerationOutputs(invalidUtf8Manifest.input);

  const invalidUtf8Submission = createFixture('invalid-utf8-submission');
  writeFileSync(
    invalidUtf8Submission.input.submissionEvidenceFile,
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  );
  const invalidUtf8SubmissionCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      invalidUtf8Submission.input,
      createRuntime({ calls: invalidUtf8SubmissionCalls }),
    ),
    /submission evidence must use valid UTF-8/u,
  );
  assert.equal(invalidUtf8SubmissionCalls.length, 0);
  assertNoGenerationOutputs(invalidUtf8Submission.input);

  const danglingEvidence = createFixture('dangling-evidence');
  symlinkSync(join(fixtureRoot, 'missing-evidence-target'), danglingEvidence.input.jsonFile);
  const danglingEvidenceCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      danglingEvidence.input,
      createRuntime({ calls: danglingEvidenceCalls }),
    ),
    /package generation JSON must be a regular file when it already exists/u,
  );
  assert.equal(danglingEvidenceCalls.length, 0);
  assert.equal(lstatSync(danglingEvidence.input.jsonFile).isSymbolicLink(), true);
  assert.equal(existsSync(danglingEvidence.input.outputFile), false);

  const localIconMismatch = createFixture('local-icon-mismatch');
  const localIconMismatchCalls: { url: string; init: RequestInit }[] = [];
  writeFileSync(
    join(localIconMismatch.gameRoot, 'artifacts', 'microsoft-store', 'icon-192.png'),
    Buffer.from('different'),
  );
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      localIconMismatch.input,
      createRuntime({ calls: localIconMismatchCalls }),
    ),
    /web app manifest icon\[0\] SHA-256 must match submission evidence/u,
  );
  assert.equal(localIconMismatchCalls.length, 0);
  assertNoGenerationOutputs(localIconMismatch.input);

  const iconDimensionMismatch = createFixture('icon-dimension-mismatch');
  const dimensionEvidence = JSON.parse(
    readFileSync(iconDimensionMismatch.input.submissionEvidenceFile, 'utf8'),
  ) as { manifest: { icons: { width: number }[] } };
  const firstDimensionEvidence = dimensionEvidence.manifest.icons[0];

  if (firstDimensionEvidence === undefined) {
    throw new Error('Fixture icon evidence is missing.');
  }

  firstDimensionEvidence.width = 193;
  writeJson(iconDimensionMismatch.input.submissionEvidenceFile, dimensionEvidence);
  const iconDimensionMismatchCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      iconDimensionMismatch.input,
      createRuntime({ calls: iconDimensionMismatchCalls }),
    ),
    /icon evidence\[0\] dimensions must match the hash-verified web app manifest/u,
  );
  assert.equal(iconDimensionMismatchCalls.length, 0);
  assertNoGenerationOutputs(iconDimensionMismatch.input);

  const aliasedIconEvidence = createFixture('aliased-icon-evidence');
  const aliasedIconEvidenceCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      {
        ...aliasedIconEvidence.input,
        jsonFile: join(
          aliasedIconEvidence.gameRoot,
          'artifacts',
          'microsoft-store',
          'icon-192.png',
        ),
      },
      createRuntime({ calls: aliasedIconEvidenceCalls }),
    ),
    /package generation JSON must not alias web app manifest icon\[0\]/u,
  );
  assert.equal(aliasedIconEvidenceCalls.length, 0);
  assert.equal(existsSync(aliasedIconEvidence.input.outputFile), false);

  const remoteIconMismatch = createFixture('remote-icon-mismatch');
  const remoteIconMismatchCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      remoteIconMismatch.input,
      createRuntime({
        calls: remoteIconMismatchCalls,
        iconResponses: { [icon192Url]: [response(Buffer.from('different'), 'image/png')] },
      }),
    ),
    /manifest icon\[0\] SHA-256 must match submission evidence before/u,
  );
  assert.equal(
    remoteIconMismatchCalls.some((call) => call.url === microsoftStorePackageGeneratorEndpoint),
    false,
  );
  assertNoGenerationOutputs(remoteIconMismatch.input);

  const missingRemoteIcon = createFixture('missing-remote-icon');
  const missingRemoteIconCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      missingRemoteIcon.input,
      createRuntime({
        calls: missingRemoteIconCalls,
        iconResponses: { [icon192Url]: [new Response(null, { status: 404 })] },
      }),
    ),
    /manifest icon\[0\] before package generation must return a 2xx response, received 404/u,
  );
  assert.equal(
    missingRemoteIconCalls.some((call) => call.url === microsoftStorePackageGeneratorEndpoint),
    false,
  );
  assertNoGenerationOutputs(missingRemoteIcon.input);

  const redirectedRemoteIcon = createFixture('redirected-remote-icon');
  const redirectedRemoteIconCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      redirectedRemoteIcon.input,
      createRuntime({
        calls: redirectedRemoteIconCalls,
        iconResponses: { [icon192Url]: [new Response(null, { status: 302 })] },
      }),
    ),
    /manifest icon\[0\] before package generation must return a 2xx response, received 302/u,
  );
  assert.equal(
    redirectedRemoteIconCalls.some((call) => call.url === microsoftStorePackageGeneratorEndpoint),
    false,
  );
  assertNoGenerationOutputs(redirectedRemoteIcon.input);

  const oversizedRemoteIcon = createFixture('oversized-remote-icon');
  const oversizedRemoteIconCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      oversizedRemoteIcon.input,
      createRuntime({
        calls: oversizedRemoteIconCalls,
        iconResponses: {
          [icon192Url]: [response(icon192Bytes, 'image/png', 2 * 1024 * 1024 + 1)],
        },
      }),
    ),
    /manifest icon\[0\].*exceeds the 2097152-byte size limit/u,
  );
  assert.equal(
    oversizedRemoteIconCalls.some((call) => call.url === microsoftStorePackageGeneratorEndpoint),
    false,
  );
  assertNoGenerationOutputs(oversizedRemoteIcon.input);

  const outsideScope = createFixture('outside-scope');
  const outsideScopeCalls: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      { ...outsideScope.input, pwaUrl: 'https://games.acme.dev/store/gameplay/' },
      createRuntime({ calls: outsideScopeCalls }),
    ),
    /must stay within the hash-verified web app manifest scope/u,
  );
  assert.equal(outsideScopeCalls.length, 0);

  const redirect = createFixture('redirect');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      redirect.input,
      createRuntime({ packageResponse: new Response(null, { status: 302 }) }),
    ),
    /must return a 2xx response, received 302/u,
  );

  const wrongContentType = createFixture('wrong-content-type');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      wrongContentType.input,
      createRuntime({
        packageResponse: response(Buffer.from('not a ZIP'), 'application/octet-stream'),
      }),
    ),
    /must return application\/zip/u,
  );

  const truncated = createFixture('truncated');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      truncated.input,
      createRuntime({ packageResponse: response(Buffer.from('PK\u0003\u0004'), 'application/zip') }),
    ),
    /archive is truncated/u,
  );
  assertNoTemporaryArchive(truncated.input.outputFile);

  const unsafeEntry = createFixture('unsafe-entry');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      unsafeEntry.input,
      createRuntime({
        packageResponse: response(
          createZipArchive('../outside.msixbundle', Buffer.from('unsafe')),
          'application/zip',
        ),
      }),
    ),
    /unsafe ZIP entry path/u,
  );

  const unsafeLocalEntry = createFixture('unsafe-local-entry');
  const unsafeLocalArchive = Buffer.from(validArchive);
  Buffer.from('../').copy(unsafeLocalArchive, 30);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      unsafeLocalEntry.input,
      createRuntime({
        packageResponse: response(unsafeLocalArchive, 'application/zip'),
      }),
    ),
    /unsafe ZIP entry path/u,
  );
  assertNoGenerationOutputs(unsafeLocalEntry.input);

  const mismatchedLocalEntry = createFixture('mismatched-local-entry');
  const mismatchedLocalArchive = Buffer.from(validArchive);
  Buffer.from('q').copy(mismatchedLocalArchive, 30);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      mismatchedLocalEntry.input,
      createRuntime({
        packageResponse: response(mismatchedLocalArchive, 'application/zip'),
      }),
    ),
    /local filename must match its central directory entry/u,
  );
  assertNoGenerationOutputs(mismatchedLocalEntry.input);

  const zip64 = createFixture('zip64');
  const zip64Archive = Buffer.from(validArchive);
  zip64Archive.writeUInt32LE(0xffffffff, zip64Archive.length - 22 + 16);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      zip64.input,
      createRuntime({ packageResponse: response(zip64Archive, 'application/zip') }),
    ),
    /must not use ZIP64 extensions/u,
  );
  assertNoGenerationOutputs(zip64.input);

  const duplicateEntry = createFixture('duplicate-entry');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      duplicateEntry.input,
      createRuntime({
        packageResponse: response(
          createZipArchiveEntries([
            { name: 'packages/Fixture.msix', data: Buffer.from('first') },
            { name: 'PACKAGES/fixture.msix', data: Buffer.from('second') },
          ]),
          'application/zip',
        ),
      }),
    ),
    /duplicate or case-colliding ZIP entry/u,
  );
  assertNoGenerationOutputs(duplicateEntry.input);

  const splitDiskEntry = createFixture('split-disk-entry');
  const splitDiskArchive = Buffer.from(validArchive);
  const splitDiskCentralOffset = splitDiskArchive.readUInt32LE(splitDiskArchive.length - 22 + 16);
  splitDiskArchive.writeUInt16LE(1, splitDiskCentralOffset + 34);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      splitDiskEntry.input,
      createRuntime({ packageResponse: response(splitDiskArchive, 'application/zip') }),
    ),
    /keep every entry on disk 0/u,
  );
  assertNoGenerationOutputs(splitDiskEntry.input);

  const mismatchedLocalMetadata = createFixture('mismatched-local-metadata');
  const mismatchedLocalMetadataArchive = Buffer.from(validArchive);
  mismatchedLocalMetadataArchive.writeUInt32LE(1, 18);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      mismatchedLocalMetadata.input,
      createRuntime({
        packageResponse: response(mismatchedLocalMetadataArchive, 'application/zip'),
      }),
    ),
    /local metadata must match its central directory entry/u,
  );
  assertNoGenerationOutputs(mismatchedLocalMetadata.input);

  const changedManifest = createFixture('changed-manifest');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      changedManifest.input,
      createRuntime({ manifestResponses: [manifestBytes, Buffer.from('changed')] }),
    ),
    /after package generation/u,
  );
  assert.equal(existsSync(changedManifest.input.outputFile), false);
  assertNoTemporaryArchive(changedManifest.input.outputFile);

  const changedRemoteIcon = createFixture('changed-remote-icon');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      changedRemoteIcon.input,
      createRuntime({
        iconResponses: {
          [icon192Url]: [
            response(icon192Bytes, 'image/png'),
            response(Buffer.from('changed'), 'image/png'),
          ],
        },
      }),
    ),
    /manifest icon\[0\] SHA-256 must match submission evidence after/u,
  );
  assertNoGenerationOutputs(changedRemoteIcon.input);

  const changedLocalIconAfterCheck = createFixture('changed-local-icon-after-check');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      changedLocalIconAfterCheck.input,
      createRuntime({
        onIconRequest: (url, requestIndex) => {
          if (url === icon192Url && requestIndex === 1) {
            writeFileSync(
              join(
                changedLocalIconAfterCheck.gameRoot,
                'artifacts',
                'microsoft-store',
                'icon-192.png',
              ),
              Buffer.from('changed locally'),
            );
          }
        },
      }),
    ),
    /web app manifest icon\[0\] changed during package generation/u,
  );
  assertNoGenerationOutputs(changedLocalIconAfterCheck.input);

  const competingOutput = createFixture('competing-output');
  const competingOutputBytes = Buffer.from('competitor package output');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      competingOutput.input,
      createRuntime({
        onPackageRequest: () => {
          writeFileSync(competingOutput.input.outputFile, competingOutputBytes);
        },
      }),
    ),
    /package ZIP appeared during generation/u,
  );
  assert.deepEqual(readFileSync(competingOutput.input.outputFile), competingOutputBytes);
  assert.equal(existsSync(competingOutput.input.jsonFile), false);
  assert.equal(existsSync(competingOutput.input.markdownFile), false);
  assertNoTemporaryArchive(competingOutput.input.outputFile);

  const lockedEvidence = createFixture('locked-evidence');
  const evidenceLockFile = join(
    dirname(lockedEvidence.input.jsonFile),
    `.${basename(lockedEvidence.input.jsonFile)}.mpgd-package-generation.lock`,
  );
  const evidenceLockToken = 'competing package generation';
  writeFileSync(evidenceLockFile, `${evidenceLockToken}\n`);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(lockedEvidence.input, createRuntime()),
    /evidence is already being written/u,
  );
  assert.equal(readFileSync(evidenceLockFile, 'utf8'), `${evidenceLockToken}\n`);
  assertNoGenerationOutputs(lockedEvidence.input);
  const evidenceLockMetadata = lstatSync(evidenceLockFile);
  removeMicrosoftStoreEvidenceLockIfOwned(
    evidenceLockFile,
    { dev: evidenceLockMetadata.dev, ino: 0 },
    'different transaction',
  );
  assert.equal(existsSync(evidenceLockFile), true);
  removeMicrosoftStoreEvidenceLockIfOwned(
    evidenceLockFile,
    { dev: evidenceLockMetadata.dev, ino: 0 },
    evidenceLockToken,
  );
  assert.equal(existsSync(evidenceLockFile), false);

  const reportFailure = createFixture('report-failure');
  const previousJsonEvidence = '{"previous":true}\n';
  writeFileSync(reportFailure.input.jsonFile, previousJsonEvidence);
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      reportFailure.input,
      createRuntime({
        onPackageRequest: () => {
          mkdirSync(reportFailure.input.markdownFile, { recursive: true });
        },
      }),
    ),
    /Failed to write Microsoft Store package generation evidence/u,
  );
  assert.equal(existsSync(reportFailure.input.outputFile), false);
  assert.equal(readFileSync(reportFailure.input.jsonFile, 'utf8'), previousJsonEvidence);
  assert.equal(lstatSync(reportFailure.input.markdownFile).isDirectory(), true);
  assertNoTemporaryArchive(reportFailure.input.outputFile);

  const archivePlacementFailure = createFixture('archive-placement-failure');
  mkdirSync(dirname(archivePlacementFailure.input.outputFile), { recursive: true });
  const archivePlacementIconInputs = [
    {
      file: join(
        archivePlacementFailure.gameRoot,
        'artifacts',
        'microsoft-store',
        'icon-192.png',
      ),
      url: icon192Url,
      snapshot: { sizeBytes: icon192Bytes.length, sha256: sha256(icon192Bytes) },
      width: 192,
      height: 192,
    },
    {
      file: join(
        archivePlacementFailure.gameRoot,
        'artifacts',
        'microsoft-store',
        'icon-512.png',
      ),
      url: icon512Url,
      snapshot: { sizeBytes: icon512Bytes.length, sha256: sha256(icon512Bytes) },
      width: 512,
      height: 512,
    },
  ];
  await assert.rejects(
    withMicrosoftStorePackageArchive(
      {
        runtime: createRuntime(),
        manifestUrl,
        manifestSha256: sha256(manifestBytes),
        manifestIcons: archivePlacementIconInputs,
        requestBody: '{}',
        outputFile: archivePlacementFailure.input.outputFile,
        assertInputsUnchanged: () => {},
        afterPlacement: () => {
          throw new Error('after archive placement');
        },
      },
      () => {
        assert.fail('archive consumer must not run after a placement failure');
      },
    ),
    /after archive placement/u,
  );
  assertNoGenerationOutputs(archivePlacementFailure.input);

  const linkedPlacementFailure = createFixture('linked-placement-failure');
  assert.throws(
    () => writeMicrosoftStorePackageGenerationEvidenceFiles(
      {
        jsonFile: linkedPlacementFailure.input.jsonFile,
        markdownFile: linkedPlacementFailure.input.markdownFile,
        report: { placed: true },
        markdown: '# Placed\n',
      },
      {
        afterPlacement: () => {
          throw new Error('after link placement');
        },
      },
    ),
    /after link placement/u,
  );
  assert.equal(existsSync(linkedPlacementFailure.input.jsonFile), false);
  assert.equal(existsSync(linkedPlacementFailure.input.markdownFile), false);
  assertNoEvidencePublicationArtifacts(linkedPlacementFailure.input);

  const renamedPlacementFailure = createFixture('renamed-placement-failure');
  const previousRenamedJson = '{"previous":"json"}\n';
  const previousRenamedMarkdown = '# Previous Markdown\n';
  writeFileSync(renamedPlacementFailure.input.jsonFile, previousRenamedJson);
  writeFileSync(renamedPlacementFailure.input.markdownFile, previousRenamedMarkdown);
  assert.throws(
    () => writeMicrosoftStorePackageGenerationEvidenceFiles(
      {
        jsonFile: renamedPlacementFailure.input.jsonFile,
        markdownFile: renamedPlacementFailure.input.markdownFile,
        report: { placed: true },
        markdown: '# Replaced\n',
      },
      {
        afterPlacement: () => {
          throw new Error('after rename placement');
        },
      },
    ),
    /after rename placement/u,
  );
  assert.equal(readFileSync(renamedPlacementFailure.input.jsonFile, 'utf8'), previousRenamedJson);
  assert.equal(
    readFileSync(renamedPlacementFailure.input.markdownFile, 'utf8'),
    previousRenamedMarkdown,
  );
  assertNoEvidencePublicationArtifacts(renamedPlacementFailure.input);

  const lengthMismatch = createFixture('length-mismatch');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      lengthMismatch.input,
      createRuntime({
        packageResponse: response(validArchive, 'application/zip', validArchive.length + 1),
      }),
    ),
    /archive length mismatch/u,
  );

  const invalidVersions = createFixture('invalid-versions');
  const invalidVersionRun = runMicrosoftStorePackageGeneration(
    { ...invalidVersions.input, classicVersion: invalidVersions.input.modernVersion },
    createRuntime(),
  );
  await assert.rejects(invalidVersionRun, /classic package version must be lower/u);

  const linkedOutput = createFixture('linked-output');
  const linkedOutputOutside = join(fixtureRoot, 'outside');
  mkdirSync(linkedOutputOutside, { recursive: true });
  symlinkSync(linkedOutputOutside, join(linkedOutput.gameRoot, 'linked-output'));
  const linkedOutputRun = runMicrosoftStorePackageGeneration(
    {
      ...linkedOutput.input,
      outputFile: join(linkedOutput.gameRoot, 'linked-output', 'package.zip'),
    },
    createRuntime(),
  );
  await assert.rejects(linkedOutputRun, /must stay inside the game root/u);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('CLI Microsoft Store package generation smoke passed.');

function createFixture(name: string): {
  readonly gameRoot: string;
  readonly input: RunMicrosoftStorePackageGenerationInput;
} {
  const gameRoot = join(fixtureRoot, name);
  const manifestFile = join(gameRoot, 'artifacts', 'microsoft-store', 'manifest.webmanifest');
  const submissionEvidenceFile = join(
    gameRoot,
    'release-output',
    'microsoft-store',
    'submission-preflight.json',
  );
  const outputFile = join(gameRoot, 'release-input', 'microsoft-store', 'package.zip');
  const evidenceDirectory = join(gameRoot, 'release-output', 'microsoft-store');

  mkdirSync(dirname(manifestFile), { recursive: true });
  mkdirSync(dirname(submissionEvidenceFile), { recursive: true });
  writeFileSync(manifestFile, manifestBytes);
  const icon192File = join(gameRoot, 'artifacts', 'microsoft-store', 'icon-192.png');
  const icon512File = join(gameRoot, 'artifacts', 'microsoft-store', 'icon-512.png');
  writeFileSync(icon192File, icon192Bytes);
  writeFileSync(icon512File, icon512Bytes);
  writeJson(submissionEvidenceFile, {
    schemaVersion: 1,
    target: 'microsoft-store',
    productIdentity: {
      packageId,
      publisherId,
      publisherDisplayName: 'Acme Games',
      reservedName: 'Fixture Game',
    },
    manifest: {
      file: 'artifacts/microsoft-store/manifest.webmanifest',
      sha256: sha256(manifestBytes),
      iconCount: 2,
      icons: [
        {
          file: 'artifacts/microsoft-store/icon-192.png',
          sha256: sha256(icon192Bytes),
          width: 192,
          height: 192,
        },
        {
          file: 'artifacts/microsoft-store/icon-512.png',
          sha256: sha256(icon512Bytes),
          width: 512,
          height: 512,
        },
      ],
    },
    listing: {
      locales: {
        'ko-KR': {},
        'en-US': {},
      },
    },
  });

  return {
    gameRoot,
    input: {
      gameRoot,
      submissionEvidenceFile,
      pwaUrl,
      manifestUrl,
      modernVersion: '1.2.3',
      classicVersion: '1.2.2.0',
      outputFile,
      jsonFile: join(evidenceDirectory, 'package-generation.json'),
      markdownFile: join(evidenceDirectory, 'package-generation.md'),
    },
  };
}

function createRuntime(options: {
  readonly calls?: { readonly url: string; readonly init: RequestInit }[];
  readonly manifestResponses?: readonly (Buffer | Response)[];
  readonly iconResponses?: Readonly<Record<string, readonly Response[]>>;
  readonly onIconRequest?: (url: string, requestIndex: number) => void;
  readonly onPackageRequest?: () => void;
  readonly packageResponse?: Response;
} = {}): MicrosoftStorePackageGenerationRuntime {
  let manifestIndex = 0;
  const iconIndexes = new Map<string, number>();

  return {
    fetch: (async (input, init = {}) => {
      const url = requestUrl(input);
      options.calls?.push({ url, init });

      if (url === manifestUrl && (init.method ?? 'GET') === 'GET') {
        const values = options.manifestResponses ?? [manifestBytes, manifestBytes];
        const value = values[Math.min(manifestIndex, values.length - 1)] ?? manifestBytes;
        manifestIndex += 1;
        return value instanceof Response ? value : response(value, 'application/manifest+json');
      }

      if ((url === icon192Url || url === icon512Url) && (init.method ?? 'GET') === 'GET') {
        const defaults = url === icon192Url ? icon192Bytes : icon512Bytes;
        const values = options.iconResponses?.[url];
        const index = iconIndexes.get(url) ?? 0;
        iconIndexes.set(url, index + 1);
        options.onIconRequest?.(url, index);
        return values?.[Math.min(index, values.length - 1)] ?? response(defaults, 'image/png');
      }

      if (url === microsoftStorePackageGeneratorEndpoint && init.method === 'POST') {
        options.onPackageRequest?.();
        return options.packageResponse ?? response(validArchive, 'application/zip');
      }

      throw new Error(`Unexpected fixture request: ${init.method ?? 'GET'} ${url}`);
    }) as typeof fetch,
  };
}

function response(bytes: Buffer, contentType: string, contentLength = bytes.length): Response {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: {
      'content-length': String(contentLength),
      'content-type': contentType,
    },
  });
}

function encodedResponse(bytes: Buffer, contentType: string): Response {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: {
      'content-encoding': 'gzip',
      'content-length': String(Math.max(0, bytes.length - 1)),
      'content-type': contentType,
    },
  });
}

function createZipArchive(name: string, data: Buffer): Buffer {
  return createZipArchiveEntries([{ name, data }]);
}

function createZipArchiveEntries(
  entries: readonly { readonly name: string; readonly data: Buffer }[],
): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    const localRecord = Buffer.concat([localHeader, fileName, entry.data]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, fileName]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function assertNoTemporaryArchive(outputFile: string): void {
  const directory = dirname(outputFile);

  if (!existsSync(directory)) {
    return;
  }

  assert.deepEqual(
    readdirSync(directory).filter((entry) => entry.startsWith(`.${basename(outputFile)}.`)),
    [],
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;

  for (const byte of bytes) {
    checksum ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (-(checksum & 1) & 0xedb88320);
    }
  }

  return (checksum ^ 0xffffffff) >>> 0;
}

function assertNoGenerationOutputs(input: RunMicrosoftStorePackageGenerationInput): void {
  assert.equal(existsSync(input.outputFile), false);
  assert.equal(existsSync(input.jsonFile), false);
  assert.equal(existsSync(input.markdownFile), false);
  assertNoTemporaryArchive(input.outputFile);
}

function assertNoEvidencePublicationArtifacts(
  input: RunMicrosoftStorePackageGenerationInput,
): void {
  const outputDirectory = dirname(input.jsonFile);
  const evidenceBasenames = [basename(input.jsonFile), basename(input.markdownFile)];
  const leftovers = readdirSync(outputDirectory).filter((entry) =>
    evidenceBasenames.some((evidenceBasename) => entry.startsWith(`.${evidenceBasename}.`)),
  );
  assert.deepEqual(leftovers, []);
}

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  return result;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
