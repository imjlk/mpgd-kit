import { Deflate } from 'fflate';

import { createBoundedZipDecoder, type ArchiveWorkerExpected } from '@mpgd/phaser-assets/archives';

declare global {
  interface Window {
    __zip_worker_result: () => string;
  }
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
const sha256 = async (data: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer));
  return [...digest].map((n) => n.toString(16).padStart(2, '0')).join('');
};

/** Build a small archive matching the deterministic ZIP v1 profile. */
async function buildV1Zip(entries: readonly { path: string; data: Uint8Array; method: 'store' | 'deflate' }[]): Promise<{
  archive: Uint8Array;
  expected: ArchiveWorkerExpected;
}> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const expectedEntries: { path: string; method: 'store' | 'deflate'; bytes: number; sha256: string }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
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
    expectedEntries.push({
      path: entry.path,
      method: entry.method,
      bytes: entry.data.length,
      sha256: await sha256(entry.data),
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
    expected: {
      formatVersion: 1,
      archive: {
        bytes: archive.length,
        sha256: await sha256(archive),
      },
      entries: expectedEntries,
    },
  };
}

/** Decode a v1 archive inside a real module Worker and verify the bytes. */
export async function runZipWorkerSelfTest(): Promise<void> {
  const finish = (value: unknown): void => {
    window.__zip_worker_result = (): string => JSON.stringify(value);
  };
  try {
    const texture = new Uint8Array(1024);
    for (let index = 0; index < texture.length; index++) {
      texture[index] = (index * 31 + 7) & 0xff;
    }
    const atlas = new TextEncoder().encode('{"frames":{"ground":{"frame":{"x":0,"y":0,"w":8,"h":8}}}}');
    const fixture = await buildV1Zip([
      { path: 'grove/grove.png', data: texture, method: 'store' },
      { path: 'grove/grove.json', data: atlas, method: 'deflate' },
    ]);
    const decoder = createBoundedZipDecoder({
      createWorker: (): Worker => new Worker(new URL('./archive-decode-worker.ts', import.meta.url), { type: 'module' }),
    });
    const job = decoder.decode({
      archive: fixture.archive,
      expected: fixture.expected,
      limits: {
        archiveBytes: 1024 * 1024,
        entryBytes: 1024 * 1024,
        totalExpandedBytes: 4 * 1024 * 1024,
        entryCount: 16,
        maxPathLength: 256,
        decodeDeadlineMs: 10000,
      },
    });
    const received: { path: string; bytes: Uint8Array }[] = [];
    for await (const entry of job.entries) {
      received.push({ path: entry.path, bytes: entry.bytes });
    }
    const status = await job.result;
    if (received.length !== 2 || status.status !== 'completed') {
      throw new Error(`worker decode did not complete: ${JSON.stringify(status)}`);
    }
    if (received[0]!.path !== 'grove/grove.png' || !received[0]!.bytes.every((byte, index) => byte === texture[index])) {
      throw new Error('texture bytes differ');
    }
    if (received[1]!.path !== 'grove/grove.json' || received[1]!.bytes.length !== atlas.length) {
      throw new Error('atlas bytes differ');
    }
    finish({
      status: 'passed', entries: received.length, expandedBytes: status.stats?.expandedBytes,
    });
  } catch (error) {
    finish({
      status: 'failed', error: String(error),
    });
  }
}
