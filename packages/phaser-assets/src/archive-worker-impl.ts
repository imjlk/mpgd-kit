import { ZipDecodeError } from './archive-errors.js';
import type {
  ArchiveWorkerRequest,
  ArchiveWorkerResponse,
  ArchiveWorkerStats,
} from './archive-protocol.js';
import {
  decodeZipV1Entries,
  type ExpectedZipArchive,
  type ZipDecodeLimits,
} from './archive-zip-core.js';

export interface ArchiveWorkerPort {
  post(message: ArchiveWorkerResponse, transfer?: readonly Transferable[]): void;
}
interface ActiveJob {
  readonly jobId: number;
  readonly transferArchive: boolean;
  readonly startedAt: number;
  cancelled: boolean;
  entries: number;
  expandedBytes: number;
  resolveRelease: ((seq: number, cancelled: boolean) => void) | undefined;
}
const stats = (job: ActiveJob): ArchiveWorkerStats => ({
  entries: job.entries,
  expandedBytes: job.expandedBytes,
  elapsedMs: Date.now() - job.startedAt,
});

/**
 * Protocol logic for the archive decode worker. Kept separate from the
 * worker entry so tests can drive exactly the same code with an in-process
 * port. The worker decodes one entry at a time and only proceeds after the
 * client acknowledges the previous entry, so the main thread never queues
 * unbounded output.
 */
export function createArchiveWorkerDispatch(port: ArchiveWorkerPort): (message: ArchiveWorkerRequest) => void {
  let active: ActiveJob | undefined;
  const finish = (
    job: ActiveJob,
    status: ArchiveWorkerResponse & { readonly type: 'done' },
  ): void => {
    if (active === job) {
      active = undefined;
    }
    const transfer: Transferable[] = [];
    if (job.transferArchive && status.archive !== undefined) {
      transfer.push(status.archive);
    }
    port.post(status, transfer);
  };
  const runJob = async (request: ArchiveWorkerRequest & { readonly type: 'decode' }): Promise<void> => {
    const job: ActiveJob = {
      jobId: request.jobId,
      transferArchive: request.transferArchive,
      startedAt: Date.now(),
      cancelled: false,
      entries: 0,
      expandedBytes: 0,
      resolveRelease: undefined,
    };
    active = job;
    const archiveBytes = new Uint8Array(request.archive);
    const handBackArchive = (): ArrayBuffer | undefined => {
      if (!request.transferArchive) {
        return undefined;
      }
      // The transferred caller buffer is returned whole; decoded entries are
      // fresh buffers, so nothing aliases it anymore.
      return archiveBytes.buffer as ArrayBuffer;
    };
    const fail = (status: 'cancelled' | 'deadline' | 'error', code?: string, detail?: string): void => {
      finish(job, {
        type: 'done',
        jobId: job.jobId,
        status,
        code,
        detail,
        archive: handBackArchive(),
        stats: stats(job),
      });
    };
    try {
      const expected = request.expected as ExpectedZipArchive;
      const limits = request.limits as ZipDecodeLimits;
      for await (const entry of decodeZipV1Entries(archiveBytes, expected, limits, {
        shouldStop: (): boolean => job.cancelled,
      })) {
        if (job.cancelled) {
          break;
        }
        const seq = job.entries + 1;
        const buffer = entry.bytes.buffer.slice(
          entry.bytes.byteOffset,
          entry.bytes.byteOffset + entry.bytes.byteLength,
        ) as ArrayBuffer;
        port.post(
          {
            type: 'entry',
            jobId: job.jobId,
            seq,
            path: entry.path,
            method: entry.method,
            bytes: buffer,
          },
          [buffer],
        );
        job.entries = seq;
        job.expandedBytes += entry.bytes.byteLength;
        const released = await new Promise<boolean>((resolve) => {
          job.resolveRelease = (ackSeq, cancelled) => resolve(ackSeq === seq ? cancelled : job.cancelled);
        });
        job.resolveRelease = undefined;
        if (released || job.cancelled) {
          break;
        }
      }
      if (job.cancelled) {
        fail('cancelled');
        return;
      }
      finish(job, {
        type: 'done',
        jobId: job.jobId,
        status: 'completed',
        archive: handBackArchive(),
        stats: stats(job),
      });
    } catch (error) {
      if (job.cancelled) {
        fail('cancelled');
        return;
      }
      if (error instanceof ZipDecodeError) {
        if (error.code === 'cancelled') {
          fail('cancelled');
          return;
        }
        if (error.code === 'deadline') {
          fail('deadline', error.code, error.message);
          return;
        }
        fail('error', error.code, error.message);
        return;
      }
      fail('error', 'decode', String(error));
    }
  };
  return (message: ArchiveWorkerRequest): void => {
    if (message.type === 'decode') {
      if (active !== undefined) {
        port.post({
          type: 'done',
          jobId: message.jobId,
          status: 'error',
          code: 'worker-busy',
          detail: 'The archive worker already runs a decode job',
          stats: stats(active),
        });
        return;
      }
      void runJob(message);
      return;
    }
    const job = active;
    if (job === undefined || job.jobId !== message.jobId) {
      return;
    }
    if (message.type === 'cancel') {
      job.cancelled = true;
      job.resolveRelease?.(0, true);
      return;
    }
    if (message.type === 'release' && job.resolveRelease !== undefined) {
      job.resolveRelease(message.seq, false);
    }
  };
}
