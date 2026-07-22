import typia from 'typia';

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
  | 'commerce.getProducts'
  | 'commerce.purchase'
  | 'commerce.restore'
  | 'commerce.getEntitlements'
  | 'ads.preload'
  | 'ads.showRewarded'
  | 'ads.showInterstitial'
  | 'leaderboard.submitScore'
  | 'leaderboard.open'
  | 'storage.load'
  | 'storage.save';

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

export const bridgeStorageLoadProtocol = 'mpgd.storage.load.v1' as const;

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
