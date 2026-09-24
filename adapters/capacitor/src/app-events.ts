import { App, type AppPlugin } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import type { LifecycleAdapter, NativeBackButtonEvent, NativeOpenUrlEvent } from '@mpgd/platform';

export type CapacitorIncomingUrlKind = 'game' | 'oauth';

export interface CapacitorVisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type CapacitorAppEventsApi = Pick<
  AppPlugin,
  'addListener' | 'getState' | 'getLaunchUrl' | 'exitApp'
>;

export interface CreateCapacitorAppEventsInput {
  readonly target: 'android' | 'ios';
  readonly app?: CapacitorAppEventsApi;
  readonly visibility?: CapacitorVisibilitySource | null;
  /** Return null for URLs that this game does not own. Never default OAuth to game. */
  readonly classifyIncomingUrl?: (url: string) => CapacitorIncomingUrlKind | null;
  readonly historyBack?: () => void;
  readonly onError?: (error: unknown) => void;
}

const maxWarmUrlsBeforeInitial = 32;
// Covers a near-simultaneous duplicate from getLaunchUrl and appUrlOpen, not a later tap.
const coldUrlDedupeWindowMs = 2_000;

function defaultVisibility(): CapacitorVisibilitySource | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Owns only handles it registers. Disposing during an awaited addListener
 * removes the eventual handle without touching another gateway's listeners.
 */
