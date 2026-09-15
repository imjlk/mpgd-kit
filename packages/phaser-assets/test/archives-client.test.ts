import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  defaultArchiveWorkerLimits,
  type ArchiveWorkerLimits,
  type ArchiveWorkerRequest,
  type ArchiveWorkerResponse,
  type ArchiveWorkerStats,
  type ArchiveWorkerStatus,
  type ArchiveZipEntryMethod,
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
  throwOnCancelPost(value: boolean): void;
  throwOnReleasePost(value: boolean): void;
  blackhole(): void;
}

/** In-process worker running the real dispatch logic over a fake port. */
function createFakeWorker(): FakeWorker {
  const requests: ArchiveWorkerRequest[] = [];
  const messageListeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
  const errorListeners: ((event: Event) => void)[] = [];
  let terminated = false;
  let postedEntryCount = 0;
  let ignoreCancel = false;
  let throwCancelPost = false;
  let throwReleasePost = false;
  let silent = false;
  const dispatch = createArchiveWorkerDispatch({
    post: (message): void => {
      if (terminated || silent) {
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
      if (message.type === 'cancel') {
        if (throwCancelPost) {
          throw new Error('postMessage failed');
        }
        if (ignoreCancel) {
          return;
        }
      }
      if (message.type === 'release' && throwReleasePost) {
        throw new Error('postMessage failed');
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
    throwOnCancelPost(value: boolean): void {
      throwCancelPost = value;
    },
    throwOnReleasePost(value: boolean): void {
      throwReleasePost = value;
    },
    blackhole(): void {
      silent = true;
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
    expect(status.stats?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(workers).toHaveLength(1);
  });

  it('bounds outstanding output to one entry ahead for a slow consumer', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = buildV1Zip([
      { path: 'grove/grove.png', data: pngBytes, method: 'store' },
      { path: 'grove/grove.json', data: jsonBytes, method: 'deflate' },
      { path: 'grove/extra.bin', data: new Uint8Array(8), method: 'store' },
    ]);
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Hold the first entry without pulling the next: the release returns
    // with the handout, so the worker may decode at most one entry ahead,
    // and the third entry must wait for the next release.
    await tick(6);
    expect(worker.postedEntries()).toBe(2);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    await tick(6);
    expect(worker.postedEntries()).toBe(3);
    const third = await iterator.next();
    expect(third.done).toBe(false);
    const fourth = await iterator.next();
    expect(fourth.done).toBe(true);
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

  it('settles cancellation from the grace fallback when the cancel post throws', async () => {
    const worker = createFakeWorker();
    worker.throwOnCancelPost(true);
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 5,
    });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const status = await job.cancel();
    expect(status.status).toBe('cancelled');
    expect((await job.result).status).toBe('cancelled');
    const afterCancel = await iterator.next();
    expect(afterCancel.done).toBe(true);
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

  it('rejects transfers of views into larger buffers', async () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    const padded = new Uint8Array(zip.archive.length + 16);
    padded.set(zip.archive, 8);
    const view = padded.subarray(8);
    const job = decoder.decode({
      archive: view, expected: zip.expected, transferArchive: true,
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('unsupported');
    expect(status.detail).toContain('exact-fit');
  });

  it('terminates unresponsive workers after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      let releaseDigest: (() => void) | undefined;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (): Promise<ArrayBuffer> => new Promise((resolve) => {
            releaseDigest = (): void => {
              resolve(new ArrayBuffer(32));
            };
          }),
        },
      });
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => {
          const worker = createFakeWorker();
          worker.ignoreCancel(true);
          worker.blackhole();
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
      // Complete the pre-transfer hash and submit the decode while the
      // deadline has not yet fired.
      await vi.advanceTimersByTimeAsync(0);
      releaseDigest!();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await expectation;
      const finalStatus = await job.result;
      expect(finalStatus.status).toBe('deadline');
      expect(finalStatus.archiveLost).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('does not transfer the archive when the deadline fires during hashing', async () => {
    vi.useFakeTimers();
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      let releaseDigest: (() => void) | undefined;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (): Promise<ArrayBuffer> => new Promise((resolve) => {
            releaseDigest = (): void => {
              resolve(new ArrayBuffer(32));
            };
          }),
        },
      });
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
        limits: {
          ...defaultArchiveWorkerLimits(),
          decodeDeadlineMs: 10,
        },
      });
      // The deadline guard fires while the pre-transfer hash pends.
      await vi.advanceTimersByTimeAsync(3000);
      releaseDigest!();
      await vi.advanceTimersByTimeAsync(0);
      const finalStatus = await job.result;
      expect(finalStatus.status).toBe('deadline');
      // The buffer was never submitted, so ownership never left the caller.
      expect(finalStatus.archiveLost).toBeUndefined();
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
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
    const settle = async (): Promise<void> => {
      for (let round = 0; round < 12; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await settle();
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(1);
    dispatch({ type: 'release', jobId: 1, seq: 41 });
    await settle();
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(1);
    dispatch({ type: 'release', jobId: 1, seq: 1 });
    await settle();
    expect(posted.filter((message) => message.type === 'entry')).toHaveLength(2);
    dispatch({ type: 'release', jobId: 1, seq: 2 });
    await settle();
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
    expect(status.detail).toContain('before its predecessor was released');
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

  it('returns the transferred archive when the worker self-deadlines', async () => {
    const posted: ArchiveWorkerResponse[] = [];
    const dispatch = createArchiveWorkerDispatch({
      post: (message, transfer): void => {
        posted.push(message);
        void transfer;
      },
    });
    const zip = fixture();
    dispatch({
      type: 'decode',
      jobId: 9,
      protocol: 1,
      archive: zip.archive.slice().buffer as ArrayBuffer,
      transferArchive: true,
      expected: zip.expected,
      limits: {
        archiveBytes: 1024 * 1024,
        entryBytes: 1024 * 1024,
        totalExpandedBytes: 1024 * 1024,
        entryCount: 16,
        maxPathLength: 256,
        // A zero deadline fires deterministically once the core awaits the
        // entry digest, without racing the client's transport grace.
        decodeDeadlineMs: 0,
      },
    });
    await tick(4);
    const done = posted.find((message) => message.type === 'done');
    expect(done).toMatchObject({ status: 'deadline', jobId: 9 });
    expect((done as { archive?: ArrayBuffer }).archive?.byteLength).toBe(zip.archive.length);
  });

  it('fails workers that skip entry sequences', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(3);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 5,
      path: 'grove/skip.png',
      method: 'store',
      bytes: new Uint8Array(4).slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    // Depending on whether the first entry already arrived, the gap is at
    // sequence 1 or 2 — either way the skip must fail the job.
    expect(status.detail).toMatch(/skipped entry sequence [12]/u);
  });

  it('fails malformed done messages', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'celebration',
    } as never);
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('malformed done message');
  });

  it('cancels a job before its worker posts the decode', async () => {
    let created = 0;
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => {
        created++;
        return createFakeWorker();
      },
    });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(), expected: zip.expected, transferArchive: true,
    });
    const status = await job.cancel();
    expect(status.status).toBe('cancelled');
    expect(status.archiveLost).toBeUndefined();
    const after = await job.result;
    expect(after.status).toBe('cancelled');
    const iteration: string[] = [];
    for await (const entry of job.entries) {
      iteration.push(entry.path);
    }
    expect(iteration).toEqual([]);
    expect(created).toBeLessThanOrEqual(1);
  });

  it('fails workers that post unknown message types', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'surprise',
      jobId: 1,
    } as never);
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('unknown message type');
  });

  it.each([
    ['a swapped path', 'grove/other.png', 'store', pngBytes.length],
    ['a swapped method', 'grove/grove.png', 'deflate', pngBytes.length],
    ['a swapped byte length', 'grove/grove.png', 'store', 4],
  ])('rejects worker entries with %s against the manifest', async (_name, path, method, length) => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path,
      method: method as ArchiveZipEntryMethod,
      bytes: new Uint8Array(length).slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('expected manifest entry');
  });

  it.each([
    true,
    false,
  ])('returns buffered entries when the worker replies to releases synchronously (buffered first: %s)', async (bufferedFirst) => {
    const zip = fixture();
    const createSyncReplyWorker = (): ZipDecodeWorkerLike => {
      const listeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
      const deliver = (data: ArchiveWorkerResponse): void => {
        for (const listener of [...listeners]) {
          listener({ data } as MessageEvent<ArchiveWorkerResponse>);
        }
      };
      // An in-process worker that answers every post synchronously, including
      // the entry released from inside next().
      return {
        postMessage(message: ArchiveWorkerRequest): void {
          if (message.type === 'decode') {
            deliver({
              type: 'entry',
              jobId: message.jobId,
              seq: 1,
              path: zip.expected.entries[0]!.path,
              method: 'store',
              bytes: pngBytes.slice().buffer as ArrayBuffer,
            });
            return;
          }
          if (message.type === 'release' && message.seq === 1) {
            deliver({
              type: 'entry',
              jobId: message.jobId,
              seq: 2,
              path: zip.expected.entries[1]!.path,
              method: 'deflate',
              bytes: jsonBytes.slice().buffer as ArrayBuffer,
            });
          } else if (message.type === 'release') {
            deliver({
              type: 'done',
              jobId: message.jobId,
              status: 'completed',
              stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
            });
          }
        },
        addEventListener(
          type: 'message' | 'error' | 'messageerror',
          listener: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | ((event: Event) => void),
        ): void {
          if (type === 'message') {
            listeners.push(listener as (event: MessageEvent<ArchiveWorkerResponse>) => void);
          }
        },
        terminate(): void {},
      };
    };
    const decoder = createBoundedZipDecoder({ createWorker: createSyncReplyWorker });
    const job = decoder.decode({ archive: zip.archive.slice(), expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    if (bufferedFirst) {
      // Let the first entry buffer before any pull so the release post
      // happens with a captured predecessor.
      await tick(2);
    }
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.path).toBe('grove/grove.png');
    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.path).toBe('grove/grove.json');
    const third = await iterator.next();
    expect(third.done).toBe(true);
    expect((await job.result).status).toBe('completed');
  });

  it('finalizes the job as a worker error when posting a release throws', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    worker.throwOnReleasePost(true);
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    // The pull resolves at handout; the release that follows it throws and
    // must finalize the job instead of wedging the protocol.
    const first = await firstPull;
    expect(first.done).toBe(false);
    expect((await job.result).status).toBe('worker-error');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'worker-error' });
  });

  it('rejects terminal responses carrying a non-buffer archive', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'integrity',
      archive: { not: 'a buffer' } as never,
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('malformed done message');
    // The transferred archive was never returned as a real buffer.
    expect(status.archiveLost).toBe(true);
  });

  it('rejects transferred completions that omit the archive', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('malformed done message');
    // The detached caller buffer was not handed back.
    expect(status.archiveLost).toBe(true);
  });

  it('copies view inputs without polymorphic slice for transport', async () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    const slab = Buffer.alloc(zip.archive.length + 64);
    slab.set(zip.archive, 32);
    // A Node Buffer view: slice() returns another view into the slab instead
    // of a copy, so the transport must not go through it.
    const view = slab.subarray(32, 32 + zip.archive.length);
    const job = decoder.decode({ archive: view, expected: zip.expected });
    const received: string[] = [];
    for await (const entry of job.entries) {
      received.push(entry.path);
    }
    expect(received).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect((await job.result).status).toBe('completed');
  });

  it('rejects completions that do not deliver every expected entry', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('without delivering every expected entry');
  });

  it('rejects delivered entries whose bytes fail the manifest digest', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    // Same path, method and length as the manifest, but different bytes.
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: new Uint8Array(pngBytes.length).fill(7).slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('expected manifest digest');
  });

  it('rejects returned archives with the wrong byte length', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'integrity',
      archive: new ArrayBuffer(4),
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('not the transported archive');
    expect(status.archiveLost).toBe(true);
  });

  it('rejects returned archives replaced with a same-length substitute', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(1);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    expect((await secondPull).done).toBe(false);
    const thirdPull = iterator.next();
    await tick(1);
    // Same length as the transported archive, but different bytes.
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: new Uint8Array(zip.archive.length).fill(1).slice().buffer as ArrayBuffer,
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    await expect(thirdPull).rejects.toMatchObject({ code: 'worker-error' });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('not the transported archive');
    expect(status.archiveLost).toBe(true);
  });

  it('does not let pending entry verification flip a terminal settlement', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    // The entry's digest verification is still pending when the terminal
    // response arrives and defers settlement behind the archive hash.
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'cancelled',
      archive: zip.archive.slice().buffer as ArrayBuffer,
      stats: { entries: 1, expandedBytes: pngBytes.length, elapsedMs: 0 },
    });
    // The accepted cancellation settles the pull; the racing entry cannot.
    expect((await firstPull).done).toBe(true);
    const status = await job.result;
    expect(status.status).toBe('cancelled');
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
    expect(status.archiveLost).toBeUndefined();
  });

  it('settles when the returned archive digest cannot be computed', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const empty = buildV1Zip([]);
    const job = decoder.decode({
      archive: empty.archive.slice(),
      expected: empty.expected,
      transferArchive: true,
    });
    await tick(2);
    const subtle = crypto.subtle;
    vi.stubGlobal('crypto', {
      subtle: {
        digest: (): Promise<ArrayBuffer> => Promise.reject(new Error('boom')),
      },
    });
    try {
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: empty.archive.slice().buffer as ArrayBuffer,
        stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
      });
      const status = await job.result;
      expect(status.status).toBe('worker-error');
      expect(status.detail).toContain('Could not verify the returned archive');
      expect(status.archiveLost).toBe(true);
    } finally {
      vi.stubGlobal('crypto', { subtle });
    }
  });

  it('preserves integrity failures and restores the submitted archive', async () => {
    const decoder = createBoundedZipDecoder({ createWorker: createFakeWorker });
    const zip = fixture();
    // The submission fails the manifest digest, but the worker still hands
    // the exact submitted bytes back with its integrity error.
    const corrupted = zip.archive.slice();
    corrupted[5] = corrupted[5]! ^ 0xff;
    const job = decoder.decode({
      archive: corrupted,
      expected: zip.expected,
      transferArchive: true,
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('archive-mismatch');
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
    expect(status.archiveLost).toBeUndefined();
  });

  it('copies entry bytes out of worker-owned storage', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    const emitted = pngBytes.slice().buffer as ArrayBuffer;
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: emitted,
    });
    // Mutate after emit: verification snapshots the original bytes, so the
    // consumer must receive a copy that cannot follow the mutation.
    new Uint8Array(emitted)[0] = new Uint8Array(emitted)[0]! ^ 0xff;
    const first = await firstPull;
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!.bytes).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it('rejects completion after the client deadline fires', async () => {
    vi.useFakeTimers();
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      const limits = { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 0 };
      const job = decoder.decode({ archive: zip.archive.slice(), expected: zip.expected, limits });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await firstPull).done).toBe(false);
      const secondPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 2,
        path: 'grove/grove.json',
        method: 'deflate',
        bytes: jsonBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await secondPull).done).toBe(false);
      const thirdPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      // The deadline guard fires while the worker stalls before its
      // terminal response; a completion posted afterwards cannot succeed.
      await vi.advanceTimersByTimeAsync(2001);
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
      });
      await expect(thirdPull).rejects.toMatchObject({ code: 'deadline' });
      const status = await job.result;
      expect(status.status).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves unsupported status from worker failures', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'unsupported',
      detail: 'SHA-256 verification requires WebCrypto',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('unsupported');
    expect(status.code).toBe('unsupported');
  });

  it('rejects done messages with non-string detail fields', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'integrity',
      detail: Symbol('unstringifiable') as never,
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('malformed done message');
  });

  it('does not transfer the archive when cancellation lands during hashing', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const subtle = crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    let releaseDigest: (() => void) | undefined;
    vi.stubGlobal('crypto', {
      subtle: {
        digest: (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> =>
          new Promise((resolve) => {
            releaseDigest = (): void => {
              void realDigest(algorithm, data).then(resolve);
            };
          }),
      },
    });
    try {
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
      });
      // Let start() reach the pre-transfer hash, which now pends.
      await tick(3);
      const cancelPromise = job.cancel();
      releaseDigest!();
      const status = await cancelPromise;
      expect(status.status).toBe('cancelled');
      const after = await job.result;
      expect(after.status).toBe('cancelled');
      // The buffer was never submitted, so ownership never left the caller.
      expect(after.archiveLost).toBeUndefined();
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
    } finally {
      vi.stubGlobal('crypto', { subtle });
    }
  });

  it('restores the transferred archive when completion lands after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const subtle = crypto.subtle;
      const realDigest = subtle.digest.bind(subtle);
      let releaseDigest: (() => void) | undefined;
      let firstDigest = true;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
            // Gate only the pre-transfer archive hash; later digests
            // (entry verification, the returned archive) run for real.
            if (!firstDigest) {
              return realDigest(algorithm, data);
            }
            firstDigest = false;
            return new Promise((resolve) => {
              releaseDigest = (): void => {
                void realDigest(algorithm, data).then(resolve);
              };
            });
          },
        },
      });
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      const submitted = zip.archive.slice();
      const job = decoder.decode({
        archive: submitted,
        expected: zip.expected,
        transferArchive: true,
        limits: {
          ...defaultArchiveWorkerLimits(),
          decodeDeadlineMs: 10,
        },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      releaseDigest!();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await firstPull).done).toBe(false);
      const secondPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 2,
        path: 'grove/grove.json',
        method: 'deflate',
        bytes: jsonBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await secondPull).done).toBe(false);
      const thirdPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      // The deadline fires, then the worker posts a completion with the
      // submitted archive; the settlement stays a deadline but ownership is
      // restored because the buffer is the caller's own submission.
      await vi.advanceTimersByTimeAsync(3000);
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: submitted.buffer as ArrayBuffer,
        stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
      });
      await expect(thirdPull).rejects.toMatchObject({ code: 'deadline' });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
      expect(status.archiveLost).toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('re-evaluates the deadline over a pending returned-archive verification', async () => {
    vi.useFakeTimers();
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const subtle = crypto.subtle;
      const realDigest = subtle.digest.bind(subtle);
      let releaseArchiveDigest: (() => void) | undefined;
      let archiveDigestPending = false;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
            // Gate only the returned-archive verification: the largest
            // input is the full archive, entry payloads are far smaller.
            const size = data.byteLength;
            if (!archiveDigestPending || size < 128) {
              return realDigest(algorithm, data);
            }
            archiveDigestPending = false;
            return new Promise((resolve) => {
              releaseArchiveDigest = (): void => {
                void realDigest(algorithm, data).then(resolve);
              };
            });
          },
        },
      });
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      const submitted = zip.archive.slice();
      const job = decoder.decode({
        archive: submitted,
        expected: zip.expected,
        transferArchive: true,
        limits: {
          ...defaultArchiveWorkerLimits(),
          decodeDeadlineMs: 5000,
        },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await firstPull).done).toBe(false);
      const secondPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 2,
        path: 'grove/grove.json',
        method: 'deflate',
        bytes: jsonBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await secondPull).done).toBe(false);
      const thirdPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      // The completion arrives before the deadline; its returned-archive
      // verification pends while the deadline guard fires.
      archiveDigestPending = true;
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: submitted.buffer as ArrayBuffer,
        stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
      });
      await vi.advanceTimersByTimeAsync(5000 + 2000 + 1);
      releaseArchiveDigest!();
      await expect(thirdPull).rejects.toMatchObject({ code: 'deadline' });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
      expect(status.archiveLost).toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('bounds a returned-archive verification that never settles', async () => {
    vi.useFakeTimers();
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      let releasePreTransferHash: (() => void) | undefined;
      let digestCalls = 0;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (): Promise<ArrayBuffer> => {
            digestCalls++;
            // The first call is the pre-transfer hash (released manually);
            // every later call is the returned-archive verification, which
            // never settles.
            if (digestCalls === 1) {
              return new Promise((resolve) => {
                releasePreTransferHash = (): void => {
                  resolve(new ArrayBuffer(32));
                };
              });
            }
            return new Promise<ArrayBuffer>(() => {});
          },
        },
      });
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const empty = buildV1Zip([]);
      const job = decoder.decode({
        archive: empty.archive.slice(),
        expected: empty.expected,
        transferArchive: true,
        limits: {
          ...defaultArchiveWorkerLimits(),
          decodeDeadlineMs: 10,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      releasePreTransferHash!();
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(true);
      // The completion's archive verification pends forever; the deadline
      // fallback must still reclaim the worker and permit.
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: empty.archive.slice().buffer as ArrayBuffer,
        stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
      });
      await vi.advanceTimersByTimeAsync(3000);
      const status = await job.result;
      expect(status.status).toBe('deadline');
      // Conservative: an unrestorable, unverified buffer counts as lost.
      expect(status.archiveLost).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('rejects done messages with invalid numeric statistics', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await tick(2);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'cancelled',
      stats: { entries: 'two', expandedBytes: -1, elapsedMs: Number.NaN } as never,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('malformed done message');
  });

  it('rejects decode deadlines that leave no room for the transport grace', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 2 ** 31 - 1 },
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('limit');
    expect(status.archiveLost).toBeUndefined();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('transfers an immutable snapshot of the submitted archive', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const submitted = zip.archive.slice();
    const subtle = crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    let releaseFreeze: (() => void) | undefined;
    let firstDigest = true;
    vi.stubGlobal('crypto', {
      subtle: {
        digest: (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
          if (!firstDigest) {
            return realDigest(algorithm, data);
          }
          firstDigest = false;
          return new Promise((resolve) => {
            releaseFreeze = (): void => {
              void realDigest(algorithm, data).then(resolve);
            };
          });
        },
      },
    });
    try {
      const job = decoder.decode({
        archive: submitted,
        expected: zip.expected,
        transferArchive: true,
      });
      // The pre-transfer hash pends while the caller mutates its view.
      await tick(2);
      submitted[0] = submitted[0]! ^ 0xff;
      releaseFreeze!();
      for await (const _entry of job.entries) {
        void _entry;
      }
      const status = await job.result;
      expect(status.status).toBe('completed');
      expect(status.archiveBuffer).toBeDefined();
      // The caller's view was never detached or observed mid-mutation.
      expect(submitted.byteLength).toBe(zip.archive.length);
    } finally {
      vi.stubGlobal('crypto', { subtle });
    }
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    2 ** 31,
  ])('rejects a cancelGraceMs of %s', (graceMs) => {
    expect(() => createBoundedZipDecoder({
      createWorker: createFakeWorker,
      cancelGraceMs: graceMs,
    })).toThrow(/cancelGraceMs/u);
  });

  it.each([
    ['the per-entry byte limit', { entryBytes: pngBytes.length - 1 }],
    ['the entry count limit', { entryCount: 0 }],
    ['the total expanded byte limit', { totalExpandedBytes: 4 }],
  ])('enforces %s even when the worker skips them', async (_name, override) => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), ...override },
    });
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('limit');
  });

  it.each([
    ['archiveBytes', 1.5],
    ['entryBytes', Number.NaN],
    ['totalExpandedBytes', Number.POSITIVE_INFINITY],
    ['entryCount', 0],
    ['maxPathLength', -1],
    ['decodeDeadlineMs', Number.NaN],
  ])('validates a malformed %s limit client-side', async (name, value) => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), [name]: value } as ArchiveWorkerLimits,
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('limit');
    expect(status.detail).toContain(String(name));
  });

  it('enforces the path-length limit even when the worker skips it', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const longPath = `${'grove/'.repeat(12)}sprite.png`;
    const zip = buildV1Zip([{ path: longPath, data: pngBytes, method: 'store' }]);
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), maxPathLength: 16 },
    });
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: longPath,
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('limit');
    expect(status.detail).toContain('length limit');
  });

  it('rejects completions whose statistics contradict the delivered output', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(1);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    expect((await secondPull).done).toBe(false);
    const thirdPull = iterator.next();
    await tick(1);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 0, expandedBytes: 1, elapsedMs: 0 },
    });
    await expect(thirdPull).rejects.toMatchObject({ code: 'worker-error' });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('statistics that do not match');
  });

  it('settles on the terminal fields validated before archive verification', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await tick(2);
    const response: {
      type: 'done';
      jobId: number;
      status: ArchiveWorkerStatus;
      code: string;
      archive: ArrayBuffer;
      stats: { entries: number; expandedBytes: number; elapsedMs: number };
    } = {
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'archive-mismatch',
      archive: zip.archive.slice().buffer as ArrayBuffer,
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    };
    worker.emit(response);
    // A worker retaining the response mutates it while verification pends.
    response.status = 'completed';
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('archive-mismatch');
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
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
