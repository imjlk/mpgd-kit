export type DevvitSurfaceMode = 'inline' | 'expanded';

export type DevvitSurfaceResult = 'inline-preview' | 'expanded-game';

export interface DevvitSurfaceClient {
  getWebViewMode(): DevvitSurfaceMode;
}

export interface DevvitSurfaceOptions {
  readonly client: DevvitSurfaceClient;
  readonly mountInlinePreview: () => void | Promise<void>;
  readonly loadExpandedGame: () => void | Promise<void>;
  readonly onModeUnavailable?: (error: unknown) => void;
}

/**
 * Starts the light inline surface when Devvit reports inline mode and defers the
 * game bundle until an expanded surface is active. Outside a Devvit host, the
 * expanded game remains available for local browser development.
 */
export async function startDevvitSurface(
  options: DevvitSurfaceOptions,
): Promise<DevvitSurfaceResult> {
  let mode: DevvitSurfaceMode;

  try {
    mode = options.client.getWebViewMode();
  } catch (error) {
    options.onModeUnavailable?.(error);
    await options.loadExpandedGame();
    return 'expanded-game';
  }

  if (mode === 'inline') {
    await options.mountInlinePreview();
    return 'inline-preview';
  }

  await options.loadExpandedGame();
  return 'expanded-game';
}
