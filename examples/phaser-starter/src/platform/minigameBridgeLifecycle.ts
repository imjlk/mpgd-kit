export interface StarterMiniGameBridgeScope {
  __MPGD_MINIGAME_RUNTIME__?: object;
}

export interface StarterMiniGameRuntimeMetadataScope {
  readonly __MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__?: unknown;
}

export function requireStarterMiniGameRuntimeAssetOrigins(
  scope: StarterMiniGameRuntimeMetadataScope,
  expectedOrigins: readonly string[],
): readonly string[] {
  const descriptor = Object.getOwnPropertyDescriptor(
    scope,
    '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__',
  );
  const value: unknown = descriptor?.value;

  if (
    descriptor === undefined
    || descriptor.configurable !== false
    || descriptor.enumerable !== false
    || descriptor.writable !== false
    || !isStringArray(value)
    || !Object.isFrozen(value)
  ) {
    throw new Error('Mini-game runtime asset-origin metadata is unavailable or mutable.');
  }
  if (
    value.length !== expectedOrigins.length
    || value.some((origin, index) => origin !== expectedOrigins[index])
  ) {
    throw new Error('Mini-game runtime asset-origin metadata differs from target configuration.');
  }

  return value;
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === 'string');
}

export function runStarterMiniGameBootstrapStep<T>(input: Readonly<{
  readonly run: () => T;
  readonly cleanup: () => void;
  readonly reportCleanupError: (error: unknown) => void;
}>): T {
  try {
    return input.run();
  } catch (bootstrapError) {
    try {
      input.cleanup();
    } catch (cleanupError) {
      try {
        input.reportCleanupError(cleanupError);
      } catch {
        // Preserve the authoritative bootstrap error when reporting is unavailable.
      }
    }
    throw bootstrapError;
  }
}

export class StarterMiniGameBridgeLifecycle {
  readonly #disposeGlobals: () => void;
  #disposed = false;
  #disposing = false;

  constructor(disposeGlobals: () => void) {
    this.#disposeGlobals = disposeGlobals;
  }

  dispose(scope: StarterMiniGameBridgeScope, bridge: object): void {
    if (this.#disposed || this.#disposing) {
      return;
    }
    this.#disposing = true;
    let failure: Readonly<{ readonly cause: unknown }> | undefined;

    try {
      this.#disposeGlobals();
    } catch (cause) {
      failure = { cause };
    } finally {
      this.#disposed = true;

      try {
        if (
          scope.__MPGD_MINIGAME_RUNTIME__ === bridge
          && !Reflect.deleteProperty(scope, '__MPGD_MINIGAME_RUNTIME__')
          && failure === undefined
        ) {
          failure = { cause: new Error('Mini-game runtime bridge could not be removed.') };
        }
      } catch (cause) {
        if (failure === undefined) {
          failure = { cause };
        }
      } finally {
        this.#disposing = false;
      }
    }

    if (failure !== undefined) {
      throw failure.cause;
    }
  }
}
