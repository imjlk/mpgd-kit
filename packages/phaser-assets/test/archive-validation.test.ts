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

  it('accepts views whose @@toStringTag is overridden', async () => {
    // The brand probe must read the view's internal slot, not the
    // user-customizable tag.
    const { archive, expected } = buildFixture();
    const view = new Uint8Array(archive);
    Object.defineProperty(view, Symbol.toStringTag, { value: 'DeliberatelyOpaque' });
    const stats = await verifyZipV1Archive(view, expected, limitsOf(expected.entries));
    expect(stats.entries).toBe(fixtureEntries.length);
  });

  it('rejects non-view input through the slot-based guard', async () => {
    const { archive, expected } = buildFixture();
    // A plain object shaped like a view — even carrying a genuine
    // ArrayBuffer in `buffer` and a length that satisfies the core's
    // size gate — is rejected by the [[ViewedArrayBuffer]] slot check.
    const fake = {
      length: expected.archive.bytes,
      buffer: archive.buffer,
      byteOffset: archive.byteOffset,
    } as unknown as Uint8Array;
    const failure = await verifyZipV1Archive(fake, expected, limitsOf(expected.entries))
      .catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(ZipDecodeError);
    expect((failure as ZipDecodeError).code).toBe('invalid-structure');
    const nonView = await verifyZipV1Archive(
      {} as unknown as Uint8Array,
      expected,
      limitsOf(expected.entries),
    ).catch((error: unknown): unknown => error);
    expect((nonView as ZipDecodeError).code).toBe('invalid-structure');
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
