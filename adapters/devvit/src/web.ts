import * as devvitWebClient from '@devvit/web/client';

import {
  startDevvitSurface,
  type DevvitSurfaceOptions,
  type DevvitSurfaceResult,
} from './surface.js';

export type {
  DevvitSurfaceClient,
  DevvitSurfaceMode,
  DevvitSurfaceOptions,
  DevvitSurfaceResult,
} from './surface.js';

export type DevvitWebSurfaceOptions = Omit<DevvitSurfaceOptions, 'client'>;

// The Devvit package publishes browser implementations behind an export
// condition while its default declaration is a server-side panic module.
// Keep the narrow browser contract explicit until its default types expose it.
const browserClient = devvitWebClient as unknown as {
  readonly getWebViewMode: () => 'inline' | 'expanded';
  readonly requestExpandedMode: (event: MouseEvent, entry: string) => void | Promise<void>;
};

export function startDevvitWebSurface(
  options: DevvitWebSurfaceOptions,
): Promise<DevvitSurfaceResult> {
  return startDevvitSurface({
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
