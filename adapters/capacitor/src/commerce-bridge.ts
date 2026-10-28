import {
  bridgeCommerceEventProtocol,
  bridgeCommercePresentationEventProtocol,
  createBridgeError,
  isBridgeCommerceV2Method,
  type BridgeCommerceEvent,
  type BridgeCommercePresentationEvent,
  type BridgeCommerceV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { PlatformOperationError, type PlatformPurchasePresentationEvent } from '@mpgd/platform';
import {
  assertCommerceBridgeFetchProductsPayload,
  assertCommerceBridgeFetchProductsResult,
  assertCommerceBridgeFinishTransactionPayload,
  assertCommerceBridgeFinishTransactionResult,
  assertCommerceBridgeGetAvailablePurchasesPayload,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeGetCapabilitiesPayload,
  assertCommerceBridgeGetCapabilitiesResult,
  assertCommerceBridgeRequestPurchasePayload,
  assertCommerceBridgeRequestPurchaseResult,
  assertCommerceBridgeRestorePurchasesPayload,
  assertCommerceBridgeRestorePurchasesResult,
  assertCommerceEventEnvelope,
  assertCommercePresentationEventEnvelope,
  CommerceError,
  commerceErrorInfoOf,
  commerceProtocol,
  commerceProtocolVersion,
  type CommerceBridgeMethods,
  type CommerceEvent,
  type CommerceEventEnvelope,
  type CommerceProvider,
  type StoreId,
} from '@mpgd/platform/commerce';

import { namesOtherProtocol } from './bridge-events.js';
import type { CapacitorCommerceServiceProvider } from './providers.js';
import { createPurchasePresentationChannel } from './purchase-presentation.js';
import { normalizeStoreSdkError } from './store-sdk.js';

/** Bridge error for a commerce v2 payload the typia assert rejected. */
export const commerceV2InvalidPayloadBridgeErrorCode = 'COMMERCE_V2_INVALID_PAYLOAD' as const;
/** Bridge error for a v2 method the provider does not implement (`finishTransaction`). */
export const commerceV2MethodUnsupportedBridgeErrorCode =
  'COMMERCE_V2_METHOD_UNSUPPORTED' as const;

export interface CommerceProviderBridge {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /** Delivers `{ protocol: 'mpgd.commerce.v2', sequence, event }`; `sequence` starts at 0 per bridge. */
  subscribe(listener: (event: BridgeCommerceEvent) => void): () => void;
  /**
   * Present when the provider has `presentation`: delivers its purchase
   * presentation facts as `{ protocol: 'mpgd.commerce.presentation.v1',
   * sequence, event }`, `sequence` from 0 per bridge. Facts are never
   * buffered, and a fact of a call that opened no sheet reaches a listener
   * before that call's answer. Kept apart from `subscribe` so a commerce
   * listener sees only commerce envelopes, and a bridge without it tells a
   * consumer that its host has no facts.
   */
  subscribePresentation?(listener: (event: BridgeCommercePresentationEvent) => void): () => void;
}

export interface CreateCommerceProviderBridgeInput {
  readonly provider: CommerceProvider;
  /** Serves the methods the provider does not own, for example a plugin's ad methods. */
  readonly fallback?: { request(input: BridgeRequest): Promise<BridgeResponse> };
}

/**
 * In-process `NativeBridge` over a commerce v2 provider: the six
 * `commerce.v2.*` methods validate their payload and result with the
 * `@mpgd/platform/commerce` asserts, and events carry the bridge envelope
 * with a per-session sequence. Any other method goes to `fallback`, or answers
 * `UNSUPPORTED_METHOD` without one. A thrown failure crosses the bridge as
 * `{ code, message, retryable }`; a `cancelled` or `failed` purchase result
 * keeps its `storeCode` because it is data, not an error.
 */
export function createCommerceProviderBridge(
  input: CreateCommerceProviderBridgeInput,
): CommerceProviderBridge {
  const { provider } = input;
  const listeners = new Set<(event: BridgeCommerceEvent) => void>();
  const presentationListeners = new Set<{
    readonly listener: (event: BridgeCommercePresentationEvent) => void;
  }>();
  let sequence = 0;
  let presentationSequence = 0;
  let detach: (() => void) | undefined;
  let detachPresentation: (() => void) | undefined;

  const deliver = (event: CommerceEvent): void => {
    const envelope: BridgeCommerceEvent = { protocol: commerceProtocol, sequence, event };
    sequence += 1;
    for (const listener of [...listeners]) {
      listener(envelope);
    }
  };
  const deliverPresentation = (event: PlatformPurchasePresentationEvent): void => {
    let envelope: BridgeCommercePresentationEvent;
    try {
      envelope = assertCommercePresentationEventEnvelope({
        protocol: bridgeCommercePresentationEventProtocol,
        sequence: presentationSequence,
        event,
      });
    } catch (error) {
      // A fact the contract rejects is not delivered; the provider's own
      // safety timeout still ends a sheet it never reports closed.
      console.warn('A commerce provider reported an invalid presentation fact.', error);
      return;
    }
    presentationSequence += 1;
    for (const entry of [...presentationListeners]) {
      if (!presentationListeners.has(entry)) {
        continue;
      }
      try {
        entry.listener(envelope);
      } catch (error) {
        // A failing listener must not keep a `closed` fact from the others.
        console.warn('A purchase presentation bridge listener failed.', error);
      }
    }
  };

  const serve = async (request: BridgeRequest): Promise<unknown> => {
    const { payload } = request;
    switch (request.method) {
      case 'commerce.v2.getCapabilities': {
        assertCommerceBridgeGetCapabilitiesPayload(payload);
        return assertResult('commerce.v2.getCapabilities', {
          protocolVersion: commerceProtocolVersion,
          store: provider.store,
          capabilities: await provider.getCapabilities(),
        });
      }
      case 'commerce.v2.fetchProducts': {
        const products = await provider.fetchProducts(
          assertCommerceBridgeFetchProductsPayload(payload),
        );
        return assertResult('commerce.v2.fetchProducts', { products });
      }
      case 'commerce.v2.requestPurchase':
        return assertResult(
          'commerce.v2.requestPurchase',
          await provider.requestPurchase(assertCommerceBridgeRequestPurchasePayload(payload)),
        );
      case 'commerce.v2.getAvailablePurchases': {
        const purchases = await provider.getAvailablePurchases(
          // The payload is asserted as sent; a caller meaning the default sends `{}`.
          assertCommerceBridgeGetAvailablePurchasesPayload(payload),
        );
        return assertResult('commerce.v2.getAvailablePurchases', { purchases });
      }
      case 'commerce.v2.finishTransaction': {
        const finish = assertCommerceBridgeFinishTransactionPayload(payload);
        if (provider.finishTransaction === undefined) {
          throw new PlatformOperationError({
            code: commerceV2MethodUnsupportedBridgeErrorCode,
            message: `Store ${provider.store} does not finish transactions on the client.`,
          });
        }
        return assertResult(
          'commerce.v2.finishTransaction',
          await provider.finishTransaction(finish),
        );
      }
      case 'commerce.v2.restorePurchases': {
        assertCommerceBridgeRestorePurchasesPayload(payload);
        if (provider.restorePurchases === undefined) {
          return assertResult('commerce.v2.restorePurchases', { restored: false });
        }
        await provider.restorePurchases();
        return assertResult('commerce.v2.restorePurchases', { restored: true });
      }
      default:
        throw new PlatformOperationError({
          code: 'UNSUPPORTED_METHOD',
          message: `${request.method} is not a commerce method.`,
        });
    }
  };

  return {
    async request(request) {
      if (!isBridgeCommerceV2Method(request.method) && input.fallback !== undefined) {
        return input.fallback.request(request);
      }
      try {
        return { id: request.id, ok: true, data: await serve(request) };
      } catch (error) {
        return toBridgeError(request, error);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        detach = provider.subscribe(deliver);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        detach?.();
        detach = undefined;
      };
    },
    ...(provider.presentation === undefined ? {} : {
      subscribePresentation(listener: (event: BridgeCommercePresentationEvent) => void) {
        const entry = { listener };
        presentationListeners.add(entry);
        if (presentationListeners.size === 1) {
          detachPresentation = provider.presentation?.subscribe(deliverPresentation);
        }
        return () => {
          if (!presentationListeners.delete(entry) || presentationListeners.size > 0) {
            return;
          }
          detachPresentation?.();
          detachPresentation = undefined;
        };
      },
    }),
  };
}

export interface CreateCommerceServiceProviderInput {
  readonly id: string;
  readonly commerce: CommerceProvider;
}

/**
 * Registry entry for a commerce provider: it declares no feature and no
 * method, the six `commerce.v2.*` methods are implied and served in process by
 * `createCommerceProviderBridge`, and the gateway's `commerce` capability block
 * is the provider's own `getCapabilities()` answer.
 */
export function createCommerceServiceProvider(
  input: CreateCommerceServiceProviderInput,
): CapacitorCommerceServiceProvider {
  return {
    id: input.id,
    features: [],
    methods: [],
    commerce: input.commerce,
    bridge: createCommerceProviderBridge({ provider: input.commerce }),
    async getAvailability() {
      return {};
    },
  };
}

// Each entry is the typia assert of that method's result type; the lookup is
// typed by `assertCommerceBridgeResult`.
const resultAsserts: Readonly<Record<BridgeCommerceV2Method, (input: unknown) => unknown>> = {
  'commerce.v2.getCapabilities': assertCommerceBridgeGetCapabilitiesResult,
  'commerce.v2.fetchProducts': assertCommerceBridgeFetchProductsResult,
  'commerce.v2.requestPurchase': assertCommerceBridgeRequestPurchaseResult,
  'commerce.v2.getAvailablePurchases': assertCommerceBridgeGetAvailablePurchasesResult,
  'commerce.v2.finishTransaction': assertCommerceBridgeFinishTransactionResult,
  'commerce.v2.restorePurchases': assertCommerceBridgeRestorePurchasesResult,
};

/** Validates a commerce v2 result; a provider answer the contract rejects never reaches the caller. */
export function assertCommerceBridgeResult<TMethod extends BridgeCommerceV2Method>(
  method: TMethod,
  data: unknown,
): CommerceBridgeMethods[TMethod]['result'] {
  return resultAsserts[method](data) as CommerceBridgeMethods[TMethod]['result'];
}

function assertResult<TMethod extends BridgeCommerceV2Method>(
  method: TMethod,
  data: unknown,
): CommerceBridgeMethods[TMethod]['result'] {
  try {
    return assertCommerceBridgeResult(method, data);
  } catch (error) {
    throw new PlatformOperationError({
      code: 'NATIVE_PROVIDER_INVALID_RESPONSE',
      message: `Commerce provider returned invalid data for ${method}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

function toBridgeError(request: BridgeRequest, error: unknown): BridgeResponse {
  if (isTypiaGuardError(error)) {
    return createBridgeError(
      request.id,
      commerceV2InvalidPayloadBridgeErrorCode,
      `${request.method} payload is invalid: ${error.message}`,
    );
  }
  if (error instanceof PlatformOperationError) {
    return createBridgeError(request.id, error.code, error.message, error.retryable);
  }
  const info = commerceErrorInfoOf(error);
  return createBridgeError(
    request.id,
    info.code,
    info.message ?? `${request.method} failed.`,
    info.retryable,
  );
}

function isTypiaGuardError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TypeGuardError';
}

// Client side.

export interface CreateBridgeCommerceProviderInput {
  readonly store: StoreId;
  /** Sends one validated bridge request; the gateway's `request` fits. */
  readonly request: <TData>(method: BridgeCommerceV2Method, payload: unknown) => Promise<TData>;
  readonly subscribe: (listener: (event: BridgeCommerceEvent) => void) => () => void;
  /**
   * The bridge host accepts `FinishTransactionInput.retry` (it is built on the
   * same contract and its provider declares `acceptsFinishRetry`). Absent, the
   * provider does not declare it and callers never send `retry`.
   */
  readonly acceptsFinishRetry?: boolean;
  /**
   * The host's purchase presentation facts
   * (`CommerceProviderBridge.subscribePresentation`), each fact of a call
   * that opened no sheet delivered before that call's answer. Only with it
   * does this provider offer `presentation`: a host built before the
   * protocol, or one whose provider has no facts, leaves it out, and the
   * consumer keeps its behavior without them.
   */
  readonly subscribePresentation?: (
    listener: (event: BridgeCommercePresentationEvent) => void,
  ) => () => void;
}

/**
 * `CommerceProvider` over a bridge that serves the `commerce.v2.*` methods and
 * the event envelope. Results are validated again on this side, so a transport
 * that forgets to is still fail-closed; bridge errors become `CommerceError`s
 * with the bridge code kept as `storeCode` when it is not already a v2 code.
 *
 * With `subscribePresentation`, it offers `presentation`: the host's facts,
 * validated and numbered again on this side, plus `not-started`, delivered
 * before the answer, for a `requestPurchase` that settles without any fact
 * (the bridge refused it before the host's provider ran). Every call it
 * forwards then ends with a fact.
 */
export function createBridgeCommerceProvider(
  input: CreateBridgeCommerceProviderInput,
): CommerceProvider {
  const send = async <TMethod extends BridgeCommerceV2Method>(
    method: TMethod,
    payload: CommerceBridgeMethods[TMethod]['payload'],
  ): Promise<CommerceBridgeMethods[TMethod]['result']> => {
    let data: unknown;
    try {
      data = await input.request<unknown>(method, payload);
    } catch (error) {
      throw toCommerceError(error);
    }
    try {
      return assertCommerceBridgeResult(method, data);
    } catch (error) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: `Bridge returned invalid data for ${method}.`,
        cause: error,
      });
    }
  };
  const provider: CommerceProvider = {
    store: input.store,
    ...(input.acceptsFinishRetry === true ? { acceptsFinishRetry: true } : {}),
    async getCapabilities() {
      return (await send('commerce.v2.getCapabilities', { protocol: commerceProtocol }))
        .capabilities;
    },
    async fetchProducts(request) {
      return (await send('commerce.v2.fetchProducts', request)).products;
    },
    requestPurchase(request) {
      return send('commerce.v2.requestPurchase', request);
    },
    async getAvailablePurchases(request = {}) {
      return (await send('commerce.v2.getAvailablePurchases', request)).purchases;
    },
    finishTransaction(request) {
      return send('commerce.v2.finishTransaction', request);
    },
    async restorePurchases() {
      await send('commerce.v2.restorePurchases', { protocol: commerceProtocol });
    },
    subscribe(listener) {
      return input.subscribe((envelope) => {
        // Another protocol on a shared event channel is not ours to judge; an
        // envelope without a protocol is malformed and must reach the
        // validator, as in the Apps in Toss provider.
        if (namesOtherProtocol(envelope, bridgeCommerceEventProtocol)) {
          return;
        }
        let event: CommerceEventEnvelope;
        try {
          event = assertCommerceEventEnvelope(envelope);
        } catch (error) {
          listener({
            type: 'purchaseError',
            error: new CommerceError('INVALID_RESPONSE', {
              message: 'Bridge delivered an invalid commerce event.',
              cause: error,
            }).toCommerceErrorInfo(),
          });
          return;
        }
        listener(event.event);
      });
    },
  };
  const subscribePresentation = input.subscribePresentation;
  return subscribePresentation === undefined
    ? provider
    : withBridgePresentation(provider, subscribePresentation);
}

/**
 * `presentation` over the host's facts. One attachment to the host serves
 * every listener; it is made with the first and dropped with the last.
 */
function withBridgePresentation(
  provider: CommerceProvider,
  subscribePresentation: NonNullable<CreateBridgeCommerceProviderInput['subscribePresentation']>,
): CommerceProvider {
  const channel = createPurchasePresentationChannel();
  let listenerCount = 0;
  let detach: (() => void) | undefined;
  // Idempotency keys of `requestPurchase` calls in flight, each call with
  // whether a fact for its key arrived while it ran. Facts are observed only
  // while a listener is attached; a consumer (the game runtime's gate)
  // subscribes before its first purchase, so it never misses one.
  const calls = new Map<string, { seen: boolean }[]>();

  const onEnvelope = (envelope: BridgeCommercePresentationEvent): void => {
    if (namesOtherProtocol(envelope, bridgeCommercePresentationEventProtocol)) {
      return;
    }
    let event: PlatformPurchasePresentationEvent;
    try {
      event = assertCommercePresentationEventEnvelope(envelope).event;
    } catch (error) {
      console.warn('The bridge delivered an invalid purchase presentation fact.', error);
      return;
    }
    for (const call of calls.get(event.idempotencyKey) ?? []) {
      call.seen = true;
    }
    channel.publish({
      idempotencyKey: event.idempotencyKey,
      state: event.state,
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
  };

  return {
    ...provider,
    presentation: {
      subscribe(listener) {
        const unsubscribe = channel.presentation.subscribe(listener);
        listenerCount += 1;
        detach ??= subscribePresentation(onEnvelope);
        let active = true;
        return () => {
          if (!active) {
            return;
          }
          active = false;
          unsubscribe();
          listenerCount -= 1;
          if (listenerCount === 0 && detach !== undefined) {
            const unsubscribeHost = detach;
            detach = undefined;
            unsubscribeHost();
          }
        };
      },
    },
    async requestPurchase(request) {
      const call = { seen: false };
      const key = request.idempotencyKey;
      calls.set(key, [...(calls.get(key) ?? []), call]);
      try {
        return await provider.requestPurchase(request);
      } finally {
        const remaining = (calls.get(key) ?? []).filter((entry) => entry !== call);
        if (remaining.length === 0) {
          calls.delete(key);
        } else {
          calls.set(key, remaining);
        }
        // No fact by the answer: the host's provider never ran, so no sheet
        // opened. Published before the caller sees the answer.
        if (!call.seen) {
          channel.publish({ idempotencyKey: key, state: 'not-started' });
        }
      }
    },
  };
}

function toCommerceError(error: unknown): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  if (error instanceof PlatformOperationError) {
    return normalizeStoreSdkError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  return normalizeStoreSdkError(error);
}
