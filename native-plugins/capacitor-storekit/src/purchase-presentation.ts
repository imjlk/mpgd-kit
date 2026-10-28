import type { PluginListenerHandle } from '@capacitor/core';

// The store sheet facts of the StoreKit SDK. The types mirror
// `StoreSdkPurchasePresentation*` of `@mpgd/adapter-capacitor` field for
// field instead of importing them, so this package's declarations still
// type-check against an adapter from before sheet facts (which never sends a
// `presentationId`, so purchases run as in earlier releases).

export type StoreKitPurchasePresentationState = 'open' | 'closed' | 'not-started';

/** A sheet fact of one `requestPurchase` call; see `StoreSdkPurchasePresentationEvent`. */
export interface StoreKitSdkPurchasePresentationEvent {
  readonly presentationId: string;
  readonly state: StoreKitPurchasePresentationState;
  readonly reason?: NativePresentationReason;
}

/** Why native code closed a sheet it did not see close: teardown, or its own safety bound. */
export type NativePresentationReason = 'interrupted' | 'timeout';

/** The SDK's `purchasePresentation`; see `StoreSdkPurchasePresentation` in `@mpgd/adapter-capacitor`. */
export interface StoreKitSdkPurchasePresentation {
  subscribe(listener: (event: StoreKitSdkPurchasePresentationEvent) => void): () => void;
}

export interface NativePurchasePresentation {
  readonly purchasePresentation: StoreKitSdkPurchasePresentation;
  /** Whether the native code in the app reports facts; see `getPresentationSupport`. */
  supported(): Promise<boolean>;
  /**
   * Someone follows the facts: an adapter that reads them subscribes when it
   * builds its provider (one from before them never does).
   */
  followed(): boolean;
  /** Follows facts for a `purchase` call about to be sent with this id. */
  begin(presentationId: string): void;
  /** Applies the sheet state a `purchase` answer (or a rejection's `data`) carried. */
  answered(presentationId: string, presentation: unknown): void;
}

/**
 * Facts by presentation id from the native `purchasePresentation` events and
 * the `presentation` field of `purchase` answers, whichever arrives first:
 * `requested` until `open`, removed once the sheet ended, so each call gets
 * at most one `open` and one terminal fact. The native listener is attached
 * with the first subscriber and removed with the last.
 */
export function createNativePurchasePresentation(native: {
  addListener(
    eventName: 'purchasePresentation',
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
  readonly getPresentationSupport?: () => Promise<unknown>;
}): NativePurchasePresentation {
  const listeners = new Set<{
    readonly listener: (event: StoreKitSdkPurchasePresentationEvent) => void;
  }>();
  const sheets = new Map<string, 'requested' | 'open'>();
  let handle: Promise<PluginListenerHandle> | undefined;
  let generation = 0;
  let support: Promise<boolean> | undefined;

  const report = (
    presentationId: string,
    state: StoreKitPurchasePresentationState,
    reason?: NativePresentationReason,
  ): void => {
    const current = sheets.get(presentationId);
    if (current === undefined || (state === 'open' && current === 'open')) {
      return;
    }
    if (state === 'open') {
      sheets.set(presentationId, 'open');
    } else {
      sheets.delete(presentationId);
    }
    const event: StoreKitSdkPurchasePresentationEvent = {
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
    const { state } = event;
    if (state === 'open' || state === 'closed' || state === 'not-started') {
      report(
        event.presentationId,
        state,
        state === 'closed' && (event.reason === 'interrupted' || event.reason === 'timeout')
          ? event.reason
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
            // A native build from before the facts answers UNIMPLEMENTED for
            // good; any other failure is asked again next time.
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
    answered(presentationId, presentation) {
      if (presentation === 'open' || presentation === 'requested') {
        // Still up, or not observed yet: facts follow as events.
        report(presentationId, 'open');
      } else if (presentation === 'closed' || presentation === 'not-started') {
        report(presentationId, presentation);
      } else if (sheets.get(presentationId) === 'requested') {
        // No sheet state from native code that declared facts: nothing was
        // seen opening, which the provider reads as not-started.
        sheets.delete(presentationId);
      }
    },
  };
}

/** The `presentation` of a `purchase` answer or of a rejection's `data`. */
export function answeredPresentation(answer: unknown): unknown {
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
