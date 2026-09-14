import { Deflate } from 'fflate';

import type { ArchiveZipEntryMethod } from './archive-protocol.js';

/**
 * Browser-compatible fixture builder for the deterministic ZIP v1 delivery
 * profile. Shared by this package's tests and by consumers (the sample app)
 * so every validation exercises the same archive shape: STORE and DEFLATE
 * entries, fixed 1980-01-01 DOS timestamp, 0644 regular files, UTF-8 name
 * flag, no extra fields or comments. Digests are left to the caller because
 * environments hash differently.
 */
export interface ZipV1FixtureEntry {
  readonly path: string;
  readonly data: Uint8Array;
  readonly method: ArchiveZipEntryMethod;
}
export interface ZipV1Fixture {
  readonly archive: Uint8Array;
  readonly entries: readonly {
    readonly path: string;
    readonly method: ArchiveZipEntryMethod;
    readonly bytes: number;
    readonly data: Uint8Array;
  }[];
}
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
/** fflate exposes raw DEFLATE compression only as a stream class. */
export const deflateRaw = (data: Uint8Array): Uint8Array => {
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
export const zipV1Crc32 = crc32Of;
export function buildZipV1Fixture(entries: readonly ZipV1FixtureEntry[]): ZipV1Fixture {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const described: {
    path: string;
    method: ArchiveZipEntryMethod;
    bytes: number;
    data: Uint8Array;
  }[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const stored = entry.method === 'deflate' ? deflateRaw(entry.data) : entry.data;
    const crc = crc32Of(entry.data);
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0x0800, true);
    localHeader.setUint16(8, entry.method === 'deflate' ? 8 : 0, true);
    localHeader.setUint16(10, 0, true);
    localHeader.setUint16(12, 0x0021, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, stored.length, true);
    localHeader.setUint32(22, entry.data.length, true);
    localHeader.setUint16(26, name.length, true);
    localHeader.setUint16(28, 0, true);
    local.push(new Uint8Array(localHeader.buffer), name, stored);
    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 0x0300, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0x0800, true);
    centralHeader.setUint16(10, entry.method === 'deflate' ? 8 : 0, true);
    centralHeader.setUint16(12, 0, true);
    centralHeader.setUint16(14, 0x0021, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, stored.length, true);
    centralHeader.setUint32(24, entry.data.length, true);
    centralHeader.setUint16(28, name.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, (0o100644 << 16) >>> 0, true);
    centralHeader.setUint32(42, offset, true);
    central.push(new Uint8Array(centralHeader.buffer), name);
    described.push({
      path: entry.path,
      method: entry.method,
      bytes: entry.data.length,
      data: entry.data,
    });
    offset += 30 + name.length + stored.length;
  }
  let centralSize = 0;
  for (const chunk of central) {
    centralSize += chunk.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const chunk of [...local, ...central, new Uint8Array(end.buffer)]) {
    archive.set(chunk, position);
    position += chunk.length;
  }
  return {
    archive,
    entries: described,
  };
}
