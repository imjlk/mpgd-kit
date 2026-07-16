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

export type BridgeStorageLoadData =
  | {
      readonly found: false;
    }
  | {
      readonly found: true;
      readonly value: unknown;
    };

export const assertBridgeRequest = typia.createAssert<BridgeRequest>();
export const assertBridgeResponse = typia.createAssert<BridgeResponse>();

export function decodeBridgeStorageLoadData(
  input: unknown,
): { readonly value: unknown } | null {
  if (typeof input !== 'object' || input === null || !('found' in input)) {
    throw new Error('Storage bridge load returned an invalid response.');
  }

  const response = input as { readonly found?: unknown; readonly value?: unknown };

  if (response.found === false) {
    return null;
  }

  if (response.found !== true || !Object.prototype.hasOwnProperty.call(response, 'value')) {
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
