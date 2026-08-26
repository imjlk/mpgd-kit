import {
  startDevvitSurface,
  type DevvitSurfaceOptions,
  type DevvitSurfaceResult,
} from './surface.js';

export type DevvitViewMode = 'inline' | 'expanded';

export interface DevvitViewModeClient {
  getWebViewMode(): DevvitViewMode;
}

export type DevvitPreviewViewModeOptions = DevvitSurfaceOptions;

export type DevvitPreviewViewModeResult = {
  readonly surface: DevvitSurfaceResult;
};

export interface DevvitInlineModeContext {
  /**
   * Loads gameplay in the current inline mode. Call this only from an explicit
   * user action so the initial post entry can remain a lightweight launch screen.
   */
  readonly startGameplay: () => Promise<void>;
}

export type DevvitViewModeResult =
  | {
      readonly mode: 'inline';
      readonly startGameplay: () => Promise<void>;
    }
  | {
      readonly mode: 'expanded';
    };

export interface DevvitViewModeOptions {
  readonly client: DevvitViewModeClient;
  readonly mountInlineMode: (
    context: DevvitInlineModeContext,
  ) => void | Promise<void>;
  readonly loadGameplay: (mode: DevvitViewMode) => void | Promise<void>;
  readonly onModeUnavailable?: (error: unknown) => void;
}

/**
 * Preview-only inline entry contract. This is intentionally a thin alias of
 * {@link startDevvitSurface}; generated games pin this policy-facing name while
 * the lower-level surface API remains independently available.
 *
 * Use this contract by default for generated games. Games that intentionally
 * support policy-compliant inline gameplay can opt in through
 * {@link startDevvitViewMode} instead.
 */
export async function startDevvitPreviewViewMode(
  options: DevvitPreviewViewModeOptions,
): Promise<DevvitPreviewViewModeResult> {
  const surface = await startDevvitSurface(options);

  return { surface };
}

/**
 * Starts a Devvit web view using Reddit's official inline and expanded mode
 * terminology. Inline mode mounts lightweight content first and exposes a
 * retryable, concurrency-safe gameplay loader for a later user action.
 * Expanded mode loads gameplay immediately. Outside a Devvit host, expanded
 * mode is used as the local-browser fallback.
 *
 * This is an explicit inline-gameplay opt-in. Prefer
 * {@link startDevvitPreviewViewMode} unless the game's inline interaction and
 * gesture model has been reviewed against current Reddit requirements.
 */
export async function startDevvitViewMode(
  options: DevvitViewModeOptions,
): Promise<DevvitViewModeResult> {
  let mode: DevvitViewMode;

  try {
    mode = options.client.getWebViewMode();
  } catch (error) {
    options.onModeUnavailable?.(error);
    await options.loadGameplay('expanded');
    return { mode: 'expanded' };
  }

  if (mode === 'expanded') {
    await options.loadGameplay('expanded');
    return { mode: 'expanded' };
  }

  const startGameplay = createInlineModeGameplayStarter(options.loadGameplay);

  await options.mountInlineMode({ startGameplay });

  return {
    mode: 'inline',
    startGameplay,
  };
}

function createInlineModeGameplayStarter(
  loadGameplay: DevvitViewModeOptions['loadGameplay'],
): () => Promise<void> {
  let activeLoad: { readonly promise: Promise<void> } | undefined;

  return () => {
    if (activeLoad !== undefined) {
      return activeLoad.promise;
    }

    const pendingLoad = Promise.resolve().then(() => loadGameplay('inline'));
    const loadState = { promise: pendingLoad };

    activeLoad = loadState;
    void pendingLoad.catch(() => {
      if (activeLoad === loadState) {
        activeLoad = undefined;
      }
    });

    return pendingLoad;
  };
}
