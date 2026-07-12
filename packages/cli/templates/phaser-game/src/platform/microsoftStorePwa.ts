export const microsoftStorePwaUpdateReadyEvent = 'mpgd:pwa-update-ready';

export interface MicrosoftStorePwaUpdateReadyDetail {
  readonly registration: ServiceWorkerRegistration;
}

export function shouldInstallMicrosoftStorePwa(input: {
  readonly configTarget: string;
  readonly debug: boolean;
}): boolean {
  return input.configTarget === 'microsoft-store' && !input.debug;
}

export function installMicrosoftStorePwa(input: {
  readonly configTarget: string;
  readonly debug: boolean;
  readonly onUpdateReady?: (detail: MicrosoftStorePwaUpdateReadyDetail) => void;
  readonly onRegistrationError?: (error: unknown) => void;
}): () => void {
  if (
    !shouldInstallMicrosoftStorePwa(input)
    || typeof navigator === 'undefined'
    || !('serviceWorker' in navigator)
    || typeof document === 'undefined'
  ) {
    return () => {};
  }

  let disposed = false;
  let registration: ServiceWorkerRegistration | null = null;
  let installingWorker: ServiceWorker | null = null;
  const announceWaitingUpdate = () => {
    if (
      disposed
      || registration === null
      || registration.waiting === null
      || navigator.serviceWorker.controller === null
    ) {
      return;
    }

    const detail = { registration } satisfies MicrosoftStorePwaUpdateReadyDetail;

    if (input.onUpdateReady !== undefined) {
      input.onUpdateReady(detail);
      return;
    }

    globalThis.dispatchEvent(new CustomEvent(microsoftStorePwaUpdateReadyEvent, { detail }));
  };
  const handleInstallingStateChange = () => {
    if (installingWorker?.state === 'installed') {
      announceWaitingUpdate();
    }
  };
  const handleUpdateFound = () => {
    installingWorker?.removeEventListener('statechange', handleInstallingStateChange);
    installingWorker = registration?.installing ?? null;
    installingWorker?.addEventListener('statechange', handleInstallingStateChange);
  };
  const register = async () => {
    try {
      registration = await navigator.serviceWorker.register('./service-worker.js', {
        scope: './',
        updateViaCache: 'none',
      });

      if (disposed) {
        return;
      }

      registration.addEventListener('updatefound', handleUpdateFound);
      handleUpdateFound();
      announceWaitingUpdate();
    } catch (error) {
      if (input.onRegistrationError !== undefined) {
        input.onRegistrationError(error);
      } else {
        console.warn('[mpgd] Microsoft Store service worker registration failed.', error);
      }
    }
  };
  const handleWindowLoad = () => {
    void register();
  };

  if (document.readyState === 'complete') {
    void register();
  } else {
    globalThis.addEventListener('load', handleWindowLoad, { once: true });
  }

  return () => {
    disposed = true;
    globalThis.removeEventListener('load', handleWindowLoad);
    installingWorker?.removeEventListener('statechange', handleInstallingStateChange);
    registration?.removeEventListener('updatefound', handleUpdateFound);
  };
}
