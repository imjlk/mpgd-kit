import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  parseMicrosoftStoreSubmissionConfig,
  runMicrosoftStoreSubmissionPreflight,
} from '../../packages/cli/src/index';

const fixtureRoot = resolve('node_modules/.cache/mpgd-cli-microsoft-store-submission');
const gameRoot = join(fixtureRoot, 'game');
const artifactRoot = join(gameRoot, 'artifacts', 'microsoft-store');
const outputDir = join(gameRoot, 'release-output', 'microsoft-store');
const screenshotFile = join(gameRoot, 'store-assets', 'en-US', '01.png');
const targetsFile = join(gameRoot, 'mpgd.targets.json');
const submissionFile = join(gameRoot, 'mpgd.microsoft-store.json');

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(join(gameRoot, 'store-assets', 'en-US'), { recursive: true });
  const validScreenshot = createPng(1366, 768);
  writeFileSync(screenshotFile, validScreenshot);
  writeJson(targetsFile, {
    targets: {
      'microsoft-store': {
        kind: 'web',
        gameApp: '.',
        adapter: 'browser',
        output: '${MPGD_GAME_ROOT}/artifacts/microsoft-store',
      },
    },
  });
  writeJson(join(artifactRoot, 'manifest.webmanifest'), {
    id: 'com.acme.fixture-game',
    name: 'Fixture Game',
    short_name: 'Fixture',
    start_url: './',
    scope: './',
    description: 'A deterministic fixture game.',
    display: 'standalone',
    background_color: '#000000',
    orientation: 'landscape',
    screenshots: [{ src: './screenshot.png', sizes: '1280x720', type: 'image/png' }],
    categories: ['games'],
    icons: [{ src: './icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
  });
  writeJson(submissionFile, validConfig());
  const spawnOptions = {
    cwd: process.cwd(),
    encoding: 'utf8' as const,
    env: process.env,
    timeout: 30_000,
  };

  const result = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--no-plugins',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'target',
      'preflight',
      'microsoft-store',
      '--targets-file',
      targetsFile,
      '--submission-file',
      submissionFile,
      '--output-dir',
      outputDir,
    ],
    spawnOptions,
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.signal !== null) {
    throw new Error(
      `CLI fixture was killed by signal ${result.signal}:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }

  assert.equal(
    result.status,
    0,
    `CLI fixture exited with status ${String(result.status)}:\n${result.stderr || result.stdout || '(no output)'}`,
  );
  assert.match(
    result.stdout,
    /submission preflight passed: 1 listing locale\(s\), 0 warning\(s\)/u,
  );

  const evidence = JSON.parse(
    readFileSync(join(outputDir, 'submission-preflight.json'), 'utf8'),
  ) as {
    readonly target: string;
    readonly manifest: { readonly id: string };
    readonly listing: {
      readonly personalData: { readonly accessedOrTransmitted: boolean };
      readonly locales: Record<string, unknown>;
    };
    readonly commerce: { readonly mode: string };
    readonly warnings: readonly string[];
  };
  assert.equal(evidence.target, 'microsoft-store');
  assert.equal(evidence.manifest.id, 'com.acme.fixture-game');
  assert.equal(evidence.listing.personalData.accessedOrTransmitted, true);
  assert.deepEqual(Object.keys(evidence.listing.locales), ['en-US']);
  assert.equal(evidence.commerce.mode, 'disabled');
  assert.deepEqual(evidence.warnings, []);
  assert.match(
    readFileSync(join(outputDir, 'submission-preflight.md'), 'utf8'),
    /# Microsoft Store Submission Preflight[\s\S]*Personal data accessed or transmitted: true/u,
  );

  const base = validConfig();

  expectConfigError(
    {
      ...base,
      productIdentity: {
        ...base.productIdentity,
        packageId: 'REPLACE_ME',
      },
    },
    'placeholder content',
  );
  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        locales: {
          'en-US': {
            ...base.listing.locales['en-US'],
            description: 'REPLACE_ME',
          },
        },
      },
    },
    'placeholder content',
  );
  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        personalData: { accessedOrTransmitted: true },
      },
    },
    'privacyPolicyUrl is required',
  );
  expectConfigError(
    {
      ...base,
      commerce: { mode: 'microsoft-store' },
    },
    'server-side ledger verification',
  );

  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        supportUrl: 'https://127.0.0.1/support',
      },
    },
    'valid public HTTPS URL',
  );

  for (const supportUrl of ['https://release.invalid/help', 'https://release.test/help']) {
    expectConfigError(
      {
        ...base,
        listing: { ...base.listing, supportUrl },
      },
      'valid public HTTPS URL',
    );
  }

  expectConfigError(
    {
      ...base,
      productIdentity: { ...base.productIdentity, publisherId: 'CN=' },
    },
    'complete X.509 distinguished name',
  );

  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        locales: {
          'en-US': {
            ...base.listing.locales['en-US'],
            description: 'x'.repeat(10_001),
          },
        },
      },
    },
    'must not exceed 10000 characters',
  );

  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        locales: {
          'en-US': {
            ...base.listing.locales['en-US'],
            screenshots: Array.from({ length: 11 }, (_, index) => `shot-${index}.png`),
          },
        },
      },
    },
    'at most 10 files',
  );

  const ordinaryDescription = parseMicrosoftStoreSubmissionConfig({
    ...base,
    listing: {
      ...base.listing,
      locales: {
        'en-US': {
          ...base.listing.locales['en-US'],
          description: 'Collect a sample and bring it back to your research station.',
        },
      },
    },
  });
  assert.match(ordinaryDescription.listing.locales['en-US']?.description ?? '', /sample/u);

  for (const packageId of ['ab', 'con', 'abc.', 'xn--fixture', 'fixture.xn--name']) {
    expectConfigError(
      {
        ...base,
        productIdentity: {
          ...base.productIdentity,
          packageId,
        },
      },
      'Windows package string|package string restrictions',
    );
  }

  for (const invalidScreenshot of [
    Buffer.from('not a PNG'),
    createPngWithEmptyImageData(1366, 768),
    createPng(1366, 1366),
  ]) {
    writeFileSync(screenshotFile, invalidScreenshot);
    assert.throws(
      () => runMicrosoftStoreSubmissionPreflight({
        gameRoot,
        artifactRoot,
        configFile: submissionFile,
        jsonFile: join(outputDir, 'invalid-screenshot.json'),
        markdownFile: join(outputDir, 'invalid-screenshot.md'),
      }),
      /must be a valid PNG|must be landscape or portrait/u,
    );
  }
  writeFileSync(screenshotFile, validScreenshot);

  const originalSubmission = readFileSync(submissionFile, 'utf8');
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: submissionFile,
      markdownFile: join(outputDir, 'aliased-input.md'),
    }),
    /must not alias Microsoft Store submission config/u,
  );
  assert.equal(readFileSync(submissionFile, 'utf8'), originalSubmission);

  const sharedOutputFile = join(outputDir, 'shared-evidence');
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: sharedOutputFile,
      markdownFile: sharedOutputFile,
    }),
    /must not alias submission evidence Markdown/u,
  );

  const linkedOutputFile = join(outputDir, 'linked-submission-preflight.json');
  const outsideOutputFile = join(fixtureRoot, 'outside-evidence.json');
  writeFileSync(outsideOutputFile, 'outside');
  symlinkSync(outsideOutputFile, linkedOutputFile);
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: linkedOutputFile,
      markdownFile: join(outputDir, 'linked-submission-preflight.md'),
    }),
    /must not be a symbolic link/u,
  );

  const outsideDirectory = join(fixtureRoot, 'outside-directory');
  const linkedOutputDirectory = join(gameRoot, 'linked-output');
  mkdirSync(outsideDirectory);
  symlinkSync(outsideDirectory, linkedOutputDirectory, 'dir');
  const linkedResult = spawnSync(
    process.execPath,
    [
      'tools/run-ttsx.mjs',
      '--no-plugins',
      '--mpgd-cli',
      'packages/cli/src/bin.ts',
      'target',
      'preflight',
      'microsoft-store',
      '--targets-file',
      targetsFile,
      '--submission-file',
      submissionFile,
      '--output-dir',
      linkedOutputDirectory,
    ],
    spawnOptions,
  );

  if (linkedResult.error !== undefined) {
    throw linkedResult.error;
  }

  if (linkedResult.signal !== null) {
    throw new Error(
      `CLI fixture was killed by signal ${linkedResult.signal}:\n${linkedResult.stderr || linkedResult.stdout || '(no output)'}`,
    );
  }

  assert.notEqual(linkedResult.status, 0, 'Symlinked output directory unexpectedly passed.');
  assert.match(linkedResult.stderr || linkedResult.stdout, /must stay inside the game root/u);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('CLI Microsoft Store submission preflight smoke passed.');

function validConfig() {
  return {
    schemaVersion: 1,
    productIdentity: {
      packageId: '12345Acme.FixtureGame',
      publisherId: 'CN=01234567-89ab-cdef-0123-456789abcdef',
      publisherDisplayName: 'Acme Games',
      reservedName: 'Fixture Game',
    },
    listing: {
      category: 'Games',
      supportUrl: 'https://support.acme.games/help',
      personalData: {
        accessedOrTransmitted: true,
        privacyPolicyUrl: 'https://support.acme.games/privacy',
      },
      locales: {
        'en-US': {
          description: 'A deterministic fixture for Microsoft Store submission validation.',
          screenshots: ['store-assets/en-US/01.png'],
        },
      },
    },
    ageRating: {
      questionnaireCompleted: true,
      iarcId: 'fixture-iarc-id',
    },
    commerce: { mode: 'disabled' },
  };
}

function expectConfigError(input: unknown, message: string): void {
  assert.throws(() => parseMicrosoftStoreSubmissionConfig(input), new RegExp(message, 'u'));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowLength = width * 4 + 1;
  const pixels = Buffer.alloc(rowLength * height);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', deflateSync(pixels)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createPngWithEmptyImageData(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', Buffer.alloc(0)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(input: Buffer): number {
  let crc = 0xffff_ffff;

  for (const byte of input) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }

  return (crc ^ 0xffff_ffff) >>> 0;
}
