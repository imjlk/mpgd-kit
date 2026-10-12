import typia from 'typia';

import {
  commerceBridgeMethods,
  commerceProtocol,
  type CommerceBridgeMethod,
  type CommerceEventEnvelope,
} from '@mpgd/platform/commerce';

/**
 * Commerce v2 request methods (RFC "Bridge and versioning"). The literal
 * union below spells them out so the published declaration stays readable;
 * `bridgeCommerceV2Methods` and the type checks under it keep the list equal
 * to `commerceBridgeMethods` from `@mpgd/platform/commerce`.
 */
export type BridgeCommerceV2Method =
  | 'commerce.v2.getCapabilities'
  | 'commerce.v2.fetchProducts'
  | 'commerce.v2.requestPurchase'
  | 'commerce.v2.getAvailablePurchases'
  | 'commerce.v2.finishTransaction'
  | 'commerce.v2.restorePurchases';

export type BridgeMethod =
  | 'runtime.getCapabilities'
  | 'identity.getPlayer'
  | 'identity.getSession'
  | 'identity.requestUpgrade'
  | 'presentation.getLaunchIntent'
  | 'presentation.requestGameSurface'
  | 'share.share'
  | 'share.readInboundShare'
  | 'notifications.getStatus'
  | 'notifications.requestSubscription'
  | 'promotions.getAvailability'
  | 'promotions.grantReward'
  | BridgeCommerceV2Method
  | 'ads.preload'
  | 'ads.getAvailability'
  | 'ads.prepare'
  | 'ads.show'
  | 'ads.showRewarded'
  | 'ads.showInterstitial'
  | 'ads.mountBanner'
  | 'ads.unmountBanner'
  | 'leaderboard.submitScore'
  | 'leaderboard.open'
  | 'storage.load'
  | 'storage.save'
  | 'credentials.load'
  | 'credentials.save'
  | 'credentials.remove';

export interface BridgeRequest<TPayload = unknown> {
  readonly id: string;
  readonly method: BridgeMethod;
  readonly payload: TPayload;
  readonly meta: {
    readonly target: string;
    readonly appVersion: string;
    readonly buildId: string;
    readonly sentAt: string;
  };
}

export type BridgeResponse<TData = unknown> =
  | {
      readonly id: string;
      readonly ok: true;
      readonly data: TData;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export const bridgeCommerceV2Methods: readonly BridgeCommerceV2Method[] = commerceBridgeMethods;

// Both directions must hold: every platform method is a bridge method, and the
// bridge union names nothing the platform contract does not define.
type MethodsAgree<A extends string, B extends string> =
  [A] extends [B] ? [B] extends [A] ? true : never : never;
const bridgeCommerceV2MethodsAgree: MethodsAgree<BridgeCommerceV2Method, CommerceBridgeMethod> =
  true;
void bridgeCommerceV2MethodsAgree;

const bridgeCommerceV2MethodSet: ReadonlySet<string> = new Set(bridgeCommerceV2Methods);

export function isBridgeCommerceV2Method(method: string): method is BridgeCommerceV2Method {
  return bridgeCommerceV2MethodSet.has(method);
}

/**
 * Answer for a commerce request that reaches a transport without a commerce
 * provider. Non-retryable: the caller must route to a transport that sells
 * (or report the store unavailable), not retry the same transport.
 */
export const commerceV2UnavailableBridgeErrorCode = 'COMMERCE_V2_UNAVAILABLE' as const;

export function createCommerceV2UnavailableBridgeError(
  request: Pick<BridgeRequest, 'id' | 'method'>,
  transport: string,
): BridgeResponse {
  return createBridgeError(
    request.id,
    commerceV2UnavailableBridgeErrorCode,
    `${transport} does not provide commerce v2; ${request.method} is unavailable.`,
  );
}

/**
 * Event side of the bridge. Transports push commerce v2 events in the
 * envelope `{ protocol: 'mpgd.commerce.v2', sequence, event }`; `sequence` is
 * per session and starts at 0.
 */
export const bridgeEventProtocol = commerceProtocol;

export type BridgeEvent = CommerceEventEnvelope;

export type BridgeEventListener = (event: BridgeEvent) => void;

/** Implemented by transports that can deliver events; the unsubscribe stops delivery. */
export interface BridgeEventSource {
  subscribe(listener: BridgeEventListener): () => void;
}

export const bridgeStorageLoadProtocol = 'mpgd.storage.load.v1' as const;
export const bridgeCredentialLoadProtocol = 'mpgd.credentials.load.v1' as const;

export type BridgeCredentialLoadData =
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeCredentialLoadProtocol;
      readonly found: false;
    }
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeCredentialLoadProtocol;
      readonly found: true;
      readonly value: string;
    };

export function decodeBridgeCredentialLoadData(input: unknown): string | null {
  if (typeof input !== 'object' || input === null
    || !('__mpgdBridgeProtocol' in input)
    || input.__mpgdBridgeProtocol !== bridgeCredentialLoadProtocol
    || !('found' in input)) {
    throw new Error('Credential bridge load returned an invalid response.');
  }
  if (input.found === false && !('value' in input)) {
    return null;
  }
  if (input.found === true && 'value' in input
    && typeof input.value === 'string' && input.value !== '') {
    return input.value;
  }
  throw new Error('Credential bridge load returned an invalid response.');
}

export type BridgeStorageLoadData =
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
      readonly found: false;
    }
  | {
      readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
      readonly found: true;
      readonly value: unknown;
    };

export const assertBridgeRequest = typia.createAssert<BridgeRequest>();
export const assertBridgeResponse = typia.createAssert<BridgeResponse>();
export const assertBridgeEvent = typia.createAssertEquals<BridgeEvent>();

export function decodeBridgeStorageLoadData(
  input: unknown,
): { readonly value: unknown } | null {
  if (input === null) {
    return null;
  }

  if (input === undefined) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  if (
    typeof input !== 'object' ||
    !(input !== null && '__mpgdBridgeProtocol' in input) ||
    input.__mpgdBridgeProtocol !== bridgeStorageLoadProtocol
  ) {
    return { value: input };
  }

  const response = input as {
    readonly __mpgdBridgeProtocol: typeof bridgeStorageLoadProtocol;
    readonly found?: unknown;
    readonly value?: unknown;
  };

  if (response.found === false) {
    return null;
  }

  if (response.found !== true) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'value')) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  return { value: response.value };
}

export function createBridgeError(
  id: string,
  code: string,
  message: string,
  retryable = false,
): BridgeResponse {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}