export function createCapacitorAppEvents(input: CreateCapacitorAppEventsInput): LifecycleAdapter {
  const app = input.app ?? App;
  const visibility = input.visibility === undefined ? defaultVisibility() : input.visibility;
  const pauseCallbacks = new Set<() => void>();
  const resumeCallbacks = new Set<() => void>();
  const gameUrlCallbacks = new Set<(event: NativeOpenUrlEvent) => void>();
  const oauthCallbacks = new Set<(event: NativeOpenUrlEvent) => void>();
  const backHandlers: Array<(event: NativeBackButtonEvent) => boolean | Promise<boolean>> = [];
  const handles: PluginListenerHandle[] = [];
  const warmUrlsBeforeInitial = new Set<string>();
  let disposed = false;
  let initialResolved = false;
  let appActive = true;
  let visibilityActive = visibility?.hidden !== true;
  let currentActive = true;
  let transitionVersion = 0;
  let stateEvents = 0;
  let externalActivities = 0;
  let backInProgress = false;
  let startFailureReported = false;
  let recentColdUrl: string | undefined;
  let recentColdUntil = 0;
  let startPromise: Promise<void> | undefined;
  let backPromise: Promise<void> | undefined;
  let initialPromise: Promise<{ kind: CapacitorIncomingUrlKind; event: NativeOpenUrlEvent } | null>
    | undefined;

  const reportError = (error: unknown): void => {
    try {
      if (input.onError !== undefined) {
        input.onError(error);
      } else {
        console.error('Capacitor app event failed.', error);
      }
    } catch {
      // Reporting must not replace the original listener or registration error.
    }
  };

  function emit(callbacks: ReadonlySet<() => void>, version: number): void {
    for (const callback of [...callbacks]) {
      // A callback can open or close external UI and reenter reconcile().
      // Never continue an older resume/pause emission after that transition.
      if (disposed || version !== transitionVersion) {
        return;
      }
      try {
        callback();
      } catch (error) {
        reportError(error);
      }
    }
  }

  function reconcile(): void {
    if (disposed) {
      return;
    }
    const active = appActive && visibilityActive && externalActivities === 0;
    if (active === currentActive) {
      return;
    }
    currentActive = active;
    transitionVersion += 1;
    emit(active ? resumeCallbacks : pauseCallbacks, transitionVersion);
  }

  function classify(url: string): CapacitorIncomingUrlKind | null {
    try {
      const kind = input.classifyIncomingUrl?.(url);
      return kind === 'game' || kind === 'oauth' ? kind : null;
    } catch (error) {
      reportError(error);
      return null;
    }
  }

  function dispatchWarmUrl(url: string): void {
    if (disposed || url.trim() === '') {
      return;
    }
    if (url === recentColdUrl && Date.now() <= recentColdUntil) {
      // Capacitor can deliver the same launch through getLaunchUrl and
      // appUrlOpen. Suppress only that immediate duplicate, not a later tap.
      recentColdUrl = undefined;
      return;
    }
    const kind = classify(url);
    if (kind === null) {
      return;
    }
    const callbacks = kind === 'game' ? gameUrlCallbacks : oauthCallbacks;
    if (!initialResolved && callbacks.size > 0) {
      // Keep enough recent entries to suppress a cold/warm duplicate without
      // retaining an unbounded history when the host never requests cold URLs.
      if (warmUrlsBeforeInitial.size >= maxWarmUrlsBeforeInitial) {
        const oldest = warmUrlsBeforeInitial.values().next().value;
        if (oldest !== undefined) {
          warmUrlsBeforeInitial.delete(oldest);
        }
      }
      warmUrlsBeforeInitial.add(url);
    }
    const event = { url, source: 'warm' } as const;
    for (const callback of [...callbacks]) {
      try {
        callback(event);
      } catch (error) {
        reportError(error);
      }
    }
  }

  async function own(registration: Promise<PluginListenerHandle>): Promise<void> {
    const handle = await registration;
    if (disposed) {
      await handle.remove();
    } else {
      handles.push(handle);
    }
  }

  function onVisibilityChange(): void {
    visibilityActive = visibility?.hidden !== true;
    reconcile();
  }

  function start(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error('Capacitor app events are disposed.'));
    }
    if (startPromise !== undefined) {
      return startPromise;
    }
    visibility?.addEventListener('visibilitychange', onVisibilityChange);
    onVisibilityChange();
    const beforeRead = stateEvents;
    startPromise = Promise.all([
      own(app.addListener('appStateChange', ({ isActive }) => {
        stateEvents += 1;
        appActive = isActive;
        reconcile();
      })),
      own(app.addListener('appUrlOpen', ({ url }) => dispatchWarmUrl(url))),
      app.getState().then(({ isActive }) => {
        if (!disposed && stateEvents === beforeRead) {
          appActive = isActive;
          reconcile();
        }
      }),
    ]).then(() => undefined);
    return startPromise;
  }

  function startForSubscription(): void {
    void start().catch((error) => {
      if (startFailureReported) {
        return;
      }
      startFailureReported = true;
      reportError(error);
    });
  }

  async function dispatchBack(event: NativeBackButtonEvent): Promise<void> {
    for (const handler of [...backHandlers].reverse()) {
      try {
        if (await handler(event)) {
          return;
        }
        if (disposed) {
          return;
        }
      } catch (error) {
        reportError(error);
      }
    }
    if (disposed) {
      return;
    }
    if (event.canGoBack) {
      if (input.historyBack !== undefined) {
        input.historyBack();
      } else if (typeof history !== 'undefined') {
        history.back();
      }
    } else {
      await app.exitApp();
    }
  }

  function startBackListener(): void {
    if (input.target !== 'android' || backPromise !== undefined || disposed) {
      return;
    }
    backPromise = own(app.addListener('backButton', (event) => {
      if (backInProgress || disposed) {
        return;
      }
      backInProgress = true;
      void dispatchBack(event).catch(reportError).finally(() => {
        backInProgress = false;
      });
    }));
    void backPromise.catch(reportError);
  }

  function subscribe<T>(callbacks: Set<T>, callback: T): () => void {
    if (disposed) {
      return () => {};
    }
    callbacks.add(callback);
    startForSubscription();
    return () => {
      callbacks.delete(callback);
    };
  }

  function getInitial(): Promise<{ kind: CapacitorIncomingUrlKind; event: NativeOpenUrlEvent } | null> {
    if (initialPromise !== undefined) {
      return initialPromise;
    }
    startForSubscription();
    initialPromise = app.getLaunchUrl().then((launch) => {
      initialResolved = true;
      const url = launch?.url;
      const seenWarm = url === undefined ? false : warmUrlsBeforeInitial.has(url);
      warmUrlsBeforeInitial.clear();
      if (disposed || url === undefined || url.trim() === '' || seenWarm) {
        return null;
      }
      const kind = classify(url);
      if (kind === null) {
        return null;
      }
      recentColdUrl = url;
      recentColdUntil = Date.now() + coldUrlDedupeWindowMs;
      return { kind, event: { url, source: 'cold' } };
    }, (error: unknown) => {
      initialResolved = true;
      warmUrlsBeforeInitial.clear();
      throw error;
    });
    return initialPromise;
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    visibility?.removeEventListener('visibilitychange', onVisibilityChange);
    pauseCallbacks.clear();
    resumeCallbacks.clear();
    gameUrlCallbacks.clear();
    oauthCallbacks.clear();
    backHandlers.length = 0;
    warmUrlsBeforeInitial.clear();
    recentColdUrl = undefined;
    // Pending registrations remove themselves in own() if they later resolve.
    // Teardown must not hang on an SDK registration that never does.
    await Promise.allSettled(handles.splice(0).map((handle) => handle.remove()));
  }

  return {
    onPause(callback) {
      // start() may synchronously emit the first pause while subscribing.
      const alreadyPaused = !disposed && currentActive === false;
      const unsubscribe = subscribe(pauseCallbacks, callback);
      if (alreadyPaused) {
        try {
          callback();
        } catch (error) {
          reportError(error);
        }
      }
      return unsubscribe;
    },
    onResume(callback) {
      return subscribe(resumeCallbacks, callback);
    },
    onBackButton(handler) {
      if (disposed || input.target !== 'android') {
        return () => {};
      }
      backHandlers.push(handler);
      startBackListener();
      return () => {
        const index = backHandlers.indexOf(handler);
        if (index >= 0) {
          backHandlers.splice(index, 1);
        }
      };
    },
    onGameUrlOpen(callback) {
      return subscribe(gameUrlCallbacks, callback);
    },
    onOAuthRedirect(callback) {
      return subscribe(oauthCallbacks, callback);
    },
    async getInitialGameUrl() {
      const initial = await getInitial();
      return initial?.kind === 'game' ? initial.event : null;
    },
    async getInitialOAuthRedirect() {
      const initial = await getInitial();
      return initial?.kind === 'oauth' ? initial.event : null;
    },
    beginExternalActivity() {
      if (disposed) {
        return () => {};
      }
      externalActivities += 1;
      reconcile();
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        externalActivities -= 1;
        reconcile();
      };
    },
    dispose,
  };
}
