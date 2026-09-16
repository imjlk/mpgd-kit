import type { ArchiveWorkerRequest, ArchiveWorkerResponse } from './archive-protocol.js';
import { createArchiveWorkerDispatch } from './archive-worker-impl.js';

/**
 * Worker entry for bounded ZIP pack decoding. Bundle this module as a module
 * worker (for example `new Worker(new URL(...), { type: 'module' })` or a
 * bundler worker import) and pass a factory for it to
 * `createBoundedZipDecoder` from `@mpgd/phaser-assets/archives`. The module
 * only installs its message handler; it never fetches, starts timers or
 * creates workers of its own. Application code deploys this file — asset
 * archives never carry executable code.
 */
type WorkerPost = (message: unknown, transfer?: readonly Transferable[]) => void;
const scope = self as unknown as {
  postMessage: WorkerPost;
  addEventListener: (type: 'message', listener: (event: MessageEvent<ArchiveWorkerRequest>) => void) => void;
};
const dispatch = createArchiveWorkerDispatch({
  post: (message: ArchiveWorkerResponse, transfer): void => {
    scope.postMessage(message, transfer);
  },
});
scope.addEventListener('message', (event) => {
  dispatch(event.data);
});
