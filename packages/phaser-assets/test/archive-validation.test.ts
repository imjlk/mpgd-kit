import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyZipV1Archive, ZipDecodeError } from '../src/archive-validation.js';
import { buildZipV1Fixture, type ZipV1FixtureEntry } from '../src/test-utils.js';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const fixtureEntries: readonly ZipV1FixtureEntry[] = [
  { path: 'shared/pilot.png', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), method: 'store' },
  { path: 'grove/grove.json', data: new TextEncoder().encode('{"frames":{}}'), method: 'deflate' },
];

const buildFixture = () => {
  const fixture = buildZipV1Fixture(fixtureEntries);
  return {
    archive: fixture.archive,
    expected: {
      formatVersion: 1,
      archive: { bytes: fixture.archive.length, sha256: sha256(fixture.archive) },
      entries: fixture.entries.map((entry) => ({
        path: entry.path,
        method: entry.method,
        bytes: entry.bytes,
        sha256: sha256(entry.data),
      })),
    },
  };
};

const limitsOf = (entries: readonly { bytes: number }[]): {
  archiveBytes: number;
  entryBytes: number;
  totalExpandedBytes: number;
  entryCount: number;
  maxPathLength: number;
  decodeDeadlineMs: number;
} => ({
  archiveBytes: 1024 * 1024,
  entryBytes: entries.reduce((max, entry) => Math.max(max, entry.bytes), 0),
  totalExpandedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  entryCount: entries.length,
  maxPathLength: 256,
  decodeDeadlineMs: 10_000,
});

describe('archive validation entry', () => {
  it('verifies a well-formed archive and reports entry statistics', async () => {
    const { archive, expected } = buildFixture();
    const stats = await verifyZipV1Archive(archive, expected, limitsOf(expected.entries));
    expect(stats.entries).toBe(fixtureEntries.length);
    expect(stats.expandedBytes).toBe(
      fixtureEntries.reduce((sum, entry) => sum + entry.data.byteLength, 0),
    );
  });

  it('rejects non-Uint8Array input with a typed failure', async () => {
    const { expected } = buildFixture();
    const failure = await verifyZipV1Archive(
      undefined as unknown as Uint8Array,
      expected,
      limitsOf(expected.entries),
    ).catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(ZipDecodeError);
    expect((failure as ZipDecodeError).code).toBe('invalid-structure');
  });

  it('propagates core failures with their existing codes', async () => {
    const { archive, expected } = buildFixture();
    // A tampered manifest digest must fail as archive-mismatch, exactly as
    // the runtime decode would.
    const lying = {
      ...expected,
      archive: { ...expected.archive, sha256: '0'.repeat(64) },
    };
    const failure = await verifyZipV1Archive(archive, lying, limitsOf(lying.entries))
      .catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(ZipDecodeError);
    expect((failure as ZipDecodeError).code).toBe('archive-mismatch');
  });

  it('enforces the configured entry-count limit', async () => {
    const { archive, expected } = buildFixture();
    const limits = { ...limitsOf(expected.entries), entryCount: 1 };
    const failure = await verifyZipV1Archive(archive, expected, limits)
      .catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(ZipDecodeError);
    expect((failure as ZipDecodeError).code).toBe('limit');
  });
});
