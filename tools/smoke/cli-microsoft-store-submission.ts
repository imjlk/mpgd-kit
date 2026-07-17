import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseMicrosoftStoreSubmissionConfig } from '../../packages/cli/src/index';

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
  writeFileSync(screenshotFile, 'fixture screenshot');
  writeJson(targetsFile, {
    targets: {
      'microsoft-store': {
        kind: 'web',
        gameApp: '.',
        adapter: 'browser',
        output: 'artifacts/microsoft-store',
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
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );

  assert.equal(
    result.status,
    0,
    `CLI fixture failed:\n${result.stderr || result.stdout || '(no output)'}`,
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
    readonly listing: { readonly locales: Record<string, unknown> };
    readonly commerce: { readonly mode: string };
    readonly warnings: readonly string[];
  };
  assert.equal(evidence.target, 'microsoft-store');
  assert.equal(evidence.manifest.id, 'com.acme.fixture-game');
  assert.deepEqual(Object.keys(evidence.listing.locales), ['en-US']);
  assert.equal(evidence.commerce.mode, 'disabled');
  assert.deepEqual(evidence.warnings, []);
  assert.match(
    readFileSync(join(outputDir, 'submission-preflight.md'), 'utf8'),
    /# Microsoft Store Submission Preflight/u,
  );

  expectConfigError(
    {
      ...validConfig(),
      productIdentity: {
        ...validConfig().productIdentity,
        packageId: 'REPLACE_ME',
      },
    },
    'placeholder content',
  );
  expectConfigError(
    {
      ...validConfig(),
      listing: {
        ...validConfig().listing,
        personalData: { accessedOrTransmitted: true },
      },
    },
    'privacyPolicyUrl is required',
  );
  expectConfigError(
    {
      ...validConfig(),
      commerce: { mode: 'microsoft-store' },
    },
    'server-side ledger verification',
  );
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
