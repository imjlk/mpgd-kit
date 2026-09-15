import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { defaultArchiveWorkerLimits } from '../src/archive-protocol.js';
import {
  decodeZipV1Entries,
  type ExpectedZipArchive,
  type ExpectedZipEntry,
  type ZipDecodeLimits,
} from '../src/archive-zip-core.js';
import { buildZipV1Fixture, type ZipV1FixtureEntry } from '../src/test-utils.js';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
type ZipFixture = { readonly archive: Uint8Array; readonly expected: ExpectedZipArchive };

/** Wrap the shared fixture builder with manifest-side digests. */
function buildV1Zip(entries: readonly ZipV1FixtureEntry[]): {
  readonly archive: Uint8Array;
  readonly expected: ExpectedZipArchive;
} {
  const fixture = buildZipV1Fixture(entries);
  return {
    archive: fixture.archive,
    expected: {
      formatVersion: 1,
      archive: {
        bytes: fixture.archive.length,
        sha256: sha256(fixture.archive),
      },
      entries: fixture.entries.map((entry): ExpectedZipEntry => ({
        path: entry.path,
        method: entry.method,
        bytes: entry.bytes,
        sha256: sha256(entry.data),
      })),
    },
  };
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const jsonBytes = new TextEncoder().encode(`${JSON.stringify({ frames: { ground: {} } })}\n`);
const mixedEntries = [
  { path: 'grove/grove.png', data: pngBytes, method: 'store' as const },
  { path: 'grove/grove.json', data: jsonBytes, method: 'deflate' as const },
];
const limits = (overrides: Partial<ZipDecodeLimits> = {}): ZipDecodeLimits => ({
  ...defaultArchiveWorkerLimits(),
  ...overrides,
});
const collect = async (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }, options: Parameters<typeof decodeZipV1Entries>[3] = {}, limitOverrides: Partial<ZipDecodeLimits> = {}): Promise<{ path: string; bytes: Uint8Array }[]> => {
  const output: { path: string; bytes: Uint8Array }[] = [];
  for await (const entry of decodeZipV1Entries(
    fixture.archive,
    fixture.expected,
    limits(limitOverrides),
    options,
  )) {
    output.push({
      path: entry.path,
      bytes: entry.bytes,
    });
  }
  return output;
};

