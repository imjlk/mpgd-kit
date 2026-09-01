export interface StarterMiniGameBridgeScope {
  __MPGD_MINIGAME_RUNTIME__?: object;
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
