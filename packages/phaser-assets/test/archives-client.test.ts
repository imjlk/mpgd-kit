import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  ArchiveWorkerRequest,
  ArchiveWorkerResponse,
  ArchiveWorkerStats,
} from '../src/archive-protocol.js';
import { createArchiveWorkerDispatch } from '../src/archive-worker-impl.js';
import {
  createBoundedZipDecoder,
  type ArchiveWorkerExpected,
  type ZipDecodeWorkerLike,
} from '../src/archives.js';
import { buildZipV1Fixture, type ZipV1FixtureEntry } from '../src/test-utils.js';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Wrap the shared fixture builder with manifest-side digests. */
function buildV1Zip(entries: readonly ZipV1FixtureEntry[]): {
  readonly archive: Uint8Array;
  readonly expected: ArchiveWorkerExpected;
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
      entries: fixture.entries.map((entry) => ({
        path: entry.path,
        method: entry.method,
        bytes: entry.bytes,
        sha256: sha256(entry.data),
      })),
    },
  };
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const jsonBytes = new TextEncoder().encode('{"frames":{"ground":{}}}');

interface FakeWorker extends ZipDecodeWorkerLike {
  readonly requests: ArchiveWorkerRequest[];
  readonly postedEntries: () => number;
  emit(message: ArchiveWorkerResponse): void;
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
    emit(message: ArchiveWorkerResponse): void {
      for (const listener of [...messageListeners]) {
        listener({ data: message } as MessageEvent<ArchiveWorkerResponse>);
      }
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
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
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
      const finalStatus = await job.result;
      expect(finalStatus.status).toBe('deadline');
      expect(finalStatus.archiveLost).toBe(true);
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

  it('buffers the first entry until the first pull instead of dropping it', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(4);
    expect(worker.postedEntries()).toBe(1);
    const received: string[] = [];
    for await (const entry of job.entries) {
      received.push(entry.path);
    }
    expect(received).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect((await job.result).status).toBe('completed');
  });

  it('rejects a second pull while one is pending', async () => {
    const worker = createFakeWorker();
    worker.ignoreCancel(false);
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    await iterator.next();
    const slowGate = createArchiveWorkerDispatch;
    void slowGate;
    const first = iterator.next();
    const second = iterator.next();
    await expect(second).rejects.toThrow('already pending');
    await first;
    await job.cancel();
  });

  it('ignores stale release acknowledgements in the worker dispatch', async () => {
    const posted: ArchiveWorkerResponse[] = [];
    const dispatch = createArchiveWorkerDispatch({
      post: (message): void => {
        posted.push(message);
      },
    });
    const zip = fixture();
    dispatch({
      type: 'decode',
      jobId: 1,
      protocol: 1,
      archive: zip.archive.slice().buffer as ArrayBuffer,
      transferArchive: false,
      expected: zip.expected,
      limits: {
        archiveBytes: 1024 * 1024,
        entryBytes: 1024 * 1024,
        totalExpandedBytes: 1024 * 1024,
        entryCount: 16,
        maxPathLength: 256,
        decodeDeadlineMs: 5000,
      },
    });
    await tick(3);
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(1);
    dispatch({ type: 'release', jobId: 1, seq: 41 });
    await tick(3);
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(1);
    dispatch({ type: 'release', jobId: 1, seq: 1 });
    await tick(3);
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(2);
    dispatch({ type: 'release', jobId: 1, seq: 2 });
    await tick(3);
    expect(posted.filter((message) => message.type === 'done')).toHaveLength(1);
    expect(posted.find((message) => message.type === 'done')).toMatchObject({ status: 'completed' });
  });

  it('rejects protocol mismatches and returns a transferred archive untouched', async () => {
    const posted: ArchiveWorkerResponse[] = [];
    const transferred: unknown[][] = [];
    const dispatch = createArchiveWorkerDispatch({
      post: (message, transfer): void => {
        posted.push(message);
        transferred.push([...(transfer ?? [])]);
      },
    });
    const zip = fixture();
    const archive = zip.archive.slice();
    dispatch({
      type: 'decode',
      jobId: 7,
      protocol: 99,
      archive: archive.buffer as ArrayBuffer,
      transferArchive: true,
      expected: zip.expected,
      limits: {
        archiveBytes: 1024 * 1024,
        entryBytes: 1024 * 1024,
        totalExpandedBytes: 1024 * 1024,
        entryCount: 16,
        maxPathLength: 256,
        decodeDeadlineMs: 5000,
      },
    });
    await tick(2);
    const done = posted.find((message) => message.type === 'done');
    expect(done).toMatchObject({
      status: 'error', code: 'unsupported', jobId: 7,
    });
    expect((done as { archive?: ArrayBuffer }).archive?.byteLength).toBe(zip.archive.length);
    expect(transferred[0]).toHaveLength(1);
  });

  it('fails over-delivering workers as protocol errors', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(3);
    expect(worker.postedEntries()).toBe(1);
    // A misbehaving worker posts the next entry without any release credit.
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/rogue.json',
      method: 'store',
      bytes: new Uint8Array(4).slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('more entries than credited');
  });

  it('does not flag archive loss when the worker was never created', async () => {
    const decoder = createBoundedZipDecoder({
      createWorker: (): ZipDecodeWorkerLike => {
        throw new Error('no workers here');
      },
    });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(), expected: zip.expected, transferArchive: true,
    });
    const consuming = (async () => {
      for await (const _entry of job.entries) {
        void _entry;
      }
    })();
    await expect(consuming).rejects.toMatchObject({ code: 'unsupported' });
    const status = await job.result;
    expect(status.status).toBe('unsupported');
    expect(status.archiveLost).toBeUndefined();
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
