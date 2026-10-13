import * as devvitWebClient from '@devvit/web/client';

import type { ShareResult } from '@mpgd/platform';

import type { DevvitCheckoutResult, DevvitPaymentsClient } from './payments.js';

import {
  startDevvitSurface,
  type DevvitSurfaceClient,
  type DevvitSurfaceOptions,
  type DevvitSurfaceResult,
} from './surface.js';
import {
  startDevvitPreviewViewMode,
  startDevvitViewMode,
  type DevvitPreviewViewModeOptions,
  type DevvitPreviewViewModeResult,
  type DevvitViewModeOptions,
  type DevvitViewModeResult,
} from './view-mode.js';

export type {
  DevvitSurfaceClient,
  DevvitSurfaceMode,
  DevvitSurfaceOptions,
  DevvitSurfaceResult,
} from './surface.js';
export type {
  DevvitInlineModeContext,
  DevvitPreviewViewModeOptions,
  DevvitPreviewViewModeResult,
  DevvitViewMode,
  DevvitViewModeClient,
  DevvitViewModeOptions,
  DevvitViewModeResult,
} from './view-mode.js';

export type DevvitWebSurfaceOptions = Omit<DevvitSurfaceOptions, 'client'>;
export type DevvitWebPreviewOptions = Omit<DevvitPreviewViewModeOptions, 'client'>;
export type DevvitWebViewOptions = Omit<DevvitViewModeOptions, 'client'>;

export interface DevvitShareSheetOptions {
  readonly data?: string;
  readonly title?: string;
  readonly text?: string;
}

// The Devvit package publishes browser implementations behind an export
// condition while its default declaration is a server-side panic module.
// Keep the narrow browser contract explicit until its default types expose it.
const browserClient = devvitWebClient as unknown as {
  readonly getWebViewMode: () => 'inline' | 'expanded';
  readonly requestExpandedMode: (event: MouseEvent, entry: string) => void | Promise<void>;
  readonly showShareSheet: (options: DevvitShareSheetOptions) => Promise<void>;
  readonly purchase: (skuOrSkus: string | readonly string[]) => Promise<DevvitOrderResultEventLike>;
};
const browserSurfaceClient: DevvitSurfaceClient = {
  getWebViewMode: browserClient.getWebViewMode,
};

export function startDevvitWebSurface(
  options: DevvitWebSurfaceOptions,
): Promise<DevvitSurfaceResult> {
  return startDevvitSurface({
    ...options,
    client: browserSurfaceClient,
  });
}

/**
 * Starts a preview-only inline entry and loads gameplay only in expanded mode.
 * This is the safe default for generated Devvit games.
 */
export function startDevvitPreviewWebView(
  options: DevvitWebPreviewOptions,
): Promise<DevvitPreviewViewModeResult> {
  return startDevvitPreviewViewMode({
    ...options,
    client: browserSurfaceClient,
  });
}

/**
 * Starts a Devvit web view in inline or expanded mode. Inline mode can defer
 * gameplay until an explicit user action while remaining inside the post.
 * This is an explicit inline-gameplay opt-in; generated games use
 * {@link startDevvitPreviewWebView} by default.
 */
export function startDevvitWebView(
  options: DevvitWebViewOptions,
): Promise<DevvitViewModeResult> {
  return startDevvitViewMode({
    ...options,
    client: browserSurfaceClient,
  });
}

export async function requestDevvitExpandedMode(
  event: MouseEvent,
  entry: string,
): Promise<void> {
  await browserClient.requestExpandedMode(event, entry);
}

/**
 * Presents Devvit's native share surface without claiming that the user
 * completed sharing. Devvit does not report a completion callback.
 */
export async function presentDevvitShareSheet(
  options: DevvitShareSheetOptions,
): Promise<ShareResult> {
  try {
    await browserClient.showShareSheet(options);
    return {
      status: 'shared',
      completion: 'presented',
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { status: 'cancelled' };
    }

    return { status: 'unavailable' };
  }
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object'
      && error !== null
      && (error as { readonly name?: unknown }).name === 'AbortError';
}

/** `OrderResultEvent` of `@devvit/payments/client`, as the webview reads it. */
export interface DevvitOrderResultEventLike {
  /** `OrderResultStatus`: 0 cancelled, 1 success, 2 error (or its name). */
  readonly status: number | string;
  readonly orderId?: string | undefined;
  readonly errorCode?: number | undefined;
  readonly errorMessage?: string | undefined;
}

/** The checkout client `createDevvitWebPaymentsClient` returns; the v2 provider needs nothing else. */
export type DevvitWebPaymentsClient = DevvitPaymentsClient;

const successStatuses: ReadonlySet<number | string> = new Set([1, 'STATUS_SUCCESS', 'SUCCESS']);
const cancelledStatuses: ReadonlySet<number | string> = new Set([
  0,
  'STATUS_CANCELLED',
  'CANCELLED',
]);
const errorStatuses: ReadonlySet<number | string> = new Set([2, 'STATUS_ERROR', 'ERROR']);

/**
 * Maps one Reddit checkout answer to the adapter's `DevvitCheckoutResult`:
 * `STATUS_SUCCESS` with an order id is `completed` (the order id is Reddit's;
 * the backend ledger decides the grant), `STATUS_SUCCESS` without one is
 * `pending` so the reconciler resolves it from the paid-order list,
 * `STATUS_CANCELLED` is `cancelled`, and `STATUS_ERROR` is `failed` with the
 * platform code kept as `storeCode`. An unknown status is `pending`: an order
 * may exist and nothing is granted or dropped on the client.
 */
export function toDevvitCheckoutResult(event: DevvitOrderResultEventLike): DevvitCheckoutResult {
  const orderId = typeof event.orderId === 'string' && event.orderId.trim().length > 0
    ? event.orderId.trim()
    : undefined;
  if (successStatuses.has(event.status)) {
    return orderId === undefined ? { status: 'pending' } : { status: 'completed', orderId };
  }
  if (cancelledStatuses.has(event.status)) {
    return {
      status: 'cancelled',
      ...(orderId === undefined ? {} : { orderId }),
      error: { code: 'USER_CANCELLED', storeCode: 'DEVVIT_CHECKOUT_CANCELLED', retryable: false },
    };
  }
  if (errorStatuses.has(event.status)) {
    const storeCode = event.errorCode === undefined
      ? 'DEVVIT_CHECKOUT_FAILED'
      : String(event.errorCode);
    return {
      status: 'failed',
      ...(orderId === undefined ? {} : { orderId }),
      error: {
        code: storeCode,
        storeCode,
        ...(typeof event.errorMessage === 'string' && event.errorMessage.length > 0
          ? { message: event.errorMessage }
          : {}),
      },
    };
  }
  return { status: 'pending', ...(orderId === undefined ? {} : { orderId }) };
}

/**
 * `purchase()` from `@devvit/payments/client` (re-exported by
 * `@devvit/web/client`) as the checkout client of `createDevvitPlatformGateway({
 * commerce: { client } })`. One SKU per checkout, no client metadata: Reddit's
 * order id is the only identity the purchase carries.
 */
export function createDevvitWebPaymentsClient(): DevvitWebPaymentsClient {
  return {
    async purchase(sku: string): Promise<DevvitCheckoutResult> {
      if (typeof sku !== 'string' || sku.trim().length === 0) {
        throw new TypeError('Devvit checkout requires a non-empty SKU.');
      }
      return toDevvitCheckoutResult(await browserClient.purchase(sku));
    },
  };
}
