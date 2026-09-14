import { createHash } from 'node:crypto';

import { Deflate } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { defaultArchiveWorkerLimits } from '../src/archive-protocol.js';
import {
  decodeZipV1Entries,
  type ExpectedZipArchive,
  type ExpectedZipEntry,
  type ZipDecodeLimits,
} from '../src/archive-zip-core.js';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const crcTable: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
const crc32Of = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface ZipFixture {
  readonly archive: Uint8Array;
  readonly expected: ExpectedZipArchive;
}

/** fflate exposes raw DEFLATE compression only as a stream class. */
const deflateRaw = (data: Uint8Array): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const deflator = new Deflate({ level: 9 }, (chunk) => {
    chunks.push(chunk);
  });
  deflator.push(data, true);
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const joined = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    joined.set(chunk, position);
    position += chunk.length;
  }
  return joined;
};

/** Build a ZIP that matches the deterministic writer's v1 profile exactly. */
function buildV1Zip(
  entries: readonly { readonly path: string; readonly data: Uint8Array; readonly method: 'store' | 'deflate' }[],
): ZipFixture {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const expectedEntries: ExpectedZipEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const stored = entry.method === 'deflate'
      ? Buffer.from(deflateRaw(entry.data))
      : Buffer.from(entry.data);
    const crc = crc32Of(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(entry.method === 'deflate' ? 8 : 0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(stored.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, stored);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0300, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(entry.method === 'deflate' ? 8 : 0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(stored.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    expectedEntries.push({
      path: entry.path,
      method: entry.method,
      bytes: entry.data.length,
      sha256: sha256(entry.data),
    });
    offset += 30 + name.length + stored.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const archive = new Uint8Array(Buffer.concat([...local, centralDirectory, end]));
  return {
    archive,
    expected: {
      formatVersion: 1,
      archive: {
        bytes: archive.length,
        sha256: sha256(archive),
      },
      entries: expectedEntries,
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
const collect = async (fixture: ZipFixture, options: Parameters<typeof decodeZipV1Entries>[3] = {}, limitOverrides: Partial<ZipDecodeLimits> = {}): Promise<{ path: string; bytes: Uint8Array }[]> => {
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
    ['encrypted entry flag', (fixture: ZipFixture): ZipFixture => {
      const mutated = fixture.archive.slice();
      mutated[fullOffset(fixture) + 8] = 0x09;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['unsupported compression method', (fixture: ZipFixture): ZipFixture => {
      const mutated = fixture.archive.slice();
      const offset = fullOffset(fixture);
      mutated[offset + 10] = 12;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['ZIP64 marker counts', (fixture: ZipFixture): ZipFixture => {
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
    ['corrupt end record', (fixture: ZipFixture): ZipFixture => {
      const mutated = fixture.archive.slice();
      mutated[mutated.length - 22] = 0;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['central/local size contradiction', (fixture: ZipFixture): ZipFixture => {
      const mutated = fixture.archive.slice();
      mutated[30 + 22] = 0x7f;
      return { archive: mutated, expected: fixture.expected };
    }],
    ['entry bytes contradicting the central directory', (fixture: ZipFixture): ZipFixture => {
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
