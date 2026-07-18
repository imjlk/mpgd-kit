import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

import { type MicrosoftStoreFileSnapshot } from './microsoft-store-package-generation-contract.js';

export function hashMicrosoftStoreFileSnapshot(
  file: string,
  label: string,
): MicrosoftStoreFileSnapshot {
  const descriptor = openSync(file, 'r');

  try {
    const pathBefore = statSync(file);
    const openedBefore = fstatSync(descriptor);

    if (
      pathBefore.dev !== openedBefore.dev
      || pathBefore.ino !== openedBefore.ino
      || !openedBefore.isFile()
    ) {
      throw new Error(`${label} changed while it was opened: ${file}`);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sizeBytes = 0;

    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }

      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }

    const openedAfter = fstatSync(descriptor);
    const pathAfter = statSync(file);

    if (
      sizeBytes !== openedBefore.size
      || openedAfter.size !== openedBefore.size
      || openedAfter.mtimeMs !== openedBefore.mtimeMs
      || pathAfter.dev !== openedBefore.dev
      || pathAfter.ino !== openedBefore.ino
      || pathAfter.size !== openedBefore.size
      || pathAfter.mtimeMs !== openedBefore.mtimeMs
    ) {
      throw new Error(`${label} changed while it was hashed: ${file}`);
    }

    return { sizeBytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(descriptor);
  }
}

export function assertMicrosoftStoreSnapshotUnchanged(
  file: string,
  expected: MicrosoftStoreFileSnapshot,
  message: string,
): void {
  const actual = hashMicrosoftStoreFileSnapshot(file, message);

  if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
    throw new Error(`${message}: ${file}`);
  }
}

export function hashMicrosoftStoreBytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
