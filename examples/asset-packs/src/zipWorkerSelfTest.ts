import { createBoundedZipDecoder, type ArchiveWorkerExpected } from '@mpgd/phaser-assets/archives';
import { buildZipV1Fixture, type ZipV1FixtureEntry } from '@mpgd/phaser-assets/test-utils';

declare global {
  interface Window {
    __zip_worker_result: () => string;
  }
}

/** Assemble the expected manifest description around the shared fixture. */
async function expectedFor(entries: readonly ZipV1FixtureEntry[]): Promise<{
  archive: Uint8Array;
  expected: ArchiveWorkerExpected;
}> {
  const fixture = buildZipV1Fixture(entries);
  const digest = async (data: Uint8Array): Promise<string> => {
    const value = new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer));
    return [...value].map((n) => n.toString(16).padStart(2, '0')).join('');
  };
  return {
    archive: fixture.archive,
    expected: {
      formatVersion: 1,
      archive: {
        bytes: fixture.archive.length,
        sha256: await digest(fixture.archive),
      },
      entries: await Promise.all(fixture.entries.map(async (entry) => ({
        path: entry.path,
        method: entry.method,
        bytes: entry.bytes,
        sha256: await digest(entry.data),
      }))),
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
    const fixture = await expectedFor([
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
