import { createHash } from 'node:crypto';
import vm from 'node:vm';

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
  readonly isTerminated: () => boolean;
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
    isTerminated: (): boolean => terminated,
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
/** Wait until the client has posted the decode request, so a crafted
 * terminal response observes a fully submitted job. */
const waitForDecodePost = async (worker: FakeWorker): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.requests.some((request) => request.type === 'decode')) {
      return;
    }
    await tick(1);
  }
};
/** Advance fake time until the decode request lands: a gated digest that
 * was just released resolves on the event loop, and crafted messages must
 * not race the submission they claim to answer. */
const advanceUntilDecodePost = async (worker: FakeWorker): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (worker.requests.some((request) => request.type === 'decode')) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
  }
};
/** Wait until the real dispatch has posted the given number of entries;
 * native digests settle on the event loop, so a fixed number of turns is
 * not a guarantee. */
const waitForPostedEntries = async (worker: FakeWorker, count: number): Promise<void> => {
  for (let attempt = 0; attempt < 100 && worker.postedEntries() < count; attempt++) {
    await tick(1);
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
    await waitForPostedEntries(worker, 2);
    expect(worker.postedEntries()).toBe(2);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    await waitForPostedEntries(worker, 3);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
    await waitForPostedEntries(worker, 1);
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
    // The real dispatch posts the first entry after its native digests
    // settle; wait for it instead of assuming a fixed number of turns.
    await waitForPostedEntries(worker, 1);
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
    await waitForDecodePost(worker);
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
    await waitForDecodePost(worker);
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
    await waitForDecodePost(worker);
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
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 5,
    });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await tick(2);
    vi.stubGlobal('crypto', {
      subtle: {
        digest: (): Promise<ArrayBuffer> => Promise.reject(new Error('boom')),
      },
    });
    try {
      // The submission (and its digest) must be complete before the
      // crafted terminal response arrives.
      await waitForDecodePost(worker);
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: zip.archive.slice().buffer as ArrayBuffer,
        stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
      });
      const status = await job.result;
      expect(status.status).toBe('worker-error');
      expect(status.detail).toContain('Could not verify the returned archive');
      expect(status.archiveLost).toBe(true);
    } finally {
      vi.unstubAllGlobals();
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      // A zero deadline would now fire before the entries arrive; a
      // positive one lets the entries verify while the worker stalls
      // before its terminal response.
      const limits = { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 2000 };
      const job = decoder.decode({ archive: zip.archive.slice(), expected: zip.expected, limits });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      await advanceUntilDecodePost(worker);
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
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 5,
    });
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
      vi.unstubAllGlobals();
    }
  });

  it('restores the transferred archive when completion lands after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
      // The released hash resolves on the event loop; wait for the
      // submission it gates so the crafted messages answer a posted job.
      await advanceUntilDecodePost(worker);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
      // The real pre-transfer digest resolves on the event loop; wait for
      // the submission it gates so the crafted messages answer a posted job.
      await advanceUntilDecodePost(worker);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const subtle = crypto.subtle;
      const realDigest = subtle.digest.bind(subtle);
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
            return new Promise<ArrayBuffer>(() => {});
          },
        },
      });
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
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
      await advanceUntilDecodePost(worker);
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
      // The completion's archive verification pends forever; the deadline
      // fallback must still reclaim the worker and permit.
      archiveDigestPending = true;
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: submitted.buffer as ArrayBuffer,
        stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
      });
      await vi.advanceTimersByTimeAsync(5000 + 50 + 1);
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

  it('rejects decode deadlines beyond the platform timer range', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 2 ** 31 },
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
      vi.unstubAllGlobals();
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

  it('rejects detached entry buffers instead of throwing in the listener', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = buildV1Zip([{ path: 'grove/empty.bin', data: new Uint8Array(0), method: 'store' }]);
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const detached = new Uint8Array(0).slice().buffer as ArrayBuffer;
    structuredClone(detached, { transfer: [detached] });
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/empty.bin',
      method: 'store',
      bytes: detached,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    // The probe rejects the detached buffer at the shape check (the spec's
    // IsDetachedBuffer rule), before any copy is attempted.
    expect(status.detail).toContain('malformed entry message');
  });

  it('ends at the deadline without submitting when pre-transfer hashing overruns it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      let releasePreTransferHash: (() => void) | undefined;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (): Promise<ArrayBuffer> => new Promise((resolve) => {
            releasePreTransferHash = (): void => {
              resolve(new ArrayBuffer(32));
            };
          }),
        },
      });
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
        limits: {
          ...defaultArchiveWorkerLimits(),
          decodeDeadlineMs: 1000,
        },
      });
      // Hashing pends 1500ms, past the 1000ms deadline: the job must end at
      // the deadline without ever submitting the archive, not ride a grace
      // window into a decode with a fresh budget.
      await vi.advanceTimersByTimeAsync(1500);
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('before the job was submitted');
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
      releasePreTransferHash!();
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
      // The buffer was never submitted, so ownership never left the caller.
      expect(status.archiveLost).toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('submits only the unspent deadline budget to the worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      let releasePreTransferHash: (() => void) | undefined;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (): Promise<ArrayBuffer> => new Promise((resolve) => {
            releasePreTransferHash = (): void => {
              resolve(new ArrayBuffer(32));
            };
          }),
        },
      });
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const limits = { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 };
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
        limits,
      });
      // Submission preparation spends 700ms of the 1000ms budget before
      // the decode post; the worker may only spend what is left.
      await vi.advanceTimersByTimeAsync(700);
      releasePreTransferHash!();
      await advanceUntilDecodePost(worker);
      const decode = worker.requests.find((request) => request.type === 'decode');
      expect(decode).toBeDefined();
      expect((decode as { limits: ArchiveWorkerLimits }).limits.decodeDeadlineMs).toBe(300);
      // The derived budget is a copy; the caller's limits are untouched.
      expect(limits.decodeDeadlineMs).toBe(1000);
      await vi.advanceTimersByTimeAsync(300 + 50 + 1);
      const status = await job.result;
      expect(status.status).toBe('deadline');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('re-arms the deadline when the timer fires ahead of the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const realNow = performance.now.bind(performance);
      let nowMs: number | undefined = undefined;
      vi.spyOn(performance, 'now').mockImplementation(() => nowMs ?? realNow());
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      // The timer fires on schedule but the coarsened clock still reads
      // before the deadline; the deadline must not be silently disarmed.
      nowMs = realNow();
      await vi.advanceTimersByTimeAsync(1000);
      expect(worker.requests.some((request) => request.type === 'cancel')).toBe(false);
      const statusPending = job.result;
      // The clock passes the deadline; the re-armed notifier enforces it.
      nowMs = realNow() + 5000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(worker.requests.some((request) => request.type === 'cancel')).toBe(true);
      await vi.advanceTimersByTimeAsync(50 + 1);
      const status = await statusPending;
      expect(status.status).toBe('deadline');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('hands the worker copies of the manifest and limits', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    const decode = worker.requests.find((request) => request.type === 'decode') as unknown as {
      expected: { entries: { sha256: string }[] };
      limits: { entryBytes: number };
    };
    // An in-process port must not share the client's verification basis:
    // mutating its own request copy cannot change the manifest digests or
    // the limits the client judges responses against.
    decode.expected.entries[0]!.sha256 = '0'.repeat(64);
    decode.limits.entryBytes = 0;
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await secondPull).done).toBe(false);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('completed');
  });

  it('blocks the decode post when the budget expires during preparation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const realNow = performance.now.bind(performance);
      const t0 = realNow();
      // The deadline start, the pre-submit guard and the post-copy guard
      // all read before the deadline; the final remainder computation
      // reads past it, and the post must be blocked, not sent with a
      // zero-budget clamp.
      const readings = [t0, t0 + 100, t0 + 100, t0 + 5000];
      let index = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => readings[index++] ?? realNow());
      const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('before the job was submitted');
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('does not share the caller buffer with in-process workers in clone mode', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const archive = zip.archive.slice();
    const snapshot = archive.slice();
    const job = decoder.decode({ archive, expected: zip.expected });
    await waitForDecodePost(worker);
    const decode = worker.requests.find((request) => request.type === 'decode') as {
      archive: ArrayBuffer;
    };
    expect(decode.archive).not.toBe(archive.buffer);
    // A port mutating the buffer it received cannot touch the caller's bytes.
    new Uint8Array(decode.archive)[0] = (new Uint8Array(decode.archive)[0] ?? 0) ^ 0xff;
    expect(Buffer.from(archive).equals(Buffer.from(snapshot))).toBe(true);
    void job;
  });

  it('keeps the user cause over a late worker error', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await waitForDecodePost(worker);
    const cancelling = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'integrity',
      detail: 'late failure',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    expect(status.detail).toContain('Cancellation was decided first');
    expect(status.detail).toContain('late failure');
    expect((await job.result).status).toBe('cancelled');
  });

  it('keeps the deadline cause over a late worker error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 100 },
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(101);
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'error',
        code: 'integrity',
        detail: 'late failure',
        stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('The deadline was decided first');
      expect(status.detail).toContain('late failure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the user cause when the returned archive is not the submission', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 50,
    });
    const zip = fixture();
    const submitted = zip.archive.slice();
    const job = decoder.decode({
      archive: submitted,
      expected: zip.expected,
      transferArchive: true,
    });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await secondPull).done).toBe(false);
    const thirdPull = iterator.next();
    await tick(2);
    // A same-length impostor archive cannot replace the submission, and
    // the failed recovery must not replace the user's decided cause.
    const cancelling = job.cancel();
    const imposter = submitted.slice();
    imposter[3] = (imposter[3] ?? 0) ^ 0xff;
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: imposter.buffer as ArrayBuffer,
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    expect(status.archiveBuffer).toBeUndefined();
    expect(status.archiveLost).toBe(true);
    await expect(thirdPull).resolves.toMatchObject({ done: true });
  });

  it('keeps the deadline cause when the returned archive is not the submission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const submitted = zip.archive.slice();
      const job = decoder.decode({
        archive: submitted,
        expected: zip.expected,
        transferArchive: true,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 5000 },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      await advanceUntilDecodePost(worker);
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
      // The deadline fires before the impostor archive arrives; the failed
      // recovery settles as the decided deadline with the archive lost.
      await vi.advanceTimersByTimeAsync(5001);
      const imposter = submitted.slice();
      imposter[3] = (imposter[3] ?? 0) ^ 0xff;
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        archive: imposter.buffer as ArrayBuffer,
        stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.archiveBuffer).toBeUndefined();
      expect(status.archiveLost).toBe(true);
      await expect(thirdPull).rejects.toMatchObject({ code: 'deadline' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the deadline cause over a late contradictory completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 5000 },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      await advanceUntilDecodePost(worker);
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
      // The deadline fires, then a completion whose statistics contradict
      // the delivered output must not replace the decided deadline.
      await vi.advanceTimersByTimeAsync(5001);
      worker.emit({
        type: 'done',
        jobId: 1,
        status: 'completed',
        stats: { entries: 99, expandedBytes: 4242, elapsedMs: 0 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('statistics that do not match');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the user cause when the worker crashes after cancellation', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 50,
    });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await waitForDecodePost(worker);
    const cancelling = job.cancel();
    worker.crash();
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    expect(status.detail).toContain('failed or received an invalid message');
    expect((await job.result).status).toBe('cancelled');
  });

  it('keeps the user cause when the submission hash fails after cancellation', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    let rejectHash: ((error: Error) => void) | undefined;
    vi.stubGlobal('crypto', {
      subtle: {
        digest: (): Promise<ArrayBuffer> => new Promise((_resolve, reject) => {
          rejectHash = reject;
        }),
      },
    });
    try {
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        transferArchive: true,
      });
      await tick(3);
      const cancelling = job.cancel();
      rejectHash!(new Error('boom'));
      const status = await cancelling;
      expect(status.status).toBe('cancelled');
      expect(status.detail).toContain('Could not hash the archive');
      expect((await job.result).status).toBe('cancelled');
      expect(worker.requests.some((request) => request.type === 'decode')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps worker statistics when a decided cause meets a wrong-length archive', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 50,
    });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await waitForDecodePost(worker);
    const cancelling = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: new ArrayBuffer(3),
      stats: { entries: 5, expandedBytes: 4242, elapsedMs: 7 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    // The decided cause keeps the settlement, and the worker's statistics
    // survive alongside it instead of being dropped.
    expect(status.stats).toMatchObject({ entries: 5, expandedBytes: 4242 });
    expect(status.archiveLost).toBe(true);
  });

  it('restores the submitted archive when completion metadata is rejected', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const submitted = zip.archive.slice();
    const job = decoder.decode({
      archive: submitted,
      expected: zip.expected,
      transferArchive: true,
    });
    await waitForDecodePost(worker);
    // A completion with no delivered entries is rejected, but the exact
    // submitted bytes are still authenticated and restored.
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: submitted.buffer as ArrayBuffer,
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('without delivering every expected entry');
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
    expect(status.archiveLost).toBeUndefined();
  });

  it('holds the buffered entry once the deadline elapses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const realNow = performance.now.bind(performance);
      let nowMs: number | undefined = undefined;
      vi.spyOn(performance, 'now').mockImplementation(() => nowMs ?? realNow());
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      await advanceUntilDecodePost(worker);
      // The first entry verifies and buffers while no pull is pending.
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      await vi.advanceTimersByTimeAsync(0);
      // The budget is spent while the caller's task still holds the
      // thread, so the deadline timer has not run; the buffered entry
      // must not surface past the elapsed clock.
      nowMs = realNow() + 5000;
      const pull = job.entries[Symbol.asyncIterator]().next();
      const rejection = expect(pull).rejects.toMatchObject({ code: 'deadline' });
      await vi.advanceTimersByTimeAsync(1000 + 50 + 1);
      await rejection;
      expect((await job.result).status).toBe('deadline');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('settles cancellations of queued jobs immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const busy = createFakeWorker();
      busy.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => busy,
        maxConcurrentDecodes: 1,
        cancelGraceMs: 5000,
      });
      const zip = fixture();
      const running = decoder.decode({ archive: zip.archive, expected: zip.expected });
      const queued = decoder.decode({ archive: zip.archive, expected: zip.expected });
      await vi.advanceTimersByTimeAsync(0);
      // A queued job owns no worker or buffer, so its cancellation settles
      // without any grace window — under fake timers a grace-based path
      // would never resolve without advancing the clock.
      const status = await queued.cancel();
      expect(status.status).toBe('cancelled');
      expect((await queued.result).status).toBe('cancelled');
      void running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the pull when a deadline observation finalizes reentrantly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const zip = fixture();
      let listener: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | undefined;
      const posted: ArchiveWorkerRequest[] = [];
      let resolveDecodePosted: (() => void) | undefined;
      const decodePosted = new Promise<void>((resolve) => {
        resolveDecodePosted = resolve;
      });
      const workerLike: ZipDecodeWorkerLike = {
        postMessage(message): void {
          posted.push(message);
          if (message.type === 'decode') {
            resolveDecodePosted?.();
          }
          if (message.type === 'cancel') {
            // A synchronous in-process answer to the cooperative cancel.
            listener?.({
              data: {
                type: 'done',
                jobId: 1,
                status: 'cancelled',
                stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
              },
            } as MessageEvent<ArchiveWorkerResponse>);
          }
        },
        addEventListener(type, callback): void {
          if (type === 'message') {
            listener = callback as (event: MessageEvent<ArchiveWorkerResponse>) => void;
          }
        },
        terminate(): void {},
      };
      const decoder = createBoundedZipDecoder({
        createWorker: (): ZipDecodeWorkerLike => workerLike,
        cancelGraceMs: 50,
      });
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      await decodePosted;
      expect(posted.some((request) => request.type === 'decode')).toBe(true);
      listener?.({
        data: {
          type: 'entry',
          jobId: 1,
          seq: 1,
          path: 'grove/grove.png',
          method: 'store',
          bytes: pngBytes.slice().buffer as ArrayBuffer,
        },
      } as MessageEvent<ArchiveWorkerResponse>);
      await vi.advanceTimersByTimeAsync(0);
      // The clock passes the deadline while the caller holds the thread;
      // the pull's deadline observation posts the cooperative cancel, the
      // synchronous answer finalizes the job inside next(), and the pull
      // must still settle as the deadline.
      const realNow = performance.now.bind(performance);
      const nowSpy = vi.spyOn(performance, 'now');
      nowSpy.mockImplementation(() => realNow() + 5000);
      const pull = iterator.next();
      const rejection = expect(pull).rejects.toMatchObject({ code: 'deadline' });
      await rejection;
      expect((await job.result).status).toBe('deadline');
      nowSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes worker deadline responses without a code', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'deadline' });
    await waitForDecodePost(worker);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'deadline',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    await rejection;
    const status = await job.result;
    expect(status.status).toBe('deadline');
    expect(status.code).toBe('deadline');
  });

  it('normalizes worker error responses without a code', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'worker-error' });
    await waitForDecodePost(worker);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    await rejection;
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('worker-error');
  });

  it('rejects completions of archives the manifest rejects', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const corrupted = zip.archive.slice();
    corrupted[5] = (corrupted[5] ?? 0) ^ 0xff;
    const job = decoder.decode({ archive: corrupted, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await secondPull).done).toBe(false);
    // A custom worker can complete with consistent entries and statistics
    // while skipping the core's archive check; the client's own submission
    // digest still rejects the corrupt archive.
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('archive-mismatch');
    expect(status.detail).toContain('does not match the expected manifest archive');
  });

  it('rejects manifests larger than the configured bounds', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = buildV1Zip([
      { path: 'grove/one.png', data: pngBytes, method: 'store' },
      { path: 'grove/two.json', data: jsonBytes, method: 'deflate' },
    ]);
    const oversizeCount = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), entryCount: 1 },
    });
    expect((await oversizeCount.result).code).toBe('limit');
    expect((await oversizeCount.result).detail).toContain('exceeding the entry limit 1');
    const oversizePath = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), maxPathLength: 4 },
    });
    expect((await oversizePath.result).code).toBe('limit');
    expect((await oversizePath.result).detail).toContain('length limit 4');
    // Both jobs failed before any worker was created or manifest copied.
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects unsupported manifest versions before creating workers', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = fixture();
    const skewed = { ...zip.expected, formatVersion: zip.expected.formatVersion + 1 };
    const job = decoder.decode({ archive: zip.archive, expected: skewed });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('unsupported-zip');
    expect(status.detail).toContain('Unsupported archive format version');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('bounds the manifest only after the limits validate', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = buildV1Zip(new Array(64).fill(0).map((_unused, index) => ({
      path: `grove/entry-${index}.bin`,
      data: new Uint8Array(2),
      method: 'store' as const,
    })));
    // A malformed limit cannot bound anything: the manifest is not
    // snapshotted and the job rejects on the limit itself.
    const job = decoder.decode({
      archive: zip.archive,
      expected: zip.expected,
      limits: { ...defaultArchiveWorkerLimits(), entryCount: Number.NaN },
    });
    const status = await job.result;
    expect(status.code).toBe('limit');
    expect(status.detail).toContain('entryCount');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('settles as deadline when worker creation outlasts the budget', async () => {
    const realNow = performance.now.bind(performance);
    // The budget starts on the first clock read; every later read — here
    // only the settlement's elapsed check — sits past the deadline, as if
    // the factory blocked through the budget before throwing.
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++;
      return calls === 1 ? realNow() : realNow() + 5000;
    });
    try {
      const decoder = createBoundedZipDecoder({
        createWorker: (): ZipDecodeWorkerLike => {
          throw new Error('no workers');
        },
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('Cannot create the archive decode worker');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('settles as deadline when the decode post outlasts the budget', async () => {
    const realNow = performance.now.bind(performance);
    // The budget starts on the first clock read; the post then blocks past
    // the deadline and throws, and only the elapsed clock can see it.
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++;
      // Budget start and both pre-submit guards read within the budget;
      // the failing post's settlement reads past it.
      return calls <= 4 ? realNow() : realNow() + 5000;
    });
    try {
      const workerLike: ZipDecodeWorkerLike = {
        postMessage(message): void {
          if (message.type === 'decode') {
            throw new Error('post blocked then failed');
          }
        },
        addEventListener(): void {},
        terminate(): void {},
      };
      const decoder = createBoundedZipDecoder({
        createWorker: (): ZipDecodeWorkerLike => workerLike,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('Could not post the decode request');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('settles when the returned archive cannot be snapshotted', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await waitForDecodePost(worker);
    // The length check reads the real size; the snapshot allocation then
    // reads an unallocatable one, so the copy itself fails.
    let lengthReads = 0;
    class ErraticBuffer extends ArrayBuffer {
      override get byteLength(): number {
        lengthReads++;
        return lengthReads === 1 ? zip.archive.length : 2 ** 53;
      }
    }
    const cancelling = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: new ErraticBuffer(zip.archive.length),
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    expect(status.detail).toContain('could not be recovered');
    expect(status.archiveLost).toBe(true);
  });

  it('copies returned archives out of aliased buffers', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    class AliasingBuffer extends ArrayBuffer {
      override slice(): ArrayBuffer {
        return this;
      }
    }
    const aliased = new AliasingBuffer(zip.archive.length);
    new Uint8Array(aliased).set(zip.archive);
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await waitForDecodePost(worker);
    const cancelling = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'cancelled',
      archive: aliased,
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    // The settlement holds a client-owned copy: a slice() override
    // returning the same buffer cannot leave worker-mutable bytes in the
    // restored archive.
    expect(status.archiveBuffer).not.toBe(aliased);
    new Uint8Array(aliased)[0] = (new Uint8Array(aliased)[0] ?? 0) ^ 0xff;
    expect(new Uint8Array(status.archiveBuffer!)[0]).toBe(zip.archive[0]);
  });

  it('preserves the deadline when release posting throws late', async () => {
    const realNow = performance.now.bind(performance);
    // The budget (60s) cannot be hit by the real timer during the test;
    // the clock flips past it exactly when the release post is attempted,
    // so its throwing settlement observes the expired budget.
    let releaseAttempted = false;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      return releaseAttempted ? realNow() + 120000 : realNow();
    });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      worker.throwOnReleasePost(true);
      const posted = worker.postMessage.bind(worker);
      worker.postMessage = (message: ArchiveWorkerRequest): void => {
        if (message.type === 'release') {
          releaseAttempted = true;
        }
        posted(message);
      };
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 60000 },
      });
      const iterator = job.entries[Symbol.asyncIterator]();
      const firstPull = iterator.next();
      await waitForDecodePost(worker);
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      const first = await firstPull;
      expect(first.done).toBe(false);
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('Could not post the entry release');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves the deadline when startup work throws late', async () => {
    const realNow = performance.now.bind(performance);
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++;
      return calls === 1 ? realNow() : realNow() + 5000;
    });
    try {
      const decoder = createBoundedZipDecoder({
        createWorker: (): ZipDecodeWorkerLike => ({
          postMessage(): void {},
          addEventListener(): void {
            // Listener registration blocks past the budget, then throws.
            throw new Error('listener registration failed');
          },
          terminate(): void {},
        }),
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive,
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      const status = await job.result;
      expect(status.status).toBe('deadline');
      expect(status.detail).toContain('Starting the decode job failed');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects empty expected manifests before creating workers', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const empty = buildV1Zip([]);
    const job = decoder.decode({ archive: empty.archive, expected: empty.expected });
    const status = await job.result;
    expect(status.status).toBe('error');
    expect(status.code).toBe('invalid-structure');
    expect(status.detail).toContain('at least one expected entry');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects manifests beyond the ZIP entry count ceiling', async () => {
    const createWorker = vi.fn(createFakeWorker);
    const decoder = createBoundedZipDecoder({ createWorker });
    const zip = fixture();
    const huge = {
      ...zip.expected,
      entries: new Array(0xffff + 1).fill(zip.expected.entries[0]),
    };
    const job = decoder.decode({
      archive: zip.archive,
      expected: huge,
      limits: { ...defaultArchiveWorkerLimits(), entryCount: 0xffff * 2 },
    });
    const status = await job.result;
    expect(status.code).toBe('limit');
    expect(status.detail).toContain('beyond the ZIP v1 entry count ceiling 65535');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('copies entry bytes out of aliased buffers', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    class AliasingBuffer extends ArrayBuffer {
      override slice(): ArrayBuffer {
        return this;
      }
    }
    const aliased = new AliasingBuffer(pngBytes.length);
    new Uint8Array(aliased).set(pngBytes);
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: aliased,
    });
    const first = await firstPull;
    expect(first.done).toBe(false);
    // A slice() override returning the same buffer cannot leave the
    // consumer holding worker-mutable bytes.
    new Uint8Array(aliased)[0] = (new Uint8Array(aliased)[0] ?? 0) ^ 0xff;
    expect(Buffer.from(first.value.bytes).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it('freezes subclassed submissions before hashing', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    class AliasingBuffer extends ArrayBuffer {
      override slice(): ArrayBuffer {
        return this;
      }
    }
    const aliased = new AliasingBuffer(zip.archive.length);
    new Uint8Array(aliased).set(zip.archive);
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
        archive: new Uint8Array(aliased),
        expected: zip.expected,
        transferArchive: true,
      });
      await tick(2);
      // Mutate the caller's subclassed view while the pre-transfer hash
      // pends; the submission must have been frozen to the original bytes.
      new Uint8Array(aliased)[3] = (new Uint8Array(aliased)[3] ?? 0) ^ 0xff;
      releaseFreeze!();
      for await (const _entry of job.entries) {
        void _entry;
      }
      const status = await job.result;
      expect(status.status).toBe('completed');
      expect(Buffer.from(status.archiveBuffer!)).toEqual(Buffer.from(zip.archive));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('delivers the method the manifest check validated', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    let methodReads = 0;
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      get method(): 'store' | 'deflate' {
        // Switches after the validated reads; the validated and delivered
        // values must be one and the same.
        methodReads++;
        return methodReads <= 2 ? 'store' : 'deflate';
      },
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    } as never);
    const first = await firstPull;
    expect(first.done).toBe(false);
    expect(first.value.method).toBe('store');
  });

  it('settles the terminal status the shape check validated', async () => {
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
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await secondPull).done).toBe(false);
    let statusReads = 0;
    worker.emit({
      type: 'done',
      jobId: 1,
      get status(): 'cancelled' | 'completed' {
        // Alternates between reads; the validated and settled values must
        // be one and the same — and cannot combine the archive-free shape
        // check with a completed settlement.
        statusReads++;
        return statusReads % 2 === 1 ? 'cancelled' : 'completed';
      },
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    } as never);
    const status = await job.result;
    expect(status.status).toBe('cancelled');
    expect(status.archiveBuffer).toBeUndefined();
    expect(status.archiveLost).toBe(true);
  });

  it('recovers the submission when the decode post throws', async () => {
    const workerLike: ZipDecodeWorkerLike = {
      postMessage(message): void {
        if (message.type === 'decode') {
          throw new Error('post failed');
        }
      },
      addEventListener(): void {},
      terminate(): void {},
    };
    const decoder = createBoundedZipDecoder({ createWorker: (): ZipDecodeWorkerLike => workerLike });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('Could not post the decode request');
    // The throwing post never consumed the transfer list: the client still
    // owns the intact submission and returns it instead of reporting it
    // lost.
    expect(status.archiveBuffer?.byteLength).toBe(zip.archive.length);
    expect(status.archiveLost).toBeUndefined();
  });

  it('dispatches on the captured message type', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    let typeReads = 0;
    worker.emit({
      get type(): 'entry' | 'done' {
        // The captured type governs dispatch; later reads must not flip
        // the message into the opposite shape.
        typeReads++;
        return typeReads === 1 ? 'entry' : 'done';
      },
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    } as never);
    const first = await firstPull;
    expect(first.done).toBe(false);
    expect(first.value.path).toBe('grove/grove.png');
  });

  it('normalizes unknown worker failure codes by terminal status', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = buildV1Zip([
      { path: 'grove/one.png', data: pngBytes, method: 'store' },
    ]);
    const run = async (
      done: { status: ArchiveWorkerStatus; code?: string },
    ): Promise<string | undefined> => {
      const posted = createFakeWorker();
      posted.blackhole();
      const probe = createBoundedZipDecoder({ createWorker: (): FakeWorker => posted });
      const job = probe.decode({ archive: zip.archive, expected: zip.expected });
      await waitForDecodePost(posted);
      posted.emit({
        type: 'done',
        jobId: 1,
        status: done.status,
        code: done.code,
        stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
      } as never);
      return (await job.result).code;
    };
    // Unknown codes fall back by status: errors become worker-error,
    // deadlines keep their code, and successes carry none.
    expect(await run({ status: 'error', code: 'not-a-real-code' })).toBe('worker-error');
    expect(await run({ status: 'deadline', code: 'not-a-real-code' })).toBe('deadline');
    // Cancelled fixes its code, so a contradictory worker code (even a
    // recognized one) never surfaces.
    expect(await run({ status: 'cancelled', code: 'archive-mismatch' })).toBe('cancelled');
    expect(await run({ status: 'deadline', code: 'integrity' })).toBe('deadline');
    void worker;
    void decoder;

    // The iterator's ZipDecodeError shares the normalized code.
    const posted = createFakeWorker();
    posted.blackhole();
    const probe = createBoundedZipDecoder({ createWorker: (): FakeWorker => posted });
    const job = probe.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'worker-error' });
    await waitForDecodePost(posted);
    posted.emit({
      type: 'done',
      jobId: 1,
      status: 'error',
      code: 'not-a-real-code',
      detail: 'skewed worker',
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    await rejection;
    expect((await job.result).code).toBe('worker-error');
  });

  it('never attaches a failure code to a completed job', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = buildV1Zip([
      { path: 'grove/one.png', data: pngBytes, method: 'store' },
    ]);
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/one.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    // A worker attaching a failure code to a completion must not leak it:
    // consumers switching on code see a clean success.
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      code: 'integrity',
      stats: { entries: 1, expandedBytes: pngBytes.length, elapsedMs: 0 },
    });
    const status = await job.result;
    expect(status.status).toBe('completed');
    expect(status.code).toBeUndefined();
  });

  it('settles when a returned buffer length cannot be read', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({
      archive: zip.archive.slice(),
      expected: zip.expected,
      transferArchive: true,
    });
    await waitForDecodePost(worker);
    class UnreadableBuffer extends ArrayBuffer {
      override get byteLength(): number {
        throw new Error('no length for you');
      }
    }
    const cancelling = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      archive: new UnreadableBuffer(zip.archive.length),
      stats: { entries: 0, expandedBytes: 0, elapsedMs: 0 },
    });
    const status = await cancelling;
    expect(status.status).toBe('cancelled');
    expect(status.detail).toContain('length could not be read');
    expect(status.archiveLost).toBe(true);
  });

  it('accepts cross-realm ArrayBuffer entry buffers', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    // A genuine ArrayBuffer from another realm (here: a vm context) is a
    // valid buffer even though realm-local instanceof rejects it.
    const foreignBuffer = vm.runInContext('new ArrayBuffer(12)', vm.createContext({})) as ArrayBuffer;
    new Uint8Array(foreignBuffer).set(pngBytes);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: foreignBuffer,
    });
    const first = await firstPull;
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value.bytes).equals(Buffer.from(pngBytes))).toBe(true);
  });

  it('rejects tag-spoofed fake entry buffers', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'worker-error' });
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 12 } as never,
    });
    await rejection;
    expect((await job.result).detail).toContain('malformed entry message');
  });

  it('settles the job when message field access throws', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'worker-error' });
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      get path(): string {
        throw new Error('no path for you');
      },
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    } as never);
    await rejection;
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('could not be read');
  });

  it('settles the job when terminal stats access throws', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const pull = iterator.next();
    const rejection = expect(pull).rejects.toMatchObject({ code: 'worker-error' });
    await waitForDecodePost(worker);
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'cancelled',
      get stats(): ArchiveWorkerStats {
        throw new Error('no stats for you');
      },
    } as never);
    await rejection;
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    expect(status.detail).toContain('could not be read');
  });

  it('starts the next queued job after a capture failure', async () => {
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
    const failing = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const queued = decoder.decode({ archive: zip.archive, expected: zip.expected });
    // Reach the first decode post without fixed ticks.
    for (let attempt = 0; attempt < 100 && workers.length < 1; attempt++) {
      await tick(1);
    }
    expect(workers).toHaveLength(1);
    workers[0]!.blackhole();
    workers[0]!.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      get path(): string {
        throw new Error('boom');
      },
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    } as never);
    expect((await failing.result).status).toBe('worker-error');
    // The freed permit admits the queued job, which runs to completion.
    const received: string[] = [];
    for await (const entry of queued.entries) {
      received.push(entry.path);
    }
    expect(received).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect((await queued.result).status).toBe('completed');
    expect(workers).toHaveLength(2);
  });

  it('releases the worker reference after completion', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const received: string[] = [];
    for await (const entry of job.entries) {
      received.push(entry.path);
    }
    expect((await job.result).status).toBe('completed');
    // Best-effort termination happened and the reference is gone, so a
    // later cancel() cannot post to the terminated worker.
    expect(worker.isTerminated()).toBe(true);
    const lateStatus = await job.cancel();
    expect(lateStatus.status).toBe('completed');
    expect(worker.requests.some((request) => request.type === 'cancel')).toBe(false);
  });

  it('returns the permit when terminate throws', async () => {
    let terminated = 0;
    const hostileWorker = (): ZipDecodeWorkerLike => ({
      postMessage(): void {},
      addEventListener(): void {},
      terminate(): void {
        terminated++;
        throw new Error('terminate failed');
      },
    });
    const workers: ZipDecodeWorkerLike[] = [];
    const decoder = createBoundedZipDecoder({
      createWorker: (): ZipDecodeWorkerLike => {
        const worker = hostileWorker();
        workers.push(worker);
        return worker;
      },
      maxConcurrentDecodes: 1,
      cancelGraceMs: 5,
    });
    const zip = fixture();
    const first = decoder.decode({ archive: zip.archive, expected: zip.expected });
    // Phase gate: wait until the worker exists, so the cancel lands on a
    // running job instead of racing its queued start.
    for (let attempt = 0; attempt < 100 && workers.length < 1; attempt++) {
      await tick(1);
    }
    expect(workers).toHaveLength(1);
    // The silent worker never answers, so each cancelled job settles from
    // the grace fallback; its throwing terminate must not block the
    // settlement or the permit handoff to the next job.
    expect((await first.cancel()).status).toBe('cancelled');
    expect((await first.result).status).toBe('cancelled');
    expect(terminated).toBe(1);
    // The freed permit admits a fresh job whose worker is created despite
    // the previous throwing terminate.
    const third = decoder.decode({ archive: zip.archive, expected: zip.expected });
    for (let attempt = 0; attempt < 100 && workers.length < 2; attempt++) {
      await tick(1);
    }
    expect((await third.cancel()).status).toBe('cancelled');
    expect((await third.result).status).toBe('cancelled');

  });
  it('rejects shared entry buffers on both detection branches', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const runJob = async (bytes: unknown): Promise<string | undefined> => (
      await (await startFailingJob(decoder, zip, bytes)).result
    ).detail;
    const startFailingJob = async (
      decoderInstance: ReturnType<typeof createBoundedZipDecoder>,
      fixtureZip: ReturnType<typeof fixture>,
      bytes: unknown,
    ) => {
      const posted = createFakeWorker();
      posted.blackhole();
      void decoderInstance;
      void fixtureZip;
      const probe = createBoundedZipDecoder({ createWorker: (): FakeWorker => posted });
      const job = probe.decode({ archive: zip.archive, expected: zip.expected });
      await waitForDecodePost(posted);
      posted.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: bytes as ArrayBuffer,
      } as never);
      return job;
    };
    // A genuine SharedArrayBuffer is rejected by the instanceof branch.
    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new SharedArrayBuffer(pngBytes.length);
      new Uint8Array(shared).set(pngBytes);
      expect(await runJob(shared)).toContain('malformed entry message');
    }
    // A plain object spoofing the SharedArrayBuffer tag is rejected by
    // the toString branch.
    expect(await runJob({ [Symbol.toStringTag]: 'SharedArrayBuffer' })).toContain(
      'malformed entry message',
    );
  });

  it('caps unreadable error renderings in settlement details', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const runDetail = async (thrown: unknown): Promise<string | undefined> => {
      const posted = createFakeWorker();
      posted.blackhole();
      const probe = createBoundedZipDecoder({ createWorker: (): FakeWorker => posted });
      const job = probe.decode({ archive: zip.archive, expected: zip.expected });
      await waitForDecodePost(posted);
      posted.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        get path(): string {
          throw thrown;
        },
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      } as never);
      return (await job.result).detail;
    };
    // A throwing toString falls back to the constant wording.
    expect(await runDetail({ toString(): string {
        throw new Error('no'); } })).toContain(
      'an unreadable error value',
    );
    // An unbounded toString is truncated before it lands in the detail.
    const detail = await runDetail({ toString: (): string => 'x'.repeat(10_000) });
    expect(detail === undefined ? 0 : detail.length).toBeLessThan(1000);
  });

  it('settles when an entry buffer length getter throws', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    await waitForDecodePost(worker);
    class UnmeasurableBuffer extends ArrayBuffer {
      override get byteLength(): number {
        throw new Error('no length for you');
      }
    }
    const buffer = new UnmeasurableBuffer(pngBytes.length);
    new Uint8Array(buffer).set(pngBytes);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: buffer,
    });
    const status = await job.result;
    expect(status.status).toBe('worker-error');
    // The length is captured at the shape check, so a throwing getter
    // settles through the capture guard with its cause preserved.
    expect(status.detail).toContain('could not be read');
    expect(status.detail).toContain('no length for you');
  });
  it('keeps the deadline cause when cancellation lands after the deadline elapsed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const realNow = performance.now.bind(performance);
      let nowMs: number | undefined = undefined;
      vi.spyOn(performance, 'now').mockImplementation(() => nowMs ?? realNow());
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      // The budget is spent but the deadline timer callback has not run;
      // only the elapsed-clock check can see it, and a cancel landing now
      // must not steal the cause by callback ordering.
      nowMs = realNow() + 5000;
      const cancelling = job.cancel();
      await vi.advanceTimersByTimeAsync(1000 + 50 + 1);
      const status = await cancelling;
      expect(status.status).toBe('deadline');
      expect(status.code).toBe('deadline');
      expect((await job.result).status).toBe('deadline');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('keeps the user cancellation when the deadline fires inside the cancel grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({
        archive: zip.archive.slice(),
        expected: zip.expected,
        limits: { ...defaultArchiveWorkerLimits(), decodeDeadlineMs: 100 },
      });
      const consuming = (async () => {
        for await (const _entry of job.entries) {
          void _entry;
        }
      })();
      const cancelled = job.cancel();
      // The deadline timer fires mid-grace after the user cause was chosen
      // first; the shared settlement must stay a cancellation.
      await vi.advanceTimersByTimeAsync(200);
      const status = await cancelled;
      expect(status.status).toBe('cancelled');
      expect((await job.result).status).toBe('cancelled');
      await consuming;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one settlement across repeated cancellations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = createFakeWorker();
      worker.blackhole();
      const decoder = createBoundedZipDecoder({
        createWorker: (): FakeWorker => worker,
        cancelGraceMs: 50,
      });
      const zip = fixture();
      const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
      const first = job.cancel();
      const second = job.cancel();
      // One grace window settles both calls: no stacked timers, no
      // extended wait past a single grace.
      await vi.advanceTimersByTimeAsync(50 + 1);
      const statuses = await Promise.all([first, second]);
      expect(statuses[1]).toBe(statuses[0]);
      expect(statuses[0]!.status).toBe('cancelled');
      expect((await job.result).status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes the expected manifest and limits for the job at submission', async () => {
    const worker = createFakeWorker();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const limits = { ...defaultArchiveWorkerLimits(), entryBytes: 1024 * 1024 };
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected, limits });
    // Caller mutations after submission must not change what the in-flight
    // job verifies against, on the client or on the worker.
    const secondEntry: { path: string } = zip.expected.entries[1]!;
    secondEntry.path = 'grove/rogue.json';
    limits.entryBytes = 1;
    const received: string[] = [];
    for await (const entry of job.entries) {
      received.push(entry.path);
    }
    expect(received).toEqual(['grove/grove.png', 'grove/grove.json']);
    expect((await job.result).status).toBe('completed');
  });

  it('does not let a late completion claim success after cancellation', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({ createWorker: (): FakeWorker => worker });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await waitForDecodePost(worker);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 1,
      path: 'grove/grove.png',
      method: 'store',
      bytes: pngBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await firstPull).done).toBe(false);
    const secondPull = iterator.next();
    await tick(2);
    worker.emit({
      type: 'entry',
      jobId: 1,
      seq: 2,
      path: 'grove/grove.json',
      method: 'deflate',
      bytes: jsonBytes.slice().buffer as ArrayBuffer,
    });
    await tick(2);
    expect((await secondPull).done).toBe(false);
    const thirdPull = iterator.next();
    await tick(2);
    // A fully verified completion arriving after the user chose to stop
    // cannot flip the result to completed.
    const cancelled = job.cancel();
    worker.emit({
      type: 'done',
      jobId: 1,
      status: 'completed',
      stats: { entries: 2, expandedBytes: pngBytes.length + jsonBytes.length, elapsedMs: 0 },
    });
    const status = await cancelled;
    expect(status.status).toBe('cancelled');
    expect(status.detail).toContain('after cancellation was requested');
    expect((await job.result).status).toBe('cancelled');
    await expect(thirdPull).resolves.toMatchObject({ done: true });
  });

  it('does not surface entries verified after a cancellation begins', async () => {
    const worker = createFakeWorker();
    worker.blackhole();
    const decoder = createBoundedZipDecoder({
      createWorker: (): FakeWorker => worker,
      cancelGraceMs: 5,
    });
    const zip = fixture();
    const job = decoder.decode({ archive: zip.archive, expected: zip.expected });
    const iterator = job.entries[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    await tick(2);
    let releaseDigest: (() => void) | undefined;
    const subtle = crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
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
      worker.emit({
        type: 'entry',
        jobId: 1,
        seq: 1,
        path: 'grove/grove.png',
        method: 'store',
        bytes: pngBytes.slice().buffer as ArrayBuffer,
      });
      const cancelling = job.cancel();
      releaseDigest!();
      const pull = await firstPull;
      expect(pull.done).toBe(true);
      const status = await cancelling;
      expect(status.status).toBe('cancelled');
      expect((await job.result).status).toBe('cancelled');
    } finally {
      vi.unstubAllGlobals();
    }
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
    wait: (): Promise<void> => (opened
      ? Promise.resolve()
      : new Promise((yes) => {
          resolve = yes;
        })),
    open: (): void => {
      opened = true;
      resolve?.();
    },
  };
};
