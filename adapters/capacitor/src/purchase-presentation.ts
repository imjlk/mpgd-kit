import type { PluginListenerHandle } from '@capacitor/core';

import type {
  StoreSdkPurchasePresentation,
  StoreSdkPurchasePresentationEvent,
} from './store-sdk.js';

/**
 * Upper bound on how long one store sheet counts as open (or possibly open)
 * without a native `closed` fact. Past it the provider reports `closed` with
 * reason `timeout`, so a lost native observation can pause the game, but
 * never forever. It matches the purchase flow timeout of the OpenIAP Google
 * core (15 minutes).
 */
export const purchasePresentationTimeoutMs = 15 * 60_000;

/** A store plugin's native surface for sheet facts (Play Billing, StoreKit). */
export interface NativePurchasePresentationPlugin {
  addListener(
    eventName: 'purchasePresentation',
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
  readonly getPresentationSupport?: () => Promise<unknown>;
}

/** What a store plugin's `StoreSdk` uses to report its native sheet facts. */
export interface NativePurchasePresentation {
  /** The SDK's `purchasePresentation` declaration. */
  readonly purchasePresentation: StoreSdkPurchasePresentation;
  /**
   * Whether the native code in the app reports facts (`getPresentationSupport`).
   * A build from before them answers `UNIMPLEMENTED`, which is remembered;
   * any other failure is asked again next time.
   */
  supported(): Promise<boolean>;
  /**
   * Someone follows the facts: an adapter that reads them subscribes when it
   * builds its provider (one from before them never does).
   */
  followed(): boolean;
  /** Follows facts for a `purchase` call about to be sent with this id. */
  begin(presentationId: string): void;
  /**
   * Applies the sheet state a `purchase` answer, or a rejection's `data`,
   * carried (`presentation`): `open`, `closed`, `not-started`, or
   * `requested` (native code still runs the flow and has observed nothing
   * yet; its facts follow as events).
   */
  answered(presentationId: string, answerOrError: unknown): void;
}

/**
 * Sheet facts by presentation id from the plugin's `purchasePresentation`
 * events and the `presentation` field of its `purchase` answers, whichever
 * arrives first; each call gets at most one `open` and one terminal fact.
 * A `requested` answer is reported as `unknown`: the sheet may still come,
 * so the provider keeps the call waiting for the native `open`, `closed`, or
 * `not-started` instead of reading the answer as a sheet that never opened
 * or inventing one that did. The native listener is attached with the first
 * subscriber and removed with the last.
 *
 * Exported for the store plugins, which peer on this package. A plugin reads
 * it through the module namespace, so with an adapter from before it the
 * plugin declares no facts (and that adapter never asks for them).
 */
export function createNativePurchasePresentation(
  native: NativePurchasePresentationPlugin,
): NativePurchasePresentation {
  const listeners = new Set<{
    readonly listener: (event: StoreSdkPurchasePresentationEvent) => void;
  }>();
  const sheets = new Map<string, 'requested' | 'unknown' | 'open'>();
  let handle: Promise<PluginListenerHandle> | undefined;
  let generation = 0;
  let support: Promise<boolean> | undefined;

  const report = (
    presentationId: string,
    state: StoreSdkPurchasePresentationEvent['state'],
    reason?: StoreSdkPurchasePresentationEvent['reason'],
  ): void => {
    const current = sheets.get(presentationId);
    if (current === undefined || current === state || (state === 'unknown' && current === 'open')) {
      return;
    }
    if (state === 'open' || state === 'unknown') {
      sheets.set(presentationId, state);
    } else {
      sheets.delete(presentationId);
    }
    const event: StoreSdkPurchasePresentationEvent = {
      presentationId,
      state,
      ...(reason === undefined ? {} : { reason }),
    };
    for (const entry of [...listeners]) {
      if (listeners.has(entry)) {
        entry.listener(event);
      }
    }
  };
  const onNativeFact = (event: unknown): void => {
    if (!isRecord(event) || typeof event.presentationId !== 'string') {
      return;
    }
    const { state, reason } = event;
    if (state === 'open' || state === 'closed' || state === 'not-started') {
      report(
        event.presentationId,
        state,
        state === 'closed' && (reason === 'interrupted' || reason === 'timeout')
          ? reason
          : undefined,
      );
    }
  };
  const attach = (): void => {
    if (handle !== undefined) {
      return;
    }
    const attached = generation;
    let added: Promise<PluginListenerHandle>;
    try {
      added = native.addListener('purchasePresentation', (event) => {
        if (attached === generation) {
          onNativeFact(event);
        }
      });
    } catch {
      return;
    }
    handle = added;
    added.catch(() => {
      if (handle === added) {
        handle = undefined;
      }
    });
  };
  const detach = (): void => {
    const current = handle;
    if (current === undefined) {
      return;
    }
    handle = undefined;
    generation += 1;
    current.then((resolved) => resolved.remove()).catch(() => undefined);
  };

  return {
    purchasePresentation: {
      subscribe(listener) {
        const entry = { listener };
        listeners.add(entry);
        attach();
        return () => {
          if (listeners.delete(entry) && listeners.size === 0) {
            detach();
          }
        };
      },
    },
    followed() {
      return listeners.size > 0;
    },
    supported() {
      if (support !== undefined) {
        return support;
      }
      const check = native.getPresentationSupport;
      if (typeof check !== 'function') {
        return Promise.resolve(false);
      }
      const attempt = Promise.resolve()
        .then(() => check.call(native))
        .then(
          (answer: unknown) => isRecord(answer)
            && typeof answer.purchasePresentation === 'number'
            && answer.purchasePresentation >= 1,
          (error: unknown) => {
            if (!isRecord(error) || error.code !== 'UNIMPLEMENTED') {
              support = undefined;
            }
            return false;
          },
        );
      support = attempt;
      return attempt;
    },
    begin(presentationId) {
      sheets.set(presentationId, 'requested');
    },
    answered(presentationId, answerOrError) {
      const presentation = answeredPresentation(answerOrError);
      if (presentation === 'open' || presentation === 'closed' || presentation === 'not-started') {
        report(presentationId, presentation);
      } else if (presentation === 'requested') {
        report(presentationId, 'unknown');
      } else if (sheets.get(presentationId) === 'requested') {
        // No sheet state from native code that declared facts: nothing was
        // seen opening, which the provider reads as not-started.
        sheets.delete(presentationId);
      }
    },
  };
}

/** The `presentation` of a `purchase` answer or of a rejection's `data`. */
function answeredPresentation(answer: unknown): unknown {
  if (!isRecord(answer)) {
    return undefined;
  }
  if ('presentation' in answer) {
    return answer.presentation;
  }
  return isRecord(answer.data) ? answer.data.presentation : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
