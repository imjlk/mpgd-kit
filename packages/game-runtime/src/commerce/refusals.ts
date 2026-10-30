/**
 * The purchase coordinator's own pre-launch refusals and the answers it gives
 * for them. Dependency-free, so `@mpgd/game-runtime/actions` matches a service
 * result against the same definitions without loading commerce code.
 */
export type CoordinatorRefusal = 'busy' | 'disposed' | 'history-full';

export const coordinatorRefusalAnswers: Readonly<Record<CoordinatorRefusal, Readonly<{
  code: 'IN_PROGRESS' | 'NOT_PREPARED';
  storeCode: string;
  message: string;
}>>> = Object.freeze({
  busy: Object.freeze({
    code: 'IN_PROGRESS',
    storeCode: 'PRESENTATION_BUSY',
    message: 'Another full-screen presentation is in progress.',
  }),
  disposed: Object.freeze({
    code: 'NOT_PREPARED',
    storeCode: 'PRESENTATION_DISPOSED',
    message: 'Purchase coordination has been disposed.',
  }),
  'history-full': Object.freeze({
    code: 'IN_PROGRESS',
    storeCode: 'PRESENTATION_HISTORY_FULL',
    message: 'Every remembered purchase is still in flight or retryable.',
  }),
});

/**
 * Which coordinator refusal an error is exactly, if any: its code, its store
 * code (`providerCode` in a service diagnostic) and `retryable: true`. A
 * store's own failure can carry the same codes, so pair this with the
 * coordinator's `onRefusal` for the same key before trusting it.
 */
export function matchCoordinatorRefusal(error: {
  readonly code: string;
  readonly retryable: boolean;
  readonly storeCode?: string | undefined;
} | undefined): CoordinatorRefusal | undefined {
  if (error === undefined || error.retryable !== true) {
    return undefined;
  }
  for (const reason of ['busy', 'disposed', 'history-full'] as const) {
    const answer = coordinatorRefusalAnswers[reason];
    if (error.code === answer.code && error.storeCode === answer.storeCode) {
      return reason;
    }
  }
  return undefined;
}
