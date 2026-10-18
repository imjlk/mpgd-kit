import type {
  AitNotificationAgreementRequest,
  AitNotificationAgreementResult,
  AitNotificationSdk,
} from '../src/notifications-provider.js';

/** One scripted answer of the fake agreement sheet. */
export type FakeAitAgreementAnswer =
  | { readonly kind: 'event'; readonly type: AitNotificationAgreementResult; readonly sync?: boolean }
  /** The sheet never answers, so the provider's settle timer decides. */
  | { readonly kind: 'silent' }
  | { readonly kind: 'error'; readonly error: unknown; readonly sync?: boolean }
  /** `requestAgreement` itself throws, as it does on a Toss app too old for it. */
  | { readonly kind: 'throw'; readonly error: unknown };

export interface FakeAitNotificationHost {
  readonly sdk: AitNotificationSdk;
  /** Template codes of every `requestAgreement` call, in order. */
  readonly calls: readonly string[];
  /** Cleanup calls the provider made. */
  readonly cleanups: number;
  /** Sheets currently open (called and not yet cleaned up). */
  readonly open: number;
  queue(answer: FakeAitAgreementAnswer): void;
  setSupported(supported: boolean): void;
  setInitialUrl(url: string | undefined): void;
}

/**
 * A fake `Notification.requestAgreement` and `Environment.initialURL`. Each
 * call takes the next queued answer and delivers it on a later microtask (or
 * synchronously, before the call returns, with `sync`); a call with nothing
 * queued throws, so an unscripted prompt fails the test.
 */
export function createFakeAitNotificationHost(
  input: { readonly supported?: boolean; readonly initialUrl?: string } = {},
): FakeAitNotificationHost {
  const answers: FakeAitAgreementAnswer[] = [];
  const calls: string[] = [];
  let cleanups = 0;
  let open = 0;
  let supported = input.supported ?? true;
  let initialUrl = input.initialUrl;

  const requestAgreement = Object.assign(
    (request: AitNotificationAgreementRequest): (() => void) => {
      calls.push(request.options.templateCode);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error(`Unscripted agreement sheet for ${request.options.templateCode}.`);
      }
      if (answer.kind === 'throw') {
        throw answer.error;
      }
      open += 1;
      let cleaned = false;
      const cleanup = (): void => {
        if (!cleaned) {
          cleaned = true;
          cleanups += 1;
          open -= 1;
        }
      };
      const deliver = (): void => {
        if (answer.kind === 'event') {
          request.onEvent({ type: answer.type });
        } else if (answer.kind === 'error') {
          void request.onError(answer.error);
        }
      };
      if (answer.kind !== 'silent' && answer.sync === true) {
        deliver();
      } else {
        queueMicrotask(deliver);
      }
      return cleanup;
    },
    { isSupported: () => supported },
  );

  return {
    sdk: { requestAgreement, readInitialUrl: () => initialUrl },
    get calls() {
      return calls;
    },
    get cleanups() {
      return cleanups;
    },
    get open() {
      return open;
    },
    queue(answer) {
      answers.push(answer);
    },
    setSupported(next) {
      supported = next;
    },
    setInitialUrl(url) {
      initialUrl = url;
    },
  };
}
