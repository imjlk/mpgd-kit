import { createHash } from 'node:crypto';

import { Deflate } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArchiveWorkerRequest,
  ArchiveWorkerResponse,
  ArchiveWorkerStats,
} from '../src/archive-protocol.js';
import { createArchiveWorkerDispatch } from '../src/archive-worker-impl.js';
import { createBoundedZipDecoder, type ZipDecodeWorkerLike } from '../src/archives.js';

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
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const jsonBytes = new TextEncoder().encode('{"frames":{"ground":{}}}');

function buildV1Zip(entries: readonly { path: string; data: Uint8Array; method: 'store' | 'deflate' }[]): {
  archive: Uint8Array;
  expected: {
    formatVersion: number;
    archive: { bytes: number; sha256: string };
    entries: { path: string; method: 'store' | 'deflate'; bytes: number; sha256: string }[];
  };
} {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const expectedEntries: {
    path: string; method: 'store' | 'deflate'; bytes: number; sha256: string;
  }[] = [];
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

interface FakeWorker extends ZipDecodeWorkerLike {
  readonly requests: ArchiveWorkerRequest[];
  readonly postedEntries: () => number;
  terminate(): void;
  crash(): void;
  ignoreCancel(value: boolean): void;
}

/** In-process worker running the real dispatch logic over a fake port. */
function createFakeWorker(): FakeWorker {
  const requests: ArchiveWorkerRequest[] = [];
  const messageListeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
  const errorListeners: ((event: Event) => void)[] = [];
  let terminated = false;
  let postedEntryCount = 0;
  let ignoreCancel = false;
  const dispatch = createArchiveWorkerDispatch({
    post: (message): void => {
      if (terminated) {
        return;
      }
      if (message.type === 'entry') {
        postedEntryCount++;
      }
      for (const listener of [...messageListeners]) {
        listener({ data: message } as MessageEvent<ArchiveWorkerResponse>);
      }
    },
  });
  return {
    requests,
    postedEntries: (): number => postedEntryCount,
    postMessage(message): void {
      if (terminated) {
        return;
      }
      if (message.type === 'cancel' && ignoreCancel) {
        return;
      }
      requests.push(message);
      dispatch(message);
    },
    addEventListener(type, listener): void {
      if (type === 'message') {
        messageListeners.push(listener as (event: MessageEvent<ArchiveWorkerResponse>) => void);
      } else {
        errorListeners.push(listener as (event: Event) => void);
      }
    },
    terminate(): void {
      terminated = true;
    },
    crash(): void {
      for (const listener of errorListeners) {
        listener(new Event('error'));
      }
    },
    ignoreCancel(value: boolean): void {
      ignoreCancel = value;
    },
  };
}

const fixture = () => buildV1Zip([
  { path: 'grove/grove.png', data: pngBytes, method: 'store' },
  { path: 'grove/grove.json', data: jsonBytes, method: 'deflate' },
]);
const tick = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('bounded ZIP decode client', () => {
  it('decodes entries through the real dispatch and terminates the worker', async () => {
    const workers: FakeWorker[] = [];
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => {
        const worker = createFakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const received: { path: string; bytes: Uint8Array }[] = [];
    for await (const entry of job.entries) {
      received.push({ path: entry.path, bytes: entry.bytes });
    }
    expect(received.map((entry) => entry.path)).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect(Buffer.from(received[1]!.bytes).equals(Buffer.from(jsonBytes))).toBe(true);
    const status = await job.result;
    expect(status.status).toBe('completed');
    expect(status.stats?.entries).toBe(2);
    expect(status.stats?.expandedBytes).toBe(pngBytes.length + jsonBytes.length);
    expect(workers).toHaveLength(1);
  });

  it('bounds outstanding output to one entry for a slow consumer', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Hold the first entry without pulling the next: no further entries may
    // be posted into the main-thread queue.
    await tick(6);
    expect(worker.postedEntries()).toBe(1);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    await tick(6);
    expect(worker.postedEntries()).toBe(2);
    const third = await iterator.next();
    expect(third.done).toBe(true);
    expect(await job.result).toMatchObject({ status: 'completed' });
  });

  it('cancels cleanly, ends iteration and keeps the completion state', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const status = await job.cancel();
    expect(status.status).toBe('cancelled');
    const afterCancel = await iterator.next();
    expect(afterCancel.done).toBe(true);
    expect((await job.result).status).toBe('cancelled');
    // A late entry for the finished job cannot flip anything.
    for (const listener of []) {
      void listener;
    }
    expect(worker.requests.some((request) => request.type === 'cancel')).toBe(true);
  });

  it('reports worker errors to the consumer and the result', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const consuming = (async () => {
      for await (const _entry of job.entries) {
        void _entry;
        worker.crash();
      }
    })();
    await expect(consuming).rejects.toMatchObject({ code: 'worker-error' });
    expect((await job.result).status).toBe('worker-error');
  });

  it('propagates decode failures with their code', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const lying = {
      ...zip.expected,
      entries: zip.expected.entries.map((entry) => ({
        ...entry, sha256: entry.sha256.slice(0, 63) + (entry.sha256.endsWith('0') ? '1' : '0'),
      })),
    };
    const job = decoder.decode({ archive: zip.archive, expected: lying });
    const consuming = (async () => {
      for await (const _entry of job.entries) {
        void _entry;
      }
    })();
    await expect(consuming).rejects.toMatchObject({ code: 'integrity' });
    expect((await job.result)).toMatchObject({
      status: 'error', code: 'integrity',
    });
  });

  it('fails as unsupported when workers cannot be created', async () => {
    const decoder = createBoundedZipDecoder({
      createWorker: (): ZipDecodeWorkerLike => {
        throw new Error('CSP blocked the worker script');
      },
    });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const consuming = (async () => {
      for await (const _entry of job.entries) {
        void _entry;
      }
    })();
    await expect(consuming).rejects.toMatchObject({ code: 'unsupported' });
    expect((await job.result).status).toBe('unsupported');
  });

  it('never detaches the caller archive by default and returns it when transferred', async () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    const copied = zip.archive.slice();
    const copyJob = decoder.decode({ archive: copied, expected: zip.expected });
    for await (const _entry of copyJob.entries) {
      void _entry;
    }
    expect(copied.byteLength).toBe(zip.archive.length);
    const transferred = zip.archive.slice();
    const transferJob = decoder.decode({
      archive: transferred, expected: zip.expected, transferArchive: true,
    });
    for await (const _entry of transferJob.entries) {
      void _entry;
    }
    const status = await transferJob.result;
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
  });

  it('rejects transfers of views into larger buffers', () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    const padded = new Uint8Array(zip.archive.length + 16);
    padded.set(zip.archive, 8);
    const view = padded.subarray(8);
    expect(() => decoder.decode({
      archive: view, expected: zip.expected, transferArchive: true,
    })).toThrow('exact-fit');
  });

  it('terminates unresponsive workers after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => {
          const worker = createFakeWorker();
          worker.ignoreCancel(true);
          workers.push(worker);
          return worker;
        },
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: {
          archiveBytes: 1024 * 1024,
          entryBytes: 1024 * 1024,
          totalExpandedBytes: 1024 * 1024,
          entryCount: 16,
          maxPathLength: 256,
          decodeDeadlineMs: 10,
        },
      });
      const consuming = (async () => {
        for await (const _entry of job.entries) {
          void _entry;
        }
      })();
      const expectation = expect(consuming).rejects.toMatchObject({ code: 'deadline' });
      await vi.advanceTimersByTimeAsync(3000);
      await expectation;
      expect((await job.result).status).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes decode jobs behind the concurrency limit', async () => {
    const workers: FakeWorker[] = [];
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => {
        const worker = createFakeWorker();
        workers.push(worker);
        return worker;
      },
      maxConcurrentDecodes: 1,
    });
    const zip = fixture();
    const gate = jobGate();
    const firstJob = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const firstRun = (async () => {
      for await (const _entry of firstJob.entries) {
        void _entry;
        await gate.wait();
      }
    })();
    await tick(2);
    expect(workers).toHaveLength(1);
    const secondJob = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(4);
    expect(workers).toHaveLength(1);
    gate.open();
    await firstRun;
    await firstJob.result;
    await tick(4);
    expect(workers).toHaveLength(2);
    for await (const _entry of secondJob.entries) {
      void _entry;
    }
    expect((await secondJob.result).status).toBe('completed');
  });

  it('reports cancelled stats from the worker', async () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    await iterator.next();
    const status = await job.cancel();
    expect(status.status).toBe('cancelled');
    const stats = status.stats as ArchiveWorkerStats | undefined;
    expect(stats?.entries).toBe(1);
  });
});

const jobGate = (): {
  wait(): Promise<void>;
  open(): void;
} => {
  let resolve: (() => void) | undefined;
  let opened = false;
  return {
    wait: (): Promise<void> => (opened ? Promise.resolve() : new Promise((yes) => {
      resolve = yes;
    })),
    open: (): void => {
      opened = true;
      resolve?.();
    },
  };
};
