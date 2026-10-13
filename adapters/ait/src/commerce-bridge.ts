import {
  bridgeCommerceEventProtocol,
  createBridgeError,
  type BridgeCommerceEvent,
  type BridgeCommerceV2Method,
  type BridgeEventStream,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
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
  CommerceError,
  commerceErrorInfoOf,
  commerceProtocol,
  commerceProtocolVersion,
  isCommerceErrorCode,
  type CommerceBridgeMethods,
  type CommerceEvent,
  type CommerceEventEnvelope,
  type CommerceProvider,
  type StoreId,
} from '@mpgd/platform/commerce';

/**
 * Commerce v2 over the Apps in Toss game bridge. The host side serves the six
 * `commerce.v2.*` methods from a `CommerceProvider` and pushes events to the
 * game in the `@mpgd/bridge` envelope; the game side is a `CommerceProvider`
 * over the installed bridge. Both sides validate payloads and results with
 * the `@mpgd/platform/commerce` asserts, so an invalid answer never reaches a
 * caller as data. This module imports no Apps in Toss SDK.
 */

/** Bridge error for a commerce v2 payload the typia assert rejected. */
export const aitCommerceV2InvalidPayloadBridgeErrorCode = 'COMMERCE_V2_INVALID_PAYLOAD' as const;
/** Bridge error for a v2 method the provider does not implement (`finishTransaction`). */
export const aitCommerceV2MethodUnsupportedBridgeErrorCode =
  'COMMERCE_V2_METHOD_UNSUPPORTED' as const;

export interface AitCommerceV2BridgeHandler extends BridgeEventStream<BridgeCommerceEvent> {
  /** Answers one of the six `commerce.v2.*` methods; other methods are rejected. */
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

/**
 * Host side: serves `commerce.v2.*` from the provider. Events are delivered
 * as `{ protocol: 'mpgd.commerce.v2', sequence, event }` with a per-handler
 * sequence starting at 0; the provider is subscribed when the first bridge
 * listener attaches, so events the provider buffered before that reach the
 * first game listener. A thrown failure crosses the bridge as
 * `{ code, message, retryable }`; a `cancelled` or `failed` purchase result
 * keeps its `storeCode` because it is data, not an error.
 */
export function createAitCommerceV2BridgeHandler(
  provider: CommerceProvider,
): AitCommerceV2BridgeHandler {
  const listeners = new Set<(event: BridgeCommerceEvent) => void>();
  let sequence = 0;
  let detach: (() => void) | undefined;

  const deliver = (event: CommerceEvent): void => {
    const envelope: BridgeCommerceEvent = { protocol: commerceProtocol, sequence, event };
    sequence += 1;
    for (const listener of [...listeners]) {
      try {
        listener(envelope);
      } catch (error) {
        // One game listener must not stop the others from receiving the event.
        console.warn('AIT commerce v2 bridge listener failed.', error);
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
            code: aitCommerceV2MethodUnsupportedBridgeErrorCode,
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
          message: `${request.method} is not a commerce v2 method.`,
        });
    }
  };

  return {
    async request(request) {
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
  };
}

// Each entry is the typia assert of that method's result type; the lookup is
// typed by `assertAitCommerceBridgeResult`.
const resultAsserts: Readonly<Record<BridgeCommerceV2Method, (input: unknown) => unknown>> = {
  'commerce.v2.getCapabilities': assertCommerceBridgeGetCapabilitiesResult,
  'commerce.v2.fetchProducts': assertCommerceBridgeFetchProductsResult,
  'commerce.v2.requestPurchase': assertCommerceBridgeRequestPurchaseResult,
  'commerce.v2.getAvailablePurchases': assertCommerceBridgeGetAvailablePurchasesResult,
  'commerce.v2.finishTransaction': assertCommerceBridgeFinishTransactionResult,
  'commerce.v2.restorePurchases': assertCommerceBridgeRestorePurchasesResult,
};

/** Validates a commerce v2 result; a provider answer the contract rejects never reaches the caller. */
export function assertAitCommerceBridgeResult<TMethod extends BridgeCommerceV2Method>(
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
    return assertAitCommerceBridgeResult(method, data);
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
      aitCommerceV2InvalidPayloadBridgeErrorCode,
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

// Game side.

export interface CreateAitBridgeCommerceProviderInput {
  readonly store: StoreId;
  /** Sends one bridge request and returns its data; the gateway's `request` fits. */
  readonly request: <TData>(method: BridgeCommerceV2Method, payload: unknown) => Promise<TData>;
  readonly subscribe: (listener: (event: BridgeCommerceEvent) => void) => () => void;
}

/**
 * `CommerceProvider` over a bridge that serves the `commerce.v2.*` methods and
 * the event envelope. Results are validated again on this side, so a transport
 * that forgets to is still fail-closed; bridge errors become `CommerceError`s
 * with the bridge code kept as `storeCode` when it is not already a v2 code.
 */
export function createAitBridgeCommerceProvider(
  input: CreateAitBridgeCommerceProviderInput,
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
      return assertAitCommerceBridgeResult(method, data);
    } catch (error) {
      throw new CommerceError('INVALID_RESPONSE', {
        message: `Bridge returned invalid data for ${method}.`,
        cause: error,
      });
    }
  };
  return {
    store: input.store,
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
        // envelope without a protocol is malformed and must reach the validator.
        const protocol: unknown = typeof envelope === 'object' && envelope !== null
          ? (envelope as { readonly protocol?: unknown }).protocol
          : undefined;
        if (typeof protocol === 'string' && protocol !== bridgeCommerceEventProtocol) {
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
}

function toCommerceError(error: unknown): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  if (error instanceof PlatformOperationError) {
    if (isCommerceErrorCode(error.code)) {
      return new CommerceError(error.code, {
        message: error.message,
        retryable: error.retryable,
        cause: error,
      });
    }
    return new CommerceError('UNKNOWN', {
      message: error.message,
      retryable: error.retryable,
      storeCode: error.code,
      cause: error,
    });
  }
  const info = commerceErrorInfoOf(error);
  return new CommerceError(info.code, {
    retryable: info.retryable,
    ...(info.storeCode === undefined ? {} : { storeCode: info.storeCode }),
    ...(info.message === undefined ? {} : { message: info.message }),
    cause: error,
  });
}
