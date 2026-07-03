export interface BridgeRequest {
  readonly id: string;
  readonly method: string;
  readonly payload: unknown;
  readonly meta?: {
    readonly target?: string;
    readonly appVersion?: string;
    readonly buildId?: string;
    readonly sentAt?: string;
  };
}

export type BridgeResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly data: unknown;
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
