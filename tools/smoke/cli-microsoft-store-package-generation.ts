import assert from 'node:assert/strict';
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
  runMpgdCli,
  type MicrosoftStorePackageGenerationRuntime,
  type RunMicrosoftStorePackageGenerationInput,
} from '../../packages/cli/src/index';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-microsoft-store-package-generation');
const pwaUrl = 'https://games.acme.dev/store/game/';
const manifestUrl = 'https://games.acme.dev/store/manifest.webmanifest';
const manifest = {
  id: 'com.acme.fixture',
  name: 'Fixture Game',
  scope: './game',
  start_url: './game/',
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
  await runMpgdCli(['game', 'create', generatedStarter]);
  assert.ok(
    readFileSync(join(generatedStarter, '.gitignore'), 'utf8')
      .split(/\r?\n/u)
      .includes('release-input/'),
    'generated starter must ignore downloaded package inputs',
  );

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
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.url),
    [manifestUrl, microsoftStorePackageGeneratorEndpoint, manifestUrl],
  );
  assert.ok(calls.every((call) => call.init.redirect === 'manual'));

  const request = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
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
  assert.equal(evidence.generator.requestSha256, sha256(Buffer.from(String(calls[1]?.init.body))));
  assert.equal(evidence.manifest.pinnedInGeneratorRequest, true);
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
  assert.equal(existsSync(remoteMismatch.input.outputFile), false);

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
  const outside = join(fixtureRoot, 'outside');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(linkedOutput.gameRoot, 'linked-output'));
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
  readonly packageResponse?: Response;
} = {}): MicrosoftStorePackageGenerationRuntime {
  let manifestIndex = 0;

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

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
