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
const manifestFile = join(artifactRoot, 'manifest.webmanifest');
const iconFile = join(artifactRoot, 'icon.png');
const icon192File = join(artifactRoot, 'icon-192.png');
const oversizedDecodedIconFile = join(artifactRoot, 'icon-oversized-decoded.png');
const targetsFile = join(gameRoot, 'mpgd.targets.json');
const submissionFile = join(gameRoot, 'mpgd.microsoft-store.json');
const kitRoot = process.cwd();
const ttsxRunner = join(kitRoot, 'tools', 'run-ttsx.mjs');
const ttsxProject = join(kitRoot, 'tsconfig.tools.json');
const cliEntry = join(kitRoot, 'packages', 'cli', 'src', 'bin.ts');

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(join(gameRoot, 'store-assets', 'en-US'), { recursive: true });
  const validScreenshot = createPng(1366, 768);
  const validIcon = createPng(512, 512);
  const validIcon192 = createPng(192, 192);
  const validManifest = {
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
    icons: [
      { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  writeFileSync(screenshotFile, validScreenshot);
  writeFileSync(iconFile, validIcon);
  writeFileSync(icon192File, validIcon192);
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
  writeJson(manifestFile, validManifest);
  writeJson(submissionFile, validConfig());
  const spawnOptions = {
    cwd: gameRoot,
    encoding: 'utf8' as const,
    env: process.env,
    timeout: 30_000,
  };

  const result = spawnSync(
    process.execPath,
    [
      ttsxRunner,
      '--project',
      ttsxProject,
      '--no-plugins',
      '--mpgd-cli',
      cliEntry,
      'target',
      'preflight',
      'microsoft-store',
      '--targets-file',
      targetsFile,
      '--submission-file',
      submissionFile,
      '--output-dir',
      outputDir,
      '--kit-path',
      kitRoot,
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

  if (result.status !== 0) {
    throw new Error(
      `CLI fixture exited with status ${String(result.status)}:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }
  assert.match(
    result.stdout,
    /submission preflight passed: 1 listing locale\(s\), 0 warning\(s\)/u,
  );

  const evidence = JSON.parse(
    readFileSync(join(outputDir, 'submission-preflight.json'), 'utf8'),
  ) as {
    readonly target: string;
    readonly manifest: { readonly id: string; readonly icons: readonly unknown[] };
    readonly listing: {
      readonly personalData: { readonly accessedOrTransmitted: boolean };
      readonly locales: Record<string, unknown>;
    };
    readonly commerce: { readonly mode: string };
    readonly warnings: readonly string[];
  };
  assert.equal(evidence.target, 'microsoft-store');
  assert.equal(evidence.manifest.id, 'com.acme.fixture-game');
  assert.equal(evidence.manifest.icons.length, 2);
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
  for (const publisherDisplayName of ['Exchange Media', 'Change Metadata']) {
    const config = parseMicrosoftStoreSubmissionConfig({
      ...base,
      productIdentity: { ...base.productIdentity, publisherDisplayName },
    });
    assert.equal(config.productIdentity.publisherDisplayName, publisherDisplayName);
  }
  expectConfigError(
    {
      ...base,
      productIdentity: {
        ...base.productIdentity,
        publisherDisplayName: 'CHANGE_ME Inc',
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
      productIdentity: { ...base.productIdentity, publisherId: 'CN=REPLACE_ME' },
    },
    'placeholder content',
  );
  expectConfigError(
    {
      ...base,
      productIdentity: {
        ...base.productIdentity,
        publisherId: `${base.productIdentity.publisherId},BAD=unsupported`,
      },
    },
    'Microsoft Store-supported X.509 attributes',
  );
  expectConfigError(
    {
      ...base,
      productIdentity: {
        ...base.productIdentity,
        publisherId: `${base.productIdentity.publisherId}+O=Acme`,
      },
    },
    'must not contain a multivalued RDN',
  );
  expectConfigError(
    {
      ...base,
      productIdentity: {
        ...base.productIdentity,
        publisherId: 'CN = 01234567-89ab-cdef-0123-456789abcdef',
      },
    },
    'must not contain whitespace around attribute separators',
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
  const languageOnlyListing = parseMicrosoftStoreSubmissionConfig({
    ...base,
    listing: {
      ...base.listing,
      locales: {
        en: base.listing.locales['en-US'],
      },
    },
  });
  assert.deepEqual(Object.keys(languageOnlyListing.listing.locales), ['en']);
  for (const legacyStoreLocale of ['prs', 'prs-AF', 'quz-PE', 'sr-Cyrl-CS']) {
    const config = parseMicrosoftStoreSubmissionConfig({
      ...base,
      listing: {
        ...base.listing,
        locales: {
          [legacyStoreLocale]: base.listing.locales['en-US'],
        },
      },
    });
    assert.deepEqual(Object.keys(config.listing.locales), [legacyStoreLocale]);
  }
  expectConfigError(
    {
      ...base,
      listing: {
        ...base.listing,
        locales: {
          'zz-ZZ': base.listing.locales['en-US'],
        },
      },
    },
    'listing locale must be supported by Microsoft Store',
  );

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

  writeJson(manifestFile, { ...validManifest, display: 'browser' });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'browser-display.json'),
      markdownFile: join(outputDir, 'browser-display.md'),
    }),
    /display must be standalone/u,
  );
  writeJson(manifestFile, {
    ...validManifest,
    icons: Array.from({ length: 33 }, () => ({
      src: './icon.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    })),
  });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'too-many-icons.json'),
      markdownFile: join(outputDir, 'too-many-icons.md'),
    }),
    /icons must contain at most 32 entries/u,
  );
  writeJson(manifestFile, {
    ...validManifest,
    icons: validManifest.icons.map((icon) => ({ ...icon, purpose: 'any maskable' })),
  });
  runMicrosoftStoreSubmissionPreflight({
    gameRoot,
    artifactRoot,
    configFile: submissionFile,
    jsonFile: join(outputDir, 'combined-icon-purposes.json'),
    markdownFile: join(outputDir, 'combined-icon-purposes.md'),
  });
  writeJson(manifestFile, {
    ...validManifest,
    icons: validManifest.icons.map((icon) => ({ ...icon, purpose: `${icon.purpose} bogus` })),
  });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'unsupported-icon-purpose.json'),
      markdownFile: join(outputDir, 'unsupported-icon-purpose.md'),
    }),
    /purpose contains an unsupported token: bogus/u,
  );
  writeJson(manifestFile, {
    ...validManifest,
    icons: validManifest.icons.filter((icon) => icon.purpose === 'any'),
  });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'missing-maskable.json'),
      markdownFile: join(outputDir, 'missing-maskable.md'),
    }),
    /must include purpose: maskable/u,
  );
  writeJson(manifestFile, {
    ...validManifest,
    icons: [
      { src: './icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'missing-192.json'),
      markdownFile: join(outputDir, 'missing-192.md'),
    }),
    /must include size: 192x192/u,
  );
  writeJson(manifestFile, validManifest);

  writeJson(manifestFile, { ...validManifest, start_url: 'https://outside.example/game' });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'absolute-start-url.json'),
      markdownFile: join(outputDir, 'absolute-start-url.md'),
    }),
    /artifact-relative URL/u,
  );
  writeJson(manifestFile, { ...validManifest, start_url: './', scope: './game/' });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'start-url-outside-scope.json'),
      markdownFile: join(outputDir, 'start-url-outside-scope.md'),
    }),
    /start_url must stay within scope/u,
  );
  writeJson(manifestFile, validManifest);

  rmSync(iconFile);
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'missing-icon.json'),
      markdownFile: join(outputDir, 'missing-icon.md'),
    }),
    /must exist/u,
  );
  writeFileSync(iconFile, Buffer.from('not a PNG'));
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'invalid-icon.json'),
      markdownFile: join(outputDir, 'invalid-icon.md'),
    }),
    /must be a valid PNG/u,
  );
  writeFileSync(iconFile, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'oversized-icon.json'),
      markdownFile: join(outputDir, 'oversized-icon.md'),
    }),
    /exceeds its maximum file size/u,
  );
  writeFileSync(iconFile, validIcon);
  writeFileSync(oversizedDecodedIconFile, createPng(2049, 2049));
  writeJson(manifestFile, {
    ...validManifest,
    icons: [
      ...validManifest.icons,
      {
        src: './icon-oversized-decoded.png',
        sizes: '2049x2049',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  });
  assert.throws(
    () => runMicrosoftStoreSubmissionPreflight({
      gameRoot,
      artifactRoot,
      configFile: submissionFile,
      jsonFile: join(outputDir, 'oversized-decoded-icon.json'),
      markdownFile: join(outputDir, 'oversized-decoded-icon.md'),
    }),
    /decoded pixel data is too large/u,
  );
  writeJson(manifestFile, validManifest);

  for (const invalidScreenshot of [
    Buffer.from('not a PNG'),
    createPngWithEmptyImageData(1366, 768),
    createPngWithUnknownCriticalChunk(1366, 768),
    createPngWithDuplicatePalette(1366, 768),
    createPngWithPalette(1366, 768, 8, 0, 1),
    createPngWithPalette(1366, 768, 1, 3, 3),
    createPngWithTrailingImageData(1366, 768),
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
      ttsxRunner,
      '--project',
      ttsxProject,
      '--no-plugins',
      '--mpgd-cli',
      cliEntry,
      'target',
      'preflight',
      'microsoft-store',
      '--targets-file',
      targetsFile,
      '--submission-file',
      submissionFile,
      '--output-dir',
      linkedOutputDirectory,
      '--kit-path',
      kitRoot,
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

  if (linkedResult.status === 0) {
    throw new Error('Symlinked output directory unexpectedly passed.');
  }
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

function createPngWithTrailingImageData(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowLength = width * 4 + 1;
  const pixels = Buffer.alloc(rowLength * height);
  const imageData = Buffer.concat([deflateSync(pixels), Buffer.from([0])]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', imageData),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createPngWithUnknownCriticalChunk(width: number, height: number): Buffer {
  const png = createPng(width, height);
  const endOffset = png.length - 12;

  return Buffer.concat([
    png.subarray(0, endOffset),
    createPngChunk('ABCD', Buffer.alloc(0)),
    png.subarray(endOffset),
  ]);
}

function createPngWithDuplicatePalette(width: number, height: number): Buffer {
  const png = createPng(width, height);
  const imageDataOffset = png.indexOf(Buffer.from('IDAT', 'ascii')) - 4;
  const palette = createPngChunk('PLTE', Buffer.from([0, 0, 0]));

  return Buffer.concat([
    png.subarray(0, imageDataOffset),
    palette,
    palette,
    png.subarray(imageDataOffset),
  ]);
}

function createPngWithPalette(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  paletteEntries: number,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  const rowLength = Math.ceil(width * bitDepth / 8) + 1;
  const pixels = Buffer.alloc(rowLength * height);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('PLTE', Buffer.alloc(paletteEntries * 3)),
    createPngChunk('IDAT', deflateSync(pixels)),
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
