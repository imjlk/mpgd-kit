import * as devvitWebClient from '@devvit/web/client';

import type { ShareResult } from '@mpgd/platform';

import {
  startDevvitSurface,
  type DevvitSurfaceOptions,
  type DevvitSurfaceResult,
} from './surface.js';
import {
  startDevvitViewMode,
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
  DevvitViewMode,
  DevvitViewModeClient,
  DevvitViewModeOptions,
  DevvitViewModeResult,
} from './view-mode.js';

export type DevvitWebSurfaceOptions = Omit<DevvitSurfaceOptions, 'client'>;
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
};

export function startDevvitWebSurface(
  options: DevvitWebSurfaceOptions,
): Promise<DevvitSurfaceResult> {
  return startDevvitSurface({
    ...options,
    client: { getWebViewMode: browserClient.getWebViewMode },
  });
}

/**
 * Starts a Devvit web view in inline or expanded mode. Inline mode can defer
 * gameplay until an explicit user action while remaining inside the post.
 */
export function startDevvitWebView(
  options: DevvitWebViewOptions,
): Promise<DevvitViewModeResult> {
  return startDevvitViewMode({
    ...options,
    client: { getWebViewMode: browserClient.getWebViewMode },
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
