import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const maximumWaitMs = 30_000;
const pollingIntervalMs = 50;
const incompleteLockGraceMs = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Local-process lock for atomic read/merge/replace of a shared release manifest. */
export function withReleaseManifestLock<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + maximumWaitMs;

  while (true) {
    try {
      const descriptor = openSync(lockFile, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
      } catch (error) {
        unlinkSync(lockFile);
        throw error;
      } finally {
        closeSync(descriptor);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let observed;
      try {
        observed = lstatSync(lockFile);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (observed.isSymbolicLink()) {
        throw new Error('Release manifest lock must not be a symbolic link.');
      }
      if (canRecoverLock(lockFile)) {
        try {
          const current = lstatSync(lockFile);
          if (current.dev === observed.dev && current.ino === observed.ino
            && current.mtimeMs === observed.mtimeMs) {
            unlinkSync(lockFile);
          }
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw unlinkError;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the release manifest lock.');
      }
      Atomics.wait(sleeper, 0, 0, pollingIntervalMs);
    }
  }

  try {
    return action();
  } finally {
    if (existsSync(lockFile)) {
      const contents = readFileSync(lockFile, 'utf8');
      if (contents.includes(token)) {
        unlinkSync(lockFile);
      }
    }
  }
}

function canRecoverLock(lockFile: string): boolean {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return Date.now() - statSync(lockFile).mtimeMs > incompleteLockGraceMs;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return Date.now() - statSync(lockFile).mtimeMs > incompleteLockGraceMs;
  }
  const pid = (record as { readonly pid?: unknown }).pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
    return Date.now() - statSync(lockFile).mtimeMs > incompleteLockGraceMs;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
