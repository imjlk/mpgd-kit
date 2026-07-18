import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  microsoftStorePackageGeneratorEndpoint,
  microsoftStorePackageGeneratorSourceRevision,
  runMicrosoftStorePackageGeneration,
  type MicrosoftStorePackageGenerationRuntime,
  type RunMicrosoftStorePackageGenerationInput,
} from '../../packages/cli/src/index';

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
    '--version',
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

  const request = JSON.parse(String(calls[3]?.init.body)) as Record<string, unknown>;
  assert.equal(request.name, 'Fixture Game');
  assert.equal(request.packageId, packageId);
  assert.equal(request.url, pwaUrl);
  assert.equal(request.version, '1.2.3.0');
  assert.equal(request.manifestUrl, manifestUrl);
  assert.deepEqual(request.manifest, manifest);
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

  const remoteMismatch = createFixture('remote-mismatch');
  await assert.rejects(
    runMicrosoftStorePackageGeneration(
      remoteMismatch.input,
      createRuntime({ manifestResponses: [Buffer.from('different')] }),
    ),
    /Deployed Microsoft Store manifest SHA-256 must match/u,
  );
  assertNoGenerationOutputs(remoteMismatch.input);

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

  mkdirSync(join(manifestFile, '..'), { recursive: true });
  mkdirSync(join(submissionEvidenceFile, '..'), { recursive: true });
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
  readonly calls?: { url: string; init: RequestInit }[];
  readonly manifestResponses?: readonly Buffer[];
  readonly iconResponses?: Readonly<Record<string, readonly Response[]>>;
  readonly onIconRequest?: (url: string, requestIndex: number) => void;
  readonly packageResponse?: Response;
} = {}): MicrosoftStorePackageGenerationRuntime {
  let manifestIndex = 0;
  const iconIndexes = new Map<string, number>();

  return {
    fetch: (async (input, init = {}) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      options.calls?.push({ url, init });

      if (url === manifestUrl && (init.method ?? 'GET') === 'GET') {
        const values = options.manifestResponses ?? [manifestBytes, manifestBytes];
        const value = values[Math.min(manifestIndex, values.length - 1)] ?? manifestBytes;
        manifestIndex += 1;
        return response(value, 'application/manifest+json');
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

function createZipArchive(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);

  const centralOffset = localHeader.length + fileName.length + data.length;
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([localHeader, fileName, data, centralHeader, fileName, end]);
}

function assertNoTemporaryArchive(outputFile: string): void {
  const directory = join(outputFile, '..');

  if (!existsSync(directory)) {
    return;
  }

  assert.deepEqual(
    readdirSync(directory).filter((entry) => entry.startsWith(`.${outputFile.split('/').at(-1)}.`)),
    [],
  );
}

function assertNoGenerationOutputs(input: RunMicrosoftStorePackageGenerationInput): void {
  assert.equal(existsSync(input.outputFile), false);
  assert.equal(existsSync(input.jsonFile), false);
  assert.equal(existsSync(input.markdownFile), false);
  assertNoTemporaryArchive(input.outputFile);
}

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