describe('bounded ZIP decode core', () => {
  it('round-trips mixed STORE and DEFLATE entries with intact bytes', async () => {
    const output = await collect(buildV1Zip(mixedEntries));
    expect(output.map((entry) => entry.path)).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect(Buffer.from(output[0]!.bytes).equals(Buffer.from(pngBytes))).toBe(true);
    expect(Buffer.from(output[1]!.bytes).equals(Buffer.from(jsonBytes))).toBe(true);
  });

  it('rejects archive length and digest mismatches before decoding', async () => {
    const fixture = buildV1Zip(mixedEntries);
    await expect(collect({
      archive: fixture.archive.slice(0, fixture.archive.length - 1),
      expected: fixture.expected,
    })).rejects.toMatchObject({ code: 'archive-mismatch' });
    const flipped = fixture.archive.slice();
    flipped[0] = flipped[0]! ^ 0xff;
    await expect(collect({
      archive: flipped,
      expected: fixture.expected,
    })).rejects.toMatchObject({ code: 'archive-mismatch' });
  });

  it('rejects unsupported format versions', async () => {
    const fixture = buildV1Zip(mixedEntries);
    await expect((async () => {
      for await (const _entry of decodeZipV1Entries(fixture.archive, {
        ...fixture.expected,
        formatVersion: 2,
      }, limits())) {
        void _entry;
      }
    })()).rejects.toMatchObject({ code: 'unsupported-zip' });
  });

  it.each([
    ['encrypted entry flag', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      mutated[fullOffset(fixture) + 8] = 0x09;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['unsupported compression method', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      const offset = fullOffset(fixture);
      mutated[offset + 10] = 12;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['ZIP64 marker counts', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      const endOffset = mutated.length - 22;
      mutated[endOffset + 10] = 0xff;
      mutated[endOffset + 11] = 0xff;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['truncated archive', (fixture: ZipFixture): ZipFixture => ({
      archive: fixture.archive.slice(0, fixture.archive.length - 30),
      expected: fixture.expected,
    })],
    ['corrupt end record', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      mutated[mutated.length - 22] = 0;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['central/local size contradiction', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      mutated[30 + 22] = 0x7f;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['entry bytes contradicting the central directory', (fixture: { archive: Uint8Array; expected: ExpectedZipArchive }): { archive: Uint8Array; expected: ExpectedZipArchive } => {
      const mutated = fixture.archive.slice();
      mutated[30 + 5] = mutated[30 + 5]! ^ 0xff;
      return { archive: mutated, expected: fixture.expected };
    }],
  ])('rejects %s', async (_name, mutate) => {
    const fixture = mutate(buildV1Zip(mixedEntries));
    await expect(collect(fixture)).rejects.toThrow(/ZIP/u);
  });

  it.each([
    ['traversal entry', ['../escape.png']],
    ['absolute entry', ['/abs.png']],
    ['duplicate entries', ['grove/a.png', 'grove/a.png']],
  ])('rejects %s', async (_name, paths) => {
    const fixture = buildV1Zip(paths.map((path) => ({
      path, data: pngBytes, method: 'store' as const,
    })));
    await expect(collect(fixture)).rejects.toThrow(/ZIP/u);
  });

  it('rejects unexpected, missing and reordered entries against the manifest', async () => {
    const fixture = buildV1Zip(mixedEntries);
    await expect(collect({
      archive: fixture.archive,
      expected: {
        ...fixture.expected,
        entries: [fixture.expected.entries[1]!, fixture.expected.entries[0]!],
      },
    })).rejects.toMatchObject({ code: 'entry-mismatch' });
    await expect(collect({
      archive: fixture.archive,
      expected: {
        ...fixture.expected,
        entries: fixture.expected.entries.slice(0, 1),
      },
    })).rejects.toMatchObject({ code: 'entry-mismatch' });
  });

  it('counts expanded output while inflating and applies the entry limit', async () => {
    const bomb = new Uint8Array(64 * 1024);
    const fixture = buildV1Zip([{ path: 'bomb.json', data: bomb, method: 'deflate' }]);
    await expect(collect(fixture, {}, { entryBytes: 1024, totalExpandedBytes: 4096 })).rejects.toMatchObject({ code: 'limit' });
  });

  it('applies the total expanded limit across entries after partial output', async () => {
    const fixture = buildV1Zip([
      { path: 'a.bin', data: new Uint8Array(4096), method: 'store' as const },
      { path: 'b.bin', data: new Uint8Array(4096), method: 'store' as const },
    ]);
    const decoded: { path: string; bytes: Uint8Array }[] = [];
    await expect((async () => {
      for await (const entry of decodeZipV1Entries(
        fixture.archive,
        fixture.expected,
        limits({ totalExpandedBytes: 5000 }),
      )) {
        decoded.push({ path: entry.path, bytes: entry.bytes });
      }
    })()).rejects.toMatchObject({ code: 'limit' });
    expect(decoded).toHaveLength(1);
  });

  it('enforces the deadline between entries and inflate chunks', async () => {
    const fixture = buildV1Zip([
      { path: 'zeros.bin', data: new Uint8Array(256 * 1024), method: 'deflate' as const },
    ]);
    let clock = 0;
    const output: string[] = [];
    await expect((async () => {
      for await (const entry of decodeZipV1Entries(fixture.archive, fixture.expected, limits({ decodeDeadlineMs: 10 }), {
        now: (): number => (clock += 100),
      })) {
        output.push(entry.path);
      }
    })()).rejects.toMatchObject({ code: 'deadline' });
    expect(output).toEqual([]);
  });

  it('stops when the consumer cancels without publishing later entries as success', async () => {
    const fixture = buildV1Zip(mixedEntries);
    const seen: string[] = [];
    await expect((async () => {
      for await (const entry of decodeZipV1Entries(fixture.archive, fixture.expected, limits(), {
        shouldStop: (): boolean => seen.length > 0,
      })) {
        seen.push(entry.path);
      }
    })()).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen).toEqual(['grove/grove.png']);
  });

  it('rejects entries whose expanded digest or size differs from the manifest', async () => {
    const fixture = buildV1Zip(mixedEntries);
    const lying: ExpectedZipArchive = {
      ...fixture.expected,
      entries: fixture.expected.entries.map((entry) => ({
        ...entry, sha256: entry.sha256.slice(0, 63) + (entry.sha256.endsWith('0') ? '1' : '0'),
      })),
    };
    await expect(collect({
      archive: fixture.archive, expected: lying,
    })).rejects.toMatchObject({ code: 'integrity' });
    const lyingBytes: ExpectedZipArchive = {
      ...fixture.expected,
      entries: fixture.expected.entries.map((entry) => ({
        ...entry, bytes: entry.bytes + 1,
      })),
    };
    await expect(collect({
      archive: fixture.archive, expected: lyingBytes,
    })).rejects.toMatchObject({ code: 'entry-mismatch' });
  });

  it('rejects nonzero central directory internal attributes', async () => {
    const fixture = buildV1Zip(mixedEntries);
    const mutated = fixture.archive.slice();
    mutated[fullOffset(fixture) + 36] = 1;
    const refreshed: ExpectedZipArchive = {
      ...fixture.expected,
      archive: {
        ...fixture.expected.archive,
        sha256: sha256(mutated),
      },
    };
    await expect(collect({
      archive: mutated, expected: refreshed,
    })).rejects.toMatchObject({ code: 'invalid-structure' });
  });

  it('rejects a STORE entry larger than the total allowance without copying it', async () => {
    const fixture = buildV1Zip([
      { path: 'big.bin', data: new Uint8Array(4096), method: 'store' as const },
    ]);
    await expect(collect(fixture, {}, { totalExpandedBytes: 100 })).rejects.toMatchObject({ code: 'limit' });
  });

  it('rejects STORE entries whose stored size differs from the declared size', async () => {
    const fixture = buildV1Zip(mixedEntries);
    const mutated = fixture.archive.slice();
    const view = new DataView(mutated.buffer);
    // Entry 0 is STORE: lie about its uncompressed size in both headers while
    // the expected manifest repeats the lie, so only the size check can fire.
    view.setUint32(22, pngBytes.length + 1, true);
    const centralOffset = fullOffset(fixture);
    view.setUint32(centralOffset + 24, pngBytes.length + 1, true);
    const lying: ExpectedZipArchive = {
      ...fixture.expected,
      archive: {
        ...fixture.expected.archive,
        sha256: sha256(mutated),
      },
      entries: fixture.expected.entries.map((entry, index) => index === 0
        ? { ...entry, bytes: pngBytes.length + 1 }
        : entry),
    };
    await expect(collect({
      archive: mutated, expected: lying,
    })).rejects.toMatchObject({ code: 'invalid-structure' });
  });

  it('decodes multi-megabyte incompressible deflate entries promptly', async () => {
    // A nonrepeating LCG stream so DEFLATE cannot shrink it.
    const payload = new Uint8Array(4 * 1024 * 1024);
    let state = 0x2f6e2b1 >>> 0;
    for (let index = 0; index < payload.length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      payload[index] = (state >>> 23) & 0xff;
    }
    const fixture = buildV1Zip([{ path: 'big.bin', data: payload, method: 'deflate' }]);
    const started = Date.now();
    const output = await collect(fixture, {}, { decodeDeadlineMs: 15000 });
    expect(output[0]!.bytes.length).toBe(payload.length);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('rejects malformed numeric limits before decoding', async () => {
    const fixture = buildV1Zip(mixedEntries);
    for (const overrides of [
      { entryBytes: Number.NaN },
      { totalExpandedBytes: Number.NaN },
      { archiveBytes: Number.NaN },
      { entryCount: 0 },
      { maxPathLength: 0 },
      { decodeDeadlineMs: -1 },
      { archiveBytes: 1.5 },
    ]) {
      await expect(collect(fixture, {}, overrides)).rejects.toMatchObject({ code: 'limit' });
    }
  });

  it('requires a secure context for SHA-256 verification', async () => {
    const subtle = crypto.subtle;
    vi.stubGlobal('crypto', { });
    try {
      await expect(collect(buildV1Zip(mixedEntries))).rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      vi.stubGlobal('crypto', { subtle });
    }
  });
});

/** Offset of the first central directory entry, to mutate its header fields. */
function fullOffset(fixture: ZipFixture): number {
  return fixture.archive.length - 22 - fixture.expected.entries.reduce((total, entry) => {
    return total + 46 + Buffer.byteLength(entry.path);
  }, 0);
}
