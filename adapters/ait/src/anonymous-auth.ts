import { createWebViewIdentity } from '@ait-kit/sdk/webview';

export interface AitAnonymousAuthCode {
  readonly code: string;
  readonly expiresIn: number;
}

/**
 * Issue a fresh SDK 3.6+ code for the game authority to exchange over mTLS.
 * Codes are never cached, persisted, or replaced with the client identity hash.
 * The host calls this; gameplay continues to use PlatformGateway.
 */
export async function createAitAnonymousAuthCode(): Promise<AitAnonymousAuthCode> {
  return createWebViewIdentity().createAnonymousKeyAuthCode();
}
